# FINDINGS — 实测结论，不要重新推导

本文件的每一条都是**实际跑出来的**，不是从文档推的。重新验证的成本很高（需要抓包级对比 + 反复试 upstream gate），接手前请完整读完。

验证环境：`omp 18.6.1`（Windows，omp 可执行文件位于 `%LOCALAPPDATA%\omp\omp.exe`），走 `http://192.168.31.50:7890` 代理。日期：**2026-10-05**。

---

## 1. 匿名免费通道现在可用（关键前提）

`https://opencode.ai/zen/v1` 的免key 通道**没有被关闭**。早期 pi 生态里`pi-opencode-zen` 在 2026-09-23 宣布「免费层已对非官方客户端关闭」，**这个结论是错的**——它只是没解开下面的形状闸门。

> 反例教训：我第一版探针因为 session id 格式非法 + 没用插件自己的请求构造，测出全量 403，差点得出「上游已封、这个项目没救了」的结论。**任何"上游关停了"的判断都必须用正确形状复测一遍。**

## 2. 上游闸门的三个必要条件

全部经实测确认。**三个缺一即 403 `FreeTierError`**：

| # | 条件 | 违反时的报错 |
| --- | --- | --- |
| 1 | `Authorization: Bearer public`（字面量 `public`） | 401 |
| 2 | 规范 session id：`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`（12 hex + 14 base62 = 26 字符总长），**且 12 位 hex 的布局要被校验**（低 12 位解码为逐毫秒计数器，须落在 `[1, 63]`，即线上 hex 低 12 位 ∈ `[0xFC0, 0xFFF]`）——2026-10-13 起「形状正确」不再够用，详见 §2.3/§2.4 | `MissingSessionID` / 403 |
| 3 | **agent 形态 body**：`stream: true` **且** `tools` 满足双通道形状之一（legacy `/zen/v1`：**单 `read` 工具**、定义不校验；`/inference`：`shell` 和 `read` **真实 OpenCode 定义**，stub 定义被 403）——2026-10-14 起 keyless 通道迁至 `/inference`，2026-10-17 恢复双通道，详见 §2.4/§2.5 | 403 FreeTierError |

条件 3 有**两个独立的部分**，只满足一半仍然403：

```
stream:true  + tools:[shell,read]  →  200 ✅
stream:false + tools:[shell,read]  →  403 FreeTierError   ← 非流式一律被拒
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

### 2.1 名单复测（2026-10-08，闸门形状同上）

`GET /zen/v1/models` 匿名返回 87 个 id，其中名字带 `free` 或定价为零的 13 个。
逐个闸门形状实测：

| 模型 | 结果 |
| --- | --- |
| `big-pickle` / `mimo-v2.6-flash-free` / `nemotron-3.5-lightning-free` | ✅ 200 |
| `space-bunny-free` / `fledge-alpha-free` / `longcat-2.5-preview-free` / `ling-3.1-flash-free` | ✅ 200 |
| `mimo-v2.5-free` | 401 `ModelError: not supported`，且已从 `/models` 消失 → **已下线** |
| `ling-3.0-flash-fin-free` / `exo-free` | 400 / 503 `Endpoint is unavailable`（当时记为抖动保留 → **§2.2 已改判**） |
| `jev-1.13-free` | 500 Internal server error（当时记为保留 → **§2.2 已改判**） |
| `nemotron-3.ultra-free` | 401 `ModelError` |
| `muse-spark-1.2/1.3-contributor-free` | 403 `RegionError`（本地区封锁） |

### 2.2 名单复测（2026-10-11）：三个 id 从「保留」翻成「拒绝」

2026-10-08 那张表把 `exo-free` / `jev-1.13-free` / `ling-3.0-flash-fin-free`
记成「上游抖动，保留」。同日用**同一份 `gate.ts`**（doctor 与探测共用的那份）
各测 3 次，结果 3/3 完全一致：

| id | 结果 | 判定依据 |
| --- | --- | --- |
| `exo-free` | 410 `ModelDeprecated` | 上游已下架 |
| `jev-1.13-free` | 400 `ModelProtocolUnsupported` | 该协议根本不提供此模型 |
| `ling-3.0-flash-fin-free` | 400 `Upstream request failed: Model is unavailable` | 上游侧拒绝 |

三个都已进 `UNAVAILABLE`。注意**当时的保留理由本身有歧义**：
它们出现在目录里、也没被标记黑名单，只是 API 测试不同 —— 这跟「上游明确
拒绝」不是一回事。现在是后者，所以改判。`ling-3.0-flash-fin-free` 尤其
关键：它此前是 400/503 反复翻转的，才被当成抖动保留；现在每次都稳定 400，
那是拒绝而不是抖动。

这也再次证明 §2.1 那条教训：这三个 id **至今仍被 `/models` 列出**，
`exo-free` / `muse-spark-1.*` 甚至在 models.dev 上仍是 0 价，
S1 与 S2 双重背书一个聊天层拒绝的 id —— 只有 denylist 挡得住。

**mimo-v2.6-flash-free 的上下文窗口分歧，2026-10-14 改判采纳 1048576**：
models.dev 声明 `limit.context: 200000`，opencode2dsh 用模型卡把它覆盖成
1048576（其 issue #17 报同一处不符，模型卡确写 1.05M），官方 OpenCode CLI
配置同样声明 1048576。2026-10-11 时我们因「实测能通但测不出真实上限、
两种错法代价不对称（声明偏小只提前压缩上下文，可恢复；声明偏大让请求真的
溢出，硬错误）」保守取 200000；本次同步上游 0.3.11 时经评审决定改为
1048576（`seed.ts` 与 `metadata.ts` 的 `LOCAL_MODEL_OVERRIDES` 两处生效，
后者带 note 落日志）。若后续实测发现上限确为 200000，改回只需动这两处。

教训：**models.dev 的零定价元数据会滞后于下线**。`mimo-v2.5-free` 下线后
models.dev 仍以 0 价发布，纯靠元数据判定会继续把死模型端上选择器 ——
`UNAVAILABLE` denylist 是唯一挡住它的机制，所以下线必须手工登记。

**`deepseek-v4.1-flash-free` 的上下文窗口，2026-10-21 按上游 #99 改判 300000**：
models.dev 给同一 canonical 模型的免费与付费两个 id 写了不同的窗口 —— 免费 id
写 `limit.context: 200000`，付费 `deepseek-v4.1-flash` 写 1000000。2026-10-19
合并上游 #81 时取 1048576（2026-10-16 实测 1,011,668 prompt tokens 仍能召回）；
但上游 2026-10-20 对同一通道复测：**315,596 tokens 仍能召回，~326k 直接
`context_length_exceeded`**，1M 已不再被服务。声明 1M 不只是偏乐观，而是主动
有害：宿主在 0.8 × contextWindow（800k）才压缩，长会话会在从未压缩的情况下越过
真实上限，然后硬失败。现取 **300000**：宿主在 240k 压缩，240k + 32k 输出预算
= 272k，仍低于 315,596 的实测召回点。只覆盖 `contextWindow`，`maxTokens` 保持
models.dev 的 32000。`LOCAL_MODEL_OVERRIDES` 按 id 生效，同桶的
`glm-5.3-flash-free` 仍是 200000 —— 测试同时钉住这两点，避免以后把覆盖写成
「凡 200000 就放宽」。

denylist 的 id 拼写必须逐字来自 `/models`：`nemotron-3.ultra-free`（点）
曾长期挂在 `UNAVAILABLE` 里，而线上真实 id 是 `nemotron-3-ultra-free`（连字符），
于是这条 denylist 一直是静默空转，401 的死模型照旧出现在选择器上。
真实 id 本身也带点（`mimo-v2.6-flash-free`），所以拼写只能靠实测，不能靠肉眼推断。

### 2.3 会话 id 的时钟半条（2026-10-13 上游变更 · 2026-10-14 本地复现）

2026-10-13 上游给闸门第 2 条加了**第二个独立部分**：12 位十六进制不再是任意串，
而是被解码回一段**位取反的墙钟**。opencode2dsh 当日 live probe
（mimo-v2.6-flash-free 与 nemotron-3.5-lightning-free）结论：

- 上游读这 12 位的**低 12 位**当作逐毫秒计数器，只接受 `[0, 63]`；
  高 36 位时钟位根本不检查——解回 1970 年的 id 照样通过（其 issue #65
  修正了最初「核对墙钟合理性」的误读）；
- 摘要前缀落进该窗口的概率只有 ~1.5%，于是**几乎每个会话都 403，
  而正则形状断言全绿**——测试钉的是「长得像」，上游查的是「是不是真的」。

本仓库 2026-10-14 复现：修复前用 `gate.ts` 同形探针打 mimo-v2.6-flash-free，
返回 `403 FreeTierError`（errors.ts 归类为 SHAPE_REJECTED），与上游结论一致。
修复前 `canonicalSessionID()` 用 sha256 摘要填时间位，正是被拒的派生方式。

修法（移植上游最终版）：时间位改由上游自己的生成器公式产出
`~(Date.now() * 0x1000 + counter)`，counter 固定取 1（本扩展是自己会话的
唯一写入者）——取反的结构性副产物是时间位以 `ffe` 结尾，这是字符串层面
就能看出来的判据。会话身份只进 14 位 Base62 尾巴，不同会话不撞车、
prompt cache 亲和保留；整个 id 按会话信号 memo（FIFO 1024），重试与多轮
复用同一 id。真实 OpenCode 客户端传来的 `ses_` id 依旧原样透传。

教训：**闸门条件会从「形状」升级到「派生方式」**。形状断言永远必要、但永远
不充分——回归测试必须把上游编码器当 oracle 逐字节钉死
（test/opencode2pi.test.ts「session clock」组），而不是在同一模块里重写
一遍公式自证。

### 2.4 匿名通道迁移与工具定义校验（2026-10-15 上游变更 · 本地实测）

2026-10-14 深夜上游把 keyless 免费通道整体改造，opencode2api v1.3.9
（commit `f8e996d`/`be91f86`）为此发布修复。本仓库 2026-10-15 用
`gate.ts` 同形探针复现：**修复前的请求形状（/zen + bash/read stub + 旧 UA +
`prj_` 前缀 project）返回 403 FreeTierError，扩展整体失效**。逐变量归因
（其余全部保持 v1.3.9 形状，只改一个变量）：

| 变量 | 实测 | 结论 |
| --- | --- | --- |
| URL `/zen/v1` → 保持 `/zen` | 403 | **硬条件**：匿名通道迁至 `https://opencode.ai/inference/v1` |
| 删 `x-opencode-session-id` 头 | 403 | **硬条件**：该头必需（客户端指纹的一部分） |
| `x-opencode-project` 用 `prj_` 前缀 | 403 | **硬条件**：必须是裸 40 位小写 hex（`sha256("opencode-project\0"+project)` 截 20 字节） |
| tools 用 stub 定义（即使名字是 shell） | 403 | **硬条件**：上游校验认识的工具的**定义**（description + schema），stub 一律 403 |
| tools 用 shell/read **真实定义** | 200 | 最小集 `shell`+`read` 真实定义即可通过 |
| User-Agent 用旧格式 `opencode/1.18.31 (…)` | 200 | 暂兼容，但上游期望 `opencode/latest/2.0.29/cli`，一并换掉 |
| `/models` 列表打 `/zen` 还是 `/inference` | 均 200（85 id） | 非硬条件，统一迁移防 `/zen` 停服 |

要点：

- **工具名从 `bash` 变成 `shell`**（OpenCode 2.x 的名字）。旧 `bash` 拼写不再
  注入——上游校验定义，合成 bash 定义与官方不匹配照样 403。真实定义照抄
  opencode2api `opencode_tools.json`（本仓库 `src/tools.ts` 只取 `shell`/`read`）。
- **会话 id 不再需要真实时钟**（opencode2api #70）：既然只查低 12 位
  （counter ∈ [1,63]，hex 低 12 位 ∈ `[0xFC0, 0xFFF]`），就用 sha256 前 6
  字节确定性派生「36 位伪时钟 << 12 | counter 1」再取反——同会话恒同 id、
  零状态（无 memo、无时钟）；`ses_` 形状但布局不对的 foreign id（旧摘要
  填充/ascending）也被重编码而不是透传。§2.3 的 memo/真实时钟方案被此取代。
- 教训：**闸门条件的组合会整体换代**——一个变量（endpoint、头、工具定义）
  变了就是全量 403，`doctor` 只测形状是不够的，必须用真实请求形状归因。

### 2.5 上游恢复 legacy /zen/v1 双通道（2026-10-17 上游变更 · 本地实测）

opencode2api v1.4.1（commit `076451f`/`2319941`/`a9470df`）把 keyless
通道改回双端点：**优先 legacy `/zen/v1`（恢复 v1.3.7 请求形状，即单
`read` 工具、定义不校验、`prj_` project、`opencode/1.18.31 (…)` UA、
`x-opencode-request` 头）**，`/inference` 作为 fallback 保留 2.x 形状。

2026-10-17 本仓库 `lane-probe`（已删）用四组形状实测，**全部 200**：

| 组合 | URL | UA | project | tools | 结果 |
| --- | --- | --- | --- | --- | --- |
| L1 legacy + v1.3.7 形状 | `/zen/v1` | `1.18.31` | `prj_*` | 单 read（stub 即可） | 200 |
| I1 zen + 2.x 形状 | `/zen/v1` | `2.0.29` | 40-hex | shell/read 真实定义 | 200 |
| I2 inference + 2.x 形状 | `/inference/v1` | `2.0.29` | 40-hex | shell/read 真实定义 | 200 |
| L2 旧 bash stub | `/zen/v1` | `2.0.29` | 40-hex | bash stub（旧 v0.3.4 形状） | 200 |

即闸门**又放宽了**：v0.3.5 的单通道形状仍然有效，但上游因此重启双通道，
本仓库同步实现（获批三点合并：请求双通道、S1 发现双通道、doctor 双通道）。

实现约束（实测）：

- **`model.baseUrl` 不生效，`options.fetch` 生效**：注册期 URL 一旦固定，
  运行期改不了（用「注册错误 URL + handler 覆盖」实测返回 404）。**2026-10-17
  更正**：初版把 `options.fetch` 与 `baseUrl` 一起写成「不生效」，实测是错的 ——
  在 handler 里传自己的 `fetch`，宿主 `stream.ts:1356` 的 `withTransportFetch`
  会拿它当 `base`（`transport-fetch.ts:28`），而且 `withProxyInit`
  在调用方已给 `init.proxy` 时不再覆盖（`proxy.ts:185`）。实测三连见 §2.6。
  注意这里的区分：**URL 只能靠注册期选 lane，出口 IP 可以逐请求换**。
  fallback 只能靠「403 FreeTierError → `findHealthyLane(model.id)` 双通道探测 →
  `setCurrentLane()` + 重新注册 provider」完成，60s 冷却（
  `LANE_SWITCH_COOLDOWN_MS`）防振荡。
- legacy 通道**只要求单 `read` 工具，定义不校验**；注入 stub 时不能
  **重命名客户端已声明的 `read_file` 类工具**——那是宿主工具调度的名字，
  重命名会破坏工具调度（与上游网关不同，它重命名的是 wire 层自己合成的）。
  客户端已声明 `read` 就原样保留、不再注入 stub；声明了别的工具则追加 stub
  且 `toolChoice: 'none'`（无工具可选时禁止宿主强制选工具）。
- 会话头按通道不同：legacy 用 `x-opencode-request: req_<16 hex>`（无
  `x-opencode-session-id`）；`/inference` 仍带 `x-opencode-session-id`（4 头
  客户端指纹）。两通道 session id 的时钟半条要求相同（§2.3）。

### 2.6 逐请求换出口 IP 是可行的（2026-10-17 实测）

问题：匿名配额按出口 IP 限流，而宿主的代理配置**只在进程启动时读一次环境变量**，
运行期改 `PI_PROXY*` 无效（`utils/proxy.ts:129-151` 按 provider memo）。
所以要运行中换出口，必须自己拿住 transport。实测三连：

| # | 做法 | 结果 |
| --- | --- | --- |
| 1 | handler 里给 `streamSimple` 传自己的 `fetch`，wrapper 把 `init.proxy` 设成死端口 `http://127.0.0.1:9` | 请求失败：`ECONNREFUSED`，wrapper 被调用 28 次（宿主对传输失败的重试，120s 内） |
| 2 | 同上，`init.proxy` 设成 `http://192.168.31.50:7890` | 正常 200 |
| 3 | `fetch(url, { proxy })` 直接量出口 IP（`https://cloudflare.com/cdn-cgi/trace`） | 直连 `120.225.64.15` / `loc=CN` / 633ms；走 7890 `195.154.200.13` / `loc=FR` / `colo=CDG` / 1750ms；死端口 `ECONNREFUSED` |

结论（三条各自独立）：

1. **`options.fetch` 生效**：宿主拿它当 `base`（`transport-fetch.ts:28`
   `given ?? …`），UA/CA/代理/调试层仍由宿主叠在它外面。
2. **`init.proxy` 生效**，且调用方给的 `init.proxy` 胜过环境变量
   （`withProxyInit` 见 `init.proxy` 已存在即原样返回，`proxy.ts:185`）——
   于是「换出口」= 每次请求换一个 `init.proxy`，**不需要重注册、不需要重启**，
   而「关掉」= 根本不传 `fetch`（宿主行为原样保留）。
3. **`https://cloudflare.com/cdn-cgi/trace` 一次请求同时给出出口 IP 与地区**
   （`ip=` / `loc=`），且是 TLS —— 拦截型 HTTP 代理伪造不了。这是候选出口
   「免配额屏检」的请求形状（opencode2api 用同一 URL 做可达性探针）。

副作用要注意：**宿主对传输层失败会重试（实测 120s 内 28 次）**，所以一个坏出口
的代价不是一次失败，而是一串；这也正是换出口前必须先跑探测确认的理由 ——
一次闸门 + 一次完成探测的代价，远小于切到一个死出口后被宿主重试一串。

### 2.7 `init.proxy` 只在 Bun 上成立，Node 会静默忽略（2026-10-17 实测，修正 §2.6 第 2 条）

§2.6 的第 2 条当时只在 omp 上量过。补测 Node（pi）时结论反了一半：

| 运行时 | `fetch(url, { proxy })` | 实测出口 IP |
| --- | --- | --- |
| **Bun** 26.3.0（omp） | 生效 | 直连 `120.225.64.15` / 走 `192.168.31.50:7890` → `195.154.200.13` |
| **Node** 22.22.2（pi） | **静默忽略** | 直连、美国代理 `40.192.70.191`、局域网代理 **全部** `120.225.64.15` |

`proxy` 是 Bun 给 `RequestInit` 加的扩展字段。undici 对未知的 init 属性
**不报错也不提示**，直接丢弃 —— 所以在 Node 上 `poolFetch` 返回了一个函数，
而这个函数做的事和直连完全一样。

这是本项目里最危险的一类失败：**在线路上无法区分「池在工作」和「池是摆设」**。
菜单照常显示选中的出口、屏检证据照常显示，而每个请求仍从本机 IP 出发 ——
恰好是配额已经耗尽的那个地址。

连带的次生损害：当时的屏检（`traceEgress`）也用 `init.proxy`，于是在 Node 上
六个出口（含美国 IP `40.192.70.191`）全部测出 `exitIP = 120.225.64.15` ——
屏检从来没测过代理，全在测本机，于是把死代理判成 A/B 档「可用」并写进了
`pool.json`。**这批可用性证据在修复前整体不可信。**（屏检与内置池已于
2026-10-21 整体移除；这条留作「探测必须与真实请求共用 transport」的实证。）

Node 上的机制是 undici 的 `ProxyAgent`，有一个必须写下来的坑：

> **dispatcher 只与构造它的那份 undici 的 `fetch` 配套。**
> 把外部 undici 的 `ProxyAgent` 交给 Node 内置的全局 `fetch`，
> 会 `TypeError: fetch failed`（实测）——因为全局那个属于 Node *内部* 的 undici。

所以 wrapper 必须整体切换 `fetch`，不能只换 dispatcher。实测 Node 侧换成
`undici.fetch` + `ProxyAgent` 后：直连 `2409:8a3c:…` → 走代理 `195.154.200.13`。

undici 的来源按序尝试（实测）：先 `import('undici')`，再用
`createRequire(process.argv[1])` 从**宿主自己的入口脚本**向上解析 ——
pi 自带 undici 8.10.2，且是 `@earendil-works/pi-coding-agent` 的**直接**依赖，
实测可解析。同时声明为 optional peerDependency，只提示不强求。

**`https://` 出口的代理跳必须关掉证书校验（2026-10-19 合并上游 `6c9802e`）**：
内置免费源里有一批 `https://host:port` 地址，它们的证书是自签的或者对不上
主机名。undici 的 `ProxyAgent` 默认会在**发 CONNECT 之前**校验代理这一跳，
于是地址被判死 —— 而隧道本身可能完全可用。Bun 的 `init.proxy` 与 Node 的
`ProxyAgent({ proxyTls: { rejectUnauthorized: false } })` 都按同一规则处理。
**关掉的只是到代理的这一跳**；通过隧道打到 `cloudflare.com` / `opencode.ai`
的 TLS 仍由各自的客户端正常校验。预筛已随内置池删除；这条规则现在只作用于
真实请求与闸门/完成探测（三者共用 `transport.ts`，所以不会出现同一地址
「探测判死、真实请求可用」的偏差）。

测试钉住：`https://` 出口在 undici 侧以
`ProxyAgent({ proxyTls: { rejectUnauthorized: false } })` 构造（`transport.test.ts`），
`http://` 出口仍以字符串形式交给 `ProxyAgent`，不受这次改动影响。

**流在响应头之后断掉必须记账（2026-10-19 合并上游 `2baeb87`）**：闸门 200 与完成
探测都只覆盖一次短请求。共享代理完全可能在拿到 200、吐出几个 token 后断流，
而旧的 ✅ 仍会保留到 TTL 结束，于是菜单把一个每个新回合都失败的出口标成可用。
请求路径的 `catch` 现在把它记为 `transport`（`recordPassive`），与 429/地区拒绝
共用 `lastFailure`/`modelMarks` 语义：`isVerified` 立即失效，菜单显示「流中断」。
**只在 `poolFetch` 真的返回了 wrapper 时记**——池没开或运行时无代理机制时请求是
直连的，记到选中的出口上就是伪造观测。用户主动取消（错误名含 `Abort`）也不记。
仍然只记账、不自动换出口。

顺带确认一件事，因为它决定了要不要写两条路：**pi 无论用哪种方式安装，
内部都是 Node。** 它的 `dist/bundle/cli.js` shebang 是 `#!/usr/bin/env node`
（从安装文件读出），`engines.node >= 22.19.0`，`pi.ps1` / `pi.cmd` 都显式
`& node pi-launcher.js`。而 `bun add --global` **遵从 shebang** —— 用一个
自建包实测：`#!/usr/bin/env node` 的 shim 拉起 node；改成 `#!/usr/bin/env bun`
则尝试拉 bun 并失败。所以判断依据只能是运行时本身，不能是宿主名或安装方式。

### 2.8 上游 2026-10-18 更新：形状漂移与 Bun 运行时伪装（2026-10-19 同步）

opencode2api `a9470df..d04ff33`（7 个 commit，v1.4.2）带来两类变化：**请求形状
向官方客户端再收紧一档**，以及**传输层伪装成 Bun**。本地逐项实测如下。

**形状（必须同步，已合并）**：

| 项 | 同步前 | 新（opencode2api v1.4.2） |
| --- | --- | --- |
| `/inference` UA | `opencode/latest/2.0.29/cli` | `opencode/latest/2.0.32/cli` |
| `/inference` 的 `shell` 定义 | `Commands run on Windows using powershell.` | `Commands run on Linux using bash.`（官方 2.0.32 客户端自己的定义） |
| legacy UA | `opencode/1.18.31 (win32 x64; node…)` | `opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` |
| legacy project | `prj_<24hex>` | 裸 40-hex（1.x 客户端上报 git root commit；非 git 项目哈希成同形） |
| legacy 会话头 | `x-opencode-session` + `req_<16hex>` + 两个 affinity 头 | `x-opencode-session` + `x-opencode-session-id` + `x-opencode-request: msg_<12hex><14base62>`，**不发** affinity 头 |

`x-opencode-request` 是**用户消息 id**（官方 `Identifier.ascending()` 布局），
一轮用户消息内所有 tool step 复用同一个 id，新的一轮才换。本仓库按会话 + 用户
消息条数 memo（FIFO 1024），见 `session.ts` 的 `messageIDForRequest`。

实测（2026-10-19，Bun 1.4.3 直连）：新旧两套形状**都能拿 200**（旧形状仍被
兼容），因此本次同步是**消除可识别的偏差**，不是修复一个已复现的 403。但
`/inference` 的 shell 定义属于「上游校验定义」的那一半闸门，旧 Windows 描述
随时可能变成 403，必须跟。

**传输层（只记录，不合并）**：`d04ff33` 给网关加了 `httpx.BunTransport`
（uTLS 复刻 Bun 1.4.3 的 BoringSSL ClientHello：JA4 `t13d1713h1`、
X25519MLKEM768、ALPN 只有 `http/1.1`；再按 Bun fetch 的头顺序/大小写重排
HTTP/1.1；支持 gzip/deflate/br/zstd 增量解 SSE）。理由是官方 1.x/2.x 客户端
都跑在 Bun 上，而 Go 的 `net/http` ClientHello、HTTP/2 与头顺序都不像 Bun。

对本项目的含义分两半，**都不要现在实现**：

- **omp 跑在 Bun 上**，TLS 与头顺序天然就是 Bun 的（本机 Bun 1.4.3 正是
  上游抓包用的版本），无需干预。
- **pi 跑在 Node 上**，ClientHello 来自 OpenSSL、头顺序来自 undici。实测
  （2026-10-19，Node 24.20）：同一份 v1/v2 形状在 Node 上也是 **200**，
  说明闸门**目前不校验 TLS/头顺序**。这是预防性伪装，不是已发生的拒绝。
  若将来出现「Bun 上 200、Node 上裸 403」，先怀疑这一项；Node 复刻
  BoringSSL ClientHello 需要原生依赖，不应预先引入。

---

## 3. omp 扩展 API 的实测行为

### 3.1 `pi.registerProvider` 的 `onPayload` / `prepareRequest` 是哑字段

传这两个字段**不会报错**，但**运行时永远不会被调用**。实测：注册成功、模型出现在选择器、真实请求发出，日志里`onPayload` 一次都没触发，请求原样发出 → 403。

> **不要用这两个字段。** 这是本项目第一版的失败点，也是最容易浪费时间的坑。

### 3.2 真正的接缝是 `registerProvider` 里的 `streamSimple`（2026-10-17 修正）

> **本节此前写的是「真正的接缝是 `registerCustomApi`」，那条结论只在 omp 上成立，
> 并且直接导致 pi 启动崩溃。** 保留 `registerCustomApi` 的签名仅作 omp 侧参考。

omp 内置 pi-ai 里的签名（仅 omp 有）：

```ts
registerCustomApi(apiId: string, streamSimple: Fn, sourceId: string, stream?: Fn): void
```

**pi 1.3.0 没有 `registerCustomApi`**，也没有任何进程级 custom-API 注册表。唯一的
注册入口是 `pi.registerProvider(name, { api, streamSimple, ... })`，它在 omp 侧会内部
转发到 `registerCustomApi`（`src/config/model-registry.ts:3453-3476`）。因此统一走
`registerProvider`：

```ts
pi.registerProvider(PROVIDER, { baseUrl, api: API_ID, apiKey: 'public', authHeader: true, headers, models, streamSimple })
```

共同约束：

- `streamSimple` 入参是 `(model, context, options)`；
- 委托宿主引擎时必须把 `model.api` 换回 `'openai-completions'`，否则会递归回自己的 handler；
- `toolChoice` 在 `options` 上，不在 context 上。

**context 形状两侧不同**（这是适配层存在的根本原因）：

| | omp 18.11.3 | pi 1.3.0 |
| --- | --- | --- |
| context | 结构化：`systemPrompt` / `messages` / `tools` | **transcript**：prompt 和工具声明在 leading system message |
| 取工具 | `context.tools` | `getCurrentTools(messages)` |
| 写回工具 | `{ ...ctx, tools }` | 折叠后写 leading system message 的 `toolsAdded` |
| 流终止 | `fail(err)` | 只有 `end()` |
| 错误状态 | 有 `errorStatus` | 无，状态折进文本 `"<status>: <body>"` |
| logger | 有 `pi.logger` | **没有** |

`pi.logger` 的有无就是两者的判别信号（`src/index.ts` 的 `detectAdapter`）。

### 3.2b pi 会覆盖 `x-opencode-session`（2026-10-17 实测，形状闸门在 pi 上失败的唯一原因）

只要 `baseUrl` 是 `opencode.ai`，pi 就认为这是它自己的 provider：

- `core/provider-attribution.ts:67-77` 从 `transformHeaders` 钩子写入
  **pi 自己的** session id 与 `x-opencode-client: pi`；
- 该钩子在 model headers 解析**之后**执行，合并顺序把宿主值放**最后**
  （`core/sdk.ts:354-364`）。

所以只挂在 `model.headers` 上的 session 头会被静默替换成 pi 的 UUID。上游闸门要求
`x-opencode-session` 是规范 `ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`，于是返回裸
`FreeTierError`——**与 omp 同一请求的结果差异只有这一处**（omp 429 = 过闸门，pi
FreeTierError = 被形状拒绝）。

修法：session 头**同时**挂到 `options.headers`。该层作为 `requestHeaders` 传入归属钩子，
而钩子最后才 apply 它，所以我们的值胜出。回归测试 `test/session-headers.test.ts`。

### 3.2c 附带实测：pi 会带上 `x-stainless-*` 与 `stream_options`

pi 的 openai-completions 走官方 `openai` SDK，请求因此多出 `x-stainless-*` 系列头、
`stream_options.include_usage`，并用 `max_completion_tokens` 而非 `max_tokens`。实测
**这些都不影响闸门**（修复 session 头后 pi 与 omp 返回同一个 429）。记录在此以免将来
误判为形状差异。

### 3.3 omp 内置的 pi-ai 是 1.x，API 面与 opencode2dsh 依赖的不同

`opencode2dsh` 锁的是 `@earendil-works/pi-ai@^0.82.1`，用 `createProvider()` + `openaiCompletions`。**omp 内置的版本里这两个导出已经不存在**（已核对 307 个导出）：

- ❌ 没有：`createProvider`、`openaiCompletions`
- ✅ 有：`streamSimple`、`streamSimpleOpenAIResponses`、`registerCustomApi`、`getCustomApi`、`clearCustomApis`、`AssistantMessageEventStream`

结论：**DSH 那套写法不能照搬**，必须走 provider 注册 + 宿主引擎委托。

### 3.4 import 说明符

`@earendil-works/*` 会被 omp 的 legacy-pi compat shim 改写到宿主内置副本，实测可用；pi
侧由 jiti alias 指向 `ai/dist/compat.js`。宿主类型包是 `@oh-my-pi/pi-coding-agent`（仅
类型，运行时会被擦除）。运行时导入一律写在 `src/host/` 内，由 `test/host-boundary.test.ts`
断言这条分层规则不被破坏。

### 3.5 命令行细节

- `--provider <id>` 在扩展加载前就做校验，会报 `Unknown provider`。扩展注册的 provider 必须用 `--model <provider>/<model>` 形式指定。
- `-e <path>` 支持绝对路径与相对路径。

### 3.6 omp 的 select 不是不显示 description，是会自动折叠（2026-10-17 实测）

现象：出口池菜单在 pi 上每行都带检测结果，在 omp 上只有当前高亮那一行带。
第一反应是「omp 不支持」，不是。omp 的 `select` 收
`ExtensionUISelectItem = string | {label, description?}`
（`extensibility/extensions/types.ts:151-156`），一路透传到
`HookSelectorComponent`（`packages/tui/src/overlays/hook-selector.ts`），
`#renderOptionLines` 确实会把 description 渲染成第二行。

真正的原因是 **compact 模式**（同文件 `:577-578`）：

```ts
#isSearchEnabled(renderWidth, mdTheme) {
  return this.#totalOptionRows(this.#options, renderWidth, mdTheme) > this.#maxVisible
}
```

`maxVisible = max(4, min(15, terminal.rows - 12))`，也就是**最多 15 行**。
一旦「所有行都展开 description」的总行数超过这个预算，就进入 compact：
所有行塌成 label，**只有高亮行的 description 单独渲染**在下方
（`:505` 的 `descMode = compact ? (isSelected ? selectedDescRows : 0) : "full"`），
并顺带开启搜索框。

出口池的行天然是「多行 + 长描述」，几乎必然触发。所以这不是能力差异，
是行数预算。要在 omp 上也看到全部检测结果，只能缩短 description。

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

## 8. 实现期新增的实测结论（2026-10-05，T2–T6）

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

### 8.7 omp 同时认 `pi` 和 `omp` 两个 manifest key

实测方法：造两个最小包，一个只声明 `pi.extensions`、一个只声明 `omp.extensions`，
分别 `omp install` 后看扩展里的 `console.error` 是否打印，然后卸载。

| 包内容 | omp 是否加载 |
| --- | --- |
| 只有 `pi.extensions`（无 `omp` key） | ✅ 加载 |
| 只有 `omp.extensions`（无 `pi` key） | ✅ 加载 |

即 **`omp` key 是 omp 的原生声明，`pi` key 是它对上游 pi 的兼容**，不是「omp 靠兼容 pi 格式」。
因此 `package.json` 里两个 key 都要写：pi 只认 `pi`（未实测，但 `omp` 是分叉扩展，
pi 不可能认识它），omp 则走各自最优路径。

**一个 npm 包即可同时服务 pi 和 omp，不需要发两个包。**

### 8.8 宿主支持的安装源（实测）

`omp install --dry-run` 逐个验证：

| 源 | 结果 |
| --- | --- |
| `npm:opencode2pi` | ✅ |
| `git:https://github.com/<owner>/<repo>` | ✅ |
| `https://github.com/<owner>/<repo>` | ✅ |
| 本地目录 `./my-ext` | ✅ |
| **`.tgz` 压缩包** | ❌ `Failed to link: package.json not found at ...tgz` |

推论：**GitHub Release 的 tarball 附件不能作为安装路径**，只是存档。
没有 npm 时真正的免发布路径是 git ref（`git:<url>@<tag>`）。

### 8.9 `fetchDynamicModels` 不能用来做过滤：缓存 24h，且会话内不重跑（2026-10-09 实测）

现象：TUI 里跑完 `/opencode2pi filter`，`/model` 里被隐藏的模型**一个没少**，
连不在种子里的新发现模型也还在。

两条独立的宿主行为叠加导致（源码 `src/config/model-registry.ts` +
`@oh-my-pi/pi-catalog` 的 `model-manager.ts`）：

1. **重新注册不会重跑发现。** `registerProvider` 只重建该 provider 的静态 overlay
   切片；`fetchDynamicModels` 那一段只把 fetcher 存进 `#runtimeModelManagers`，
   源码注释写得很直白：*“Discovery is driven by refreshRuntimeProviders() after the
   drain — not here.”* 会话启动时已经合并进来的动态行就留在注册表里。
2. **动态缓存的指纹与我们的静态列表无关。** 建 manager 时传的是 `staticModels: []`，
   而 `cacheFingerprint()` 在 `dynamicModelsAuthoritative` 下只对这份空静态列表取
   指纹。缓存 TTL 是 24h，命中时**根本不调用 fetcher**。所以「在 fetcher 里过滤」
   只在第一次、缓存还冷的时候有效。

推论：**不要注册 `fetchDynamicModels`**（`opencode2pi-cli` 早就这么做了）。发现由
扩展自己跑，模型列表由扩展自己以静态 `models` 整体发布 —— 重新注册同名 provider 会
整体替换它的模型切片（实测：`[a,b,c]` → 重新注册 `[a]` 后 `getProviderModels`
只剩 `[a]`，`find('b')` 为 undefined），这是唯一可靠的收敛点。

代价与对策：静态 `models` 必须在注册时就有值（§7.3），所以流程是「先注册种子 →
再 `await` 发现 → 重新注册」。宿主的扩展加载会 `await` 工厂函数、之后才排空注册
队列（`extensibility/extensions/loader.ts`），所以这一次 `await` 换来的是
`--model provider/id` 能解析到种子以外的 id；实测发现耗时 0.3–0.7s。
