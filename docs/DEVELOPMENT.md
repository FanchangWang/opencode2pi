# 开发文档

面向要改这个扩展的人。**只想用它，请看 [README](../README.md)。**

前置阅读：[`FINDINGS.md`](FINDINGS.md) 里的实测结论是本文件所有设计的前提，不要重复推导。

---

## 1. 上游闸门：三个必要条件

Zen 的匿名通道不靠凭据鉴权，而是**请求形状校验**。三个条件缺一即 `403 FreeTierError`：

| # | 条件 | 违反时的报错 |
| --- | --- | --- |
| 1 | `Authorization: Bearer public`（字面量） | 401 |
| 2 | 规范 session id `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$` | `MissingSessionID` / 403 |
| 3 | agent 形态 body：`stream: true` **且** `tools` 同时含 `bash` 和 `read` | 403 FreeTierError |

条件 3 有**两个独立部分**，只满足一半照样 403：

```
stream:true  + tools:[bash,read]  →  200 ✅
stream:false + tools:[bash,read]  →  403
stream:true  + 无 tools            →  403
```

完整模型矩阵见 [`FINDINGS.md`](FINDINGS.md) §2。**注意 `RegionError`（地区封锁）
和 `FreeTierError`（形状闸门）是两回事**，错误分类必须分开。

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

### 2.3 宿主类型从哪来

宿主在运行时把 `@earendil-works/*` 改写到它**内建**的 pi-ai 副本（legacy-pi compat shim）。
类型包用 `@oh-my-pi/pi-coding-agent`，版本要和 omp 对齐（本项目锁 `18.6.1`）。

**npm 上那个同名的 `@earendil-works/pi-ai` 是个更早的构建，没有 `registerCustomApi`，
故意不装** —— 装了反而会把类型指向一个宿主根本没有的 API 面。`src/host.d.ts` 把
说明写在了声明旁边。

### 2.4 容易踩的三个契约细节

| 细节 | 结论 |
| --- | --- |
| `toolChoice` 在哪 | 在 **`StreamOptions`** 上，不在 `Context` 上。设在 context 里是静默 no-op |
| `Context` 的字段 | 只有 `systemPrompt` / `messages` / `tools` / `inactiveTools` |
| 模型元数据 | 嵌套 `limits: {context, output}` 被**静默忽略**，回落到 128000/16384 不报错 |

`SessionOptions.sessionId` 运行时存在（实测 UUID），但**不在**发布的类型里，
所以用运行时收窄读取，不要 `as` 断言。

---

## 3. 模块地图

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | provider 注册、闸门形状补全、错误流转发、命令注册 |
| `src/seed.ts` | 静态种子（冷启动必需）+ 已知失效 id |
| `src/metadata.ts` | models.dev → 宿主扁平模型契约；免费判定 |
| `src/discovery.ts` | 三级发现阶梯、并发、15s 预算、落盘缓存 |
| `src/session.ts` | 按会话派生 session id |
| `src/errors.ts` | 上游失败分类 |
| `src/gate.ts` | **共享**的闸门形状请求（doctor 与健康探测共用同一份） |
| `src/doctor.ts` | 闸门自检 |
| `src/health.ts` | 逐模型探测、判定规则、落盘缓存 |
| `src/commands.ts` | `/opencode2pi` 斜杠命令与 TUI |

> `gate.ts` 单独存在是有原因的：如果 doctor 和健康探测各写一份形状，两者一旦漂移，
> doctor 会报「闸门正常」而真实路径已经失效 —— 那正是这段代码唯一要抓的故障。

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
- 通道级失败（`SHAPE_REJECTED` / `AUTH`）**不记到模型头上** —— 那是全roster 的问题，不是某个模型的

### 4.5 健康状态只标注，不隐藏

任何情况下都不用健康状态去过滤模型列表。

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

`/opencode2pi doctor` 和 `/opencode2pi probe` 需要交互式 TUI，打印模式下不可用。

---

## 6. 发布

打 `vX.Y.Z` tag 触发 [`.github/workflows/release.yml`](../.github/workflows/release.yml)：

校验 tag 与 `package.json` 版本一致 → `npm ci` → typecheck → test →
校验 tarball 产物完整 → 发布 npm → 建 GitHub Release → 前移 `stable` ref。

### `stable` ref：README 里不该出现版本号

README 的 git 安装命令写 `@stable`，不发版就不需要改它 —— 手改版本号这件事
只会在某一次发版被漏掉，而漏掉时没有任何报错：文档安静地指向上一版。
workflow 在 tag 推送后执行 `git push origin "$GITHUB_SHA:refs/heads/stable"`，
把 `stable` 前移到本次发版的 commit。

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

**Release 步骤始终执行**（`if: always()`），且 notes 会写明这次有没有发上 npm、
走的是哪条认证路径。

### 首次发布必须用一次 token

Trusted Publisher 是在 npmjs.com 的**包的 Settings 页面**里配置的，包还不存在时
没有这个页面。所以第一次发布只能用 token（创建 token 时需要勾 2FA bypass）。
配好 Trusted Publisher 后就可以删掉 `NPM_TOKEN` secret，workflow 不用再改。

### ⚠️ 配置 Trusted Publisher 时必须勾 "Allow npm publish"

2026-09-03 之后新建的 Trusted Publisher 配置**默认只允许 `npm stage publish`**，
是否同时允许直接 `npm publish` 需要手动勾选。本项目用的是 `npm publish`，不勾就会发布失败。
而 **npm 保存配置时不校验**，错误只在真正发布那一刻才暴露。

### 其它

- 宿主**不支持**直接安装 `.tgz` 文件（实测报 `package.json not found`）。支持的源是：
  npm spec、git ref、`https://` 仓库地址、本地目录。所以 release 里的 tarball 附件
  只作存档，不是安装路径；没有 npm 时真正的免发布路径是
  `omp install git:https://github.com/FanchangWang/opencode2pi@vX.Y.Z`
- 一次 `npm publish` 同时服务两个宿主：`pi install npm:opencode2pi` 和
  `omp install npm:opencode2pi` 都从 npm 解析，pi.dev 的包目录也是索引 npm，没有独立 registry

---

## 7. 明确不要做的事

- ❌ 不要用 `onPayload` / `prepareRequest`（哑字段）
- ❌ 不要引入 `createProvider` / `openaiCompletions`（宿主 1.x 里没有这两个导出）
- ❌ 不要返回嵌套 `limits`（静默失效）
- ❌ 不要只给 `fetchDynamicModels` 不给静态种子（冷启动失败）
- ❌ 不要 spawn 子进程，不要移植 IP 池（宿主代理是进程内缓存，运行时改环境变量不生效）
- ❌ 不要照抄 opencode2dsh 的重试策略（匿名通道重试轰炸会挤掉自己的配额）
