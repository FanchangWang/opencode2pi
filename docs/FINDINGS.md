# FINDINGS — 实测结论，不要重新推导

本文件的每一条都是**实际跑出来的**，不是从文档推的。重新验证的成本很高（需要抓包级对比 + 反复试 upstream gate），接手前请完整读完。

验证环境：`omp 18.6.1`（`C:\Users\guyue\AppData\Local\omp\omp.exe`），Windows，走 `http://192.168.31.50:7890` 代理。日期：**2026-10-05**。

---

## 1. 匿名免费通道现在可用（关键前提）

`https://opencode.ai/zen/v1` 的免key 通道**没有被关闭**。早期 pi 生态里`pi-opencode-zen` 在 2026-09-23 宣布「免费层已对非官方客户端关闭」，**这个结论是错的**——它只是没解开下面的形状闸门。

> 反例教训：我第一版探针因为 session id 格式非法 + 没用插件自己的请求构造，测出全量 403，差点得出「上游已封、这个项目没救了」的结论。**任何"上游关停了"的判断都必须用正确形状复测一遍。**

## 2. 上游闸门的三个必要条件

全部经实测确认。**三个缺一即 403 `FreeTierError`**：

| # | 条件 | 违反时的报错 |
| --- | --- | --- |
| 1 | `Authorization: Bearer public`（字面量 `public`） | 401 |
| 2 | 规范 session id：`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`（12 hex + 14 base62 = 26 字符总长） | `MissingSessionID` / 403 |
| 3 | **agent 形态 body**：`stream: true` **且** `tools` 里同时有 `bash` 和 `read` | 403 FreeTierError |

条件 3 有**两个独立的部分**，只满足一半仍然403：

```
stream:true  + tools:[bash,read]  →  200 ✅
stream:false + tools:[bash,read]  →  403 FreeTierError   ← 非流式一律被拒
stream:true  + 无 tools            →  403 FreeTierError
```

完整实测矩阵（CLI 同形头 + 规范 session id）：

| 模型 | stream=true | stream=false |
| --- | --- | --- |
| `big-pickle` | ✅ 200 | 403 |
| `mimo-v2.5-free` | ✅ 200 | 403 |
| `mimo-v2.6-flash-free` | ✅ 200 | 403 |
| `nemotron-3.5-lightning-free` | ✅ 200 | 403 |
| `ling-3.0-flash-fin-free` | 空响应 / 503 | 403 |
| `nemotron-3.ultra-free` | 401 `ModelError: not supported` | 401 |
| `muse-spark-1.2-contributor-free` | 403 `RegionError: not available in your country` | 403 |

注意最后两行：**`RegionError`（地区封锁）和 `FreeTierError`（形状闸门）是两回事**，错误分类必须分开，否则会把地区问题误报成凭据问题。

## 3. omp 扩展 API 的实测行为

### 3.1 `pi.registerProvider` 的 `onPayload` / `prepareRequest` 是哑字段

传这两个字段**不会报错**，但**运行时永远不会被调用**。实测：注册成功、模型出现在选择器、真实请求发出，日志里`onPayload` 一次都没触发，请求原样发出 → 403。

> **不要用这两个字段。** 这是本项目第一版的失败点，也是最容易浪费时间的坑。

### 3.2 真正的接缝是 `registerCustomApi`

从 omp 内置的 pi-ai 里反解出的签名：

```ts
registerCustomApi(apiId: string, streamSimple: Fn, sourceId: string, stream?: Fn): void
// arity = 4；`stream` 省略时降级为 (model, ctx, opts) => streamSimple(model, ctx, opts)
```

- `streamSimple` 的入参是 `(model, context, options)`；
- `context` 是**结构化对象**（`systemPrompt` / `messages` / `tools` / `toolChoice`），**不是序列化 body**。所以闸门要加在 `context.tools` 上，而不是改 JSON 字符串。
- 委托宿主引擎时必须把 `model.api` 换回 `'openai-completions'`，否则会递归回自己的 handler。

工作实现见 `src/index.ts` 的 `registerCustomApi(...)` 与 `withGateTools(...)`。

### 3.3 omp 内置的 pi-ai 是 1.x，API 面与 opencode2dsh 依赖的不同

`opencode2dsh` 锁的是 `@earendil-works/pi-ai@^0.82.1`，用 `createProvider()` + `openaiCompletions`。**omp 内置的版本里这两个导出已经不存在**（已核对 307 个导出）：

- ❌ 没有：`createProvider`、`openaiCompletions`
- ✅ 有：`streamSimple`、`streamSimpleOpenAIResponses`、`registerCustomApi`、`getCustomApi`、`clearCustomApis`、`AssistantMessageEventStream`

结论：**DSH 那套写法不能照搬**，必须走 `registerCustomApi` + 宿主引擎委托。

### 3.4 import 说明符

`@earendil-works/*` 会被 omp 的 legacy-pi compat shim 改写到宿主内置副本，实测可用。宿主类型包是 `@oh-my-pi/pi-coding-agent`（仅类型，运行时会被擦除）。

### 3.5 命令行细节

- `--provider <id>` 在扩展加载前就做校验，会报 `Unknown provider`。扩展注册的 provider 必须用 `--model <provider>/<model>` 形式指定。
- `-e <path>` 支持绝对路径与相对路径。

## 4. 可用的现成扩展：全部不可用，但原因各不相同

pi生态里已有4 个相关包，**没有一个能直接用**：

| 包 | 为什么不能用 |
| --- | --- |
| `pi-opencode-zen` (feng-h) | 只做了 session id，**没做 stream + bash/read 闸门** → 403。作者宣布的「cannot be bypassed by any headers or client emulation」是**错误结论**。已 DEPRECATED。 |
| `pi-opencode-free` (pedroalexis) | 只发 `x-opencode-client` / `x-opencode-project` / `User-Agent`，README 声称「这就授权了 free keyless usage」——**缺规范 session id 和闸门工具** → 同样 403。 |
| `Danu28/opencode-zen` | 自称 CLI 形状头，**缺闸门**。 |
| `pi-opencode-provider` (mdsitton) | 目标不同：要 **paid key**，只是把模型目录改成运行时发现。不解决免费层。 |

**唯一架构上真正不同、可能仍存活**的是 `opencode-pi` (luongnv89)：它 spawn 真实 `opencode` CLI 子进程，不碰公开端点，因此不受闸门影响。代价是每轮起进程、工具调用靠 prompt marker桥接。未实测。

## 5. 宿主内建的能力清单（不要重复造轮子）

| 能力 | 来源 |
| --- | --- |
| 流式引擎、tool call 分片聚合、usage 归并 | 宿主 `openai-completions` 引擎 |
| 内建 `opencode-zen` / `opencode-go` provider | 需付费 `OPENCODE_API_KEY`，走 `X-Api-Key` 而非 Bearer |
| 多协议路由 `createOpenCodeApiResolution` | 宿主已处理 muse-spark → Responses |
| 代理 | `PI_PROXY` / `PI_PROXY_<PROVIDER>`，**进程生命周期内缓存** |

## 6. IP 池的移植约束

`opencode2dsh` 的 IP 池（`src/pool/*`，约 2000 行）对抗的是「匿名配额按出口 IP 限流」。移植到 omp 时：

- omp 的 provider 代理查找**进程内缓存**，运行时改环境变量**不会**生效；
- 要做运行中轮换，只能自己接管 fetch / 用 `registerCustomApi` 里持有的 transport；
- 宿主已支持 `NO_PROXY` 与私网/回环豁免，不要破坏。

---

## 7. 扩展 provider 的模型元数据契约（2026-10-05 实测）

方法：注册一个 provider，`fetchDynamicModels` 返回带特征值的假模型（`contextWindow: 999999` 等），在自定义 API handler 里把**宿主解析后的 model 对象**dump 出来比对。

### 7.1 被采纳的字段（扁平形式，全部原样保留）

```ts
fetchDynamicModels: async () => [{
  id: 'probe-alpha',
  name: 'Probe Alpha',
  contextWindow: 999_999,             // ✅ 原样采纳
  maxTokens: 12_345,                  // ✅ 原样采纳
  cost: { input: 7.5, output: 9.25 },// ✅ 原样采纳
  input: ['text', 'image'],           // ✅ 采纳 → 图片输入放行
  reasoning: true,                    // ✅ 采纳，并派生 thinking
}]
```

宿主解析后的对象：

```json
{
  "contextWindow": 999999,
  "maxTokens": 12345,
  "cost": { "input": 7.5, "output": 9.25 },
  "input": ["text", "image"],
  "reasoning": true,
  "thinking": { "mode": "effort", "efforts": ["minimal","low","medium","high"] }
}
```

`thinking.efforts` 显式声明时按声明保留（实测 `['off','low','high']` 原样通过）；只给 `reasoning: true` 时宿主自动派生 `mode: 'effort'` + 四档默认 effort。

### 7.2 嵌套 `limits` 形式被静默忽略 ⚠️

```ts
{ id: 'probe-beta', limits: { context: 888_888, output: 8_888 } }  // ❌ 无效
```

解析结果回落到宿主通用默认值，且**没有任何报错或告警**：

```json
{ "contextWindow": 128000, "maxTokens": 16384 }
```

models.dev 的原始字段名是 `limit.context` / `limit.output`，所以**必须显式改名映射**为 `contextWindow` / `maxTokens`。直接透传 models.dev 的形状会让 omp 拿到偏小的默认值 —— 这正是「模型能力没暴露就静默用默认值」的失败模式。

### 7.3 静态 `models` 种子是必需的

只提供 `fetchDynamicModels` 而不给静态 `models` 列表时：

```
$ omp -e ./probe.ts -p --model zen-fieldprobe/probe-alpha "hi"
Model "zen-fieldprobe/probe-alpha" not found     ← 0.6s 内直接失败
```

加上 `models: [PROBE_ALPHA, PROBE_BETA]` 静态种子后同一命令正常发出请求。

即：**异步发现的结果在冷启动时来不及参与 `--model` 解析。** 扩展必须同时提供静态种子列表，动态发现只负责更新它。这与内建 `opencode-go` 的 `dynamicModelsAuthoritative: true` + 捆绑 seed 是同一套机制。

### 7.4 `omp models` CLI 不列出扩展 provider

```
$ omp models -e ./probe.ts
agnes (2) ...
opencode-zen (112) ...
```

扩展注册的 provider 完全不出现（带 apiKey 与 `auth: 'none'` 两种情况都试过）。但 `/model` 选择器和 `--model provider/id` 都能正常解析并使用。

后果：**用户不能用 `omp models` 查这个 provider 的清单**，`--provider` 也会报 `Unknown provider`。这是可用性上的真实短板，也说明 T3（`/opencode2pi` 命令）有实际价值。

### 7.5 宿主自动注入 Authorization

`apiKey: 'public'` + `authHeader: true` 时，宿主自动把凭据加进请求头，扩展不需要自己拼：

```json
"headers": {
  "x-opencode-client": "cli",
  "x-opencode-session": "ses_0123456789abABCDEFGHIJKLMN",
  "Authorization": "Bearer public"
}
```

扩展 `headers` 里写的内容会被保留并与之合并。

---

## 8. 实现期新增的实测结论（2026-10-05，T2–T5）

### 8.1 models.dev `opencode` provider 的字段形状

免费判定和能力映射都靠它。关键点：

```jsonc
{
  "limit": { "context": 200000, "output": 32000 },
  "cost":  { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0 },
  "modalities": { "input": ["text", "image", "audio", "video"] },
  "reasoning": true,
  "reasoning_options": [],
  "deprecated": null
}
```

`limit.context` / `limit.output` 必须改名映射成 `contextWindow` / `maxTokens`，
原因见 §7.2。

`reasoning_options` 是**数组**，形态不止一种，只有第一种能映射到宿主的 `thinking.efforts`：

| 形态 | 处理 |
| --- | --- |
| `{type:'effort', values:[...]}` | → `thinking.efforts`；宿主只认 `minimal/low/medium/high/xhigh/max`，其余必须过滤 |
| `{type:'toggle'}` | 不给 `thinking`，让宿主从 `reasoning:true` 派生。给空数组会违反宿主契约 |
| `{type:'budget_tokens', ...}` | 同上 |

### 8.2 免费池的真实规模：必须和实时列表求交集

```
Zen /v1/models 在售          86
models.dev 里 0 元           36
两者交集（真正的免费池）      13
```

**只看价格会多出 23 个已下架的 id。**「在售」必须由 S1 提供，元数据只负责判免费。
另有 `jev-1.13-free` 在售但 models.dev 完全没有条目 —— 这是「元数据缺失时回退名字启发式」
的真实用例，不是理论构造。

### 8.3 宿主 `options.sessionId` 确实存在（dump 实测）

dump 自定义 API handler 的运行时 `options`：

```
sessionId       = "01a10bfe-9111-744a-8200-d1d09389c7f7"
metadata.user_id = {"session_id":"01a10bfe-9111-744a-8200-d1d09389c7f7"}
fetch           = [function]
```

两个字段**都不在**发布的 `SimpleStreamOptions` 类型里，只能运行时收窄读取。
`context.tools` 实测已包含宿主的真实 `bash` / `read`，所以闸门桩在正常路径上是 no-op。

### 8.4 `401 ModelError` 在这条通道上会翻转

逐模型探测实测（同一分钟内的两次独立请求）：

```
nemotron-3.ultra-free   第一次  HTTP 401 ModelError
nemotron-3.ultra-free   第二次  HTTP 200
```

**所以「一次 ModelError 即判定模型已死」是错的**，会把能用的模型划掉。
必须连续两次才升级，且任何一次成功清零。同一批探测还确认了
`deepseek-v4-flash-free` 稳定 400（opencode2dsh 当年留下的那个确实已死），
`muse-spark-1.3-contributor-free` 是 `403 RegionError`。

### 8.5 `Endpoint is unavailable` 同时表示 400 和 5xx

给只支持文本的模型发图片，上游返回的是：

```
400 ... Upstream request failed: Endpoint is unavailable.
```

而上游真故障时也可能是同一句话，只是状态码不同。**必须以状态码判别**，
否则会把「这个请求永远不可能成功」误报成「稍后重试」。

### 8.6 打包与分发

- pi 与 omp **都从 npm 解析扩展**，一次 `npm publish` 同时服务两边；pi.dev 的包目录是索引 npm，没有独立 registry
- npm 上带 `pi-package` keyword 才进 pi 的包目录
- 宿主包（`@earendil-works/pi-ai`）必须声明为 `peerDependencies` 且**不能打包进去** —— 物理副本会绕过宿主的模块映射，制造重复的 registry 实例
- 实测 `omp install .` 后**不带 `-e`** 也能加载并正常对话