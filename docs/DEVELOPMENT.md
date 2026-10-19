# 开发文档

面向要改这个扩展的人。**只想用它，请看 [README](../README.md)。**

前置阅读：[`FINDINGS.md`](FINDINGS.md) 里的实测结论是本文件所有设计的前提，不要重复推导。

---

## 1. 上游闸门：三个必要条件

Zen 的匿名通道不靠凭据鉴权，而是**请求形状校验**。三个条件缺一即 `403 FreeTierError`：

| # | 条件 | 违反时的报错 |
| --- | --- | --- |
| 1 | `Authorization: Bearer public`（字面量） | 401 |
| 2 | 规范 session id `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`，且 12 位 hex 布局须被校验（低 12 位解码为逐毫秒计数器 ∈ `[1, 63]`，见下） | `MissingSessionID` / 403 |
| 3 | agent 形态 body：`stream: true` **且** `tools` 满足双通道形状之一 —— legacy `/zen/v1`：**单 `read` 工具**（定义不校验）；`/inference`：同时含 `shell` 和 `read`（**真实 OpenCode 定义**，stub 被 403） | 403 FreeTierError |

条件 3 有**两个独立部分**，只满足一半照样 403：

```
stream:true  + 双通道任一工具形状  →  200 ✅
stream:false + 工具形状正确         →  403
stream:true  + 无 tools             →  403
```

条件 2 的 hex 段带**布局校验**（上游 2026-10-13 新增，opencode2dsh #62/#65；
2026-10-15 起改用确定性重编码，opencode2api #70）：低 12 位解码为逐毫秒
计数器、只接受 `[1, 63]`（线上 hex 低 12 位 ∈ `[0xFC0, 0xFFF]`）。铸 id 的
逻辑在 `src/session.ts`（`descendingTimePart`），机制与矩阵见 FINDINGS
§2.3/§2.4。

2026-10-14 起匿名通道迁至 `/inference`、工具名 `bash` → `shell` 且校验定义
（stub 403），见 FINDINGS §2.4；**2026-10-17 上游恢复双通道**（opencode2api
v1.4.1）：优先 legacy `/zen/v1`，`/inference` 作 fallback。**2026-10-19 同步
opencode2api v1.4.2**（FINDINGS §2.8）：legacy 改发 1.19.3 形状（单 read 工具、
裸 40-hex project、`opencode/1.19.3 ai-sdk/.../runtime/bun/1.3.14` UA、两个
会话头 + `msg_` 形状的 `x-opencode-request`），`/inference` 改发 2.0.32 形状
（UA `opencode/latest/2.0.32/cli`，shell 定义换成官方 Linux/bash 版）。双通道
形状中心在 `src/lanes.ts`：当前 lane 状态
（`currentLane`/`setCurrentLane`）也在那里，health 探针与真实路径共用；
请求 403 → `findHealthyLane(model.id)` 双通道探测 → 重注册（60s 冷却），因为
`model.baseUrl` / `options.fetch` 在注册期后就不可改（FINDINGS §2.5）。
`src/gate.ts` 的 `sendGateProbe(modelId, lane)` 按 lane 发同形探针，`doctor`
与健康探测共用同一份。完整模型矩阵见 [`FINDINGS.md`](FINDINGS.md) §2。
**注意 `RegionError`（地区封锁）和 `FreeTierError`（形状闸门）是两回事**，
错误分类必须分开。

---

## 2. 宿主 API 的实测行为

> 全部来自 omp 18.6.1 实测，**不要凭直觉假设**。

### 2.1 `onPayload` / `prepareRequest` 是哑字段

`pi.registerProvider` 接受这两个字段**不报错**，但**运行时永远不会被调用**。
注册成功、模型出现在选择器、请求照发，日志里一次都不触发 → 403。

### 2.2 真正的接缝是 `registerCustomApi`

```ts
registerCustomApi(apiId: string, streamSimple: Fn, sourceId: string, stream?: Fn): void
```

- `context` 是**结构化对象**（`systemPrompt` / `messages` / `tools` / `inactiveTools`），
  **不是序列化 body**。闸门要加在 `context.tools` 上，不要改 JSON 字符串。
- 委托宿主引擎时必须把 `model.api` 换回 `'openai-completions'`，否则会递归回自己的 handler。

### 2.3 统一注册路径：只用 `pi.registerProvider`

**不要**在模块顶层调用 `registerCustomApi`。它只存在于 omp；pi 1.3.0 根本没有这个
API，顶层调用会让 pi 启动即崩（`(0, _piAi.registerCustomApi) is not a function`）。

两个宿主唯一都接受的接缝是 provider 注册里的 `streamSimple`：

```ts
pi.registerProvider(name, {
  baseUrl, api: API_ID, apiKey: 'public', authHeader: true,
  headers, models, streamSimple,
})
```

omp 的 registry 会在内部转发到 `registerCustomApi`
（`src/config/model-registry.ts:3453-3476`），所以这一条路径同时覆盖两侧。

### 2.4 宿主类型从哪来

宿主在运行时把 `@earendil-works/*` 改写到它**内建**的 pi-ai 副本（legacy-pi compat shim）。
类型包用 `@oh-my-pi/pi-coding-agent`，版本要和 omp 对齐（本项目锁 `18.6.1`）。

**npm 上那个同名的 `@earendil-works/pi-ai` 是个更早的构建，没有 `registerCustomApi`，
故意不装** —— 装了反而会把类型指向一个宿主根本没有的 API 面。`src/host.d.ts` 把
说明写在了声明旁边。

### 2.5 pi 会覆盖 `x-opencode-session`（2026-10-17 实测，最容易复发的一条）

只要 provider 的 `baseUrl` 是 `opencode.ai`，pi 就把它当成自己的 provider：

- `core/provider-attribution.ts:67-77` 从 `transformHeaders` 钩子塞上
  **它自己的** session id 和 `x-opencode-client: pi`；
- 该钩子在 model headers 解析**之后**运行，且合并顺序把宿主的值放在**最后**
  （`core/sdk.ts:354-364`）。

后果：只把 session 头挂在 `model.headers` 上会被静默替换成 pi 的 UUID，而上游闸门读
`x-opencode-session` 要求规范 `ses_...` 布局，于是返回裸 `FreeTierError`。
**同一请求在 omp 通过、在 pi 被拒**——差别只在这里。

修法是同一个 session 头**同时**挂到 `options.headers`：那一层会作为 `requestHeaders`
传给归属钩子，而钩子最后才 apply 它，所以我们的值赢（omp 无此钩子，两层都发即可）。
回归测试见 `test/session-headers.test.ts`。

### 2.6 容易踩的契约细节

| 细节 | 结论 |
| --- | --- |
| `toolChoice` 在哪 | 在 **`StreamOptions`** 上，不在 context 上。设在 context 里是静默 no-op |
| omp 的 `context` | 结构化对象（`systemPrompt` / `messages` / `tools` / `inactiveTools`） |
| pi 的 `context` | 是 **transcript**：prompt 和工具声明在 leading system message 里，要用 `getCurrentTools` 读出、`toolsAdded` 写回 |
| pi 的 `select` | 只吃 `string[]`，description 要折进 label 再在返回时匹配回 label |
| pi 的流 | 没有 `fail()`，终止只能 `end()` |
| pi 的错误 | 没有 `errorStatus`，HTTP 状态折进文本 `"<status>: <body>"`，分类只能靠 marker |
| pi 有 `logger` 吗 | **没有**。omp 有、pi 没有，所以 `'logger' in pi` 就是宿主判别信号 |

`SessionOptions.sessionId` 运行时存在（实测 UUID），但**不在**发布的类型里，
所以用运行时收窄读取，不要 `as` 断言。

分层规则（只有 `src/host/` 能出现宿主包名）由 `test/host-boundary.test.ts` 断言。

---

## 3. 模块地图

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | provider 注册（可重写）、闸门形状补全、错误流转发、命令注册 |
| `src/request.ts` | 请求路径本身（两端宿主完全相同）：工具集闸门整形、session id 上头、出口池挂 `options.fetch`、流转发与失败改写、闸门被拒时重探 lane |
| `src/host/contract.ts` | 宿主边界：扩展需要运行时提供的全部能力，用**两边都不认**的术语表达（`StreamEngine` / `ModelSpec` / …） |
| `src/host/omp.ts` | omp 适配：`registerCustomApi` 之外的形状差异（Context 分离字段、`ui.select` 的 `{label,description}`、`errorStatus` 数字字段） |
| `src/host/pi.ts` | pi 适配：从 system message 里回放工具声明、字符串版 `ui.select`、从消息文本里解析状态码 |
| `src/transport.ts` | 代理机制**按运行时选**（Bun 的 `init.proxy` / Node 的 undici `ProxyAgent`），屏检与真实请求共用同一份 transport |
| `src/seed.ts` | 静态种子（冷启动必需）+ 已知失效 id |
| `src/metadata.ts` | models.dev → 宿主扁平模型契约；免费判定 |
| `src/discovery.ts` | 三级发现阶梯、并发、15s 预算、落盘缓存 |
| `src/session.ts` | 按会话派生 session id |
| `src/errors.ts` | 上游失败分类 |
| `src/gate.ts` | **共享**的闸门形状请求（doctor 与健康探测共用同一份）+ `findHealthyLane` 双通道选择 |
| `src/lanes.ts` | 双通道形状中心：legacy `/zen/v1` 与 `/inference` 的 headers/sessionHeaders/gateTools，当前 lane 状态 |
| `src/doctor.ts` | 闸门自检 |
| `src/health.ts` | 逐模型探测、判定规则、落盘缓存 |
| `src/filters.ts` | 用户选择的隐藏规则、落盘与派生隐藏集 |
| `src/store.ts` | 数据目录与读写：四处散落的 `tmpdir()` 拼接集中在这里；`OPENCODE2PI_DATA_DIR` 覆盖（测试用） |
| `src/exits.ts` | `exits.txt` 的文法：解析/拒绝原因/写回/凭据脱敏 |
| `src/sources.ts` | 内置免费代理源（18 条，**不分档**）与地址行解析 |
| `src/pool.ts` | 出口池状态：开关、选中出口、证据落盘、`poolFetch` 包装器、被动标记 |
| `src/prefilter.ts` | 隧道预筛：每地址一次 CONNECT，2s 硬预算（覆盖 DNS 与连接），不消耗推理配额 |
| `src/pool-probe.ts` | 预筛 → 屏检（cloudflare trace，5s 预算 + S/A/B/C 分级）、闸门探测、完成探测、内置源补充（合并取源 + 1 小时源缓存 + 源开关） |
| `src/pool-cmd.ts` | `/opencode2pi pool` 的八项 TUI 菜单与六项动作（选自定义 / 选已扫描内置 / 扫描内置 / 删除 / 设置免费源 / 清空内置结果），以及「开启出口池」在无选中出口时的三分叉 |
| `src/commands.ts` | `/opencode2pi` 五条命令（doctor/status/probe/filter/pool）与 TUI |

> `gate.ts` 单独存在是有原因的：如果 doctor 和健康探测各写一份形状，两者一旦漂移，
> doctor 会报「闸门正常」而真实路径已经失效 —— 那正是这段代码唯一要抓的故障。

> **`src/host/` 之下不许出现宿主包名**。共享层（`lanes`、`gate`、`pool`、…）只跟
> `contract.ts` 的接口说话，具体某个宿主怎么拼写由适配器独家承担。这是双宿主能共用
> 一条代码路径的前提，也是 `test/host-boundary.test.ts` 盯着的东西。

---

## 4. 关键设计决策

### 4.1 静态种子是必需的

只提供 `fetchDynamicModels` 而没有静态 `models` 时，冷启动 `--model` 直接
`Model "..." not found`（0.6s 内失败）。异步发现来不及参与 `--model` 解析。

所以 `models: [...SEED_MODELS]` 必须静态给出，动态发现只负责更新它。

### 4.2 免费判定顺序（最容易写反）

1. 已知实测失效的 id → 永不发布（它们在 models.dev 里也是 0 元，只看价格会被重新放进列表）
2. `deprecated` → 否决，**包括名字里带 `free` 的**
3. 已实测可用的 id → 无条件放行（`big-pickle` 名字里没有 `free`）
4. **元数据完整 → 元数据判定优先**
5. 元数据缺失/不完整 → 才回退到名字启发式 `id.includes('free')`

第 4 条为什么重要：opencode2dsh 明确记录过 `deepseek-v4-flash-free` 因为「先判名字」
而永远留在列表里，尽管上游早已拒绝它。

### 4.3 能力参数必须显式默认

缺失字段落到保守默认值**并写日志**，理由就是不能复现 §2.4 那个静默失效。
`maxTokens` 还会被夹到 `contextWindow` 以内。

### 4.4 健康判定：一次失败不判死

实测 `nemotron-3.ultra-free` **一分钟内先 `401 ModelError`、再 `200`**。所以：

- 一次 `MODEL_GONE` 只标 ⚠️，**连续两次**才升级 ❌
- 任何一次成功清零计数
- `REGION_BLOCKED` 对同一出口是确定性的，命中即 ❌
- 通道级失败（`SHAPE_REJECTED` / `AUTH`）**不记到模型头上** —— 那是全 roster 的问题，不是某个模型的
- `RATE_LIMIT` 和 transport 超时同样**不是模型判定**，标 🚧「配额受限」

### 4.4.1 429 是按模型计费，不是按 IP

实测 2026-10-06：串行探测（并发 1、间隔 1.5s）时 `big-pickle` 返回 200，
同一次运行里 `ling-3.1-flash-free` / `longcat-2.5-preview-free` 返回 429。
所以 429 说的不是「这个出口被打爆了」，而是「这个 id 的匿名额度用完了」——
把它算成模型不稳定是**归错因**。

同一个模型连续失败 10 次且每次响应完全一致（实测 `muse-spark-1.3-contributor-free`
恒 403；2026-10-11 又测出 `exo-free` / `jev-1.13-free` / `ling-3.0-flash-fin-free`
三个恒 3/3 被拒，已据此进 denylist，见 `FINDINGS.md` §2.2），
那是稳定的坏，不是抖动。真正会翻转的只有 429 额度和上线初期那种 401→200
（已下线，见 `FINDINGS.md` §2.1）。展示层把前者和后者画成同一个 ⚠️，
才让通道显得不稳定。

探测本身也会烧配额：一次全扫是十几个请求，打成突发会把下一轮自己的额度吃掉。
所以 `PROBE_CONCURRENCY` 是 2，每发一个请求后停 500ms。这**缓解**自伤，
治不了 429 —— 429 本来就是按模型计的。

### 4.5 默认只标注；隐藏与否由用户决定

健康状态**从不自动**过滤模型列表。要不要把探测失败的模型从 `/model` 与 `--model`
里拿掉，是用户的决定，由 `/opencode2pi filter` 询问后落进 `filters.json`
（两个开关，默认都关）。

隐藏集由 `filters.ts` 一处派生，规则按**展示出来的判定**而不是失败类型来写：
只有 ❌ 与 ⚠️ 可隐藏，🚧（429 与 transport 超时）与 ❓（闸门/凭据）永远不隐藏 ——
那些是通道的状态，按它们隐藏会在通道最该被看见的时候把 roster 清空。

隐藏集变化时 `filters.ts` 通知 `index.ts` 的 `applyProvider` 重写一次注册：重复注册
同名 provider 会**整体替换**该 provider 的全部模型（宿主契约
`src/config/model-registry.ts`），这是结论能进 `/model` 的唯一机制。

模型列表**只由这一处以静态 `models` 发布**，不注册 `fetchDynamicModels`：会话内重新
注册不会重跑发现，而宿主把动态结果缓存 24h、指纹只对它自己的空静态列表取，缓存
命中时根本不调用我们的 fetcher —— 在 fetcher 里过滤等于没过滤。完整实测见
`FINDINGS.md` §8.9。启动顺序因此是「先注册种子 → `await` 发现 → 重新注册」，
宿主的扩展加载会 await 工厂函数、之后才排空注册队列，所以这一次 await 让
`--model provider/id` 仍然能解析到种子以外的 id。

### 4.6 `status` 读 store，`probe` 才全量重探

`status` 回答的是「上次探测说了什么」，答案就在 `<dataDir>/health.json` 里，
每次全探一遍等于拿真实推理配额重画一张用户已经有的图。两个例外是**缺口**而不是图：

- 从没有记录过的模型（含上次探测之后新发现的）当场补测 —— 对能问的东西显示
  「未探测」比问一句更糟。
- 超过 `HEALTH_TTL_MS`（6 小时）的结论**标注不重探**（行尾 `（已过期）` 并提示
  跑 `probe`）。它是一个真实结果，只是不再代表当前状态。

`status` 与 `probe` 的差别只在事后动作：只有 `probe` 询问过滤。补测只覆盖缺口，
所以 `saveHealth` 按**调用方看到的整个 roster** 剪枝，不是按这批结果 ——
否则会把它刚刚拒绝重跑的那些结论删掉。

### 4.7 出口池：能换、但只手动换

**为什么需要它**：匿名额度按 **出口 IP × 模型** 记账。同一个出口上换模型通常还有额度
（§4.4.1 实测），同一个模型换出口能不能继续，只有实测才知道 —— 这正是出口探测要问的
问题（`gate.ts` 的同一份形状、同一个代理机制）。而且**闸门 200 只是响应头**：一个共享
代理可以过闸门然后在第一个 token 前死掉，所以池的 ✅ 以**一次完整回答**为准
（`sendCompletionProbe`，见下文「完成探测」）。宿主的 `PI_PROXY*` 在进程生命周期
内被 memo（`utils/proxy.ts:129-151`），所以「换出口」不可能靠环境变量，只能靠
`options.fetch` + 逐请求代理（`FINDINGS.md` §2.6 实测三连）。

**代理机制按运行时选，不按宿主选**（`src/transport.ts`，`FINDINGS.md` §2.7）：
`init.proxy` 是 Bun 的扩展字段，Node 的 undici 会**静默忽略**它 —— 不报错，只是
照直连发出去。Node 上要用 undici 的 `ProxyAgent`，且必须连 `fetch` 一起换
（dispatcher 只与构造它的那份 undici 配套，否则 `TypeError: fetch failed`）。
取不到机制时 `poolFetch` 返回 `undefined` 并由请求路径**明确警告一次**；
在线路上「池在工作」和「池是摆设」是无法区分的，所以这条静默路径必须堵死。

**为什么不做自动轮换**：宿主对传输层失败会重试（实测 120s 内 28 次，§2.6），在这一层再
加一次「失败就换」等于把量级乘起来，而匿名通道正是靠请求量记账的。所以真实请求失败时
只做一件事：在**它经过的那个出口**上按模型记一笔（`recordPassive`），下次打开 `pool`
能看到实际发生了什么。换不换由用户点。opencode2dsh 的自动轮换是另一套设计，不要抄。

**跨会话的开关会在每次启动时提醒一次**（`src/index.ts` 的 `session_start`）：
池的开关和选中出口都持久化，用户很容易第二天忘了请求还在走代理。两个宿主都在 TUI
已经起来之后才发 `session_start`，所以提示放在这里；并且只在**当前选中的模型属于本
provider** 时发 —— 在别的 provider 上聊天时这个池根本没参与。提示内容是**配置状态**
（选中出口的脱敏地址 + 出口 IP、池开着却没有有效出口、或运行时根本没有代理机制），
**不主动联网探测**：启动不该依赖一次外部请求，真实连通性由用户的下一个请求证明，
失败时照常走既有的错误分类与被动记账。

**「自动扫描内置出口池」自动化的是搜索，不是决策**（`huntUsableExit` + `scanBuiltinPool`）：
从菜单里逐个挑，意味着要探测用户没挑的那些出口，而每次探测都要花配额和一条隧道——
死出口会吃满 20s 总预算，十二个就是四分钟。所以：

- **并发 4 个一批**（`HUNT_CONCURRENCY`），按 `candidates()` 的既有排名（手动在前按文件序，
  内置按可用性与延迟）依次取；
- **闸门通过后再跑一次完整回答**（`completionTestExit`），**只有完成判 `ok` 才算通过**；
  批内出现通过就停，具体用哪个由用户在结果列表里选（hunt 的 `winner` 只用于判断命中）。
  只有闸门通过、完成失败的不算 winner（也已被隔离）；
- **找到后列成结果表让用户选，不自动切换** —— 与上面「不自动轮换」同一条线。
  扫描的产出是一个集合，不是单一答案：达到目标时在途的探测也会入池，所以扫描结束直接打开
  「选择内置出口」的同一张列表。取消选择等于不切换，命令结束，**不会替用户选第一个**；
- 全批失败时**按失败原因分组**（`groupHuntFailures`），因为「都没成功」这句话本身没有行动价值：
  `transport`（代理死了，换一个有意义）/ `limited`（代理是通的，配额用尽，重探同批是浪费）/
  `region`（同上，换地区）/ `shape`（**这次请求形状对每个出口都一样**，若整批都是这一类，
  问题多半不在代理，劝用户继续换代理是把他送进循环）。

**菜单是用户做决策的地方**（2026-10-17 重构，2026-10-19 增三项）：
开关 / 选择自定义出口 / 选择内置出口 / 自动扫描内置出口池 / 删除自定义出口 / 设置免费源 /
清空内置结果 / 查看当前状态。七处判断值得记下来：

① **「补充」和「选哪个」合并成一个命令**。这不是合并两个便利功能 —— 屏检只说明代理能转发
TLS，**补充完之后用户手里依然没有一个能直接用的出口**，两个命令逼着他跑完再自己记住哪个。
一个命令一个答案。

② **内部顺序是「先试现有的，再拉源」**，与直觉相反且是这个设计里最值得辩护的一处。
先拉源要**无条件**付一次完整下载 + 几百次 trace，而「昨天入池的出口今天还能用」是常态，
那几十秒到几分钟全是白等。先探测已有的每个只花一次闸门探测且命中即停，健康池子几秒出结果，
只有空池才付拉源的代价。而这个优化只有在**过滤后才不浪费**：

> `probeWorthyCandidates()` 只返回「有可用证据」或「完全没有证据」的候选。已证伪的
> （`transport`/`region`/`shape`）跳过 —— 它们已经被真实请求判死，再花配额探一次什么也学不到。
> 反过来**「完全没有证据」的手动出口要留**：那是它该拿的第一次测量（`ensureEvidence` 就靠这一下
> 建记录），而且它是你自己的路，比拉来的更值得先试。
> 由此还得到一个便宜的结论：**池里没有值得探的候选时，直接跳到拉源**，而不是先探一轮死出口。
> 注意 `limited`（429）**不算**证伪 —— 配额窗口会滚，把它排除等于让一次限流变成永久的。

③ **删掉「重新屏检全部出口」**。屏检免费且每次补充都跑，所以单独刷新一个入口是在重复
补充已经做过的事；剩下的唯一价值是「零成本体检池子」，而这个需求被「查看当前状态」覆盖。
`screenAll()` 没有别的调用者，一并删除（不留死代码）。

④ **「自定义池 1/2/3」按位置落地，不做固定槽位**。`exits.txt` 是有序列表、顺序即用户排名，
所以「自定义池 2」就是第二行，且**加到第 4 个时多出一个槽位而不是把第三个挤出菜单**。
固定 3 个槽位要额外处理空位与删后留洞，换不到任何东西—— 行号本来就让「位置」可读成「名字」。
菜单行按位置命名而不是显示裸 URL，正是这一点带来的可读性。

⑤ **「开启出口池」在无选中出口时分叉，把「选择内置出口」和「自动扫描内置出口池」都挂进去**（2026-10-17 追加，2026-10-19 扩为三分叉）。
分叉只在**没有可复用的选择**时出现：有选择就一键开，兑现「关闭时选择保留着」。
分叉的每个出口都以 `setPoolEnabled(true)` 收尾，没有「现在直接开」的路径 ——
出口池不能在「开着但没选中」的状态下打开，那样每个请求仍然从本机 IP 发出，
而那正是唯一已经用完配额的那个地址。

> **这里有一个必须记住的读法**：`activeCandidate()` **不能用**来判断「有没有可开启的出口」。
> `pool.ts` 里 `active = store.enabled && store.selected !== null ? … : undefined`，
> 所以池一关它就恒为 `undefined`，恰好在唯一需要它的时刻不给信息。
> 早先 `togglePool` 的 `else { 直接开启 }` 分支因此**永远不可达**，菜单每次都把
> 「之前选过、池子只是关着」说成「还没有选中的出口」。
> 正确读法是 `selectedKey()` + 在 `candidates()` 里重新核对成员资格：
> `selected` 会被持久化而 `candidates()` 是从 `exits.txt` 与已入池出口重建的，
> key 可能比它指名的候选活得久（那行被删、内置出口被裁掉），那时才是真的没东西可开。
> `test/pool.test.ts` 的 "turning the pool off keeps the selection, but
> `activeCandidate` stops reporting it" 钉住的就是这个区别。

⑥ **扫描结果就是选择界面，且刚验证过的结果不重复花配额**（2026-10-19 追加）。
扫描结束不再弹一个「用这个吗」，而是直接打开「选择内置出口（扫描结果）」的同一张列表：
扫描的产出是一个集合，不是单一答案，让用户在结果里挑。取消列表等于不切换，命令结束。
列表只列**当前证据仍可用**的扫描结果（`usableBuiltinSlots`），所以不会把已经失败的出口
重新端上来。选中时如果完成证据还在 30 分钟 TTL 内（`COMPLETION_TTL_MS`），
直接展示它并询问是否切换 —— 再探一次是拿稀缺配额去重学一个刚学会的事实；更旧或更弱的
证据则照常重测。扫描本身也**不再有墙钟总预算**：它按完成探测次数记账（`stopReason:
'budget'` 因此只表示完成预算），一个慢隧道不会再把整轮扫描提前掐断。

⑦ **「设置免费源」与「清空内置结果」是两项用户主权**（2026-10-19）。
停用某个源必须**同时**作用于下载和缓存：只在下载器里过滤，一小时后缓存仍会把该源
的地址带回来（`collectSources` 的 `disabled` 参数就是为此存在的，测试钉住两条路径）。
清空只删 `tier === 'builtin'` 的测量结果，保留 `exits.txt`、当前选择和源设置 ——
发现结果是测量，不是用户数据；`clearBuiltinExits` 用 `candidates()` 复核选中项，
因为手动的 `selected` 可能没有 evidence 记录。

**探测过程必须全程可见**：开场先打印 `huntPlan()`（候选总数、其中几个已有可用证据、
批数与并发度），每条结果带 `[n / m]` 序号和剩余数。理由是**首条反馈可能迟到十几秒**——
第一批里排在前面的候选若是死代理，会吃满预算才返回，这段静默足以让用户以为命令没响应
而取消掉一个正在工作的事情。

**命中可用出口后要单独再打一行结论**，然后才弹询问框。这一行不是重复：批次结果一次报 4 个
候选，询问框之前那一条是「最后一个被列出的候选」，可能是一次失败，也可能是另一个赢家。
问「用这个吗」而日志里紧邻的上一行没写这个名字，两半屏就在说不同的出口
（`autoFindExit` 里 winner 那条 `notify` 的注释记录了这个坑）。

**验证失败的地址 24 小时内不回池**（`QUARANTINE_MS`，2026-10-17）：
免费源每次都返回同样的地址列表。没有这份记忆，下一次补充会重新屏检用户刚看着失败的代理、
为每个再花一次 trace 请求，还可能把一个「失败」重新入池当成新发现。隔离存在 `pool.json`
的 `quarantine` 段（**独立于 `evidence`**：证据描述池中的出口、随出口一起删，隔离必须活得比
出口久——它记的正是池里已经没有的那个地址），由 `recordGate` 统一写入：

| verdict | 是否隔离 | 理由 |
| --- | --- | --- |
| `transport` / `region` / `shape` | **是** | 都是「换一个出口就能避开」的失败，与 `isUsable` 的证伪集合一致 |
| `limited`（429） | 否 | 代理把请求送到了，是配额用尽；隔离它等于因一个会自己过去的条件丢掉一个好出口 |
| `inconclusive` | 否 | 上游没给出可分类的答复，无从判断 |
| `ok` | **解禁** | 24 小时不短，禁令比故障活得久会把已经恢复的地址挡在唯一还能用它的池外 |

两道过滤缺一不可：`discoverExit` 在**屏检前**跳过（省下一次请求），`admitDiscovered` 在**入池前**
再拒一次（唯一的入池入口，只靠上游过滤等于任何第二个调用方都能绕过）。过期记录在
`loadPool` 时清理并回写，避免文件随地址轮转无限增长；`poolReport` 明写隔离数量与最早恢复
时间——否则用户会以为「IP 自己消失了」而当成 bug。

> ⚠️ **闸门先于入池，所以隔离有第三个写入方**：`noteGateVerdict`。
> `recordGate` 需要地址已经是池成员（`ensureEvidence`），而新流程里失败的地址**从未入池**，
> 用 `recordGate` 记等于把判定丢掉。这个函数只写隔离、不碰 evidence，
> 存在的唯一理由就是补上那个静默缺口（见下文「顺序反转」）。

**每个闸门判定都单独播报**（`· 闸门 http://… → 🌏 地区不可用 · 4.2s`）：这些探测每一次都花配额，
不逐条念出来用户无从判断是在花钱还是在空转；而备用出口额外标 `#2 #3`，
说明「这一轮不止找到一个，它们已经在池里」。

**`shape` 那一组为什么单独说**：用户实测遇到过部分出口 403 `FreeTierError`、部分通过
（2026-10-17）。既然同一形状在别的出口上被接受，形状本身没问题，那些 403 是上游按 IP 拒绝
的。所以文案不再说「通常是本扩展的 bug」，改成「上游按出口 IP 拒绝」——把用户引向
「换 IP」而不是「提 issue」。

**关掉就是没装过**：`poolFetch()` 在池关闭时返回 `undefined`，调用方于是**不往 options 里
加 `fetch` 键**（`index.ts`），宿主行为（含 `PI_PROXY`）原样保留。这是返回值上的性质，
不是文档里的承诺 —— `test/pool.test.ts` 就钉在这一点上。

**探测只有一个预算：总 20s**。曾经还有一个更短的「握手预算」（先 10s、后 6s），**已删除**，
因为实测证明它做的是相反的事（2026-10-17）：

在一次真实的「自动找出口」里，7 个刚通过屏检的出口全部被判 `transport` 失败、全部耗时正好 6.0s。
去掉预算重测同批：

| 出口 | 结果 | 耗时 |
| --- | --- | --- |
| `102.0.25.184:8080` | **HTTP 200** | 9575ms |
| `203.14.18.246:8080` | **HTTP 200** | 10412ms |
| `160.187.221.78:5050` | **HTTP 200** | 14253ms |
| `122.3.121.231:8082` | HTTP 200 | 4650ms |
| `144.124.251.24:10167` | HTTP 403 | 1610ms |

**三个真能用的出口被 6s 预算杀掉了。** 同一批测量还给出了两条反证：

- **死代理根本不需要短预算**。坏的几个是 425ms（`ECONNRESET`）、721ms（证书错误）、
  1332ms（`HTTP 403`，那是判决不是挂起）—— 秒级就给出结论。真正会拖满预算的只有
  「连不上且不返回」，而那本来就该吃满总预算。
- **被计时的其实是上游首包，不是隧道**。同一批出口打 Cloudflare trace 只要 212–2736ms，
  打 Zen 却要 9–14 秒。这个延迟既不是代理的属性，也不随时间稳定，**无法从客户端一侧设预算**。

教训：**按阶段设预算的前提是那个阶段真的占主导**。当时「1.9s / 2.9s」的实测只在某个时段成立，
上游一变慢，所有出口就被误杀。分阶段超时不是错，**但阶段必须用当下实测校准，
而且要在分布变坏时重新校准**。

**但屏检的预算是另一回事，收紧了**（2026-10-17，`SCREEN_TIMEOUT_MS` 8s → **5s**）：
两个预算服务于两种错误，而**代价不对称**。收紧屏检最坏的结果是漏掉一个能用的免费代理 ——
而源里还有几万个没测的地址，池子上限 12 个本来就是筛剩下的；放宽闸门最坏的结果是把
一个**确实能用**的出口判死（上面那三个 9.5–14.3s 的 HTTP 200），用户只能看着
「找不到可用出口」而池里其实有。所以两个预算方向相反，不是笔误。

5s 也够用：屏检的两道门槛是 RTT ≤3s、握手 ≤2.5s，**任何跑过 5s 的请求本来就该被门槛拒掉**，
多等那 3 秒只是纯延迟。实测 160 个免费地址里，能答的都答在 0.3–2.9s，5–8s 那一段是空的。

**握手成本要单独测，因为它是可用性的真正决定项**（2026-10-17 实测，见 §3.1）：
undici 的 keep-alive 窗口是 **4s 空闲**，超过就丢弃隧道。一轮 agentic 对话里
「模型思考 / 工具执行 / 等人打字」造成的空闲远超 4s，所以**每个冷启动请求都要重付一次
握手**——这才是真实体感，而屏检原本只测了复用后的那次。

**拉源补池是多轮推进的，不是全拉也不是一轮拉完**（`pool-probe.ts` 的 `discoverExit`，由「自动扫描内置出口池」第二轮调用）：

| 量 | 值 | 出处 |
| --- | --- | --- |
| 源 | **18 个，不分档**，16 个 `raw.githubusercontent.com` + 2 个独立站点 | `FREE_SOURCES` |
| 地址 | 18 个源**全量**下载、合并去重、整体打乱 | `collectSources` |
| 源缓存 | **同一份列表 1 小时内只下载一次**，之后复用本地 `free-sources.json` | `SOURCE_CACHE_TTL_MS` |
| 源回退 | GitHub 源直连失败 → 按序试 3 个镜像 | `GITHUB_MIRRORS` |
| 屏检 | 预筛**并发 512**（一次 CONNECT，2s 硬预算，实测 254–263 个/秒），通过者再屏检**并发 128**；**每轮最多 4096 个地址** | `PREFILTER_CONCURRENCY` / `SCREEN_CONCURRENCY` / `DISCOVERY_ROUND_BUDGET` |
| 轮次 | **一直跑到找到 3 个出口、或用户说停、或源被测干、或完成探测预算耗尽** | `discoverExit` 的 `for(;;)` |
| 提前停 | **攒够 3 个完成可用的出口就停**（同批在飞的一并计入，上限 3） | `sweepRound` / `screenAndVerify` 的早退 |
| 闸门并发 | 屏检满速，**闸门探测单独限流到 8** | `Semaphore(HUNT_CONCURRENCY)` |
| 完成并发 | **与闸门共用限流槽（8）**；完成探测本身单次预算 30s，是闸门 20s 的 1.5 倍 | `HUNT_CONCURRENCY` |
| 完成预算 | **目标 × 4 次真实回答**（默认 12）；每次尝试都计数，429 也计但**不隔离** | `COMPLETION_BUDGET_FACTOR` |
| 兜底询问 | **每轮结束都问一次**，报出「还剩 N 个没测」 | `discoverExit` 的 `askContinue` |
| 不重复 | 同一轮内已测过的地址，下一轮不再测 | `state.reached` |
| 入池上限 | 内置出口最多留 **12 个** | `BUILTIN_MAX` |
| 一 IP 一名额 | 同一出口 IP 只留最快的一个，**且不再单独探测** | `admitDiscovered` / `state.claimed` |
| 入池门槛 | **闸门与完成都 `ok` 才入池**；完成探测失败只写隔离 | `screenAndVerify` / `dropUnverified` |
| 坏地址记忆 | 闸门/完成证伪禁 **24h**，屏检没通禁 **12h**，429 不隔离 | `QUARANTINE_MS` / `SCREEN_QUARANTINE_MS` |

打乱是必须的：不打乱，每次补充都按同一顺序测，永远在重复测列表头部那批死地址。
同一轮内也要记住测过哪些（`state.reached`）——每轮都重读同一批源，不记就是原地重测。

> **18 个源在 2026-10-19 做过一次全量有效性审计**（全部经 `192.168.31.50:7890`）：
> 每个 URL 检查 HTTP 状态，GitHub 源再读**该文件路径**的 commit atom feed。删掉了 4 个：
> `proxymint/free-proxy-list`（仓库与 raw 均 404）、`proxy4parsing/proxy-list`
> （最后提交 2024-04-27）、`prxchk/proxy-list`（2024-04-13）、
> `vakhov/fresh-proxy-list`（仓库当天仍有提交，但 `http.txt` 停在 2026-02-07，253 天）。
> 保留的 16 个 GitHub 源与 2 个独立站点全部在审计当天有更新。**`200 OK` 不等于新鲜** ——
> vakhov 就是反例：地址列表一直返回 200，内容却冻了八个月，测它只会浪费屏检。

> **预筛是 2026-10-19 加的第一道门，因为它把一轮从分钟级压到十几秒**。屏检要过 TLS
> 握手并打一次 Cloudflare trace；免费源里绝大多数地址的 8080 端口根本没人监听，给这些
> 地址做 TLS 是纯浪费。预筛只做一件事：向代理发 `CONNECT cloudflare.com:443`，读到
> `200` 就关掉隧道。它不经过上游、不消耗推理配额，死地址在 1–2 秒内出局，并直接沿用
> 屏检的 12h 隔离。实测 4096 个地址、512 并发用 **15.6 秒**（262 个/秒），其中 179 个
> 打开隧道（4.4%）进入屏检。两个超时必须分开：`socket.setTimeout` 从**连接成功后**才
> 开始计时，DNS 挂起时它永远不触发，所以 `prefilterExit` 另有一个覆盖全过程的硬定时器。
>
> 预筛与屏检的并发也分开：512 个 TCP 连接由本机套接字表决定，而 128 个 TLS+HTTPS
> 请求已经是对免费代理的冒犯；一个共享的 128 会让预筛重新变成瓶颈（实测 63 个/秒，
> 4096 个要 65 秒）。预筛跑完一整轮再开始屏检，不是流水线 —— 换来的是屏检看到完整
> 幸存者列表，而不是与生产者抢结果；代价是第一个候选晚十几秒出现。

> **完成探测（2026-10-19）：闸门 200 不是「能用」**。闸门探针读的是响应头，一个共享
> 代理完全可以在返回 200 之后于第一个 token 前死掉。旧流程「闸门通过即入池、命中一个就停」
> 对单个连接做对了形状校验，却没检验**整条回答**，于是用户选中出口后的第一次真实对话才
> 暴露失败。现在每个候选在闸门通过后必须回完一次 `max_tokens: 24` 的短回答
> （提示固定为 `Reply with exactly OK`）：
>
> | 结论 | 证据 | 含义 |
> | --- | --- | --- |
> | `ok` | 收到 `[DONE]` 或带正文的 SSE，且正文匹配 `OK` | 形状、连接、流式解码都真的走通了 |
> | `limited` | 429 | 出口可用但该模型配额用尽 —— **不隐藏、不隔离** |
> | `auth` / `region` | 401 / 403 地区 | 换出口有意义 |
> | `shape` | 403 形状 | 全批同因时问题不在代理 |
> | `transport` | 无响应 / 流中断 | 代理死 |
> | `inconclusive` | 回答完整但与 `OK` 无关 | 既不是死也不是证明；不隔离、不计 winner |
>
> **30s 是「回答 + 流关闭」的总预算**，比闸门的 20s 宽：闸门只等首字节，完成探测要等
> 模型把整轮说完。它仍然有界 —— 一个 30s 内连 `OK` 都送不回来的免费出口不值得留在池里，
> 而发现流程不能在一个候选上停死。这个预算覆盖的是**整条请求**，不是每读一块正文重置。
>
> **完成预算是「目标 × 4」次真实回答**（默认 3 × 4 = 12）。它按**尝试次数**记账，
> 不管结果：`ok`、`transport`、429 都花掉一次。理由很直接 —— 唯一稀缺的资源是真实
> 推理配额，而 `inconclusive` 不构成证伪，若不设上限，一轮会把每个存活候选都问一遍。
> 429 计一次但**不写隔离**，所以下一次运行还会再试它；`limited` 被当成「通道状态」
> 而不是「出口坏了」，这与模型健康标记的规则一致。
>
> **完成证据留 30 分钟，失败隔离留 24 小时**：`COMPLETION_TTL_MS = 30min` —— 免费代理
> 几分钟内就烂，而用户报告的「刚验证完就失败」正是这个短窗口要防的；重新验证只花一次
> 真实回答，比一次失败的对话便宜。闸门/完成的**证伪**统一走 `QUARANTINE_MS = 24h`；
> 屏检没通的隔离更短（12h）。429 既不隔离也不隐藏 —— 那是通道状态。
>
> **只有完成 `ok` 的内置出口才入池**：`screenAndVerify` 在闸门通过后立刻做完成探测，
> 失败就只写隔离、不 `admitDiscovered`；`pruneUnverified` 也要求内置出口同时有闸门与
> 完成记录。**闸门通过但完成没跑（预算用尽）不会入池**，下一轮重新来过 —— 池里没有
> 「暂定一等公民」，因为菜单上的 ✅ 只有一个含义，就是它真的回完过一轮。

> **源缓存为什么值得做**（2026-10-17）。22 个源意味着 22 次下载，外加每个 GitHub 源
> 直连失败时最多 3 个镜像回退，每个慢源最多 {@link SOURCE_TIMEOUT_MS}（10 秒）。
> 最坏情况几十秒，而它换来的只是一份几个小时才变一次的地址列表 —— 真正的耗时在
> 屏检那一步。所以下载结果落盘缓存 1 小时：一小时内再跑，取源不花任何网络请求，
> 屏检照跑。代价是列表最旧可能有一小时，所以 TTL 定在 1 小时而不是「整个会话」——
> 免费代理的寿命本来就是小时级，冻住不动只会把同一批死地址当成新消息反复上报。
> 缓存命中与下载分别计入 `sourcesCached` / `sourcesFetched`，报告里分开显示，
> 否则「源 22 个」会让人以为每次都真的下载了 22 个。

> **停止条件是这个命令最容易写错的地方**（2026-10-17 实测修复）。实测一次运行：
> 源 16 个、候选 18530 个、屏检 640 个、闸门 8 次、入池 0 个，然后直接结束。
> 两个 bug 叠在一起：
> ① **slow 档一次都没跑**。预算是「整个 run 一个数」（`DISCOVERY_ADDRESS_BUDGET = 320`），
> fast 档 16 个源几万地址，一口气把 320 花光，于是 `screened < budget` 判假，
> 条件挂在 slow 档前面的那道门从来不开。**14 个 slow 源一个没碰，报告却写得像搜完了。**
> ② **「继续吗」只能问一次**。直线流程 `sweep → ask → sweep`，用户答一次"是"就只多扫一轮，
> 然后无论还剩多少都结束 —— 当时还剩 17890 个地址没测，而报告里没有任何数字说明这一点。
>
> 改法两条：预算变成**每轮一个数、覆盖全部源**；`askContinue` 变成 `for(;;)` 里的
> **每轮一问**，并且每次都报「还剩 N 个没测」。
> 只有 `untested === 0`（源真的被测干）才不问自停 —— 那时没有可继续的东西，问了也是白问。
>
> **报「还剩多少」不是锦上添花**：不说这个数字，用户答"停"之后看到的结束语与
> 「源被测干」完全一样，于是唯一合理的解读就是「这命令自己放弃了」。

> **`fast` / `slow` 分档已经在 2026-10-17 删掉**（2026-10-17）。这两个标签是从
> `opencode2dsh` 的 `fastUpdateSources` / `slowUpdateSources` 原样搬来的，**本项目从没测过
> 哪个源更快**，它是一份手工排序的猜测。它唯一的作用是把每轮预算切成两半
> （各 320），并让 14 个源永远排在第二 —— 也就是上面那个 bug 的温床。
>
> 结论：**22 个源合并成一路下载、合并去重、整体打乱**，一个预算
> （{@link DISCOVERY_ROUND_BUDGET} = 4096）。这样一轮采样的是整个列表，而不是手工挑的那
> 1/8。保留的是源取用失败冷却（`SOURCE_FAILURE_LIMIT`）和按 host 熔断 —— 那两个在治真问题，
> 跟档位无关。
>
> 没有采纳「随机挑 3、4 个源全测完再换下一批」：① 它把取源和检测串起来了，每批都要先把
> 源完整 fetch 完才能开始屏检，预筛与屏检的两级并发会在批次边界断档；② 各源体量差几百倍，
> 「全测完」对不同源意味着完全不同的时长；③ 前 3 个源恰好全是死主机时会空掉一整轮，
> 而 `sourceHealth` / `hostHealth` 本来就能自动跳过连不通的源。

> **改为「屏检通过即闸门探测」是一次顺序反转，不是调参**（2026-10-17）。原流程是
> 「屏检一批 → 攒够 6 个 → 全部入池 → 再闸门探测」，两个问题：
> ① 用户要等完整个屏检批次才知道自己有没有可用出口，而**第一个可用地址出现的那一刻
> 就可以开始花配额**；② 池里留下的是**只经过无密钥 trace 的地址** —— 屏检只证明代理能转发
> TLS，不证明上游认这个 IP，于是「补充完」之后用户手里依然没有一个能直接用的出口，
> 必须再跑一次才知道该选谁。
>
> 现在 `screenAndVerify` 一条龙：trace 一答就 `probeGate`，闸门通过后紧接着
> `probeCompletion`，**只有完成 `ok` 才 `admitDiscovered`**。**池的含义从「屏检通过的
> 地址」先变成「闸门通过的出口」，再收紧为「真的回完过一轮的出口」**。
>
> **涉及的三条旧机制必须一起改，否则会静默丢东西**：
> ① `probeGate` 与 `gateTestExit` 拆开。新流程是**先探测后入池**，失败时地址根本不在池里，
> `recordGate` 的 `ensureEvidence` 会返回 `undefined` 并**把这条判定整条丢掉** ——
> 于是每一轮跑过的死代理下一轮还要再花一次配额去重新发现。新增的 `noteGateVerdict`
> 只写隔离、不碰 evidence，专治这个静默失败；完成探测失败走同样形态的
> `noteCompletionVerdict`。
> ② `pruneUnverified()`：内置出口只有在**同时有闸门与完成记录、且两者都没被证伪**时才留下。
> 旧 store 是「闸门 ok 即入池」写的，没有完成记录，所以这条规则同时负责让它自愈。
> 手动出口永不参与（它属于用户的文件，第一次测量才建记录）。
> ③ `huntUsableExit` 结束时要调 `pruneUnverified()`：第一趟刚证伪的成员不能等到
> 「下一次入池顺便清理」，因为最常见的情况恰恰是**这一趟什么都没入池**。
>
> **并发探测出来的备用出口是有意保留的**：`HUNT_CONCURRENCY = 4`，目标出现时最多还有
> 3 个探测在飞，它们跑完、通过的就一起入池。所以 `discoverExit` 返回的是 `winners`
> 列表而不是单个 winner —— 下一趟 `huntUsableExit` 先探的就是它们，这是一次运行两次收益的地方。
> **默认目标是 3 个完成可用的出口**（`SCAN_TARGET`）：只要 1 个的话，那个出口稍后死掉，
> 用户下次还得再付一整轮发现成本。**代价要说清楚**：完成探测每次都是一次真实回答，
> 所以 3 个目标大约花 3–6 次；池的备用靠多次运行累积，不是一次囤满 12 个。

**`DiscoveryNet`：轮次逻辑必须有离线测试**（2026-10-17 加）。

轮次循环是最容易写错的部分（上面那两个 bug 都出在这里），但它也是**没有真代理列表就
根本跑不到**的部分。所以 `discoverExit` 第三个参数是 `options`，其中的 `net` 可注入四个原语：

```ts
export interface DiscoveryNet {
  readonly collect: (onProgress) => Promise<CollectedSources>  // addresses / fetched / cached / failed
  readonly trace: (url) => Promise<ScreenEvidence>
  readonly probe: (url, modelId) => Promise<GateEvidence>
  // Optional only so gate-only fixtures still compile. Absent = "cannot verify",
  // never a pass.
  readonly complete?: (url, modelId) => Promise<CompletionEvidence>
}
```

`options` 里还有 `target`（默认 3）、`askContinue`、`isCancelled`、`skip`。
旧的 `discoverExit(model, onProgress, askContinue, net)` 位置参数已删除。

**注入的是原语，不是整个 sweep** —— 这个区别是被逼出来的。注 `trace` 时
`probeGate` 的调用点漏改了，测试全部 5 秒超时；改成注入整个 sweep 的话，
去重、winner 后的二次检查、隔离写入这些真逻辑就全都不跑了，等于只测了个空壳。

十三个用例钉住的行为：一轮覆盖全部源 / 每轮一问（4000 个地址 → 问 6 次，`untested` 递减到 0）/
轮间不重复测 / 报告带 `untested` / 源测干时不问自停 / 攒够目标即停且不再取源 /
无回调时持续扫 / **闸门通过但回答失败不算 winner** / **完成预算封顶一次运行的花费** /
取消时仍入池已验证的 / 同一 IP 不重探 / 报告带停止原因 / 报告区分 `sourcesFetched` 与 `sourcesCached`。

源缓存另有八个用例（`the source list is downloaded once an hour, not once per run`）：
缓存新鲜时不发一个请求 / 超过 1 小时重新下载 / **命中时不回写**（否则每次运行都刷新时间戳，
1 小时缓存会变成只要在用就永不过期）/ 跨源去重 / **停用的源既不下也不从缓存贡献地址** /
**缓存命中时同样遵守停用列表** / 缓存里少一个源只补那一个 /
缓存文件损坏降级成一次下载而不是崩溃。这些用例都注入 `collectSources` 的 `download` 形参，
**一个网络请求都不发** —— 否则单测就得依赖 22 个第三方站点是否在线。

**补充必须先驱逐再入池，否则新出口无处可放**（2026-10-17 实测修复的两个 bug）：

① `admitDiscovered` 曾在**不写screen** 的情况下建证据，而它内部紧接着就调`pruneDiscovered`——
新出口此刻 `rankOf = 1e9 + MAX_SAFE_INTEGER`，必然排在最末尾被裁。`recordScreen` 在 `refill` 里
发生在 `admitDiscovered` **之后**，永远晚一步。结果是补充报告「新增 7 个」，池里一个都没变。
**现在 screen 随地址一起入池**，进门就带着自己的排名。教训：凡「写入后立刻裁剪」，
新条目必须在裁剪前就具备参与排序的全部信息。

② `pruneDiscovered` 只在**超过 12 个之后**才裁，所以一个塞满死地址的池子会把名额占得死死的，
本轮刚验证可用的出口挤不进来。`evictFalsified` 在入池前先移除**闸门已证伪**的旧内置出口
（与 24 小时隔离同一套判定 `falsifiesExit`）。
**只按闸门证伪驱逐，不按屏检失败驱逐**：屏检只说明「这一次没通」，
而列表每次补充都会原样重新抓回，一个偶发超时的地址下次可能就通了，
为了一条没结论的记录丢掉一个出口是亏的。

**一个出口 IP 只占一个名额，而且现在连探测都省了**：实测同一台机器（`144.124.251.24`）
会在 `:10539` 和 `:10594` 两个端口上同时返回 —— 两个 URL、一份上游配额，
`dedupeAddresses` 按 URL 字符串去重拦不住。两端口各自会打同一个限流，
所以第二个名额对「换一个 IP」毫无帮助。
> **顺序反转之后去重位置也跟着前移了**：原来是在 `admitDiscovered` 事后合并（免费，因为屏检不花钱）；
> 现在每个屏检通过项都要**花一次闸门配额**，所以同样的去重必须在 `screenAndVerify` 里
> **探测之前**做（`state.claimed`）。`admitDiscovered` 的按 IP 去重保留着作为最后一道，
> 因为并发下两个 worker 可能几乎同时看到同一个出口 IP。
> 报告里仍要说明合并了几个 —— 否则「屏检通过 N」会让人以为跑了 N 份独立配额。

**源全部走 `raw.githubusercontent.com`，分支逐个核实过**（2026-10-17）。原先 7 条是
jsdelivr、1 条是 `api.proxyscrape.com`，实测本机直连下**22 个源里 20 个 `fetch failed`**，
只有 proxyspace 与 openproxylist 通——CDN 在这里不是资产而是一道墙。
**六个仓库不用 `main`**：`databay-labs/free-proxy-list`、`sunny9577/proxy-scraper`、
`TheSpeedX/PROXY-List`、`TheSpeedX/SOCKS-List`、`vakhov/fresh-proxy-list`、
`Zaeem20/FREE_PROXIES_LIST` 全是 **`master`**。已对 GitHub API 的 `default_branch`
逐个确认，且`proxy-scraper/generated/http_proxies.txt` 写 `main` 时实测 404。
分支写错返回 404，看起来和"源死了"一模一样，所以有测试钉住（`free source list`）。

**GitHub 镜像回退**（`sourceAttempts` + `fetchSource`）：直连优先（能用就是最快的路径），
失败则按`GITHUB_MIRRORS` 顺序拼前缀重试 —— `https://ghproxy.net/https://raw.githubusercontent.com/…`。
三个镜像实测都能取到内容（2710 行 HTTP 200）：ghproxy 1105ms、github.allproxy.dpdns.org
1004ms、wget.la 4481ms（所以 wget.la 排最后）。**按 host 而非 URL 记健康度**：20 个源
共用一个 host，若不按host 记，同一次不可达要付 20 次发现成本。某个镜像成功后记住它，
下一个源先试它，进度行会明说「经镜像取到」——回退不该是隐形的。

**端到端实测（2026-10-17，22 个源 7.0s）**：

| | 直连取到 | 经镜像取到 | 仍失败 |
| --- | --- | --- | --- |
| 改写前 | **2 / 22** | — | 20 |
| 改写后 | 1 / 22 | **20 / 22** | 1 |

合计 **74122 行**候选地址（此前两源只有约 10457 行）。20 个 GitHub 源全部经
`ghproxy.net` 取到，六个 `master` 分支全部有效；唯一失败的是 `openproxylist.xyz`
自身返回 403，与回退无关。

**两种测量，成本不同，所以分开**：

| 测量 | 请求形状 | 配额 | 判定 |
| --- | --- | --- | --- |
| 屏检 | `GET https://cloudflare.com/cdn-cgi/trace`，走候选出口，**每发 5s** | 0 | 通/不通、出口 IP、地区、延迟分级（>3s 不可用）、握手成本（>2.5s 不可用） |
| 闸门探测 | `gate.ts` 的最小形状请求，走候选出口，**总预算 20s** | 少量 | 上游接不接受这个出口（`verdictOf`） |

屏检打**两发**：第一发是冷连接，第二发复用同一条隧道。差值即握手成本。第二发只在
第一发成功后才打——实测 160 个候选里153 个是死的，它们仍然只花一次请求。

### 3.1 免费源的握手分布（2026-10-17 实测）

22 个源 → 6612 个去重地址 → 随机取 160 个探测，耗时 106s：

| | n | min | p50 | max |
| --- | --- | --- | --- | --- |
| 存活率 | **7 / 160** | | | |
| 冷连接 | 7 | 2239ms | 3912ms | 7845ms |
| 复用 | 7 | 252ms | 293ms | 1900ms |
| **握手成本** | 7 | 491ms | 3619ms | 7555ms |

三条结论，每一条都改了代码：

1. **冷/热是两个独立的数**。握手成本最高 7555ms 的那个，复用只要 1900ms；反过来的
   也有。原先只看 RTT 的屏检对此完全无感。
2. **没有免费出口的握手低于 2.2s**，所以 `SCREEN_MAX_HANDSHAKE_MS` 定在 2500ms——
   7 个存活者里 2 个在这条线以内、5 个在外面，线再收一点池就空了。这是分布的断点，
   不是凑整的数字。
3. **闸门预算必须大于握手门槛**。最快那批打Zen 上游要 1900ms / 2856ms（含隧道），
   所以 6s 而不是 5s：5s 里被上游首包吃掉的份额太大，容易误杀健康出口。

另一条顺带测出来的：22 个源里 20 个在本机直连下 `fetch failed`（github raw / jsdelivr
都不通），只有 `proxyspace.pro` 和 `openproxylist.xyz` 拉到了内容。`sourceHealth` 的
冷却与失败计数是为此准备的，但**在没有全局代理的环境里，内置源的补充基本是空转**。

**什么算「这个出口坏了」**：只有 `region` / `transport` / `shape` 会证伪出口。
429 是**按模型**的（§4.4.1），400 是模型拒绝内容，5xx 是上游——判成 `inconclusive`，
不动出口（`verdictOf` 的注释写了每一条的理由）。

**「可用」的判据是两种证据之一**（`isUsable`）：闸门 200（更强的证据），或屏检在时限内
通过、延迟 ≤3s **且握手成本 ≤2.5s**。所以批量屏检出的出口不必再逐个烧配额去确认；而
只做过闸门探测、没做过屏检的出口也算可用 —— 一次真实请求成功比一次 trace 成功更能说明
问题。握手成本**没测到**（旧 store，或第二发失败）时按 RTT 单独判：不把「没测过」
当成「慢」的证据，否则会为了一个从未采集的数字清空整个池。

**屏检失败只是记账，不删出口**：超时、连不上、延迟 >3s、握手 >2.5s 的出口都留在列表里，
行内写着原因（`握手 3.6s，超过 2.5s 门槛`），只是不计入「可用」——用户看到的是一份现状，
不是一份被清理过的好消息。

**凭据只留在一个地方**：手动出口的 URL 在 `exits.txt`，`pool.json` 里只有
`sha256(url)[:12]`。`recordScreen`/`recordGate` 对这些出口是「第一次测量时按候选补一条
证据」（`ensureEvidence`），而不是把 URL 抄进 store。测试 `pool.json holds no credentials`
钉住这条。

**内置免费出口是兜底，不是首选**：它们在公开列表里、是第三方代理、几小时内就会烂掉，
所以：只在用户点「自动扫描内置出口池」且池里已有的都探不通时才拉取；
**闸门判 `ok` 才入池**（屏检通过只是拿到一张探测资格）；
上限 12 个、满了按可用性与延迟淘汰；TUI 里与手动出口分开标注 `手动` / `内置`。
菜单**不提供手动删除内置出口**——它有 12 个上限与证伪驱逐两种自动淘汰手段，
再给一个手动删除入口只会让人删错（删掉的可能正是唯一还活着的那条）。

**淘汰不等于忘记**：`pruneDiscovered` 把超出 12 个的内置出口删出 `evidence`，
但它对应的 `quarantine` 记录必须留下——被淘汰的地址很可能在下一批免费源里原样出现，
而它被淘汰的原因（用户看着它闸门探测失败）依然成立。两者放在不同 map 里正是为此。

---

## 5. 验证

改完代码跑这三条，全绿才算完成。以下命令都在**仓库根目录**执行：

```sh
# 冒烟
omp -e ./src/index.ts -p --model opencode-zen-free/mimo-v2.6-flash-free "Reply with exactly OK"

# 工具往返：闸门桩不能劫持真实工具
mkdir -p /tmp/t && touch /tmp/t/a.txt /tmp/t/b.txt /tmp/t/c.txt
omp -e ./src/index.ts -p --model opencode-zen-free/big-pickle \
  "Use the bash tool to list the files in /tmp/t, then tell me exactly how many. Do not guess - run the command."

# 类型 + 单测
npx tsc --noEmit
bun test
```

**如果对话返回 403，先查本文 §1 的三个条件**，不要改别的地方。

`/opencode2pi doctor`、`probe`、`filter` 与 `pool` 需要交互式 TUI；打印模式下 `status`
照常打印已有结论并点名哪些模型没探测过，`probe` 提示不可用，`pool` 打印出口列表
（只读）。

出口池的接线要在**真实进程**里证明，因为「wrapper 装上了」这件事静态看不出来。
用 `OPENCODE2PI_DATA_DIR` 指一个临时目录，不碰用户的真实 `pool.json`：

```sh
# 池关闭：请求按原样发出（也证明关掉就是没装过）
omp -e ./src/index.ts -p --model opencode-zen-free/mimo-v2.6-flash-free "Reply with exactly OK"

# 池开启 + 死端口出口：必须失败（ECONNREFUSED / transport），成功即说明 wrapper 没接上
export OPENCODE2PI_DATA_DIR=/tmp/o2pi-smoke-dead   # exits.txt: http://127.0.0.1:9, pool.json: enabled
omp -e ./src/index.ts -p --model opencode-zen-free/mimo-v2.6-flash-free "Reply with exactly OK"

# 池开启 + 可用出口：必须成功（走代理也能过闸门）
export OPENCODE2PI_DATA_DIR=/tmp/o2pi-smoke-live   # exits.txt: http://192.168.31.50:7890
omp -e ./src/index.ts -p --model opencode-zen-free/mimo-v2.6-flash-free "Reply with exactly OK"
```

写这两个临时目录用扩展自己的代码路径最保真（`loadPool` → `addCandidate` →
`selectExit` → `setPoolEnabled`），不要手写 `pool.json`。

---

## 6. 发布

打 `vX.Y.Z` tag 触发 [`.github/workflows/release.yml`](../.github/workflows/release.yml)：

校验 tag 与 `package.json` 版本一致 → `npm ci` → typecheck → test →
校验 tarball 产物完整 → 发布 npm → 建 GitHub Release → 前移 `stable` ref。

### `stable` ref：README 里不该出现版本号

README 的 git 安装命令写 `@stable`，不发版就不需要改它 —— 手改版本号这件事
只会在某一次发版被漏掉，而漏掉时没有任何报错：文档安静地指向上一版。
workflow 在 tag 推送后执行 `git push --force origin "$GITHUB_SHA:refs/tags/stable"`，
把 `stable` 前移到本次发版的 commit。它是**轻量 tag 而不是分支**：这个远端拒绝创建
分支（实测推 `refs/heads/stable` 被 remote rejected），而 tag 可以强制前移。
`@stable` 对分支和 tag 一样解析，用户侧的安装命令不受影响。

这一步**不校验任何东西，也不失败**：它排在所有检查之后，不能成为发版的卡点
（发版失败只在 GitHub 上可见，没人盯着就会白白卡住）。

代价是 `@stable` 不固定版本。要复现某一版，用户自己去 releases 挑 tag 钉死。

### 两种认证方式，workflow 自动二选一

| 条件 | 走哪条路 | 命令 |
| --- | --- | --- |
| 存在 `NPM_TOKEN` secret | token 认证 | `npm publish --provenance --access public` |
| 没有 secret | OIDC Trusted Publishing | `npm publish --access public` |

OIDC 路径下 npm CLI 会自动检测 CI 环境并改用短期凭据；**provenance 也由 npm 自动生成**，
所以那条路径不加 `--provenance`。选 OIDC 前会先检查 `npm >= 11.5.1`，不够就明确报错，
而不是让发布挂在后面报一个看不懂的 ENEEDAUTH。

### 本机 registry 固定用官方源，但不改全局配置

开发机全局 registry 是 `registry.npmmirror.com`（国内镜像），**刻意不改**：
换掉会影响本机其它项目的依赖安装。本包所有 npm 操作一律用参数显式指定官方源，
并固化成脚本，省得每次手打：

```sh
npm run whoami         # npm --registry=https://registry.npmjs.org/ whoami
npm run dry-run        # 打包预演，发布前必看
npm run release:check  # typecheck + test + dry-run 三合一
npm run registry <cmd> # 其余命令：npm run registry login / publish / view …
```

CI runner 默认就是 `registry.npmjs.org`，无需处理。

### 已完成：token 首发 → OIDC 接管（v0.3.1，2026-10-11）

历史：v0.1.1 / v0.2.0 / v0.2.1 / v0.3.0 四次发版的 `Publish to npm` 全部
挂在 `ENEEDAUTH` —— 当时既没有 `NPM_TOKEN`，包也不存在（没有包就没有 Settings 页，
配不了 Trusted Publisher）。这不是配置错误，是顺序问题。

v0.3.1 走完了完整流程：配 `NPM_TOKEN` → 首发成功（`opencode2pi@0.3.1` 已上线，
带 provenance）→ 配好 Trusted Publisher → `gh secret delete NPM_TOKEN`。
**现在 CI 走 OIDC，仓库里不再有任何长期凭据。**

**token 是要长期保管的资产，不要提交进仓库、不要贴进聊天工具。**

**Release 步骤始终执行**（`if: always()`），且 notes 会写明这次有没有发上 npm、
走的是哪条认证路径。

### npmjs.com 的 README 不会跟着 GitHub 自动更新

**只在发版那一刻更新。** npm 不读 GitHub，只读你 publish 的 tarball 里那份
README，把它写进 registry packument 的 `readme` 字段，页面渲染的就是它。
所以改完仓库里的 README 之后，npm 页面会停留在上一个已发布版本的快照，
**必须再发一个新版本**才会同步（`npm version patch && npm publish` 即可，
README 在改动里就行，不必动代码）。

排查时注意 `npm view` 会走缓存、且发布后 registry 有几十秒同步延迟：
查证要直接读原始数据，别用 `npm view` 下结论——

```sh
curl -s https://registry.npmjs.org/<pkg> | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(Object.keys(j.versions),j['dist-tags'])})"
```

首次发布时 npm 会先建一个 `0.0.0-stage` 占位版本、真实版本稍后异步落地，
期间 `latest` 指向占位符。这**不是 staged publishing 卡住、也不需要人工
promote**，`npm stage list` 显示为空是正常的，等几十秒即可。

## 6.1 从 token 迁到 Trusted Publishing（OIDC）完整步骤

token 是**能用但要自己保管**的长期凭据：它躺在 GitHub secret 里，泄露了要手工吊销，
还要防 CI 日志意外打印。OIDC（Trusted Publishing）是 npm 官方推荐方式 ——
CI 用**一次性短期凭据**，由 GitHub 的 OIDC token 换取，没有可泄露的长期密钥，
还能自动生成 provenance。两者产出的包完全一样，差别只在认证方式。

**第 1 步 · 拿 token（只做一次）**

1. 登录 https://www.npmjs.com/settings/tokens
2. 点 **Generate New Token → Granular Access Token**
3. 勾选 2FA（账号已启用 2FA，这是创建 Granular token 的前提）
4. **Package permissions**：选中 **Publishing**，其余留空（最小权限）
5. **Expiration**：建议 90 天。过期后发布会失败，重新走一次即可
6. 生成后**只显示一次**，立刻保存

**第 2 步 · 写入 GitHub secret**

```sh
# 交互式输入，不回显、不进 shell history
gh secret set NPM_TOKEN
```

粘贴 token 回车确认。验证（只看名字，值永不回显）：

```sh
gh secret list        # 应出现 NPM_TOKEN
```

**第 3 步 · 首发**

打 tag 推上去，workflow 自动走 token 分支（`release.yml` 检测到 secret 就用
`npm publish --provenance --access public`）。验证：

```sh
npm run whoami                              # 确认登录身份
npm view opencode2pi --registry=https://registry.npmjs.org/
```

**第 4 步 · 在包的 Settings 页配 Trusted Publisher**

前提：包已经存在（所以第 3 步得先成功）。

1. https://www.npmjs.com/package/opencode2pi/settings/access 页面
2. 找到 **Trusted Publisher**（部分账号在 **Settings → Trusted Publisher**）
3. **Organization / GitHub organization**：`FanchangWang`（或你选的组织）
4. **Repository**：`FanchangWang/opencode2pi`
5. **Workflow filename**：`release.yml`
   ⚠️ 填**文件名即可，不要填 `.github/workflows/release.yml`**，填错不会报错，
   只在发布那一刻报权限错
6. 勾选 **Allow npm publish**（**必须勾**，见上节）

**第 5 步 · 删掉 secret，切到 OIDC**

```sh
gh secret delete NPM_TOKEN
```

此后 workflow 检测不到 secret，自动走 OIDC 分支。**workflow 文件不用改任何一行。**

**验证切过去了**：再打一个新 tag 推上去，看 Actions 日志里 `Publish to npm`
那一步打印的是 `No NPM_TOKEN; using OIDC trusted publishing.` 而不是
`Authenticating with NPM_TOKEN.`。npmjs.com 包的 Versions 页面会显示
provenance 徽章。

### OIDC 常见故障对照

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `npm <11.5.1 cannot use OIDC` | runner 的 npm 太老 | workflow 已提前拦截并明确报错；升级 setup-node 的 node-version |
| `E401/E403 Unauthorized` | Trusted Publisher 的 org / repo / workflow 名填错 | 回上一步逐字核对，**workflow 只填文件名** |
| 明明配了却仍走 token | secret 还没删 | `gh secret delete NPM_TOKEN` 后重推 tag |
| provenance 徽章没出现 | 走了 token 分支且未加 `--provenance` | 迁到 OIDC 后由 npm 自动生成，无需手工加 |
| `npm view` 只看到 `0.0.0-stage` | 首发占位符，真实版本异步落地中 | 等几十秒；**不是** staged 卡住，不要去 promote |
| npm 页面 README 还是旧的 | npm 只在 publish 时刷新 README | 再发一版；`npm view` 有缓存，直接读 registry 原始 JSON |
| `npm stage list` 为空 | 正常，没有待提升的版本 | 无需任何操作 |

### 其它

- 宿主**不支持**直接安装 `.tgz` 文件（实测报 `package.json not found`）。支持的源是：
  npm spec、git ref、`https://` 仓库地址、本地目录。所以 release 里的 tarball 附件
  只作存档，不是安装路径
- 一次 `npm publish` 同时服务两个宿主：`pi install npm:opencode2pi` 和
  `omp install npm:opencode2pi` 都从 npm 解析，pi.dev 的包目录也是索引 npm，没有独立 registry
- **README 改动要发版才同步到 npm 页面**（见上节）；只改 GitHub 文档不发版也没问题，
  两边短暂不一致是正常的

---

## 7. 明确不要做的事

- ❌ 不要用 `onPayload` / `prepareRequest`（哑字段）
- ❌ 不要引入 `createProvider` / `openaiCompletions`（宿主 1.x 里没有这两个导出）
- ❌ 不要返回嵌套 `limits`（静默失效）
- ❌ 不要只给 `fetchDynamicModels` 不给静态种子（冷启动失败）
- ❌ 不要 spawn 子进程，不要用环境变量换出口（宿主代理是进程内缓存，运行时改 `PI_PROXY*` 不生效）；
  要换出口就走 `options.fetch` + 逐请求代理（§4.7 / `FINDINGS.md` §2.6），且**只由用户手动换**
- ❌ 不要在 Node 上用 `init.proxy`（undici 静默忽略，实测出口 IP 不变）；
  走 `src/transport.ts`，并注意 dispatcher 必须配同一份 undici 的 `fetch`
- ❌ 不要让「取不到代理机制」退化成静默直连；`poolFetch` 返回 `undefined` 时
  必须有一条明确的警告（`FINDINGS.md` §2.7）
- ❌ 不要照抄 opencode2dsh 的重试策略（匿名通道重试轰炸会挤掉自己的配额）；
  出口池同理，失败只记账不轮换
