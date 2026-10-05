# PLAN — opencode2pi 实现方案

**读者**：接手实现的 AI。**先读 `docs/FINDINGS.md`**，那里的实测结论是本方案的前提，不要重复推导。

**当前状态**：`src/index.ts` 已经能跑通（见 §1）。T0 元数据契约探针已完成（见 §2）。本方案覆盖剩余工作。

---

## 0. 目标与非目标

**目标**：在 omp / pi 里以原生扩展的形式提供 OpenCode Zen 匿名免费通道，零 API key、零登录、零子进程、零本地端口。

**非目标**：
- 不做 DSH 插件（那是 `opencode2dsh` 的事，不要把它的 cordis / IP 池代码搬过来）。
- 不做付费 Zen 通道（宿主 `opencode-zen` 已内建且更好）。
- 不做 OpenAI/Anthropic 协议互转（宿主引擎已经处理）。

---

## 1. 已验证的基线（不要改坏）

`src/index.ts` 当前实现，2026-10-05 在 omp 18.6.1 上实测：

```
$ omp -e ./src/index.ts -p --model opencode-zen-free/mimo-v2.6-flash-free "Reply with exactly OK"
Working...
OK
```

| 模型 | 结果 |
| --- | --- |
| `big-pickle` | ✅ |
| `mimo-v2.5-free` | ✅ |
| `mimo-v2.6-flash-free` | ✅ |
| `nemotron-3.5-lightning-free` | ✅ |
| `ling-3.0-flash-fin-free` | ⚠️ 上游间歇 503 —— **按用户决定保留在默认列表，不隐藏** |

工具调用往返实测通过（注入的闸门桩没有劫持真实工具）。

---

## 2. T0 — 元数据契约探针（已完成）

结论见 `FINDINGS.md` §7。三条直接影响后续设计：

1. **扁平字段全部被采纳**：`contextWindow` / `maxTokens` / `cost` / `input` / `reasoning` / `thinking.efforts` 原样保留，宿主还会自动补 `Authorization`。
2. **嵌套 `limits: { context, output }` 被静默忽略**，回落到 128000/16384 且不报错。→ **必须改名映射**。
3. **静态 `models` 种子是必需的**：只有 `fetchDynamicModels` 时 `--model` 冷启动直接 `not found`。

---

## 3. 任务清单

### T1 — 能力参数自动暴露（优先级最高）

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

### T2 — 免费模型列表自动发现

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

### T3 — session id 按会话亲和

**问题**：当前 `SESSION` 是**进程级常量**，同进程内所有会话共用一个 session id。上游按 session 做 prompt cache 亲和，共用会互相污染。

**要做**：能拿到会话标识就按会话派生，拿不到就退回进程级。
- **先探测**自定义 API handler 的 `options` 里有没有会话字段（`sessionId` / `conversationId` 之类）。不要假设。
- 派生照抄 `src/index.ts` 的 `canonicalSessionID`。

**验收**：同进程内两个会话的 session id 不同；同一会话多轮之间稳定。

### T4 — 错误分类

上游错误目前原样透传，用户看到的是 `Error from provider (Console): ...`。在自定义 API handler 里包装：

| 上游形态 | 归类 | 展示 |
| --- | --- | --- |
| 403 `FreeTierError` | `SHAPE_REJECTED` | 「上游形状闸门拒绝，通常是本扩展的 bug，请提 issue」 |
| 403 `RegionError` | `REGION_BLOCKED` | 「该模型在当前网络地区不可用」（**不要**说成凭据问题） |
| 401 `ModelError` | `MODEL_GONE` | 「模型已下线」 |
| 429 | `RATE_LIMIT` | 「匿名配额按出口 IP 限流」 |
| 5xx | `UPSTREAM` | 「上游暂时不可用」 |

`RegionError` 的判定必须在 `AUTH` **之前** —— 否则地区封锁会被误报成「API key 无效」。这是 `opencode2dsh` 0.3.5 修过的同一个 bug。

### T5 — `/opencode2pi` TUI 命令（可选，非强制）

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

### T6 — 打包与分发

- `package.json` 的 `pi.extensions` / `omp.extensions` 双 manifest 已在位，确认 `pi install npm:opencode2pi` 与 `omp -e ./src/index.ts` 两条路都通。
- 补 README：**这是匿名免费通道，上游随时可能改闸门或关停**；附 `FINDINGS.md` §2 的三个条件供用户排障。
- **必须在 README 写明 `omp models` 看不到这个 provider**（`FINDINGS.md` §7.4），用 `/model` 或 `--model provider/id`。

---

## 4. 实现顺序

```
T1（能力参数）→ T2（列表发现）→ T3（session）→ T4（错误分类）
                                                          ↓
                                              T5 doctor → T6 打包
```

T5 的进阶版本（模型状态追踪）可以延后到 T6 之后。

---

## 5. 明确不要做的事

- ❌ **不要用 `pi.registerProvider` 的 `onPayload` / `prepareRequest`** —— 实测是哑字段，运行时永不触发（`FINDINGS.md` §3.1）。
- ❌ **不要引入 `createProvider` / `openaiCompletions`** —— omp 内置的 pi-ai 1.x 里没有这两个导出。
- ❌ **不要改 JSON body** —— handler 拿到的是结构化 `context`，加在 `context.tools` 上。
- ❌ **不要返回嵌套 `limits`** —— 静默失效（`FINDINGS.md` §7.2）。
- ❌ **不要只给 `fetchDynamicModels` 不给静态种子** —— 冷启动 `--model` 直接失败（§7.3）。
- ❌ **不要 spawn 子进程** —— 那是 `opencode-pi` 的路线，本项目走原生 HTTP。
- ❌ **不要移植 `opencode2dsh` 的 IP 池** —— 宿主已有 `PI_PROXY_<PROVIDER>`，且进程内缓存导致运行时轮换不可行（`FINDINGS.md` §6）。
- ❌ **不要照抄 DSH 侧的重试策略** —— 匿名通道重试轰炸会挤掉自己的配额。

---

## 6. 每一步都必须重跑的验证

```sh
cd C:/Users/guyue/code/opencode2pi

# 冒烟：基础对话
omp -e ./src/index.ts -p --model opencode-zen-free/mimo-v2.6-flash-free "Reply with exactly OK"
# 期望：输出恰好 OK

# 工具往返：闸门桩不能劫持真实工具
mkdir -p /tmp/t && touch /tmp/t/a.txt /tmp/t/b.txt /tmp/t/c.txt
omp -e ./src/index.ts -p --model opencode-zen-free/big-pickle \
  "Use the bash tool to list the files in /tmp/t, then tell me exactly how many. Do not guess - run the command."
# 期望：3

# 类型检查
npx tsc --noEmit
```

三条全绿才算完成。**如果对话返回 403，先查 `FINDINGS.md` §2 的三个条件**，不要改别的地方。

---

## 7. 已决策 / 待决策

**已决策**：
- `ling-3.0-flash-fin-free` **保留**在默认列表，不隐藏。

**待用户拍板**：
1. 要不要支持付费 Zen？当前只做免费通道。
2. 要不要做运行中出口轮换？代价见 `FINDINGS.md` §6，建议先不做。