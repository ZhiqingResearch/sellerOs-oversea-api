# 批量改图 Bug 修复方案（前端部分）

> 背景：测试清单 5 条 bug 于 2026-08-31 在 dev（dev.intelligentselleros.com）逐条实测，
> Bug 1（素材池同名上传 409）与 Bug 4（改图结果二次存入 409）已在后端仓库修复
> （`src/material-pool/pool-image.service.ts` 判重键 name+prompt → url）。
> Bug 3（批量改图偶发失败）与 Bug 5（变体不在通用创作显示）的根因在**前端仓库**，本文给出修复方案。
> 以下函数名来自 dev 当前线上 bundle（chunk `08qmnw~yhpyo~.js`，批量改图页面组件），
> 对应前端源码里的同名/近似命名逻辑。

## Bug 5：改图生成的图片再生成变体，通用创作模块没有显示（严重）

### 根因（已代码级确认）

- 普通改图的轮询函数 `e9(jobId, groupId)`：任务完成后调用 `e8(group)` →
  `U(projectId, {sourceName, sourceUrl, outputs}, params)` → rehost + `createTask`（`POST /api/image-project/:id/task`）落库，通用创作因此能看到。
- **变体的轮询函数 `tp(jobId, groupId, batchKey)`：完成后只 `clearInterval`，从不调用 `e8`/`U`**，
  变体输出仅更新本地卡片状态。实测：变体生成成功后网络层无任何 rehost / createTask 请求，
  `GET /api/image-project/tasks` 只有改图任务、无变体任务 → 通用创作页无法显示，刷新即丢。

### 修复

在 `tp` 的 `("completed"===status || "failed"===status)` 分支中，把**本次新增的变体 outputs**
（`typeKey` 前缀为 `variant:${batchKey}:`、状态 ready 的项）走一次 `U()` 落库：

1. 不能复用 `e8` 整组落库：`e8` 里有 `ev.current.has(groupId)` 的"已落库"去重集合，
   改图轮次已把该 groupId 标记为已落库，且整组 outputs 会重复入库。
   应新增一个按 outputs 子集落库的调用（`U` 的第二个参数 outputs 只传变体项即可）。
2. 落库参数：`sourceName = 源图名 + "·变体"`；`sourceUrl` = 变体源图（改图结果）的 https URL
   （走 proxy 拉取前先留原始 URL，**不是** blob）；prompt = `保持主体一致，按以下方向生成变体：…`。
3. 落库成功后 toast「已存入 N 张到项目，可在通用创作查看」，与普通改图一致。
4. 后端 `POST /api/image-project/:id/task` 现有能力即可承载，无需后端改动。

## Bug 3：批量改图生成图片偶发性失败（严重）

dev 实测：4 个生成 job 底层全部成功（轮询 200），失败发生在**落库阶段**，两处缺陷：

### 缺陷 1：rehost 收到 blob: URL → 400，任务丢失源图血缘

- 现象：`POST /api/ai-creative/rehost` 请求体 `{"url":"blob:https://dev.../xxx"}` →
  Next.js 路由返回 `400 {"error":"Unsupported url scheme"}`（每轮 2 个 400）。
- 位置：`U()` 内 `rehostImageViaServer(t.sourceUrl)`，其中 `t.sourceUrl` 来自
  `e8` 传入的 `e.sourceImage.previewUrl` —— 本地上传的源图 previewUrl 是 `blob:` 协议。
  rehost 失败后走 catch：非 http(s) → `refImageUrls = undefined`，
  所以**所有本地上传源图创建的任务都没有 refImageUrls**（源图血缘全丢）。
- 修复（二选一，建议 A+B 都做）：
  - A（治本）：提交批量改图时（`e7` 内、发起 job 前）先把本地源图 File 上传/rehost
    得到 https URL 存入 group（如 `sourceImage.remoteUrl`），`e8` 落库时传它而不是 previewUrl。
    job 的 FormData 里本来就有 `main` 文件，也可以由 `/api/ai-creative/image-to-image`
    响应顺带返回 rehost 后的源图 URL。
  - B（防御）：`U()` 调 rehost 前判断 `/^https?:/i.test(sourceUrl)`，
    非 http(s) 直接置 `undefined`，不发注定失败的请求。

### 缺陷 2：落库窗口期 UI 把成功任务渲染成「生成失败」

- 现象：rehost 400 + createTask 期间（约几十秒），4 组卡片全部显示「生成失败 😈」占位，
  任务列表刷新后又恢复「N 张就绪」。测试者看到的「改图失败」大概率就是这类状态抖动。
- 修复：排查 `e9` → `e8` → `U()` 期间组状态机（`status:"failed"` 的来源），
  rehost/落库失败不应把「生成已成功」的组改判为失败；
  组状态应只在**生成 job 本身** failed 时置 failed，落库失败走 toast + 重试入口。

### 附：测试者原始现象「Failed to fetch」（8 并发 7 失败）

本次 dev 未复现（2 并发均成功）。`e7` 对每张源图 `Promise.allSettled` 直发
`/api/ai-creative/image-to-image`，无并发上限、无重试。建议：提交并发限制（≤3）、
失败自动重试一次、失败卡片给「重试」按钮，覆盖偶发网络中断场景。

## 验证步骤（dev）

1. **Bug 5**：批量改图出图后点「生成变体」（任一方向 × 1）→ 完成后网络层应出现
   rehost + `POST /api/image-project/:id/task`；打开通用创作页应看到变体图。
2. **Bug 3**：本地文件作源图跑一轮批量改图 → Network 里不应再出现 rehost 400
   （请求体不应含 `blob:`）；生成→落库全程卡片不应出现「生成失败」；
   `GET /api/image-project/tasks` 新任务应带 `refImageUrls`。
3. **Bug 1/4（后端已修，回归）**：素材池一次上传 5 张同名不同内容图全部入池；
   同一源图两轮改图结果先后「存入素材池」均成功。
