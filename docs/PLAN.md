# PLAN — opencode2pi 实现方案

**读者**：接手实现的 AI。**先读 `docs/FINDINGS.md`**，那里的实测结论是本方案的前提，不要重复推导。

**当前状态**：`src/index.ts` 已经能跑通（见下方「已验证」）。本方案覆盖的是从「最小可用」到「可发布」的剩余工作。

---

## 0. 目标与非目标

**目标**：在 omp / pi 里以原生扩展的形式提供 OpenCode Zen 匿名免费通道，零 API key、零登录、零子进程、零本地端口。

**非目标**：
- 不做 DSH 插件（那是 `opencode2dsh` 的事，不要把它的 cordis/IP 池代码搬过来）。
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
| `ling-3.0-flash-fin-free` | ⚠️ 上游 503 间歇 |

工具调用往返实测通过：让模型用 bash 列目录并报数，返回正确（`a.txt b.txt c.txt` → `3 files`），注入的闸门桩没有劫持真实工具。

**改任何东西之后，必须重跑这两条验证**（见 §5）。

---

## 2. 任务清单

### T1 — 模型目录动态发现（替换静态列表）

**问题**：当前 `FREE_MODELS` 是 7 个静态 id。免费池轮换频繁，静态列表必然过期。

**要做**：把 `opencode2dsh/src/adapter/catalog.ts` 的三级回退链移植到 `fetchDynamicModels`：

```
S1  GET {zen}/v1/models              → 实时在售 id 集合
S2  GET https://models.dev/api.json  → 定价元数据 → 免费判定
S3  FREE_MODELS 静态兜底（已验证可用）
```

免费判定规则（照抄 `catalog.ts` 的 `decide`，注意**顺序**）：
- 元数据就绪时，**元数据判定永远优先**（含 `deprecated` → 拒绝）；
- 只有元数据不可用（pending / 该 model 缺失）时，才回退到名字启发式 `id.includes('free')`；
- S3 静态名单里的 `big-pickle` 不含 `free` 字样，靠元数据判定；元数据不可用时它会被名字兜底漏掉 —— 需要给静态名单单独打一个 `verified: true` 标记让它无条件放行。

**约束**：
- `fetchDynamicModels` 有 **15 秒硬超时**（宿主 `RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS`），且默认 **24 小时 TTL** 缓存。两级网络请求（Zen + models.dev）必须并发，不能串行。
- models.dev 响应很大（7MB量级），只取需要的字段，不要整份留在内存里。
- 返回给宿主的模型对象需要 `id` / `name` / `reasoning` / `input`。`input` 决定图片附件是否放行 —— models.dev 的 `modalities.input` 含 `image` 才放行，否则退回 `['text']`。

**验收**：
1. 临时把网络断掉，`fetchDynamicModels` 仍返回 5 个静态模型（走 S3）。
2. `GET /zen/v1/models` 返回的付费模型（如 `claude-opus-5`）**不出现在**最终列表里。
3. 断网 → 恢复后，列表能刷新出新模型。

### T2 — 错误分类

**问题**：宿主会把上游错误直接透传，用户看到 `Error from provider (Console): ...` 这种无信息量的文本。

**要做**：在自定义 API handler 里包装错误，至少区分这几类（依据 `FINDINGS.md` §2 的实测表）：

| 上游形态 | 归类 | 展示给用户 |
| --- | --- | --- |
| 403 `FreeTierError` | `SHAPE_REJECTED` | 「上游形状闸门拒绝，通常意味着闸门条件被破坏 —— 这是 bug，请提issue」 |
| 403 `RegionError` | `REGION_BLOCKED` | 「该模型在当前网络地区不可用」（**不要**说成凭据问题） |
| 401 `ModelError` | `MODEL_GONE` | 「模型已下线」 |
| 401 / 403 其他 | `AUTH` | 匿名通道理论上不该出现 |
| 429 | `RATE_LIMIT` | 「匿名配额按出口 IP 限流」 |
| 5xx | `UPSTREAM` | 「上游暂时不可用」 |

注意：`RegionError` 的判定必须在 `AUTH` **之前**，否则地区封锁会被误报成「API key 无效」。这是 `opencode2dsh` 0.3.5 修过的同一个 bug。

**验收**：用一个已知会触发 `RegionError` 的模型（`muse-spark-1.2-contributor-free`，手动指定测试）观察输出文案。

### T3 — session id 亲和性

**问题**：当前 `SESSION` 是**进程级常量**，同一个进程内所有会话共用一个 session id。上游按 session 做 prompt cache 亲和，共用会互相污染。

**要做**：能拿到会话标识就按会话派生，拿不到就退回进程级。
- 先确认自定义 API handler 的 `options` 里有没有会话 id（`sessionId` / `conversationId` 之类）。**先探测再写代码**，不要假设。
- 派生方式照抄 `opencode2dsh/src/adapter/ids.ts` 的 `canonicalSessionID`：对信号做 SHA-256，取前 12字节 hex 作时间部分，后 10 字节转 14 位 base62。

**验收**：同一进程内开两个会话抓包，两个 session id 不同；同一会话多轮之间 session id 稳定。

### T4 — 打包与分发

**要做**：
- `package.json` 已有 `pi.extensions` / `omp.extensions` 双 manifest，确认 `pi install npm:opencode2pi` 与 `omp -e ./src/index.ts` 两条路都通。
- `pi.dev` 包页面（`https://pi.dev/packages`）能收录：需要 `description`、仓库链接、许可证。
- 补 `.npmignore` 或确认 `files` 字段只发 `src/`（这个包零依赖，很小）。
- README 要写清楚**这是匿名免费通道，上游随时可能改闸门或关停**，并附上 `FINDINGS.md` §2 的三个条件，方便用户自行排障。

**验收**：干净profile 里 `pi install` 后 `/model` 能看到 `opencode-zen-free` 分组。

### T5 — 单元测试

宿主自带 `bun test`。至少覆盖：

1. `canonicalSessionID` —— 输出**永远**匹配 `/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/`；已是规范格式的输入原样透传。
2. `withGateTools` —— 空 tools 时注入 `bash`+`read` 且 `toolChoice === 'none'`；已有同名工具时不重复注入；宿主有工具时 `toolChoice` 保持原值不被覆盖。
3. 静态目录里的每个 id 都在 `UNAVAILABLE` 之外。
4. models.dev 解析：`cost=0 && !deprecated` → 免费；`deprecated` → 拒绝；缺失 → 走名字兜底。**顺序要测到**，这是最容易写反的地方。

不要为「转发是否发生」这类接线行为写测试 —— 那是 throwaway script 的活。

---

## 3. 实现顺序建议

```
T5 的 1、2 两项（纯函数测试）
   ↓
T3（先探测 options 里的会话字段）
   ↓
T1（目录发现，最大的一块）
   ↓
T2（错误分类）
   ↓
T4（打包）+ T5 剩余
```

T1 是唯一有真实设计难度的；其余都是机械工作。

---

## 4. 明确不要做的事

- ❌ **不要用 `pi.registerProvider` 的 `onPayload` / `prepareRequest`** —— 实测是哑字段，运行时永不触发（`FINDINGS.md` §3.1）。
- ❌ **不要引入 `createProvider` / `openaiCompletions`** —— omp 内置的 pi-ai 1.x 里没有这两个导出。
- ❌ **不要改 JSON body** —— handler 拿到的是结构化 `context`，加在 `context.tools` 上。
- ❌ **不要 spawn 子进程** —— 那是 `opencode-pi` 的路线，本项目走原生 HTTP，零进程。
- ❌ **不要移植 `opencode2dsh` 的 IP 池** —— 除非用户明确要求；宿主已有 `PI_PROXY_<PROVIDER>`，且进程内缓存导致运行时轮换不可行（`FINDINGS.md` §6）。
- ❌ **不要照抄 DSH 侧的错误重试策略** —— 匿名通道重试轰炸会挤掉自己的配额。

---

## 5. 每一步都必须重跑的验证

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

## 6. 需要用户拍板的决策点

1. **要不要支持付费 Zen？** 当前只做免费通道。宿主 `opencode-zen` 已内建付费支持，但如果要做「免费 + 付费统一入口」需要额外设计。
2. **要不要做运行中出口轮换？** 代价见 `FINDINGS.md` §6 —— 要自己接管 transport，且实现复杂度远超收益。建议先不做，用户抱怨限流再说。
3. **`ling-3.0-flash-fin-free` 留不留？** 实测上游 503 间歇，留在默认列表里会让用户以为是自己配错了。建议移到可选列表。