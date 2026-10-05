# opencode2pi

在 **omp** / **pi** 里使用 [OpenCode Zen](https://opencode.ai/zen) 的**匿名免费模型**。

**无需 API key · 无需注册 · 无需登录 · 无需子进程 · 无需本地端口**

宿主内建的 `opencode-zen` provider 需要付费 `OPENCODE_API_KEY`；本扩展走的是Zen 的匿名通道（`Authorization: Bearer public`），拿到的是那一批免费模型。

---

## 现状

核心链路已跑通并实测（omp 18.6.1，2026-10-05）：

```
$ omp -e ./src/index.ts -p --model opencode-zen-free/mimo-v2.6-flash-free "Reply with exactly OK"
Working...
OK
```

### 模型列表与能力参数

列表是**自动发现**的，三级来源（任一失败都自动降级，绝不会把 provider 变成空的）：

| 级 | 来源 | 作用 |
| --- | --- | --- |
| S1 | `GET {zen}/v1/models` | 谁现在真的在售 |
| S2 | [models.dev](https://models.dev) | 免费判定 + 真实能力参数（本地缓存 24h） |
| S3 | `src/seed.ts` 静态种子 | 完全离线时的兜底 |

实测当前发现 **13 个** 免费模型（原先硬编码 5 个）。付费模型不会进列表。

能力参数（`contextWindow` / `maxTokens` / `cost` / 图片 modality / reasoning effort）来自 models.dev，
按宿主契约**扁平映射**——嵌套 `limits: {context, output}` 会被宿主静默忽略并回落到 128000/16384，
这是 `docs/FINDINGS.md` §7.2 记录的坑。任何字段缺失都会**显式落到保守默认值并写进日志**，不会静默。

冷启动 `--model` 用的是静态种子：异步发现来不及参与 `--model` 解析（`docs/FINDINGS.md` §7.3）。

### 其它

| 能力 | 说明 |
| --- | --- |
| session 亲和 | session id 按**会话**派生（取自宿主的 `options.sessionId`，已实测存在），同会话多轮稳定，不同会话互不污染 |
| 错误分类 | 上游报错会被归类成人能看懂的原因，见下方排障表 |

宿主模型元数据契约已实测确认（含一个会静默失效的坑），见 [`docs/FINDINGS.md` §7](docs/FINDINGS.md)。

---

## 安装（开发态）

```sh
git clone https://github.com/FanchangWang/opencode2pi.git
cd opencode2pi

# 单次会话
omp -e ./src/index.ts -p --model opencode-zen-free/big-pickle "你好"

# 常驻（写入 agent 目录）
cp src/index.ts ~/.omp/agent/extensions/opencode2pi.ts
```

> 用 `--model <provider>/<model>`，**不要**用 `--provider` —— 扩展注册的 provider 在参数校验阶段还不可见，会报 `Unknown provider`。
> 同理，`omp models` **不列出**扩展注册的 provider（实测），查清单请用会话内的 `/model`。

---

## 工作原理

Zen 的匿名通道不是靠凭据鉴权，而是**请求形状校验**。三个条件缺一即 403：

1. `Authorization: Bearer public`
2. 规范 session id：`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`
3. agent 形态 body：`stream: true` **且** `tools` 里同时有 `bash` 和 `read`

第3 条有两个独立部分，只满足一半照样被拒：

```
stream:true  + tools:[bash,read]  →  200 ✅
stream:false + tools:[bash,read]  →  403
stream:true  + 无 tools            →  403
```

所以本扩展做的事只有一件：**给宿主的引擎补上闸门要求的形状**，其余全部委托。

流式引擎、tool call 分片聚合、reasoning、图片 modality、模型选择器 —— 全部由 omp/pi 内建，本扩展不重复实现。

---

## 排障

| 现象 | 归类 | 原因 / 处理 |
| --- | --- | --- |
| `Unknown provider "opencode-zen-free"` | — | 用了 `--provider`。改用 `--model opencode-zen-free/<id>` |
| `上游形状闸门拒绝（FreeTierError）` | `SHAPE_REJECTED` | 闸门条件被破坏，通常是代码回归 —— 先核对上面三个条件，然后提 issue |
| `该模型在当前网络地区不可用（RegionError）` | `REGION_BLOCKED` | **地区封锁，不是凭据问题**。换模型或换网络节点 |
| `模型已下线（ModelError）` | `MODEL_GONE` | 上游已不再支持该模型 |
| `匿名配额按出口 IP 限流（429）` | `RATE_LIMIT` | 等配额恢复，或设 `PI_PROXY_OPENCODE_ZEN_FREE` 换出口 |
| `上游拒绝了请求（400）` | `REQUEST_REJECTED` | 模型无法处理这次输入，最常见是给只支持文本的模型发图片 |
| `上游暂时不可用（5xx）` | `UPSTREAM` | 上游临时故障，换模型重试 |

---

## 文档

- [`docs/FINDINGS.md`](docs/FINDINGS.md) —— **实测结论**：闸门的精确条件、omp 扩展 API 的真实行为（含两个会浪费时间的坑）、现有同类扩展为什么都不能用
- [`docs/PLAN.md`](docs/PLAN.md) —— 剩余实现任务、顺序、验收标准

---

## 致谢

灵感与闸门条件的逆向，来自 [`FishBottle7/opencode2dsh`](https://github.com/FishBottle7/opencode2dsh)（DSH 版的同类工具，其 `legacy/` 里的 Go sidecar 源自 [`opencode2api`](https://github.com/jasonxu114514/opencode2api)）。

## 许可证

MIT