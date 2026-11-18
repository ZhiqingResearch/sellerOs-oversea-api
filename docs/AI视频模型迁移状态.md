# AI 视频模型迁移状态

更新日期：2026-08-31

## 迁移范围

- 本轮迁移：客户分镜视频、视频创作、美妆视频工作流、动作复刻（2026-08-31 切入）。
- 暂不迁移：影刀 RPA、百度曦灵数字人工作流。
- 切换方式：前后端同时切换为 AI Gateway `publicId`，不兼容旧模型值。
- 结果处理：AI Gateway 返回的视频已存入 Spaces，业务侧直接保存 URL，不再下载转存。
- 计费口径：最终以成功任务的 `usage.amount`（CNY）为准，不再叠加本地视频倍率。
- 重试策略：业务侧和 SDK 均不做失败重试。

## 当前 AI Gateway 可迁移模型

| 业务                         | AI Gateway publicId                | 状态                     |
| ---------------------------- | ---------------------------------- | ------------------------ |
| 客户分镜视频                 | `sourcing-storyboard-veo-lite`     | 已接入                   |
| 视频创作·普通·Veo Fast       | `sourcing-veo-fast-i2v`            | 已接入                   |
| 视频创作·普通·Kling V3 Turbo | `sourcing-kling-v3-turbo-i2v`      | 已接入                   |
| 视频创作·普通·Grok Imagine   | `sourcing-suchuang-grok-imagine`   | 已停用（2026-09-01）      |
| 视频创作·普通·Gemini Omni Flash | `sourcing-gemini-omni-flash`    | 已接入，已验证（APIMart） |
| 视频创作·普通·Seedance 2.5   | `sourcing-seedance-2-5-i2v`        | 已接入                   |
| 视频创作·参考·Veo Fast       | `sourcing-veo-fast-reference`      | 已接入，已验证（实际路由 Veo 3.1 Standard，publicId 兼容保留） |
| 视频创作·参考·Seedance Mini  | `sourcing-seedance-mini-reference` | 已接入                   |
| 视频创作·参考·Grok Imagine   | `sourcing-suchuang-grok-imagine`   | 已停用（2026-09-01）      |
| 视频创作·参考·Google Omni    | `sourcing-suchuang-google-omni`    | 已停用（2026-09-01）      |
| 视频创作·参考·Gemini Omni Flash | `sourcing-gemini-omni-flash`    | 已接入，已验证（APIMart） |
| 视频创作·参考·Seedance 2.5   | `sourcing-seedance-2-5-reference`  | 已接入                   |
| 美妆工作流                   | `sourcing-beauty-seedance-mini`    | 已接入                   |

## AI Gateway 暂缺能力（2026-08-31 已全部上架）

下表旧能力原先在 AI Gateway 无对应模型；网关已于 2026-08-28 前后陆续上架，本地 `AiGatewayModel` 目录行也已同步建好（`enabled=true`、`gatewayActive=true`，随 `/ai-gateway/models` 下发）：

| 旧业务组合                          | Gateway publicId                    | 备注                                     |
| ----------------------------------- | ----------------------------------- | ---------------------------------------- |
| `NORMAL:video-imagine-1.5-preview`  | `sourcing-grok-imagine-1-5-i2v`     | 已上架，目录已同步                       |
| `NORMAL:video-mini`                 | `sourcing-seedance-mini-i2v`        | 已上架，目录已同步                       |
| `NORMAL:video-ultra`                | `sourcing-seedance-fast-i2v`        | 已上架，目录已同步                       |
| `REFERENCE:video-ultra-reference`   | `sourcing-seedance-fast-reference`  | 已上架，目录已同步                       |
| `REFERENCE:video-imagine-reference` | `sourcing-grok-imagine-v2v`        | 已上架，目录已同步（Grok 视频转视频）    |
| `REFERENCE:video-edit`              | `sourcing-kling-o3-video-edit`      | 已上架，目录已同步                       |
| `MOTION_CONTROL:kling-motion`       | `sourcing-kling-motion`             | 已上架；业务链路已切 Gateway（2026-08-31），TokenLab 在途历史任务启动时自动收口 |

另：网关新增 `sourcing-minimax-h3-reference`（MiniMax H3 多图参考生视频），本地未建行，是否接入待产品确认。

## 价格预估约定

- 当前 SDK 已升级至 `0.11.0`，通过 `gateway.pricing.estimate()` 获取项目实际售价。
- 报价使用完整生成参数，后端强制使用模型 `publicId`，不读取本地 `quoteConfig`。
- 报价不缓存、不重试，只用于生成前展示和余额预检。
- 实际扣费仍以任务终态的 `usage.amount` 为准。

## 实施进度

- [x] 安装并配置 `@zhiqingresearch/ai-ts-sdk`
- [x] 注册基础 `AiGatewayProvider`
- [x] 配置本地、Docker 和 GitHub Actions 的私有包安装凭据
- [x] 完善模型目录、Gateway 报价和任务结果校验
- [x] 迁移客户分镜视频
- [x] 持久化模型能力并改造能力接口
- [x] 迁移美妆视频工作流
- [x] 切换通用视频创作后端
- [x] 清理通用创作旧视频调用和转存逻辑（动作复刻除外）
- [x] Gateway 回调、实际 usage 扣费和未关联任务幂等恢复
- [x] 任务详情轮询时将超过 30 分钟的生成中任务标记为超时
- [x] 刷新视频模型目录快照（`npm run sync:ai-gateway-video-models`，含 veo-fast-reference 兼容路由新声明）
- [x] 模型目录读时自动刷新（2026-09-01）：`GET /ai-models`（VIDEO）时按请求的 category 后台刷新该分类快照，以该分类最近 `syncedAt` 判断间隔（**30 分钟**内同步过不再打网关；另有进程内单飞 + 失败尝试兜底节流，网关故障时不放大队列），不阻塞响应；只 update 不 create、网关 404 置 `gatewayActive=false` 的原则与同步脚本一致，新模型上架仍需人工建行。**同日扩展到 IMAGE**：`maybeRefreshModels(modality, category)` 按模态分派（视频 `videos.generations` / 图片 `images.generations`），节流键升级为 `模态:分类`；TEXT（拆图分析模型，chat.completions）不参与读时刷新，仍由 sync-ai-split-models.ts 手动同步
- [x] dev 网关实测 `sourcing-veo-fast-reference` 参考生链路端到端出片
- [x] 动作复刻切 AI Gateway（`sourcing-kling-motion`，提交/取消/回调扣费全走统一链路；批次逐条提交，单条明确失败不阻断其余；prompt 空时兜底「动作复刻」；TokenLab 时代在途任务启动时自动收口为失败不扣费）
- [x] 接入 `sourcing-gemini-omni-flash`（APIMart 中转）顶替速创三行（2026-09-01，见下方「APIMart 中转模型接入」），并新增可复用上架脚本 `scripts/onboard-ai-gateway-video-model.ts`
- [x] Gateway 终态扣费对齐公共扣费 v2（2026-09-01）：下线 `chargeGatewayUsageInTransaction`（`credit.consume` 直连——不路由企业共享池、不校验 source 注册表、UsageLog 无 requestId），四条回调链路（视频/分镜/美妆/图片）改走 `chargeModelInTransaction`（与 `chargeModel` 同内核：consumeRouted 三段混合扣费 + FeatureModule 注册表校验 + `requestId=gateway:{gatewayTaskId}` 幂等对账 + 双写 UsageLog，金额 0 跳过扣费）；提交预检 `assertGatewayAffordable` 同步改路由口径（企业成员校验团队池）。**上线前需跑 `npx tsx prisma/seed.ts features`**（幂等），否则未登记环境的回调扣费会 400
- [x] 视频 source 按前端入口细分（2026-09-01，dev 注册表已 seed 23 行）：新增 `video-project.sales`（带货视频生成，回调按 `salesWorkflowId` 锚定分流）与 `video-project.motion`（动作复刻视频，按 `mode=MOTION_CONTROL`）；`video-project.generate` 保留为通用创作+刀哥创作+客户分镜的兜底；`beauty-workflow.generate` 不动。数字人合成（曦灵）不计费不设 source；`customer.storyboard-video.generate` 经产品确认不单独设立（分镜扣费归 `video-project.generate`）
- [x] 网关计费价格倍率（2026-09-01）：`AiGatewayModel` 新增 `priceMultiplier`（Decimal，dev 数据 VIDEO×2 / IMAGE×3 / TEXT×1，调整即时生效无需重启）；网关 usage 与报价统一乘倍率后计费/展示——`/ai-models/quote` 金额与积分、四处提交预检（通用/动作复刻/美妆/分镜）、五处终态扣费（视频/分镜/美妆/图片/拆图分析）三处口径一致（`safeMultiplier` 工具 + `usage.gatewayPriceMultiplier`）；扣费流水 meta 留 `gatewayAmountCny`（网关原始金额）+ `priceMultiplier` 供对账；上架脚本支持 `--priceMultiplier`
- [x] 分镜/美妆纳入生成记录（2026-09-01）：`GET /usage/generation-records` 的 VIDEO 维度新增 StoryboardVideo（model/prompt 取 generationParams 快照，用户经客户关系链）与 BeautyTask 两张表——计数/列表/筛选/模型选项/积分反查/合计全链路接入；分镜扣费 meta 加 `taskType: "storyboard-video"` 鉴别（StoryboardVideo.id 与 VideoTask.id 独立自增撞号、source 同用 video-project 前缀），`videoCreditsByTask` 排除该标记、分镜反查只认标记 + 旧 source `customer.storyboard-video.generate` 兼容；美妆 source 前缀专属无撞号。分镜关键词仅匹配用户名/手机号（prompt 在 JSON 里无法 LIKE）

## 后续清理项

- `usage.service` 的本地视频定价体系（`assertVideoAffordable` / `chargeVideoInTransaction` / 各模型单价表 / 启动自检）已无业务消费方（全部视频计费走 Gateway `usage.amount`），待整体删除。
- `GoogleProvider` 的 Veo 三件套、`AtlasProvider` / `SuchuangProvider` / `TokenlabProvider` 已无业务调用方，可随本地定价体系一并清理。
- 网关新增 `sourcing-minimax-h3-reference`（MiniMax H3 多图参考生视频）未建本地目录行，是否接入待产品确认。

## dev 全量可用性测试（2026-08-31）

对 dev 环境（dev-api.intelligentselleros.com）全部 16 个唯一模型 × 17 个（分类 × 模型）组合按最低成本参数实测，共三轮（一轮换合规素材：raw.githubusercontent 图 ≥300px、720p 视频），总扣费 926 积分（≈¥92.6）：

**✅ 真实可用（12/17 组合，12 个模型全部出片）**

| 模型 | 分类 | 结果 |
| --- | --- | --- |
| sourcing-veo-fast-i2v / grok-imagine-1-5-i2v / seedance-fast-i2v / kling-v3-turbo-i2v / seedance-2-5-i2v / seedance-mini-i2v | NORMAL | 全部 SUCCESS |
| sourcing-veo-fast-reference / seedance-fast-reference / seedance-mini-reference / seedance-2-5-reference | REFERENCE | 全部 SUCCESS |
| sourcing-storyboard-veo-lite | STORYBOARD | 2/2 席位 SUCCESS |
| sourcing-beauty-seedance-mini | BEAUTY | SUCCESS |

**❌ 网关/上游侧问题（4 组合，多轮稳定复现，需 Gateway 团队处理）**

| 模型 | 现象 |
| --- | --- |
| sourcing-suchuang-grok-imagine（NORMAL 文生视频 + REFERENCE） | `Suchuang did not return a task id`（四轮，含按最新 notes 去掉 resolution 后仍失败，已排除参数因素） |
| sourcing-suchuang-google-omni（REFERENCE） | 同上 |
| sourcing-grok-imagine-v2v（REFERENCE） | 直连网关探测实证：503 `No priced video route is available: 视频模型 V2 成本规则没有匹配当前请求`（网关未配 v2v 定价路由）；网关 notes 亦承认 grok 物理 v2v 通道「契约声明但提交即拒」 |
| sourcing-kling-motion（MOTION_CONTROL，走的是已迁移新链路） | 上游 `403 You do not have permission to access this task` / `Upstream task failed`（三次，参数与最新 facts 完全一致） |

**⚠️ 本地链路问题（1 例，已修复待部署）**

- `sourcing-kling-o3-video-edit`（任务 443 / gateway `task_130deb81…`）：**网关任务实际 succeeded 并出片，本地 VideoTask 却被标 FAILED「AI Gateway 视频任务恢复失败」**（扣费已回滚未错扣）。
- **根因（2026-08-31 排查定案）**：时间线证明本地 03:27:02.360 被启动恢复标死时，网关任务还在 running（03:27:11 才 succeeded，晚了 9 秒）——恢复路径的 `getTask` 在联合重启窗口内收到网关瞬态 4xx，被 `recoverVideoTasks` 的「BadRequestException → 终态 FAILED」兜底错杀；随后到达的成功回调因状态机只认 GENERATING/TIMEOUT 无法翻案。
- **修复**：三个启动恢复函数（video/storyboard/beauty）错误分类细化——已关联任务的 `getTask` 失败与 `applyVideoTask`（落库/扣费）失败一律只记日志、保留原状态等回调重试/下次恢复；仅「未关联任务重新提交被网关 400 明确拒绝」才终态化。回归用例已补（23/23 通过）。
- 遗留数据处理：任务 443 可人工修正为 SUCCESS 并补扣 88 积分（¥8.82 × 10）+ 回填 resultUrl，或维持 FAILED 由业务决定。

**素材坑（记录给后续测试）**：上游拉取器对各图床兼容性不同——raw.githubusercontent 全兼容但 github/explore 图仅 288px（Seedance 系要求宽 ≥300px）；upload.wikimedia 与 images.unsplash 会被上游 `DownloadFailed` 拒拉；Kling 系要求视频高度 ≥700px。测试用图推荐 `raw.githubusercontent.com/opencv/opencv/4.x/samples/data/baboon.jpg`（512×512）。

## 前端带货链路联调反馈排查（2026-08-31 07:03Z）

前端在带货创作（`POST /video-project/sales/:id/generate`，SEGMENTED）反馈两个模型失败，后端取证结论（任务 #459/#460/#462/#463，带货工作流 16）：

- **`sourcing-seedance-mini-reference`（#462/#463）**：网关错误 `Upstream HTTP 402: insufficient balance`——上游 Seedance 账户余额不足，非参数问题。带货实际下发参数已逐项核对全部合规：`mode=reference_to_video`、每段 `duration_seconds=4`（非总时长）、5 张参考图（≤ `max_reference_images:9`）、`aspect_ratio=9:16`（在 facts `aspect_ratios` 内）、720p、无 `first_frame/last_frame` 混入。同一模型 03:17Z 直连实测成功出片，说明 03:17→07:03 之间上游余额耗尽。**已解决（2026-08-31 08:55Z 复测）**：同参数（480p×4s）重测 SUCCESS 出片（任务 #468 / `task_f1f714e2…`），上游已充值，seedance 全系预计同步恢复。
- **`sourcing-suchuang-google-omni（#459/#460）`**：仍为已知网关侧问题「Suchuang did not return a task id」，与直连测试结论一致；前端时间窗不一致的历史参数与本失败无关（该错误发生在上游返回任务号之前）。**08:55Z 复测仍失败**（#466，同错误）。
- 前端建议的「保存并返回 Gateway 原始错误 + requestId」**已实现（2026-08-31）**：`VideoTask` / `StoryboardVideo` / `BeautyTask` 三表新增 `gatewayError` JSON 字段落 `{ code, type, message, requestId }`；同时 `FAILED` 任务的 `errorMessage` **直接透传网关原始错误文案**（Gateway 为自研应用，网关未带 error 对象时兜底中文），取消/超时仍为中文。任务中心、带货 `outputs[].videos[]`、客户分镜 `videos[]`、美妆任务读接口均已透出；单测 25/25 通过。前端对接说明见前端调整文档第 7/12 节。**dev 已部署验证**：复测任务 #469 的 `errorMessage`/`gatewayError` 均按新口径落库。

### 五问题模型复测汇总（2026-08-31 08:55Z，dev 实测）

| 模型 | 结果 | 网关错误（requestId） |
| --- | --- | --- |
| `sourcing-seedance-mini-reference`（#468） | **SUCCESS 出片** | —（402 已解除，上游已充值） |
| `sourcing-suchuang-grok-imagine` 文生（#464）/ 参考生（#465） | FAILED | `Suchuang did not return a task id`（req_465aeac5 / req_cb59ff4a） |
| `sourcing-suchuang-google-omni`（#466） | FAILED | 同上（req_aafaf922） |
| `sourcing-grok-imagine-v2v`（#467） | 无法创建 | 提交/报价仍 `503 No priced video route`（实时探测），本地任务 30 分钟后标 TIMEOUT |
| `sourcing-kling-motion`（#469） | FAILED | `upstream_task_failed: Upstream task failed`（req_578569e1） |

### 网关侧修复验证（2026-08-31 10:00Z，收到网关回复后实测）

网关回复口径：v2v 定价路由已修复（任意参数集可用）；kling-motion 称此前失败是「卡通片+狒狒图被判无可检测人物」，403 为偶发；速创两模型为上游维护/算力繁忙。实测验证：

- **`sourcing-grok-imagine-v2v` 修复确认 ✅（#472 / `task_2f90684f…` / req_a5ddb080）**：最小参数集（仅 prompt + reference_videos）提交即创建任务，约 6 分钟出片 SUCCESS，`usage.amount=5.6 CNY`（5s×720p 实际出片计费），resultUrl 有效。
  - 附带发现：源视频用本方 Spaces 托管的真人舞蹈视频（12MB/40s/m4v 容器）被上游 400 拒（#470 / req_ec78db14「The upstream model rejected the request」），换成 1MB/10s 标准 mp4 后正常——v2v 对源视频仍有大小/时长/容器约束，具体阈值待网关补充。
- **`sourcing-kling-motion` 素材解释被证伪 ❌（#471 / `task_f9b0ff45…` / req_670b1c40）**：按网关要求换真人素材（Spaces 托管真人舞蹈视频 + 真人肖像图）后**仍失败，错误仍为 `Upstream HTTP 403: You do not have permission to access this task`**。三次实测（#433/#469/#471）两种素材均出现该 403，说明 TokenLab 任务归属权限异常是系统性主因而非偶发、与素材无关，已把新 requestId 反馈网关。
- 速创两模型（grok-imagine / google-omni）按网关口径为上游维护/繁忙，恢复后调用方直接重试即可，无需改动。

**当前结论：本地目录 18 个模型中 15 个可用，3 个待恢复（速创×2 上游维护 + kling-motion 上游 403 权限）。**

### 网关提示的新增事项（2026-08-31）

- 网关另有 3 个视频模型未在本地目录：`sourcing-grok-imagine-i2v`、`sourcing-grok-imagine-reference`、`sourcing-minimax-h3-reference`，是否接入待产品确认（minimax 此前已挂起）。
- `sourcing-kling-o3-video-edit` 网关未测，但我方 03:27Z 已端到端验证（网关 succeeded 出片，本地 443 错杀 bug 已修复）。
- 素材 URL 约定：上游抓取器需直接可达（images.unsplash 等会被 TokenLab 系拦截）；seedance 系图片素材暂用公网图床，不传本网关对象存储 URL（视频无此限制，本方 Spaces 视频 URL 实测 v2v/kling 可达——v2v 被 400 拒的那次是文件本身约束）。

## 阻塞记录（已解除）

`motion` 冒烟验证（2026-08-31）：`sourcing-kling-motion` 报价正常（720p ¥1.96/秒，15 秒 ¥29.4），但提交任务连续返回
503 `service_unavailable`（上游暂时不可用，与请求参数无关——参数错误会返回 400）。业务侧对该错误的处理路径已由单测
覆盖（瞬态失败保留 GENERATING，启动对账按幂等键重提）；待 Gateway 侧上游恢复后重试冒烟即可。

`sourcing-veo-fast-reference` 声明支持 `reference_images` 但实际路由的上游拒绝该参数、且上游 400 被包装为 503 —— 2026-08-31 已解除：

- 网关侧将该 publicId 兼容保留并重路由到 **Veo 3.1 Standard**（`display_name` 更名为「Veo 3.1 Standard 参考生视频（兼容 ID）」），facts 声明 `reference_to_video` 支持 1–3 张参考图，`reference_images` 模式强制 8 秒。
- dev 实测（2026-08-31）：报价 `estimate` ¥44.8（720p×8s）→ 提交任务 `task_0a3833cd27174074898451e3294a3364` → `succeeded`，`usage.amount=44.8 CNY` 与报价一致，出片 URL 有效。
- 400 包装 503 的问题未再复现；实测遇到的 `504 upstream_timeout` 由参考图 302 跳转链接拉取超时引起——**参考图必须传公网直链可拉取的 URL**（本项目 OSS/Spaces URL 满足）。
- 本地目录快照已刷新，前端经 `/ai-gateway/models` 可拿到新 displayName 与 facts（含 8 秒约束）。

## APIMart 中转模型接入（2026-09-01）

网关新上 APIMart 中转的 `sourcing-gemini-omni-flash`（Gemini Omni Flash 全能视频，文生/图生/参考生/视频编辑/首帧一体的全能模型），已接入本地目录顶替长期维护中的速创模型：

- **目录变更**：`sourcing-gemini-omni-flash` 建 NORMAL + REFERENCE 两行（`sortOrder=30`，沿用速创原槽位），`sourcing-suchuang-grok-imagine`（NORMAL/REFERENCE 两行）与 `sourcing-suchuang-google-omni`（REFERENCE）置 `enabled=false`（行保留，上游恢复后可再启用）。速创不再等待恢复。
- **能力口径**：无 `duration_seconds` 入参（时长模型自定 3–10 秒，**每条统一按 8 秒计价**）；固定 720p/24fps 且输出自带音频（`facts.resolutions=["720p"]`、`facts.audio.generate=true`）；画幅 16:9 / 9:16；参考图 ≤16、参考视频 ≤1（官方建议 ≤3 秒，传参考视频时画幅被上游忽略）；不支持 `extend_from_task_id` 续写。
- **代码零改动**：`facts.durations` 为空 → 带货链路 `snapDuration` 自动省略 `duration_seconds`；通用创作链路参数由前端按 requestSchema/facts 构造（`durations`/`resolutions` 为空或单项时前端隐藏对应选择器，§3 第 4/7 条已覆盖）。注意不要传 `resolution`。
- **dev 实测（2026-09-01）**：最小参数（prompt + 1 参考图 + 16:9，不带时长/分辨率）报价 `estimate` ¥6.336 → 任务 `task_697f3b74…`（req_56bf6b8a）约 98 秒 `succeeded`，`usage.amount=6.336 CNY` 与报价一致；成片实测 10.01s / 1280×720 / 含音轨，与口径吻合。
- **存量向导**：保存过速创 publicId 的带货向导重新生成时按「模型不在最新列表」处理（下拉框消失 → 引导重选，前端文档 §14 口径）。

## 全面审查与第一批修复（2026-09-01）

对迁移后的三条视频链路做了多代理全面审查（生命周期/计费/目录横切三线 + 全量测试回归 99 套件 1075 用例全绿）。结论：幂等三层防护（`gateway:{taskId}` requestId 唯一索引 + 任务行 gatewayEventId CAS + 扣费终态同事务）在重试/恢复/对账/翻案/多实例并发下闭合，无双扣路径；真实问题集中在一致性缺口与漏扣侧。视频侧 4 项已修复（均未提交，含 spec 断言）：

1. **分镜软删行被重提/扣费（P1）**：`removeStoryboard` 软删不筛 status 也不取消网关任务，且分镜恢复/回调的 3 条 raw SQL 与终态 CAS 均无 `deletedAt` 过滤（`$queryRaw` 不走软删除扩展）→ 删除后仍会出片扣费、提交中断的软删行甚至会被幂等键重提。修复：恢复 SQL/CAS 补 `deletedAt` 过滤（回调路由层 `findStoryboardVideoTask` 刻意不过滤，让已删行事件被 CAS 安静拒绝而非 503 陷进重试）；删除时对 GENERATING 席位尽力 `cancelVideoTask` 并标记 CANCELLED。美妆"软删仍扣费"是 spec 明示的有意行为，不动。
2. **429/401/403 错杀为 FAILED（P1）**：四个同步提交点只把 BadGateway/超时当瞬态，限流与授权抖动直接终态化（与已修复的启动恢复路径口径相悖，批量全并发 + SDK maxRetries=0 下现实可触发）。修复：统一为仅 `BadRequestException`（网关明确 400/404 拒绝）才终态化，其余保留 GENERATING 等启动恢复按幂等键重提。
3. **VideoTask 假超时无法翻案（P2）**：`recoverVideoTasks` 只扫 GENERATING（分镜/美妆均含 TIMEOUT）——读时对账连续失败 + 回调丢失被墙钟标 TIMEOUT 后重启也无法自愈（UAT 两 个 motion 任务即此形态）。修复：查询/回写/失败标记统一纳入 `TIMEOUT AND gatewayEventId IS NULL`。
4. **零金额字符串判定（P2）**：`"0E-8"`/`"-0"` 等形态绕过正则 → 金额>0 校验抛错 → 终态事务无限回滚。修复：webhook 扣费点改 `Decimal.isZero()` 数值判定；`validateUsage`/`getUsageByRequestId` 对 `-0` 放行（数值为零不算无效金额）。

**移交拆图模块负责人（未修，非本模块）**：审查发现拆图第 1 步竞品拆解自动重试时 `requestId` 被覆盖只留最后一次，`settleWorkflow` 只结算一次——重试场景下第一次调用的网关消耗永不扣费（少扣方向）。建议修法：快照增加 `workflow1RequestIds` 数组全量收集（旧快照回退单字段），结算逐 requestId 各自 `getUsageByRequestId` 扣费（`billingRequestId` 幂等键天然防重）。另拆图结算里的零金额正则与 webhook 同款问题，可一并改数值判定。

审查发现的第二批（未修）：motion 回写窗口、图片 succeeded 缺 usage 静默免费、倍率取行口径（报价按 publicId+category vs 扣费按 publicId）、sales 死代码清理；图片链路零对账零恢复仍为挂起项（照抄视频读时对账模式可补）。
