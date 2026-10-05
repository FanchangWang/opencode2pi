# PLAN — 实现记录（已全部完成）

> **状态：T1–T6 全部实现并实测通过（2026-10-05，omp 18.6.1）。**
> 本文件保留为**历史记录与验收标准**，不是待办清单。新的工作请直接写进
> [`DEVELOPMENT.md`](DEVELOPMENT.md) 或 [`../AGENTS.md`](../AGENTS.md)。

要动手改这个项目，先读 [`../AGENTS.md`](../AGENTS.md)，再看
[`FINDINGS.md`](FINDINGS.md)（实测结论，不要重新推导）。

---

## 0. 目标与非目标

**目标**：在 omp / pi 里以原生扩展的形式提供 OpenCode Zen 匿名免费通道，
零 API key、零登录、零子进程、零本地端口。

**非目标**：不做 DSH 插件；不做付费 Zen 通道（宿主 `opencode-zen` 已内建且更好）；
不做 OpenAI/Anthropic 协议互转（宿主引擎已处理）。

---

## 1. 起点基线

本方案开始时 `src/index.ts` 已能跑通，2026-10-05 实测：

```
$ omp -e ./src/index.ts -p --model opencode-zen-free/mimo-v2.6-flash-free "Reply with exactly OK"
Working...
OK
```

5 个硬编码模型 id（`big-pickle` / `mimo-v2.5-free` / `mimo-v2.6-flash-free` /
`ling-3.0-flash-fin-free` / `nemotron-3.5-lightning-free`），其中
`ling-3.0-flash-fin-free` 上游间歇 503 —— **按用户决定保留、不隐藏**。

安装真实宿主类型包后 `tsc` 暴露了三个当时就存在的缺陷，已在 T1 一并修掉：

1. 种子漏了 `contextWindow` / `maxTokens`，**所有模型都在跑宿主 128000/16384 兜底**
2. `toolChoice` 被设在 `Context` 上，而引擎只读 `StreamOptions` 上的它
3. 必填的 `cost.cacheRead` / `cacheWrite` 缺失


---

## 2. 任务清单与验收

### T1 — 能力参数自动暴露 ✅ 已完成

**为什么排第一**：它和 T2 共用同一次 models.dev 解析，分开做等于解析两遍；而且能力参数缺失比列表过期更隐蔽 —— 列表少一个模型用户会换，`contextWindow` 算错会让请求在十万 token 处莫名截断，用户根本不知道该去哪查。

**输入**：models.dev `api.json` 的每个模型条：

| models.dev 字段 | → 扩展返回字段 |
| --- | --- |
| `limit.context` | `contextWindow` |
| `limit.output` | `maxTokens` |
| `cost.input` / `cost.output` | `cost.input` / `cost.output` |
| `modalities.input` | `input`（含 `image` 才放行图片） |
| `reasoning` | `reasoning` |
| `reasoning_options.effort_values` | `thinking.efforts` |

**规则**：
- 字段缺失或非法时**必须显式落到保守默认值并记录原因**，不要让宿主静默兜底 —— 静默兜底是 `FINDINGS.md` §7.2 那个坑。
- `maxTokens` 不能超过 `contextWindow`（宿主会 clamp，但自己夹一次更可控）。
- 元数据整体不可用时，退回 `src/index.ts` 里已验证的静态种子（那 5 个 id 的参数是实测过的）。

**验收**：
1. 临时断网，仍能用且参数是静态种子的值，不是 128000/16384。
2. 断网 → 恢复后列表与参数都刷新。
3. 一个声明 `modalities.input: ["text","image"]` 的模型能接收图片附件；只声明 `text` 的被拒绝。

### T2 — 免费模型列表自动发现 ✅ 已完成

**问题**：当前 7 个 id 硬编码。免费池轮换频繁。

**要做**：三级回退，但要按宿主的约束改写，**不要照抄 opencode2dsh**：

```
S1  GET {zen}/v1/models              → 实时在售 id（含全部付费模型）
S2  models.dev 定价元数据            → 免费判定（与 T1 同一次请求）
S3  src/index.ts 里已验证的静态种子   → 兜底
```

**宿主约束（`FINDINGS.md` §7）**：
- `fetchDynamicModels` 有 **15 秒硬超时**（`RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS`），超时即失败。**两级请求必须并发**。
- 更稳的设计：models.dev 本地长期缓存（日更都不到），每次只打 Zen 实时列表，15 秒预算绰绰有余。
- **必须同时提供静态 `models` 种子**，否则冷启动 `--model` 直接 `not found`。

**免费判定顺序（最容易写反的地方）**：
1. 元数据就绪 → **元数据判定永远优先**，`deprecated` 要能**否决**一个名字里带 `free` 的模型；
2. 元数据不可用（pending / 该 model 缺失）→ 才回退到名字启发式 `id.includes('free')`；
3. 静态种子里的已验证 id（如 `big-pickle`，名字里没有 `free`）需要单独标记，无条件放行。

**为什么第 1 条重要**：`opencode2dsh` 明确记录过 `deepseek-v4-flash-free` 因为「先判名字」而永远留在列表里，尽管上游早已返回 400 "Model is unavailable"。

**验收**：
1. `GET /zen/v1/models` 返回的付费模型（如 `claude-opus-5-5`）**不出现在**最终列表里。
2. 断网 → 恢复后能自动出现新模型。
3. 冷启动 `--model opencode-zen-free/<新模型>` 可用（验证种子机制）。

### T3 — session id 按会话亲和 ✅ 已完成

**问题**：当前 `SESSION` 是**进程级常量**，同进程内所有会话共用一个 session id。上游按 session 做 prompt cache 亲和，共用会互相污染。

**要做**：能拿到会话标识就按会话派生，拿不到就退回进程级。
- **先探测**自定义 API handler 的 `options` 里有没有会话字段（`sessionId` / `conversationId` 之类）。不要假设。
- 派生照抄 `src/index.ts` 的 `canonicalSessionID`。

**验收**：同进程内两个会话的 session id 不同；同一会话多轮之间稳定。

### T4 — 错误分类 ✅ 已完成

上游错误目前原样透传，用户看到的是 `Error from provider (Console): ...`。在自定义 API handler 里包装：

| 上游形态 | 归类 | 展示 |
| --- | --- | --- |
| 403 `FreeTierError` | `SHAPE_REJECTED` | 「上游形状闸门拒绝，通常是本扩展的 bug，请提 issue」 |
| 403 `RegionError` | `REGION_BLOCKED` | 「该模型在当前网络地区不可用」（**不要**说成凭据问题） |
| 401 `ModelError` | `MODEL_GONE` | 「模型已下线」 |
| 429 | `RATE_LIMIT` | 「匿名配额按出口 IP 限流」 |
| 5xx | `UPSTREAM` | 「上游暂时不可用」 |

`RegionError` 的判定必须在 `AUTH` **之前** —— 否则地区封锁会被误报成「API key 无效」。这是 `opencode2dsh` 0.3.5 修过的同一个 bug。

### T5 — `/opencode2pi` TUI 命令 ✅ 已完成

omp **没有** DSH 那种网页设置页。可用的界面手段是斜杠命令 + TUI：

| 手段 | 用途 |
| --- | --- |
| `pi.registerCommand` | `/opencode2pi` |
| `ctx.ui.select` | 交互式菜单 |
| `ctx.ui.notify` | 状态提示 |
| `setWidget` / `setHookWidget` | 输入框上方/下方常驻 widget |

先例：`opencode-pi` 的 `/opencode-pi status` 就是这个形态。

**最小版本（推荐先做这个）**：`/opencode2pi doctor` —— 发一个最小闸门形状请求并分类报错。

理由：形状闸门是本扩展**硬编码**的东西，上游一改就全线 403 且无任何提示。上游三周内改了三次策略，这个自检把「静默失效」变成「明确告警」，价值高于模型标记。

**进阶版本**：用 `pi.on('after_provider_response')`（带 `{ status, headers }` 和 `ctx.model`）记录每模型成败历史，在菜单里显示 `✅ 可用 / ⚠️ 503 间歇 / ❌ 403 地区封锁 / ❓ 未测试`，并支持用户手动标记。按用户要求：**模型照样列在选择器里，只加状态标注，不隐藏**。

**唯一真实风险**：用户标记的**持久化途径未验证**。omp 的 settings 是宿主定义的类型化句柄（`lookup(id)` 对未知 id 返回 `undefined`），扩展能否注册自己的 settings id 不确定。备选：写 JSON 到 agent 目录。**先验证再实现**，否则用户标记重启即丢。

**实测结论（2026-10-05）**：settings 持久化那条风险没有走 settings 句柄，而是直接写
`<tmpdir>/opencode2pi/health.json`（自己的格式，不依赖宿主类型化 id），因此标记重启不丢。
没有实现用户手动标记 —— 探测证据比人工标记更可信，且自动标记已覆盖用户诉求。
**实测推翻了「一次 ModelError 即判死」的设计**：`nemotron-3.ultra-free` 在一分钟内先返回
`401 ModelError`、再返回 `200`。因此改为连续两次 `ModelError` 才升级 ❌，任何一次成功清零；
`REGION_BLOCKED` 对同一出口是确定性的，命中即 ❌。

### T6 — 打包与分发 ✅ 已完成

实测：`omp install .` 链接后**不带 `-e`** 也能加载并正常对话；`npm pack` 产物只含 `src/`（用 `files` 字段收窄）。
另外修正了一处会直接坑到用户的旧文档：README 原来让用户 `cp src/index.ts`，扩展变成多文件后这条命令必然失败，已改为整目录复制。

- `package.json` 的 `pi.extensions` / `omp.extensions` 双 manifest 已在位，确认 `pi install npm:opencode2pi` 与 `omp -e ./src/index.ts` 两条路都通。
- 补 README：**这是匿名免费通道，上游随时可能改闸门或关停**；附 `FINDINGS.md` §2 的三个条件供用户排障。
- **必须在 README 写明 `omp models` 看不到这个 provider**（`FINDINGS.md` §7.4），用 `/model` 或 `--model provider/id`。

---

## 3. 实现顺序

```
T1（能力参数）→ T2（列表发现）→ T3（session）→ T4（错误分类）
                                                          ↓
                                              T5 doctor → T6 打包
```

T5 的进阶版本（模型状态追踪）可以延后到 T6 之后。

---

## 4. 明确不要做的事

- ❌ **不要用 `pi.registerProvider` 的 `onPayload` / `prepareRequest`** —— 实测是哑字段，运行时永不触发（`FINDINGS.md` §3.1）。
- ❌ **不要引入 `createProvider` / `openaiCompletions`** —— omp 内置的 pi-ai 1.x 里没有这两个导出。
- ❌ **不要改 JSON body** —— handler 拿到的是结构化 `context`，加在 `context.tools` 上。
- ❌ **不要返回嵌套 `limits`** —— 静默失效（`FINDINGS.md` §7.2）。
- ❌ **不要只给 `fetchDynamicModels` 不给静态种子** —— 冷启动 `--model` 直接失败（§7.3）。
- ❌ **不要 spawn 子进程** —— 那是 `opencode-pi` 的路线，本项目走原生 HTTP。
- ❌ **不要移植 `opencode2dsh` 的 IP 池** —— 宿主已有 `PI_PROXY_<PROVIDER>`，且进程内缓存导致运行时轮换不可行（`FINDINGS.md` §6）。
- ❌ **不要照抄 DSH 侧的重试策略** —— 匿名通道重试轰炸会挤掉自己的配额。

---

## 5. 每一步都必须重跑的验证

```sh
cd C:/Users/guyue/code/opencode2pi

# 冒烟：基础对话           期望：输出恰好 OK
omp -e ./src/index.ts -p --model opencode-zen-free/mimo-v2.6-flash-free "Reply with exactly OK"

# 工具往返：闸门桩不能劫持真实工具   期望：3
mkdir -p /tmp/t && touch /tmp/t/a.txt /tmp/t/b.txt /tmp/t/c.txt
omp -e ./src/index.ts -p --model opencode-zen-free/big-pickle \
  "Use the bash tool to list the files in /tmp/t, then tell me exactly how many. Do not guess - run the command."

# 类型检查 + 单测
npx tsc --noEmit
bun test
```

全绿才算完成。**如果对话返回 403，先查 `FINDINGS.md` §2 的三个条件**，不要改别的地方。

额外的人工验收（不在自动化里，因为需要真实网络与交互式 TUI）：

- 断网后仍可用，且能力参数是种子里的实测值，不是 128000/16384
- 图片模型能接收图片附件，纯文本模型被明确拒绝
- `/opencode2pi doctor` 在形状正常时报 ✅
- `/opencode2pi probe` 能区分「确定死了」与「现在不行」

---

## 6. 决策记录

### 已决策

| 决策 | 内容 |
| --- | --- |
| 间歇模型不隐藏 | `ling-3.0-flash-fin-free` 保留在列表里，上游 503 只标注不隐藏 |
| 健康只标注不隐藏 | 任何情况下都不用健康状态过滤模型列表 |
| 一次失败不判死 | 连续两次 `ModelError` 才升级 ❌；任何一次成功清零（依据 `FINDINGS.md` §8.4） |
| 地区封锁立即判死 | `REGION_BLOCKED` 对同一出口是确定性的，命中即 ❌ |
| 通道级失败不记到模型 | `SHAPE_REJECTED` / `AUTH` 交给 doctor，不污染模型状态 |
| 形状请求只有一份 | `doctor` 与健康探测共用 `src/gate.ts`，防止两者漂移后误报健康 |

### 仍未决（用户未拍板）

1. **要不要支持付费 Zen？** 当前只做免费通道。
2. **要不要做运行中出口轮换？** 宿主代理是进程内缓存，运行时改环境变量不生效，
   代价见 `FINDINGS.md` §6。建议先不做。
3. **`UNAVAILABLE` 里的两个 id 是否还该继续隐藏？** 用户要求「绝不隐藏模型」，
   当前理解为只针对健康标记；T2 阶段实测的 denylist 仍然生效。如需完全放开，改
   `src/seed.ts` 即可。