# opencode2pi

在 **omp** / **pi** 里直接用 [OpenCode Zen](https://opencode.ai/zen) 的**匿名免费模型**。

**无需 API key · 无需注册 · 无需登录 · 无需子进程 · 无需本地端口**

> ⚠️ **这是匿名免费通道，上游随时可能改闸门或直接关停。**
> 它不依赖任何凭据，所以上游一旦调整请求形状校验，本扩展会**全线 403**。
> 出问题先跑 `/opencode2pi doctor`，它会直接告诉你闸门还在不在。

---

## 安装

```sh
# 推荐：npm（已发布，自动带 provenance）
omp install npm:opencode2pi
pi  install npm:opencode2pi

# 备用：git @stable（最近一次发版）
omp install git:https://github.com/FanchangWang/opencode2pi@stable
pi  install git:https://github.com/FanchangWang/opencode2pi@stable

# 追踪最新代码：装的是"此刻 main 指向的 commit"，含未发布的改动，之后不会自动更新
omp install git:https://github.com/FanchangWang/opencode2pi@main
pi  install git:https://github.com/FanchangWang/opencode2pi@main
```

**为什么 npm 优先**：git 装的是源码快照，宿主要现读现编译；npm 装的是已发布的
tarball，带 provenance 签名（可在 npmjs.com 包页面核验），且 tag 与版本号一一对应。
注意 **omp/pi 不支持直接装 `.tgz` 文件**（实测报 `package.json not found`），
所以只能用 npm spec 或 git URL。

`@stable` 是最近一次发版的版本，随发版前移；要固定到某一版，去
[releases](https://github.com/FanchangWang/opencode2pi/releases) 挑一个 tag，
把 `@stable` 换成那个 tag 名或 commit SHA。上游随时可能改闸门，只有钉死才能复现"当时能用"的状态。

`@latest` 用不了：git 没有这个 ref，omp 解析会报错。

### 从源码运行（开发用）

```sh
git clone https://github.com/FanchangWang/opencode2pi.git
cd opencode2pi

# 链接当前目录：改代码立即生效，不用重装
omp install .

# 单次试用，不落盘
omp -e ./src/index.ts -p --model opencode-zen-free/big-pickle "你好"
```

`omp install .` 是**链接而非拷贝**：装的是路径，所以改 `src/` 下的代码下次启动就生效。
代价是删掉或移动这个目录，扩展就失效了 —— 所以本地开发用它，给别人用请走上面的 npm 或 git。

> **不要只复制 `src/index.ts`**。扩展是多文件模块，`index.ts` 依赖同目录的其它模块。
> 要手动常驻就整目录复制：`cp -r src ~/.omp/agent/extensions/opencode2pi`。

---

## 使用

### 选模型

会话里用 `/model` 选择，provider 名是 `opencode-zen-free`。

命令行要用 `--model <provider>/<model>`，**不要**用 `--provider`：

```sh
# 对
omp -p --model opencode-zen-free/big-pickle "你好"

# 错，会报 Unknown provider
omp --provider opencode-zen-free
```

> 扩展注册的 provider 在参数校验阶段还不可见，所以 `--provider` 一定失败。
> 同理 `omp models` **不列出**这个 provider，查清单请用会话内的 `/model`
> 或 `/opencode2pi status`。

### 模型列表是自动发现的

免费池轮换频繁，所以列表不是写死的，而是实时发现 + 元数据判定：

| 级 | 来源 | 作用 |
| --- | --- | --- |
| S1 | `GET {zen}/v1/models` | 谁现在真的在售 |
| S2 | [models.dev](https://models.dev) | 免费判定 + 真实能力参数 |
| S3 | 内置静态种子 | 完全离线时的兜底 |

实测当前发现 **7 个** 免费模型（2026-10-11 实测后从 13 个减下来，恒定被拒的
id 已进 denylist，见 `docs/FINDINGS.md` §2.2）。付费模型不会进列表；断网也能用
（退回内置种子，能力参数不会变成错误的默认值）。

### 图片输入

能否附加图片取决于模型本身。把图片作为消息的一部分传入即可：

```sh
omp -p "@photo.png" "这张图是什么颜色？"
```

只支持文本的模型会收到明确的拒绝提示，而不是模糊的 400。

### 能力参数

上下文长度、最大输出、计价、reasoning effort 都取自 models.dev 的真实数据，
不是拍脑袋的默认值。某个字段上游没给时，会落到**保守默认值并写进日志**，
而不是悄悄用一个错的数字。

---

## `/opencode2pi`

omp 没有扩展设置页，斜杠命令是本扩展唯一的界面。

| 命令 | 作用 |
| --- | --- |
| `/opencode2pi doctor` | 检查**形状闸门是否仍然成立**。上游一改闸门，这里立刻告警 |
| `/opencode2pi status` | 显示上次探测的结果；**从未探测过的模型（含新发现的）会当场补测** |
| `/opencode2pi probe` | 重新探测全部模型 |
| `/opencode2pi filter` | 选择要在 `/model` 里隐藏哪些模型（默认一个都不隐藏） |
| `/opencode2pi pool` | 出口池：换一个出口 IP（本机配额用尽、或地区封锁时用） |

不带参数执行会弹出五项菜单。

### 配额用尽时换出口 IP（出口池）

匿名通道按**出口 IP** 记每日额度。额度用完时上游对所有请求回 429，这时换一个出口
（代理）就能继续用 —— 但**换不换由你决定，扩展不会自己转**：出口可能更慢、可能看到你的
请求，匿名通道上乱重试还会把自己的额度挤掉。

`/opencode2pi pool` 的菜单：

| 项 | 做什么 |
| --- | --- |
| 开启 / 关闭出口池 | 关着的时候请求完全按原样发出（本机 IP 或你原来的 `PI_PROXY`），选择保留着 |
| 选择出口并测试… | 列出全部出口（带屏检、闸门结论）；**切换前先跑一次闸门探测**，把结果念给你听，再问你确不确定 |
| 补充内置免费出口… | 拉取公开免费代理列表并逐个屏检，用于你自己的出口都用尽时 |
| 重新屏检全部出口 | 只走一次 cloudflare trace：不消耗上游配额，随时可刷新 |
| 删除出口… | 从池里移除内置出口，或从 `exits.txt` 移除手动出口 |

出口分两层：

- **手动出口**：数据目录里的 `exits.txt`，一行一个，你自己的代理。格式
  `host:port` 或 `http://user:pass@host:port`（只支持 http/https；socks 在 Bun 的 fetch 上
  实测不可用）。凭据只留在这个文件里，`pool.json` 里只有哈希。
- **内置出口**：从公开免费列表拉取、屏检通过后入池，用于手动出口用尽时 —— 它们是
  **第三方代理**，只在必要时用。

两种测量，因为问题不同：

| 测量 | 走什么请求 | 花费 | 回答什么 |
| --- | --- | --- | --- |
| 屏检 | cloudflare `/cdn-cgi/trace` | 0 配额 | 这个代理通不通、出口 IP 与地区、延迟分级（S/A/B/C，超过 3s 不算可用） |
| 闸门探测 | 真实形状的最小请求 | 少量配额 | 上游匿名通道**接受**这个出口吗（429 / 地区封锁 / 链路失败） |

**429 和地区封锁不等于坏出口**：配额按模型记账，同一个出口通常还能跑别的模型。所以真实
请求失败时，扩展只在该出口上记一笔（`429`/`地区拒绝`，按模型），下次打开 `pool` 就能看到
实际发生了什么 —— 它不会替你换出口。

### 健康标记

| 标记 | 含义 |
| --- | --- |
| ✅ | 可用 |
| ⚠️ | **现在不行**（5xx、400、无法归类的错误），不代表模型没了 |
| 🚧 | **配额受限**（429 / transport 超时）。这是通道的匿名额度用完了，不是模型的问题，等一会儿会自动恢复 |
| ❌ | 确定死了（地区封锁，或连续两次 `ModelError`） |
| ❓ | 闸门或凭据被拒 —— 全 roster 的问题，跑 `doctor` |

每行末尾直接带上原因（HTTP 状态与上游原文）和探测时间，所以不存在
「这个模型到底怎么回事」需要另外去查的情况。超过 6 小时的结果标 `（已过期）`，
并提示你去跑 `probe` —— `status` 不会替你重探。

**默认只标注、不隐藏。** 这条通道波动很大，单次失败不足以判死刑 ——
实测有模型一分钟内先 `401 ModelError`、再 `200`，所以一次 `ModelError` 只标 ⚠️，
连续两次才升级 ❌，任何一次成功都会清零。

### 想让失败的模型不出现在 `/model` 里

`/opencode2pi filter`（或每次 `probe` 结束后自动询问）可以隐藏地区封锁的、以及所有
探测失败的模型。这个选择记在数据目录的 `filters.json` 里，重启后仍然有效；
随时可以改回「全部保留」。

**配额耗尽和链路故障不会隐藏任何模型**：那是通道的状态，不是模型的。被隐藏的只是
不进 `/model` 与 `--model`，`status` 里照样能看到全部。

---

## 排障

### 先跑 doctor

大部分「全都不能用」的情况，先跑 `/opencode2pi doctor`。它会直接告诉你闸门还在不在。

### 错误对照表

扩展会把上游错误翻译成人能看懂的原因：

| 你看到的 | 归类 | 原因 / 处理 |
| --- | --- | --- |
| `上游形状闸门拒绝（FreeTierError）` | `SHAPE_REJECTED` | 闸门条件被破坏，通常是代码回归 —— 提 issue |
| `该模型在当前网络地区不可用（RegionError）` | `REGION_BLOCKED` | **地区封锁，不是凭据问题**。换模型或换网络节点 |
| `模型已下线（ModelError）` | `MODEL_GONE` | 上游已不再支持该模型 |
| `匿名配额按出口 IP 限流（429）` | `RATE_LIMIT` | 等窗口滚动，或 `/opencode2pi pool` 换一个出口 |
| `上游拒绝了请求（400）` | `REQUEST_REJECTED` | 模型无法处理这次输入，最常见是给只支持文本的模型发图片 |
| `上游暂时不可用（5xx）` | `UPSTREAM` | 上游临时故障，换模型重试 |

### 其它常见问题

| 现象 | 处理 |
| --- | --- |
| `Unknown provider "opencode-zen-free"` | 用了 `--provider`。改用 `--model opencode-zen-free/<id>` |
| `omp models` 查不到这个 provider | 已知行为（实测），用会话内 `/model` 或 `/opencode2pi status` |
| 断网了还能用吗 | 能。退回内置种子，能力参数是正确的实测值 |

---

## 它做了什么、没做什么

宿主内建的 `opencode-zen` provider 需要付费 `OPENCODE_API_KEY`；本扩展走的是 Zen 的
匿名通道（`Authorization: Bearer public`），拿到的是那一批免费模型。

流式引擎、tool call 分片聚合、reasoning、图片 modality、模型选择器 —— 全部由
omp/pi 内建，本扩展不重复实现。它只补上匿名通道要求的那部分请求形状，
其余全部委托给宿主。细节见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)。

**不做**：付费 Zen 通道、OpenAI/Anthropic 协议互转、子进程、**自动**换出口
（出口池是显式开关 + 手动选择；换与不换由你决定，见上文）。

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 架构、闸门条件、宿主 API 实测行为、模块说明、验证与发布流程 |
| [`docs/FINDINGS.md`](docs/FINDINGS.md) | 实测结论存档：闸门精确条件、宿主扩展 API 的真实行为、同类扩展为什么都不能用 |
| [`docs/PLAN.md`](docs/PLAN.md) | 任务清单与验收标准 |
| [`AGENTS.md`](AGENTS.md) | 给接手的 AI：项目地图、验证命令、别踩的坑 |

---

## 致谢

灵感与闸门条件的逆向，来自 [`FishBottle7/opencode2dsh`](https://github.com/FishBottle7/opencode2dsh)
（DSH 版的同类工具，其 `legacy/` 里的 Go sidecar 源自 [`opencode2api`](https://github.com/jasonxu114514/opencode2api)）。

## 许可证

MIT
