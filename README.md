# opencode2pi

在 **omp** / **pi** 里直接用 [OpenCode Zen](https://opencode.ai/zen) 的**匿名免费模型**。

**无需 API key · 无需注册 · 无需登录 · 无需子进程 · 无需本地端口**

> ⚠️ **这是匿名免费通道，上游随时可能改闸门或直接关停。**
> 它不依赖任何凭据，所以上游一旦调整请求形状校验，本扩展会**全线 403**。
> 出问题先跑 `/opencode2pi doctor`，它会直接告诉你闸门还在不在。

---

## 安装

```sh
# 推荐：npm（pi 与 omp 都从这个源装；npm 还没上线时用下面的 git）
omp install npm:opencode2pi
pi  install npm:opencode2pi

# 不走 npm：钉到 release tag，可复现。注意：omp/pi 不支持 .tgz，只能用 git
omp install git:https://github.com/FanchangWang/opencode2pi@v0.1.0
pi  install git:https://github.com/FanchangWang/opencode2pi@v0.1.0

# 追踪最新代码：装的是"此刻 main 指向的 commit"，之后不会自动更新，要更新就重跑这一行
# 建议优先用 tag —— 上游随时可能改闸门，钉 tag 才能复现"当时能用"的状态
omp install git:https://github.com/FanchangWang/opencode2pi@main
pi  install git:https://github.com/FanchangWang/opencode2pi@main
```

没有 `latest` 这种写法：那是 npm 的概念，git 里没有对应 ref（实测报 `#latest failed to resolve`）。
想要"自动拿最新"，只有 npm 那条路才有。

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

实测当前发现 **13 个** 免费模型。付费模型不会进列表；断网也能用（退回内置种子，
能力参数不会变成错误的默认值）。

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
| `/opencode2pi status` | 查看当前每个模型的健康标记（必要时自动重新探测） |
| `/opencode2pi probe` | 强制重新探测全部模型（4 并发） |

### 健康标记

| 标记 | 含义 |
| --- | --- |
| ✅ | 可用 |
| ⚠️ | **现在不行**（429 / 5xx / 超时），不代表模型没了 |
| ❌ | 确定死了（地区封锁，或连续两次 `ModelError`） |
| ❓ | 未测试，或返回了无法归类的错误 |

**模型永远只标注、不隐藏。** 这条通道波动很大，单次失败不足以判死刑 ——
实测有模型一分钟内先 `401 ModelError`、再 `200`，所以一次 `ModelError` 只标 ⚠️，
连续两次才升级 ❌，任何一次成功都会清零。

探测结果会落盘缓存 6 小时，不会每次启动都全探一遍。

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
| `匿名配额按出口 IP 限流（429）` | `RATE_LIMIT` | 等配额恢复，或设 `PI_PROXY_OPENCODE_ZEN_FREE` 换出口 |
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

**不做**：付费 Zen 通道、OpenAI/Anthropic 协议互转、IP 池轮换、子进程。

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
