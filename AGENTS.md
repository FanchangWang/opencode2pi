# AGENTS.md

给接手 opencode2pi 的 AI。**动手前先读完本文件**，再按下面的顺序读文档。

---

## 这是什么

一个 omp/pi 扩展，把 [OpenCode Zen](https://opencode.ai/zen) 的**匿名免费通道**
暴露成一个原生 provider：零 API key、零登录、零子进程、零本地端口。

上游不靠凭据鉴权，而是**请求形状校验**。扩展的全部工作就是给宿主的引擎补上那个形状，
其余（流式、tool call 聚合、reasoning、图片 modality、模型选择器）全部委托。

---

## 先读这三份，按顺序

| 顺序 | 文件 | 为什么 |
| --- | --- | --- |
| 1 | [`docs/FINDINGS.md`](docs/FINDINGS.md) | **实测结论，不要重新推导**。每条都是抓包级对比跑出来的，重验成本很高 |
| 2 | [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 架构、模块地图、关键设计决策的理由 |
| 3 | [`docs/PLAN.md`](docs/PLAN.md) | 已完成任务清单 + 验收标准（全部已完成，作为历史记录） |

只想**用它**的话看 [`README.md`](README.md) 就够了。

---

## 改代码前必须知道的事

这些是本项目最贵的教训，都是实测踩出来的，**不要凭直觉推翻**：

1. **闸门三个条件缺一即 403**，且第 3 条有两个独立部分（非流式一律被拒）。
   详见 `FINDINGS.md` §2。**对话返回 403 时先查这三个条件，不要改别的地方。**

2. **`onPayload` / `prepareRequest` 是哑字段** —— 传了不报错，运行时永不调用。
   真正能用的接缝是 `registerCustomApi(apiId, streamSimple, sourceId)`。

3. **`toolChoice` 在 `StreamOptions` 上，不在 `Context` 上。** 设在 context 里是静默 no-op。

4. **模型元数据必须扁平**：`contextWindow` / `maxTokens` / `cost` / `input` /
   `reasoning` / `thinking.efforts` 会被采纳；嵌套 `limits: {context, output}`
   被**静默忽略**并回落到 128000/16384，**不报任何错**。这是最难查的一类 bug。

5. **静态 `models` 种子是必需的**，否则冷启动 `--model` 直接 `not found`
   （异步发现来不及参与参数解析）。

6. **宿主类型从 `@oh-my-pi/pi-coding-agent` 取，版本要对齐 omp**（本项目锁 18.6.1）。
   **不要装 npm 上的 `@earendil-works/pi-ai`** —— 它是更早的构建，没有
   `registerCustomApi`，装了会把类型指向宿主根本不存在的 API 面。
   原因写在 `src/host.d.ts` 里。

7. **一次失败不能判死模型。** 实测有模型一分钟内先 `401 ModelError` 再 `200`。
   连续两次才升级为死；任何一次成功清零。

8. **地区封锁 ≠ 凭据问题。** `RegionError` 和 `FreeTierError` 都是 403/401，
   判定顺序错了会把地区问题误报成 API key 无效。

---

## 项目地图

```
src/
  index.ts      provider 注册 · 闸门形状补全 · 错误流转发 · 命令注册
  seed.ts       静态种子（冷启动必需）+ 已知实测失效的 id
  metadata.ts   models.dev → 宿主扁平模型契约；免费判定顺序
  discovery.ts  三级发现阶梯（S1 实时列表 / S2 元数据 / S3 种子），15s 预算
  session.ts    按会话派生 session id
  errors.ts     上游失败分类
  gate.ts       共享的闸门形状请求（doctor 与健康探测必须用同一份）
  doctor.ts     闸门自检
  health.ts     逐模型探测 · 判定规则 · 落盘缓存
  commands.ts   /opencode2pi 斜杠命令与 TUI
  host.d.ts     把 @earendil-works/* 桥到真实宿主类型
test/
  opencode2pi.test.ts   35 项不变量测试
```

`gate.ts` 单独存在是因为：doctor 和健康探测各写一份形状的话，两者一旦漂移，
doctor 会报「闸门正常」而真实路径已失效 —— 那正是这段代码唯一要抓的故障。

---

## 验证

改完代码，**这三条全绿才算完成**：

```sh
omp -e ./src/index.ts -p --model opencode-zen-free/mimo-v2.6-flash-free "Reply with exactly OK"

mkdir -p /tmp/t && touch /tmp/t/a.txt /tmp/t/b.txt /tmp/t/c.txt
omp -e ./src/index.ts -p --model opencode-zen-free/big-pickle \
  "Use the bash tool to list the files in /tmp/t, then tell me exactly how many. Do not guess - run the command."

npx tsc --noEmit
bun test
```

期望：输出恰好 `OK` / `3` / 干净退出 / 单测全过。

`/opencode2pi doctor` 和 `/opencode2pi probe` 需要交互式 TUI，打印模式下不可用。

---

## 发布

打 `vX.Y.Z` tag，`.github/workflows/release.yml` 自动：校验 tag 与版本一致 →
ci → typecheck → test → 校验 tarball → `npm publish --provenance` → GitHub Release。

一次 publish 同时服务 pi 和 omp（两者都从 npm 解析）。

认证二选一：配了 `NPM_TOKEN` secret 就走 token；没有则走 OIDC Trusted Publishing，
release 始终产出（`if: always()`）。首次发布必须用一次 token，因为 Trusted Publisher 要在
包的 Settings 页配置。详见 `docs/DEVELOPMENT.md` §6。

---

## 明确不要做

- ❌ 用 `onPayload` / `prepareRequest`
- ❌ 引入 `createProvider` / `openaiCompletions`（宿主 1.x 没有这两个导出）
- ❌ 返回嵌套 `limits`
- ❌ 只给 `fetchDynamicModels` 不给静态种子
- ❌ spawn 子进程 / 移植 IP 池（宿主代理是**进程内缓存**，运行时改环境变量不生效）
- ❌ 照抄 opencode2dsh 的重试策略（匿名通道重试轰炸会挤掉自己的配额）
- ❌ 用健康状态过滤模型列表（只标注，不隐藏 —— 用户明确要求）

---

## 当前状态

T1–T6 全部实现并实测通过（omp 18.6.1，2026-10-05）。
未决问题见 `docs/PLAN.md` 最后一节。
