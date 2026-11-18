# AI 视频模型迁移前端调整

更新日期：2026-08-31

## 1. 调整范围

本次需要调整：

- 通用视频创作的普通模式（`NORMAL`）和全能参考模式（`REFERENCE`）。
- 带货视频创作中的模型选择和成片结果展示。
- 客户分镜视频的任务字段和状态处理。
- 美妆视频工作流的任务状态和成片结果展示；创建接口与参数不变。
- 动作复刻：接口与表单不变，但任务模型字段已切换为 Gateway 口径（见第 9 节）。

暂不调整：

- 影刀 RPA、百度曦灵数字人不属于本次 AI Gateway 切换范围。

## 2. 核心变化

| 调整项 | 前端处理 |
| --- | --- |
| 模型来源 | 删除本地硬编码模型列表，调用 `/api/ai-models` 获取 |
| 模型值 | 使用 `publicId`，不再传旧模型名或上游物理模型名 |
| 展示名称 | 使用接口返回的 `displayName` |
| 参数结构 | 使用 AI Gateway snake_case 参数，如 `duration_seconds`、`aspect_ratio` |
| 模型能力 | `facts` 决定模型可用能力，`requestSchema` 决定字段结构；前端取两者交集 |
| 价格预估 | 调用 `/api/ai-models/quote`，展示返回的积分字段 |
| 任务结果 | 使用 Gateway Space URL，前端不转存、不替换域名 |
| 任务标识 | 业务操作使用本地数字 `id`，不要使用 `gatewayTaskId` |
| 任务状态 | 统一处理 `GENERATING / SUCCESS / TIMEOUT / CANCELLED / FAILED` |

旧模型值不兼容，不需要在前端维护新旧映射。

## 3. 获取模型和能力

```http
GET /api/ai-models?modality=VIDEO&category=NORMAL
GET /api/ai-models?modality=VIDEO&category=REFERENCE
Authorization: Bearer <token>
```

- 普通视频页使用 `NORMAL`。
- 全能参考页、带货视频模型选择使用 `REFERENCE`。
- 客户分镜视频由后端固定使用 `STORYBOARD` 分类，前端无需选择模型。
- 美妆工作流由后端固定使用 `BEAUTY` 分类，前端无需选择模型。
- 动作复刻由后端固定使用 `MOTION_CONTROL` 分类（`sourcing-kling-motion`），前端无需模型下拉；如需展示预估价，可用相同分类调报价接口。

`category` 为必填参数，每次请求都必须携带。

模型能力快照的自动更新：每次查询 `modality=VIDEO` 或 `modality=IMAGE` 的模型列表时，后端会在后台（不阻塞本次
响应）按**请求的 category** 向 AI Gateway 刷新该分类的本地目录快照——以该分类最近一次成功同步
时间（`syncedAt`）判断，**30 分钟**内同步过就不再打网关。因此网关侧的
`facts`/`requestSchema`/`displayName` 变更最迟在下次读取时生效；本次响应仍返回当前快照。已下架
的模型（网关 404）会被自动置为不可用并从列表隐藏；**新模型上架仍需后端人工建行，不会自动出现**。

### 当前目录快照（2026-08-31，以接口实时返回为准）

| publicId | displayName | 分类 | 状态 |
| --- | --- | --- | --- |
| sourcing-veo-fast-i2v | Veo 3.1 Fast 图生/首尾帧 | NORMAL | 可用 |
| sourcing-kling-v3-turbo-i2v | Kling V3.0 Turbo 图生视频 | NORMAL | 可用 |
| sourcing-suchuang-grok-imagine | 速创 Grok Imagine | NORMAL / REFERENCE | 网关侧问题待修 |
| sourcing-seedance-2-5-i2v | Seedance 2.5 图生/首尾帧 | NORMAL | 可用 |
| sourcing-grok-imagine-1-5-i2v | Grok Imagine 1.5 图生视频 | NORMAL | 可用 |
| sourcing-seedance-mini-i2v | Seedance 2.0 Mini 图生/首尾帧 | NORMAL | 可用 |
| sourcing-seedance-fast-i2v | Seedance 2.0 Fast 图生/首尾帧 | NORMAL | 可用 |
| sourcing-veo-fast-reference | Veo 3.1 Standard 参考生视频（兼容 ID） | REFERENCE | 可用 |
| sourcing-seedance-mini-reference | Seedance 2.0 Mini 参考生视频 | REFERENCE | 可用 |
| sourcing-suchuang-google-omni | 速创 Google Omni | REFERENCE | 网关侧问题待修 |
| sourcing-seedance-2-5-reference | Seedance 2.5 参考/编辑视频 | REFERENCE | 可用 |
| sourcing-seedance-fast-reference | Seedance 2.0 Fast 参考生视频 | REFERENCE | 可用 |
| sourcing-grok-imagine-v2v | Grok Imagine 视频转视频 | REFERENCE | 网关侧问题待修 |
| sourcing-kling-o3-video-edit | Kling O3 视频编辑 | REFERENCE | 可用 |
| sourcing-kling-motion | Kling 3.0 动作复刻 | MOTION_CONTROL | 网关侧问题待修 |
| sourcing-storyboard-veo-lite | 客户分镜 Veo 3.1 Lite | STORYBOARD | 可用 |
| sourcing-beauty-seedance-mini | 美妆专线 Seedance 2.0 Mini | BEAUTY | 可用 |

响应：

```json
{
  "items": [
    {
      "publicId": "sourcing-seedance-2-5-i2v",
      "displayName": "Seedance 2.5",
      "modality": "VIDEO",
      "execMode": "ASYNC",
      "facts": {
        "modes": ["image_to_video"],
        "durations": [5, 10],
        "resolutions": ["720p", "1080p"],
        "aspect_ratios": ["16:9", "9:16"],
        "first_frame": true,
        "max_reference_images": 0,
        "audio": {
          "generate": true,
          "keep_source": false
        },
        "notes": []
      },
      "requestSchema": {
        "type": "object",
        "properties": {}
      }
    }
  ]
}
```

前端要求：

1. 进入页面时重新获取当前分类的模型列表，不长期缓存。
2. 下拉框的值使用 `publicId`，文案使用 `displayName`。
3. 模型失效或不在最新列表中时，清空历史选择并要求用户重新选择。
4. `facts` 是当前模型的实际能力，字段名均为 snake_case；`requestSchema` 是公共字段结构，可能包含该模型不支持的值。前端应取两者交集，报价接口作为提交前最终校验。
5. `requestSchema` 中的 `model` 由外层 `publicId` 提供，不显示为用户输入项；`callback` 也不需要显示。
6. 接口未返回的旧模型应直接从页面消失，不在前端额外保留。
7. 切换模型或模式时，立即删除新能力不支持的旧字段和素材，避免隐藏表单值继续进入报价和生成请求。

`facts` 和 `requestSchema` 的具体字段随模型变化，前端应按可选字段读取，不假设示例中的能力一定存在。

常用 `facts` 字段：

| 字段 | 前端用途 |
| --- | --- |
| `modes` | 可选生成模式 |
| `durations` | 时长选项 |
| `resolutions` | 分辨率选项 |
| `aspect_ratios` | 画幅选项 |
| `first_frame` / `last_frame` | 是否显示首帧、尾帧上传 |
| `min_reference_*` / `max_reference_*` | 图片、视频、音频素材数量限制 |
| `audio.generate` / `audio.keep_source` | 是否显示生成音频、保留原声选项 |
| `notes` | Gateway 给出的额外限制或提示；应展示给用户，并避免发送其中明确禁止的参数 |

## 4. Gateway 视频参数

前端提交给报价和生成接口的 `params` 应使用相同结构：

```ts
type MediaReference =
  | { url: string }
  | { object_key: string }

type CommonVideoGenerationParams = {
  prompt: string
  negative_prompt?: string
  mode?:
    | "text_to_video"
    | "image_to_video"
    | "start_end_to_video"
    | "reference_to_video"
    | "video_to_video"
    | "motion_control"
  duration_seconds?: number
  resolution?: string
  aspect_ratio?: string
  first_frame?: MediaReference
  last_frame?: MediaReference
  reference_images?: MediaReference[]
  reference_videos?: MediaReference[]
  reference_audios?: MediaReference[]
  generate_audio?: boolean
  keep_source_audio?: boolean
  n?: 1
}
```

注意：

- 上面只列当前页面常用字段；模型新增参数时以 `requestSchema` 为准，不把该类型当固定白名单。
- `prompt` 必填且不能为空。
- 不要继续发送旧的 camelCase 参数，例如 `durationSec`、`aspectRatio`、`firstFrameUrl`。
- 素材应先上传，再传 HTTPS URL 或 Gateway `object_key`，不要传本地路径和裸 base64。
- 只发送 `requestSchema` 允许且当前模型 `facts` 支持的字段；不要把表单默认值无条件全部发送。
- `mode` 可以显式传，也可以省略后由 Gateway 按素材推断；显式传时必须属于 `facts.modes`。
- `reference_images/videos/audios` 的数量必须同时满足对应 `min_reference_*` 和 `max_reference_*`。
- `params.model` 和 `params.callback` 可以不传，后端会分别强制使用 `publicId` 和开启回调。
- 单个任务固定生成一个视频，`n` 省略或传 `1`，不要提供数量选择器。

常见模式：

| 页面场景 | `mode` | 主要素材字段 |
| --- | --- | --- |
| 文生视频 | `text_to_video` | 无 |
| 首帧图生视频 | `image_to_video` | `first_frame` |
| 首尾帧视频 | `start_end_to_video` | `first_frame`、`last_frame` |
| 全能参考 | `reference_to_video` | `reference_images/videos/audios`，按模型能力传递 |

## 5. 价格预估

```http
POST /api/ai-models/quote
Authorization: Bearer <token>
Content-Type: application/json
```

请求：

```json
{
  "category": "NORMAL",
  "publicId": "sourcing-seedance-2-5-i2v",
  "params": {
    "prompt": "产品在柔和自然光下缓慢旋转",
    "mode": "image_to_video",
    "duration_seconds": 5,
    "resolution": "720p",
    "aspect_ratio": "9:16",
    "first_frame": {
      "url": "https://example.com/product.png"
    },
    "generate_audio": true,
    "n": 1
  }
}
```

响应重点字段：

```json
{
  "currency": "CNY",
  "variants": [
    {
      "parameters": {
        "duration_seconds": 5,
        "resolution": "720p"
      },
      "estimated_amount": "1.2",
      "minimum_amount": "1.2",
      "maximum_amount": "1.2",
      "estimated_credits": "12",
      "minimum_credits": "12",
      "maximum_credits": "12",
      "exact": false,
      "assumptions": []
    }
  ],
  "expires_at": 1787815898
}
```

展示规则：

- 优先展示积分字段，不在前端自行按人民币换算。
- `minimum_credits`、`maximum_credits` 均有值且相同时展示单一价格，不同时展示区间。
- 任一上下界为 `null` 时展示 `estimated_credits`，可标注“预计”；预计值也为空时展示“暂无法预估”。
- 参数或模型变化后重新报价；提交生成时使用与最后一次报价相同的 `params`。
- 报价请求并发时只采用最后一次请求的响应，避免慢响应覆盖新参数的价格。
- `expires_at` 是 Unix 秒时间戳；过期或参数变化后重新报价。
- 报价失败时提示后端返回的 `message`，不要使用旧的本地价格表兜底。
- 报价金额**已含平台价格倍率**（视频模型 ×2）：后端在网关报价基础上统一乘 `priceMultiplier` 再返回，
  积分/人民币字段同源放大，前端不做任何额外倍率处理；实际扣费与报价同口径（出片后按网关实际用量 × 同一倍率结算）。

## 6. 创建通用视频任务

```http
POST /api/video-project/:projectId/task
Authorization: Bearer <token>
Content-Type: application/json
```

请求体直接复用第 5 节的报价请求，不要为创建任务重新组装参数。

任务响应的模型字段已统一：

```ts
type VideoTask = {
  id: number
  publicId: string
  displayName: string
  status: "GENERATING" | "SUCCESS" | "TIMEOUT" | "CANCELLED" | "FAILED"
  resultUrl: string | null
  errorMessage: string | null
  gatewayError: {
    code: string | null
    type: string | null
    message: string
    requestId: string | null
  } | null
  gatewayTaskId: string | null
  isExpired: boolean
}
```

前端需要删除对旧字段 `model`、`modelName` 的依赖，改用 `publicId`、`displayName`。
`gatewayTaskId` 是后端与 Gateway 的关联字段，详情、取消、删除等接口仍传本地数字 `id`。
`isExpired` 是兼容字段，目前固定为 `false`，超时以 `status === "TIMEOUT"` 为准。

`gatewayError` 与 `errorMessage` 的关系（2026-08-31 起）：`FAILED` 时 `errorMessage` **直接透传
网关原始错误文案**（如 `The upstream model is temporarily unavailable: Upstream HTTP 402: insufficient
balance`；Gateway 为自研应用，不再包固定中文），网关未带 error 对象时兜底「AI Gateway 视频生成失败」；
取消、超时仍为中文文案（网关对这两种终态不提供错误对象）。`gatewayError` 是同一错误的结构化快照
`{ code, type, message, requestId }`，供按 code 做展示分支或转发网关团队排查，成功/取消/超时为 `null`。
前端展示 `errorMessage` 即可，不要额外拼接 `gatewayError.message`（内容重复）。

提交结果不确定时，创建接口可能正常返回一条 `GENERATING` 任务且暂时没有
`gatewayTaskId`。这不代表提交失败，前端应进入正常轮询，禁止自动重复创建任务。

## 7. 状态轮询和结果展示

通用视频任务：

```http
GET /api/video-project/tasks?projectId=:projectId
GET /api/video-project/tasks/stats?projectId=:projectId
GET /api/video-project/task/:taskId
```

建议每 3～5 秒查询一次，并在以下终态停止高频轮询：

| 状态 | 前端展示 |
| --- | --- |
| `GENERATING` | 生成中 |
| `SUCCESS` | 使用 `resultUrl` 播放或下载 |
| `TIMEOUT` | 生成超时，可重新生成 |
| `CANCELLED` | 已取消，可重新生成 |
| `FAILED` | 直接显示 `errorMessage`（网关原始错误文案）；需要 code/requestId 时读 `gatewayError` |

后端收到 Gateway webhook 后更新任务；前端轮询只读取本地状态，不直接查询 Gateway。
任务超过 30 分钟仍为 `GENERATING` 时，详情接口会将其标记为 `TIMEOUT`。迟到的成功回调仍可能把
`TIMEOUT` 更新为 `SUCCESS`，用户刷新页面后应以最新接口结果为准。

`resultUrl` 已是 Gateway Space 链接：

- 直接用于 `<video>`、下载和复制链接。
- 不再调用前端或后端 OSS 转存接口。
- 不拼接旧 CDN 域名，不从 `gatewayTaskId` 推导地址。

取消任务仍调用：

```http
POST /api/video-project/task/:taskId/cancel
```

若返回“任务正在提交，请稍后取消”，保持任务为生成中并允许用户稍后再次点击，不要把任务本地改成已取消。

## 8. 带货视频页面

带货视频 Step 3 的模型选择也使用：

```http
GET /api/ai-models?modality=VIDEO&category=REFERENCE
```

`REFERENCE` 只是业务分类。带货后端固定使用 `reference_to_video + reference_images`，因此模型下拉框还必须过滤：

- `facts.modes` 包含 `reference_to_video`。
- 当前产品图、数字人肖像和场景图的总数量符合 `facts.min_reference_images`、`facts.max_reference_images` 限制。
- 不展示只支持 `video_to_video` 的视频编辑模型。

保存脚本接口中，`model` 字段传选中模型的 `publicId`：

```http
PATCH /api/video-project/sales/:projectId/script
```

```json
{
  "model": "sourcing-seedance-mini-reference",
  "totalDuration": 15,
  "generateAudio": true,
  "aspectRatio": "9:16",
  "resolution": "720p",
  "segments": []
}
```

这里仍是带货业务 DTO，所以字段保持 camelCase；不要改成 Gateway snake_case。模型切换后，应按所选模型的
`facts` 清空不支持的 `totalDuration`、`generateAudio`、`aspectRatio`、`resolution`，不要把上一个模型的隐藏值继续保存。
`facts.notes` 明确禁止的参数也不要提交。

确认出片时明确传成片方式，之后继续通过详情接口读取状态：

```http
POST /api/video-project/sales/:projectId/generate
GET  /api/video-project/sales/:projectId
```

```json
{
  "outputMode": "ONESHOT"
}
```

`outputMode` 可选 `ONESHOT`（整片单任务）或 `SEGMENTED`（每个分镜一个任务）。详情接口返回的
`outputs[].videos[]` 使用
`publicId`、`displayName`、`status`、`resultUrl`、`errorMessage`、`gatewayError`（网关终态失败原始错误，
排查用，见第 7 节），前端按第 7 节处理状态和链接。

## 9. 动作复刻

动作复刻已切换到 AI Gateway（模型 `sourcing-kling-motion`）。**创建接口、请求表单、批量逻辑全部不变**，仍是业务 DTO：

```http
POST /api/video-project/:projectId/motion-control/batch
```

```json
{
  "prompt": "让目标人物复刻动作视频中的动作（可选）",
  "resolution": "720p",
  "actionVideos": [{ "url": "https://example.com/action.mp4", "name": "动作1", "durationSec": 8 }],
  "targetImages": [{ "url": "https://example.com/target.png", "name": "目标1" }]
}
```

前端需要感知的变化：

1. **任务字段切换为 Gateway 口径**：返回的 `tasks[]` 与任务中心一致，使用 `publicId`（`sourcing-kling-motion`）、`displayName`（`Kling 3.0 动作复刻`）。迁移前创建的历史任务仍会以 `publicId` 字段下发旧值 `kling-motion`，仅用于展示（旧任务均已终态），前端不要以 `publicId` 字符串做任何分支逻辑。
2. **状态与结果同第 7 节**：`GENERATING / SUCCESS / TIMEOUT / CANCELLED / FAILED`，成功后直接使用 `resultUrl`；轮询、取消、删除都走任务中心统一接口（传本地数字 `id`）。取消时若返回“任务正在提交，请稍后取消”，处理方式同第 7 节。
3. **`prompt` 可选**：未填写时后端以「动作复刻」兜底提交，无需前端强制校验必填。
4. **逐条失败不阻断批次**：批量按「动作视频 × 目标图」笛卡尔积逐条提交；个别任务被网关拒绝时会单条返回 `FAILED`（含 `errorMessage`），其余任务正常生成。前端应逐条渲染状态，不要因为一条失败判定整批失败。
5. **提交结果不确定**：同第 6 节，可能出现暂无 `gatewayTaskId` 的 `GENERATING` 任务，正常轮询即可，禁止自动重复提交。
6. **预估价（可选）**：如需在提交前展示预估积分，调用 `POST /api/ai-models/quote`，`category` 传 `MOTION_CONTROL`、`publicId` 传 `sourcing-kling-motion`，`params` 使用 Gateway snake_case（`mode: "motion_control"`、`duration_seconds`、`resolution`、`reference_images`、`reference_videos`）。不展示预估也不影响提交。

上游对素材有硬性要求（由后端和 Gateway 校验，前端可提前提示）：目标图与动作视频各恰好 1 个；动作视频时长 3–30 秒；参考视频建议不低于 720p。

## 10. 客户分镜视频

生成接口和表单字段保持不变：

```http
POST /api/customer/storyboards/generate-videos
```

```json
{
  "items": [
    {
      "id": 101,
      "duration": 4,
      "prompt": "镜头固定，薄雾缓慢移动",
      "firstFrameUrl": "https://example.com/first.png",
      "lastFrameUrl": "https://example.com/last.png"
    }
  ]
}
```

- `duration` 仅支持 `4 / 6 / 8`。
- 同一请求中 `id` 不可重复，提交前应去重。
- 同一分镜有视频正在生成时，不要再次提交。
- 模型和 Gateway 参数由后端根据 `STORYBOARD` 分类组装，前端不传 `publicId`。

轮询接口：

```http
GET /api/customer/storyboards?ids=101,102
```

`videos[]` 需要按以下字段处理：

```ts
type StoryboardVideo = {
  id: number
  url: string | null
  approved: boolean
  status: "GENERATING" | "SUCCESS" | "TIMEOUT" | "CANCELLED" | "FAILED"
  gatewayTaskId: string | null
  errorMessage: string | null
  gatewayError: { code: string | null; type: string | null; message: string; requestId: string | null } | null
}
```

旧字段 `taskId` 已移除。前端业务只需依赖 `videos[].id/status/url/approved/errorMessage`，
不要依赖 `gatewayTaskId`。`url` 同样直接使用，不再转存。

## 11. 美妆工作流

创建接口和请求字段保持原业务格式，不改成 Gateway snake_case：

```http
POST /api/beauty-project/:projectId/tasks/batch
GET  /api/beauty-project/tasks?projectId=:projectId
GET  /api/beauty-project/task/:taskId
POST /api/beauty-project/task/:taskId/cancel
```

- 前端继续提交最终 `prompt`、`durationSec`、`aspectRatio`、`resolution` 和 `referenceImageUrls`。
- 任务状态统一使用 `GENERATING / SUCCESS / TIMEOUT / CANCELLED / FAILED`。
- `SUCCESS` 时直接播放 `resultUrl`，不再转存。
- 只有尚未提交 Gateway 的任务可以取消；返回“任务已开始生成并提交至上游”时保持当前状态，不在前端强制改成 `CANCELLED`。
- 项目、任务列表、状态统计和任务详情读取时都会处理 30 分钟超时，前端始终以最新接口状态为准。

## 12. 错误处理

统一读取后端错误结构：

```json
{
  "statusCode": 400,
  "message": "积分余额不足，无法生成（预计需 12 积分）",
  "timestamp": "2026-08-27T08:00:00.000Z"
}
```

- `400`：参数、余额、任务状态错误，直接展示 `message`。
- `404`：模型已下线或资源不存在，刷新模型列表或页面数据。
- `429`：请求过于频繁，提示用户稍后操作。
- `502 / 503 / 504`：Gateway 暂时不可用，保留用户已填写表单；不要自动重复提交生成任务。

异步失败（任务 `status === "FAILED"`）的 `errorMessage` 就是网关原始错误文案（Gateway 为自研应用，
直接展示给用户）；`gatewayError`（结构见第 7 节）提供同一错误的 `code/type/requestId`，供按 code
分支展示样式或转发网关团队。同步提交失败走上面的 HTTP 错误结构，`message` 同样已带网关原始信息与
`[requestId=...]`。

## 13. 联调检查清单

- [ ] 普通和参考模型列表均来自 `/api/ai-models`。
- [ ] 模型选择保存 `publicId`，展示 `displayName`。
- [ ] 表单选项随 `facts/requestSchema` 变化，不再按旧模型名硬编码。
- [ ] 带货模型已过滤为支持 `reference_to_video` 且参考图数量足够的模型。
- [ ] 正确读取 `facts.aspect_ratios` 等 snake_case 能力字段。
- [ ] 切换模型或模式后，旧模型独有的参数和素材已从请求中删除。
- [ ] 报价和创建任务使用完全相同的 `params`。
- [ ] 所有 Gateway 参数使用 snake_case。
- [ ] 任务列表和详情使用 `publicId/displayName`，不再读取 `model/modelName`。
- [ ] 前端使用本地任务 `id` 调详情、取消、删除接口。
- [ ] `GENERATING` 不会触发自动重复创建。
- [ ] `SUCCESS` 直接播放 `resultUrl` 或分镜 `url`，没有转存逻辑。
- [ ] 五种任务状态均有对应 UI。
- [ ] `FAILED` 任务直接展示 `errorMessage`（网关原始错误文案）；需要 code/requestId 时读 `gatewayError`，不与 `errorMessage` 重复拼接。
- [ ] 客户分镜已移除对旧 `taskId` 的依赖，批量提交前会对分镜 ID 去重。
- [ ] 动作复刻仍走专用批量接口，没有误切到 AI Gateway 通用生成接口。
- [ ] 动作复刻新任务 `publicId/displayName` 为 Gateway 口径；对历史任务的旧值 `kling-motion` 仅展示、不做分支逻辑。
- [ ] 动作复刻批量结果逐条渲染状态，单条 `FAILED` 不影响其余任务展示。
- [ ] 美妆仍调用原 Beauty 接口，成功后直接使用 `resultUrl`。

## 14. 运行时限制

模型路由和上游可用性可能变化。前端只使用 `/api/ai-models` 当前返回的模型，不维护单个 `publicId` 的永久禁用名单；
报价或生成失败时展示后端 `message`、保留表单，并由后端调整模型表或 Gateway 配置。

模型能力快照由后端在「读取 VIDEO / IMAGE 模型列表」时按请求分类后台自动刷新（按 syncedAt 判断，30 分钟
间隔，见第 3 节），前端无需做任何缓存或版本判断，每次进页面直接拉 `/api/ai-models` 即可拿到最新能力。

上游故障期间，后端可能临时将个别模型下架（目录行 `enabled=false`，接口不再返回该模型；网关侧
下架的模型也会在自动刷新时被置为不可用隐藏）。此时前端表现与
“模型已下线”一致：下拉框少一个选项，历史选择失效时引导用户重新选择——不需要为“临时下架”做单独 UI。
