# 车泰斗生图比例、尺寸选择与 Sunburst 模型切换开发技术方案

日期：2026-10-06
状态：后端已实现并通过构建、自动测试；前端自行维护控件和选项，按联调文档传参。已读取当前数据库确认 Sunburst 启用、旧 ZQ-Image-2 停用；本次未重复改写模型配置。
适用入口：车泰斗工作台 `/api/chetaidou/*`。

修订说明：本版已对照现有通用生图、人像创作和 AI 拆图代码。业务尺寸字段统一采用 `resolutionTier`（大写档位），网关字段 `resolution`（小写）只出现在执行参数与旧快照兼容层。

最新范围：增加图片比例和尺寸选择，保留张数；比例由前端明确传递，包括默认母版比例。用户已取消质量选项，新任务使用模型默认质量，客户端不增加 quality 字段。旧任务已有的 quality 仅供历史执行兼容，不作为新产品能力。

裁剪口径：按现有通用图片生成 `src/image-generation/providers/gateway-size-normalize.ts` 实现复用，普通尺寸归一与模型适配后的只裁比例分支均保持一致。

## 1. 目标与实施边界

用户在生成图片前选择比例、尺寸和张数。选择真实参与网关请求，任务详情能追溯选择值、实际提交值和实际输出尺寸。

- 尺寸：业务请求及界面使用 `resolutionTier: 1K / 2K / 4K`，按模型支持情况开放；网关提交映射为 `resolution: 1k / 2k / 4k`。
- 张数：沿用 `1 / 2 / 4 / 8`，每张仍对应独立 Item 和 Call。
- 比例：默认“母版比例”，可选择现有生图的常用比例和自定义比例；前端始终提交实际 aspectRatio（如 4:5），自定义沿用 aspectRatio=custom + customAspectW/customAspectH。母版比例选项仅存在于前端，不向后端传 original。自定义数字表达比例，不是指定像素输出。
- 本期不增加输出格式选择和自定义像素尺寸。
- 新生成任务使用 `gpt-image-2.5-sunburst`，在 `CHETAIDOU_IMAGE` 分类停用原启用模型。
- 模型从数据库 `AiGatewayModel` 按 `category=CHETAIDOU_IMAGE`、`modality=IMAGE`、`enabled=true`、`gatewayActive=true` 获取，必须恰好一行；客户端不能传入或切换模型。
- `gpt-image-2.5-sunburst` 仅是本次数据库配置切换目标，不作为运行时代码常量、环境变量默认模型或查询不到模型时的兜底值。
- 保持现有计费、权限、取消、对账和 UNKNOWN 不自动重发规则。
- 使用现有 JSON 字段保存新增数据，不新增表、列和环境变量，不需要同步数据库 Schema。

“尺寸档位”是生成意图，不能承诺图片一定达到对应长边。模型能力收敛或网关适配后，以产物实际宽高为准，页面显示调整说明。

## 2. 已核实的代码现状

| 位置 | 当前行为 | 改造要求 |
|---|---|---|
| `src/chetaidou/dto/chetaidou.dto.ts` / `CreateTaskDto` | GENERATE 仅接收组合 ID 和 count | 增加 resolutionTier、aspectRatio、customAspectW/H |
| `src/chetaidou/chetaidou.service.ts` / `getConfig` | 返回张数及模型 ready，无生图参数选项 | 保持原返回，不增加生图控件配置 |
| 同文件 / `createTask` | requestHash 未包含比例和尺寸 | 显式比例、尺寸参数参与幂等比较 |
| 同文件 / `createGenerate` | 质量、尺寸从环境变量取，冻结在 snapshot 和 Job.request | 尺寸改成请求值或服务端默认值；新任务取消质量注入 |
| `src/chetaidou/executor/chetaidou-image-runner.service.ts` / `submitQuality` | 执行时再次读取环境变量，将 high 映射成 hd | 新任务不传质量；旧任务按冻结值执行，不重读环境变量 |
| 同文件 / `planSizing` | 沿用母版比例，调用通用尺寸规划，丢弃 adjustments | 使用任务冻结的目标比例，保存完整规划结果 |
| 同文件 / `deliverArtifact` | 原始产物转存，记录实际尺寸；未实现比例修正裁切 | 接入通用图片生成的裁剪归一函数及分支规则 |
| 同文件 / `openImageCall` | Call.request 仅记录 prompt/model/index | 记录比例、尺寸及规划版本等审计信息 |
| `src/chetaidou/chetaidou.prompts.ts` / COMPOSITION_PROMPT | 提示词要求保留源图长宽比 | 新组合提示词不锁定画布比例；GENERATE 按用户目标补齐画布指令，兼容旧组合 |
| `src/chetaidou/chetaidou-context.service.ts` / `resolveModels` | 各分类必须恰好一个 enabled + gatewayActive 模型 | 切换只作用于图片分类 |
| `src/chetaidou/chetaidou-billing.service.ts` | 一口价优先；否则实际账单乘倍率 | 保持该口径 |
| `src/chetaidou/chetaidou.service.ts` / `imageRetry` | 校验原快照模型仍启用 | 停用后拒绝旧任务新重试，提供明确提示 |

前端对应目录为 `../chetaidou-studio-main/public/`。现有生成区在 `studio.html`，逻辑在 `studio.js`，草稿在 `studio-draft.mjs`，接口适配在 `studio-backend.mjs`。

### 2.1 现有生图参数依据及复用关系

| 现有入口/文件 | 已存在的参数口径 | 车泰斗对应方案 |
|---|---|---|
| `src/image-generation/text-to-image.service.ts` / TextToImageBody | provider、prompt、negativePrompt、aspectRatio、resolutionTier；没有独立 quality 入参 | 复用 resolutionTier 命名，不复制提示词与模型选择入口 |
| `src/image-generation/image-to-image.service.ts` / I2IForm | aspectRatio、customAspectW/H、resolutionTier、旧 resolution、count；没有独立 quality 入参 | 复用 aspectRatio/customAspectW/H/resolutionTier 命名，count 保留车泰斗规则 |
| `src/image-generation/generate.service.ts` | 主生图使用 resolutionTier、aspectRatio、customSizeMode 等业务字段 | 保持业务字段与网关字段分层，不把旧像素兼容字段作为新推荐入参 |
| `src/image-project/portrait-image-generator.ts` | modelParams 展开后固定业务字段覆盖 | 参考其受控字段保护；模型、参考图、回调由服务端控制 |
| `src/image-project/portrait-size-planner.ts` | deliveryTarget={aspectRatio,resolutionTier}；尺寸参数从 model_params 剥离后由规划器注入 | 复用相同尺寸规划口径；车泰斗通过顶层 aspectRatio/resolutionTier 表达目标，避免重复传参 |
| `src/ai-gateway/ai-gateway-model.service.ts` / findAll | `/api/ai-models?modality=IMAGE&category=...` 返回 facts、requestSchema | 复用 gatewayConfig.detail/requestSchema 数据来源，不新增另一份模型能力配置 |
| `src/ai-gateway/gateway-image-sizing.ts` | 接收业务 resolutionTier；输出 size 或 aspect_ratio+resolution | 直接复用；保留 adjustments |
| `src/image-generation/providers/gateway-size-normalize.ts` | gatewayNormalizeTargetSize 计算目标；normalizeGatewayImage 使用 cover+attention；cropToRatio 分支只裁比例 | 车泰斗下载字节后调用同一纯函数，复用目标计算和开关策略 |
| `src/image-generation/providers/gateway-image.provider.ts` | adjustments 非空时按目标宽/高传 cropToRatio，否则归一到目标尺寸 | 冻结相同分支判断；保存 normalized、sizingAdjusted 和 adaptation |

参数映射明确如下：

| 含义 | 车泰斗业务请求 | 实际网关请求 |
|---|---|---|
| 尺寸档位 | resolutionTier，如 2K | 通常 resolution=2k；模型能力收敛后可能降低或变成 size |
| 图片比例 | 前端传实际 aspectRatio=宽:高，或 custom + customAspectW/H；默认母版比例也传实际值 | 服务端校验并约分前端值，再映射 aspect_ratio 或参与 size 推导，不自行选择比例 |
| 图片张数 | count=1/2/4/8 | 每张独立请求 n=1 |
| 模型 | 数据库 CHETAIDOU_IMAGE 分类下唯一启用且网关可用的 IMAGE 行 | model=该行 publicId；本次配置后为 gpt-image-2.5-sunburst |

尺寸字段统一使用现有业务命名 resolutionTier。车泰斗本期不增加 promptConfig.model_params 嵌套或任意网关参数透传。

现有通用文生图默认 2K，图生图无档位时可从旧 resolution 推导；车泰斗旧默认为 1k。本期保留车泰斗默认 1K，不把另一入口的默认值直接移植。通用生图客户端的 3K 兼容已按 2K 处理，新控件不展示 3K。

### 2.2 模型能力核实边界

本地 SDK 尺寸类型为 `resolution: 1k | 2k | 4k`，不能据此认定 Sunburst 一定支持所有取值。业务层大写档位和网关小写枚举之间必须通过统一适配器映射。

本地 `src/ai-gateway/gateway-image-sizing.ts` 已为 `gpt-image-2.5-` 前缀配置尺寸能力：单边 3840、总像素 655360–8294400、比例 1:3–3:1。这是现有代码依据，不是本次重新核实的在线目录。

编写本文时，网关目录和目标数据库均未成功连通，原模型 ID、实际价格及 Sunburst 最新 Schema 尚未核实。实施第一步必须通过配置的网关 SDK 读取：

```ts
await gateway.models.get("gpt-image-2.5-sunburst")
await gateway.models.requestSchema("gpt-image-2.5-sunburst", {
  operation: "images.generations",
})
```

确认图片模态、edit + reference_images、异步任务、比例/尺寸参数、使用模型默认质量，以及单张 `n=1` 可用。保存 detail、requestSchema、Schema version 和核实日期到目标模型目录行。Schema 不明确时先核实，不能按猜测提交模型请求。

## 3. 产品与默认值

生成操作栏顺序：比例 → 尺寸 → 张数 → 生成图片。选择自定义比例时显示“比例宽”“比例高”两个正整数输入框。

| 项目 | 默认策略 | 说明 |
|---|---|---|
| resolutionTier | 前端默认 1K；后端省略时也按 1K 接收 | 1K/2K/4K，提交时由后端按当前模型校验、适配 |
| count | 1 | 保持原有规则 |
| aspectRatio | 前端默认选中母版比例并计算其实际宽:高 | 新建 GENERATE 必须传递；服务端校验、约分，不按母版尺寸补默认比例 |
| customAspectW/H | 仅 custom 模式填写 | 正的安全整数，表达比例；无像素模式 |

控件、选项和默认值由前端自行维护，后端不提供生图控件配置。参数与模型不兼容时，在新建任务阶段返回明确错误。

记忆按用户和母版隔离，沿用张数的本地输入保存方式；不增加跨设备同步。修改比例、尺寸、张数只影响下一次 GENERATE，不修改已存组合结果，不标记联想或组合过期；服务端为每次生成冻结有效提示词和目标比例。

### 3.1 比例选项

沿用通用生图的 10 个预置比例，增加车泰斗的母版比例默认选项和已有生图的 custom 模式：

```text
母版比例（前端选项，提交当前母版实际宽:高）
1:1、3:4、4:3、16:9、21:9、9:16、3:2、2:3、5:4、4:5
custom（自定义比例，填写 customAspectW/customAspectH）
```

母版比例控件显示当前母版实际约分值，例如“母版比例（4:5）”。前端从母版 width/height 计算并提交 aspectRatio="4:5"；取不到合法尺寸时禁用母版比例生成并获取母版详情，不省略字段让后端猜测。选择 16:9 或自定义后，原图仍是 edit 参考图，最终画布按用户所选比例重构，不能通过直接拉伸商品来改变比例。

预置比例作为用户目标，由共享尺寸规划器适配成合法网关请求；不是把所有预置值都认定为模型可原生输出。控件选项由前端自行维护；后端在新建任务时执行能力校验，能力收敛时返回 warnings。前端提交的母版实际比例或 custom 的具体比例在创建任务时校验。

## 4. 接口契约

以下字段均为拟新增。示例以核实后模型及适配路径确实支持所列比例和 1k/2k/4k 为前提；实际上只返回已核实选项。客户端使用 aspectRatio/resolutionTier，不新增顶层 resolution 或 size 输入通道。

### 4.1 前端自行维护控件，原 config 保持不变

GET /api/chetaidou/config 继续返回原有模块、站点、模式、张数和模型就绪信息，不增加 imageGeneration、比例列表、尺寸列表或默认值字段。

前端自行定义十种常用比例、自定义比例及 1K/2K/4K 档位，默认母版比例和 1K。默认母版比例也必须由前端计算为实际宽:高后提交。后端接收、校验和执行传入的生成参数，不向前端下发控件配置。

数据库模型及完整 Schema 在新建 GENERATE 时读取并校验。尺寸使用共享规划器和网关公共 sizing Schema，保留引用和 allOf/anyOf 路由约束；切换脚本仍预检 33 组规格，不在 config 请求中进行该预检。

### 4.2 POST /api/chetaidou/tasks

```json
{
  "type": "GENERATE",
  "imageId": 19,
  "compositionTaskId": "430bf253-e97c-49fb-8bdc-f2e80931c690",
  "draftRevision": 6,
  "idempotencyKey": "1e74c121-8590-4d94-865d-1c19f8cfa858",
  "count": 4,
  "aspectRatio": "2:3",
  "resolutionTier": "2K"
}
```

| 字段 | 规则 |
|---|---|
| aspectRatio | 新建 GENERATE 必传；支持宽:高的正安全整数比例字符串或 custom。允许母版的任意合法实际比例，不只限预置清单；original、空值、非法字符串返回400 |
| customAspectW/H | aspectRatio=custom 时必须同时传入正的安全整数，服务端约分；非 custom 时显式传入返回 400 |
| resolutionTier | 可省略；trim + 大写归一；对用户开放 1K/2K/4K，且映射后必须由当前模型支持；显式 3K 按现有生图兼容规则转为 2K 并记录警告 |
| count | 保持 1/2/4/8 |
| draftRevision | 保持现有乐观锁行为，新前端始终提交 |

不允许空字符串/null 冒充省略值；resolutionTier 省略时使用本次创建的服务端默认值并冻结。比例没有服务端默认值，新建请求缺 aspectRatio 返回 400“请传递图片比例”。非 GENERATE 任务显式传比例、尺寸相关字段返回 400，避免无效输入被默默忽略。DTO 不声明 quality，继续遵循全局 whitelist 行为，不支持用户透传质量。

前端默认母版比例时也使用与预置比例相同的字段，例如母版 1600×2000 时提交 aspectRatio="4:5"。服务器只校验前端目标、约分并判断适配可行性，不要求该值等于母版比例，也不再根据 image.width/height 覆盖它。

自定义请求示例：

```json
{
  "type": "GENERATE",
  "imageId": 19,
  "compositionTaskId": "430bf253-e97c-49fb-8bdc-f2e80931c690",
  "draftRevision": 6,
  "idempotencyKey": "ec20e47e-fb52-4d8d-866e-943b6d8c292d",
  "count": 1,
  "aspectRatio": "custom",
  "customAspectW": 166,
  "customAspectH": 182,
  "resolutionTier": "2K"
}
```

上例服务端解析目标比例为 83:91；166/182 不表示输出宽高。沿用现有生图参数命名，不接收 customSizeMode=pixels 或任意像素输出字段。

非法档位先明确拒绝，不直接调用带默认回落的 normalizeResolutionTier 吞掉错误；合法及 3K 兼容值再复用该工具归一。`3K→2K` 的说明随 generation.warnings 返回，不能向用户显示为“真 3K”。

非法值返回中文 400，采用稳定业务码 `IMAGE_GENERATION_PARAM_INVALID`；参数能力缺失沿用 `MODEL_NOT_READY`。模型在页面打开后发生切换时，服务端按当前配置校验，提示用户重新提交，不要求获取生图控件配置，不自动改选后发起付费调用。

创建成功保留现有响应，追加 `generation`（结构与任务详情一致），便于立即展示服务端实际接受的参数。

### 4.3 任务详情与列表

`GET /api/chetaidou/tasks/:id` 和任务列表中的 GENERATE 行新增：

```json
{
  "generation": {
    "model": "gpt-image-2.5-sunburst",
    "count": 4,
    "resolutionTier": "4K",
    "requestedAspectRatio": "2:3",
    "aspectRatio": "2:3",
    "schemaVersion": 1,
    "providerApplied": {
      "aspect_ratio": "2:3",
      "resolution": "2k"
    },
    "warnings": ["清晰度档位 4k 超出模型尺寸能力，降档 2k 生成"]
  },
  "items": [
    {
      "resultId": 101,
      "index": 1,
      "status": "SUCCEEDED",
      "width": 1365,
      "height": 2048,
      "generationMeta": {
        "nativeWidth": 1365,
        "nativeHeight": 2048,
        "providerApplied": {
          "aspect_ratio": "2:3",
          "resolution": "2k"
        },
        "warnings": [],
        "ops": ["passthrough"]
      }
    }
  ]
}
```

上述宽高仅为结构示例。任务 warnings 表示提交前规划调整，Item warnings 追加网关 adaptation 和实际交付差异；界面合并去重展示。width/height 保持现有“最终交付文件实际尺寸”语义。

generationMeta 追加通用生图同结构的 `normalized: {from,to,ops}`（发生归一时）、`sizingAdjusted` 和 `adaptation`。未发生归一时不伪造 normalized。例：3072×2048 原图按目标 2:3 只裁比例，normalized.from=3072x2048、to=1365x2048、ops 包含 crop:cover+attention 和实际重编码操作。

requestedAspectRatio 保存前端提交值（实际宽:高或 custom），aspectRatio 保存服务端约分后的最终目标比例。custom 模式另返回 customAspectW/H；前端选母版比例时同样冻结实际提交的宽:高，不使用当前图片宽高回算旧任务。

批量状态接口仍保持轻量，不增加签名 URL 或完整元信息；前端沿用详情读取逻辑取得参数。历史任务缺元信息时显示“历史任务，参数记录不完整”，不从当前配置补成 Sunburst 或当前默认档位。

## 5. 后端开发设计

### 5.1 新增参数解析服务

建议新增 `src/chetaidou/chetaidou-image-options.service.ts`，注册到模块，集中完成：

1. 读取唯一启用的图片模型及 gatewayConfig。
2. 新建生成任务时校验当前模型的比例、尺寸适配能力，不构造生图控件配置。
3. 将用户选择解析为有效参数和默认值。
4. 校验前端提交的实际宽:高或 custom + 宽/高，约分为目标比例，调用 `resolveGatewaySizingIntentDetailed`，返回 sizing 和 adjustments；不根据母版计算新任务目标。
5. 校验组合后的网关 edit 请求；不支持的参数在创建任务前拒绝。

模型选择沿用 `ChetaidouContextService.resolveModels` 的数据库分类规则，不增加 `publicId="gpt-image-2.5-sunburst"` 的固定过滤条件。该服务返回的图片模型 publicId/category 冻结进任务；参数解析读取同一目录行的 gatewayConfig，任务详情的 generation.model 返回实际查询结果。查询为零行或多行时返回 MODEL_NOT_READY，不能回落到硬编码模型。

后续维护只需在数据库切换该分类的启用行，新任务即可取得新模型；已创建任务继续使用原快照。文本任务仍按 `CHETAIDOU_MULTIMODAL` 分类读取，图片模型切换不修改文本分类。

解析结果建议包含 model、schemaVersion、resolutionTier、requestedAspectRatio、aspectRatio、customAspectW/H、providerApplied、warnings。复用 `normalizeResolutionTier`、`gatewayResolutionValue` 和 `resolveGatewaySizingIntentDetailed`，保留校验与兼容警告。此服务与计费使用同一个已解析模型行；不要分别查询得到两个不同模型版本。

### 5.2 创建、幂等与快照

执行顺序：

1. 归一化显式参数，计算请求 hash，按 ownerId + idempotencyKey 查询已有任务。
2. 已有 hash 一致直接返回原任务；不同返回原有幂等冲突。该路径不依赖当前模型是否停用。
3. 新请求校验组合 READY、归属、当前草稿指针和上下文。
4. 解析当前模型能力、用户参数和完整 sizing plan。
5. 在创建事务内复核所选图片模型仍是唯一启用行、关键配置版本未变；变化则回滚并提示重新提交，不静默换模型。
6. 原子写入 Task、Job、Items 和原有草稿 CAS。

requestHash 兼容规则：沿用原 payload，仅追加客户端显式传入并校验归一后的 resolutionTier、aspectRatio、customAspectW/H。所有新字段省略时仍可计算旧 hash，先查询并返回上线前已存在的幂等任务；只有确认不是重放后才检查新请求的 aspectRatio 必填。新请求不允许靠省略比例创建任务。custom 模式提交的宽/高也参与 hash，同一键更改任一值返回冲突。前端重发必须保留原请求体。

为保留无比例的历史幂等重放，aspectRatio 在通用 DTO 层可选，在 GENERATE 的新建分支强制必填；不要用全局必填校验提前阻断旧请求重放。已存老任务的执行兼容与新请求的参数规则分开处理。

不要把动态模型 ID、当前 Schema 或后端默认值加入客户端请求 hash，否则模型切换后旧请求重放会产生伪冲突。

`TaskSnapshot.generation` 保留 count/resolution，旧 quality 改为仅供历史兼容的可选字段，新增业务字段 resolutionTier 和其他可选字段。新任务将 resolutionTier 作为用户接受档位；旧 resolution 是小写兼容镜像，实际提交值以 providerApplied 为准：

```ts
interface GenerationSnapshot {
  count: number
  quality?: string // 仅兼容历史快照，新任务不写
  resolution: string
  resolutionTier?: "1K" | "2K" | "4K"
  aspectRatio?: string
  requestedAspectRatio?: string
  customAspectW?: number
  customAspectH?: number
  generationPromptVersion?: string
  schemaVersion?: string
  providerApplied?: {
    size?: string
    aspect_ratio?: string
    resolution?: string
  }
  warnings?: string[]
  sizingAdjustments?: string[]
  normalizationMode?: "TARGET_SIZE" | "CROP_ONLY"
  plannerVersion?: string
}
```

同样写入 `ImageGenJob.request`；Task.input 增加接受后的比例、尺寸供审计。新任务的 snapshot.schemaVersion 继续为 1，通过可选字段兼容旧 JSON。模型仍存在 `snapshot.models.image`。

例如请求 4K 后规划降档 2k：snapshot.generation.resolutionTier=4K、旧兼容镜像 resolution=4k，providerApplied.resolution=2k；三者含义不能混用。外部 generation 详情只展示业务字段 resolutionTier 和 providerApplied，不再平铺旧 resolution。

sizingAdjustments 单独保存共享规划器的 adjustments；normalizationMode 按该数组是否非空冻结，非空=CROP_ONLY，空=TARGET_SIZE，与通用 gateway-image.provider 的 degraded 判断一致。warnings 可包含 3K 输入兼容等其他提示，不能直接用全部 warnings 判定裁剪分支。

生成参数不参与 compose/ideation 的 contextHash。现有 generate 的 contextHash 继续用于验证素材、选择和组合上下文，参数一致性由 requestHash 和冻结快照负责。

### 5.3 画布比例与组合提示词协调

现有 COMPOSITION_PROMPT 明确要求保留源图长宽比。增加比例下拉时必须一并处理提示词约束，否则即使网关参数改变，提示词仍可能要求旧画布。

1. 新版 COMPOSE 模板将“保留源图长宽比”改为“输出画布比例由后续生成参数决定；保留原机位/屏幕方向和商品身份约束”。更新提示词版本，新模板只影响新组合，不重写旧 Task.output。
2. GENERATE 使用服务端纯函数构造有效 prompt：保留组合 editPromptEn 作为创意正文，再追加受控的画布指令，明确最终目标比例、保持商品比例与结构、按新画布调整背景/留白、避免拉伸商品。
3. 画布指令明确仅覆盖正文中的输出画布比例要求，不覆盖商品事实、文字决策、人物身份或机位约束。比例只来自已验证并约分后的整数，不拼接用户自由指令；不靠字符串替换删除旧正文。
4. 原始组合正文仍存在 snapshot.composition.editPromptEn；有效 prompt、generationPromptVersion 和目标比例冻结到 Job.request 及 Call.request。重试复用同一 prompt，不重新根据当前下拉或模板版本编译。
5. 新旧 READY 组合均可使用比例选择；对旧正文里的源比例要求应用同一受控画布指令，不强制用户重新联想/组合、不增加一次 AI 调用。

例如目标 16:9 时追加英文指令，表达“最终画布使用 16:9；此要求仅优先于正文的画布长宽比要求；保持商品几何、身份和已确认编辑，仅重构背景与画面留白”。实际文案作为版本化后端模板维护，不作为前端产品参数展示。

### 5.4 执行器与 Call 账本

- 删除执行时读取 `CHETAIDOU_IMAGE_QUALITY/RESOLUTION` 的路径；新任务直接使用冻结 providerApplied。
- 新任务不暴露或写入顶层 quality 业务字段，让网关使用模型默认值。模型 Schema 若要求显式 quality 且声明了默认值，由服务端按 Schema 填充，冻结在内部 generation.providerDefaults（Task/Job/Call）以保持重试一致；对外投影移除 providerDefaults，不新增选择控件或客户端字段；若没有可用默认值，返回 MODEL_NOT_READY，不猜测 hd。
- 旧任务尺寸先读快照 resolutionTier，再将旧 resolution 映射为大写业务档位，其次读取 Job.request；缺失时使用旧兼容默认 1K。已有历史 quality 优先读取快照，其次 Job.request，high 映射 hd、standard 保持；缺失时使用模型默认，不重新读取环境变量或注入 hd。
- 旧任务使用快照中的旧模型，缺少新计划时调用同一规划器，不使用当前启用的新模型能力替换旧模型参数。
- 尺寸规划优先读取 generation.aspectRatio；仅旧任务缺失该字段时根据冻结母版宽高计算比例。不能每次执行都覆盖为母版比例。部署前已创建任务的原有 prompt 不被新的画布模板重写。
- 建立 Call 时记录 model/category、resolutionTier、aspectRatio、providerApplied、warnings、schemaVersion、plannerVersion；Call.requestHash 覆盖这些语义参数，不包含临时签名 URL。
- 对旧 PREPARED Call 的补充在提交认领前条件更新一次；已有 providerApplied 的 Call 不能被后续配置覆盖。
- 参数规划、校验在 PREPARED→SUBMITTING 前完成；避免本地校验失败后留下“已开始提交”的 UNKNOWN。认领和落库继续遵循现有 CAS。
- 发给网关的请求固定 edit、reference_images、n=1、callback=true。size 与 aspect_ratio/resolution 两种 sizing 分支互斥；新任务沿用模型默认质量，旧任务的质量兼容只在内部执行层处理。
- Call 状态机、providerIdempotencyKey、webhook 分流和扣费唯一键保持现有规则。不要增加失败自动换模型或 UNKNOWN 自动重发。

### 5.5 比例与尺寸交付展示

#### 5.5.1 复用入口和规则

裁剪以现有通用图片生成的 `gateway-size-normalize.ts` 和 `gateway-image.provider.ts` 为依据。采用同一个 normalizeGatewayImage 纯函数，不在车泰斗重新实现最大裁切框、缩放、焦点或编码算法。现有人像/AI拆图的 AiGatewayImageArtifactService 是另一条交付链路，其存储路径和 task/project 结构与车泰斗不同，本期使用通用生图的归一函数作为共用入口。

| 场景 | 与通用图片生成一致的行为 |
|---|---|
| 提交规划没有尺寸/比例调整 | TARGET_SIZE：cover+attention 裁到目标比例，并按 resolutionTier 对应目标尺寸归一；使用 lanczos3，缩小或放大时沿用现有算法，上采样时沿用 sharpen |
| 规划 adjustments 非空（尺寸降档/比例改写等） | CROP_ONLY：传 cropToRatio=用户目标宽/高，按实际原图裁回比例，不缩放、不放大补回原始档位 |
| 比例差<1%且尺寸重采样系数与1偏差≤2% | 沿用共用函数快路径，保留原字节，避免二次编码 |
| 开关关闭、模型在豁免名单、超过共用归一像素阈值、处理异常 | 沿用共用归一的保原图行为；返回实际宽高，必要时提示未完成目标比例/尺寸调整 |

普通 TARGET_SIZE 分支在原图不足所选尺寸时可能放大补档，这是当前通用图片生成的既有行为。此前方案中“所有场景只裁不放大”的描述在此修正为“模型适配分支只裁不放大”，不把人像/AI拆图的另一套交付规则混入通用生图。

处理后的格式沿用共用函数：有 alpha 输出 PNG，无 alpha 输出 JPEG（现有编码参数 quality=94、4:4:4）。这里是文件重编码参数，不是生图模型的质量选项，前端仍不提供质量控制。

#### 5.5.2 车泰斗接线步骤

建议新增薄适配文件 `src/chetaidou/chetaidou-image-delivery.ts`，仅转换冻结参数和结果结构：

1. `deliverArtifact` 继续通过车泰斗现有下载方法获取原图 Buffer，测量原生宽高；不再调用会重复下载的 normalizeGatewayArtifact 包装入口。
2. 将 generation.aspectRatio 转为通用目标计算输入：预置比例直接使用；其他合法宽:高使用 aspectRatio=custom、customAspectW/H=已约分数字、customSizeMode=ratio。resolutionTier 使用冻结的大写档位。
3. 调用现有 gatewayNormalizeTargetSize 获取目标 width/height，避免另维护档位到像素的映射。
4. 调用现有 gatewaySizeNormalizeEnabled(modelId) 遵循通用开关和模型豁免；归一阈值沿用 IMAGE_GATEWAY_NORMALIZE_MAX_PIXELS 与 DEFAULT_NORMALIZE_MAX_PIXELS，不新增车泰斗裁剪限额。该阈值仅触发保原图，不拒绝上传、创建或交付。
5. 启用时调用 normalizeGatewayImage({bytes,targetWidth,targetHeight,maxPixels,...})；仅 CROP_ONLY 模式传 cropToRatio，目标来自冻结的用户比例，不能固定裁回母版比例。
6. 返回非空结果时解码 dataUrl，使用其真实 MIME/格式转存并读取最终宽高。扩展 artifactFileKey 的可选格式参数以生成 output.jpg/output.png 等匹配后缀；保留旧调用签名和已存 key 的读取兼容。
7. 返回 null 时保留原字节。null 可能代表命中快路径，也可能代表关闭/超限/处理失败，不能一律标记 passthrough 或宣称已经精确裁到目标；以实际宽高和与目标的比较决定展示说明。
8. 使用原生及最终 metadata 更新 Item.width/height 和 gatewayImage；上传仍走车泰斗私有 hostArtifact，签名下载和来源隔离保持原有路径。

业务层保存 `requested`、`actual`、原生尺寸、`providerApplied`、`normalized`（from/to/ops）、`sizingAdjusted` 和网关 `adaptation`；公开 generationMeta 投影这些字段，不暴露网关产物或签名参考图地址。ops 原样使用共用函数输出，不自造同名但含义不同的动作。

#### 5.5.3 失败与恢复

按照通用图片生成的归一策略，裁剪/归一失败保留并转存原图，提示“图片尺寸调整未完成，已返回模型原图”，不将已成功的图片因可回退的裁剪失败置为 FAILED。若原图无法解析或下载/私有转存/结算失败，仍沿用现有 DELIVERY_PENDING 恢复，不重新调用生图、不重复扣费。

已有 SUCCEEDED 文件不批量重新处理。新增回归测试验证相同字节和冻结输入得到与共用函数相同的归一结果，而不是另写一组裁剪公式测试。

## 6. 前端开发清单

| 文件 | 具体工作 |
|---|---|
| `public/studio.html` | action-bar 增加 render-aspect-ratio、render-resolution 控件，以及 custom 比例宽/高输入 |
| `public/studio.css` | 调整操作栏窄屏布局，避免比例、尺寸、张数和自定义输入遮挡生成按钮 |
| `public/studio.js` | 前端自行定义控件选项和默认值、监听选择、展示参数和调整说明 |
| `public/studio-draft.mjs` | createDraft/serializeDraft 增加 renderAspectRatio、renderCustomAspectW/H、renderResolutionTier，恢复时验证可选值 |
| `public/studio-backend.mjs` | 母版比例选项先转换为实际 aspectRatio；GENERATE body 明确传比例、customAspectW/H、尺寸和 saved.revision；mapTask 保留 generation 和 Item 元信息 |

行为要求：

- 比例、custom 宽/高和 resolutionTier 变化只 persist 本地输入，不走会使组合过期的设置变更逻辑；尺寸控件值保持 1K/2K/4K，只有后端网关适配层转小写。
- 母版比例是前端本地选择状态，可内部使用 original 标识，但提交前必须换成母版实际比例；后端不接收 original。custom 时展示两个输入并要求同时有效，其他模式不提交 customAspectW/H。草稿缺比例时前端选母版比例并计算实际值，不用 1:1 覆盖母版默认行为。
- 本地 key 建议 `chetaidou:<userId>:<imageId>:generation-options`，仅保存输入值；不保存 JWT 或签名 URL。
- 旧本地草稿缺尺寸时使用前端默认 1K，缺比例时使用前端计算的母版实际比例；已保存值失效时显示调整提示，等待用户点击生成。
- 网络失败重发复用同一个 idempotencyKey 和请求体；用户改参数或主动新一批生成则生成新 UUID。
- `submitTask` 现有 saveDraft 路径仍要同步未保存的语义输入；只改变生图选项不能导致已就绪组合被清空。联调核实 saveDraft 在内容未变时保留指针，发现问题则修正该路径，不绕过服务端组合过期校验。
- 历史列表和结果卡使用任务自己的参数；不能用当前下拉值标注旧结果。
- 模型停用导致旧任务无法重试时，提示“原任务模型已停用，请使用当前模型重新生成”；新建 GENERATE 仍要求当前组合 READY。

## 7. 模型切换与发布

### 7.1 切换脚本

新增 `scripts/switch-chetaidou-image-model.ts`，作为本次定向维护工具，不复用全量初始化。已有初始化明确不会替换或停用模型；现有通用 onboard 脚本新建行会 enabled=true，单独执行可能造成分类双启用，不应直接作为切换命令。

已提供脚本：

```bash
# 预览，默认不写库；原模型 ID 从目标库读取后显式填写
node --env-file-if-exists=.env -r ts-node/register scripts/switch-chetaidou-image-model.ts \
  --from=<当前模型publicId> \
  --to=gpt-image-2.5-sunburst --dry-run

# 正式切换
node --env-file-if-exists=.env -r ts-node/register scripts/switch-chetaidou-image-model.ts \
  --from=<当前模型publicId> \
  --to=gpt-image-2.5-sunburst --apply
```

脚本规则：

1. 固定 category=CHETAIDOU_IMAGE、modality=IMAGE；拉取并验证目标 detail/Schema，验证成功才进入写事务。
2. 首次执行要求当前唯一启用模型与 --from 一致；如已唯一启用 --to 则幂等返回结果，不重新覆盖价格。
3. 新建目标行时默认继承旧行的 priceMultiplier/fixedCredits，并输出继承结果；目标行已有价格时保留已有值。允许显式价格参数，但不猜测网关成本或售价。
4. 事务内锁定该分类已有模型行，复核预检状态和价格；upsert 目标行启用，停用其他启用行，再校验唯一性。不允许两次切换操作互相覆盖。
5. 保留旧模型行、价格、gatewayConfig 和 gatewayActive；平台停用写 enabled=false，不伪造“网关已下架”。
6. dry-run 输出 from/to、价格、能力摘要、即将变化的行及是否可执行，不输出凭据、连接串或签名 URL。
7. apply 前将受影响目录行保存为本地受控备份，包含恢复所需字段；支持 --restore=<备份文件> 的事务恢复，要求当前状态与备份记录的切换后状态一致，避免覆盖后续人工改动。
8. 回滚恢复的是目录配置，不改写已创建任务的模型快照；Sunburst 已提交任务继续结算，停用后的新重试适用同一规则。

### 7.2 旧任务处理

| 任务情况 | 切换后的行为 |
|---|---|
| 新 GENERATE | 解析唯一启用模型，使用 Sunburst |
| 切换前已创建但未提交 | 按冻结旧模型及参数继续执行；不受新建任务目录过滤影响 |
| 已提交/待回调/待交付 | 按原 Call 查询、接收回执、交付和结算 |
| 旧模型 FAILED Item 请求重试 | 拒绝发起新调用，返回明确 MODEL_NOT_READY 提示 |
| UNKNOWN/WAITING_RECONCILIATION | 继续核对，不能通过换模型代替核对 |
| 旧成功任务 | 原样查询、下载和查看参数 |

`imageRetry` 的错误提示需要针对原图片模型停用做清晰说明；已有幂等重试请求仍优先返回原重试结果，不重新受新模型配置影响。

### 7.3 发布顺序

1. 核实目标模型能力，取得可复用的 Schema 测试夹具。
2. 完成后端、前端与切换脚本，协调发布。后端保留旧任务读取和幂等重放，但新建生图必须有前端比例字段；生图入口启用前完成前端传参部署，避免旧页面无比例提交被400拒绝。先保持原模型启用。
3. 执行 dry-run，检查原模型、价格及目标 edit 能力。
4. 执行 apply，查询数据库确认该分类唯一启用目标模型。
5. 发布前端，验证生成控件与详情展示。
6. 在测试环境进行真实单张 edit 验证；覆盖母版比例、预置横/竖/方形、自定义比例和每个开放尺寸档位，确认模型默认质量可用，并检查网关实际请求、回执、文件和流水。
7. 观察旧在途任务仍收敛、新任务全部使用 Sunburst、未出现分类双启用。

回滚时优先恢复目录备份和前端版本；保留能够处理新 JSON 和在途回调的后端。执行器需保留新任务尺寸计划与历史参数的兼容能力。

## 8. 计费与可观测性

继续使用现有 `chetaidou.image` source 和 Call 级幂等扣费，不新增余额预检：

- fixedCredits>0：成功单张按该分类固定积分结算，不因档位改变单价。
- 未配置 fixedCredits：使用实际网关账单和现有倍率/扣费路由。
- 新模型成本可能随参数变化；切换 dry-run 明确展示当前是一口价还是按量。按档位定价属于另一期需求，本次不增加价格表。
- 已提交 Call 使用原 model/category 结算；切换不能删除旧定价行。保持当前结算时实时读价格的既有语义，不宣称售价已随快照冻结。
- 终态重复回调、DELIVERY_PENDING 恢复仍必须只扣一次。

结构化日志记录 taskId/jobId/itemId/callId、模型、选择参数、实际提交参数、调整说明和终态实际尺寸。公共详情和审计字段不包含网关 reference_images 签名 URL。

## 9. 测试与验收

| 编号 | 场景 | 预期结果 |
|---|---|---|
| T01 | 原 config 返回契约 | 不新增 imageGeneration，不下发生图控件或执行额外参数能力读取 |
| T02 | resolutionTier=1K/2K/4K 的大小写输入 | 正确归一并冻结；3K 兼容为 2K 并提示；非法值、空/null 不落任务 |
| T03 | 不传比例的历史幂等重放、新建请求 | 历史 hash 一致时返回原任务；新键缺比例400，不由后端补母版比例 |
| T04 | 同键同参数、同键不同尺寸/比例/custom宽高 | 前者返回原任务；后者 409，不增 Job/Call |
| T05 | 同键省略参数与显式默认参数 | 按不同载荷返回冲突；与文档规则一致 |
| T06 | 任务创建后修改环境变量或目录默认值 | 实际提交与原快照一致 |
| T07 | 2:3 + resolutionTier=4K 的本地能力收敛 | 请求保持 4K，网关按现有规划降档 2k，warnings 和 applied 留痕，不放大 |
| T08 | 用户自定义极端比例及母版特殊比例 | size/intent 分支互斥；按用户目标裁切，未增加上传上限 |
| T09 | 原生返回尺寸不同或带 adaptation | 详情展示实际值、原生值与调整说明 |
| T10 | 本地规划失败、重复执行器扫描 | 本地失败不误记未知提交，CAS 保证一次提交 |
| T11 | 只改变比例/尺寸/张数后生成 | 组合指针仍有效，不要求重新联想或组合 |
| T12 | 部分失败后重试 | 同模型仍启用时沿用原参数、resultId/index；仅失败 Item 新建 Call |
| T13 | 切换前已创建/已提交/待交付的旧任务 | 使用旧快照执行或恢复，回调和旧模型计费正常 |
| T14 | 旧模型停用后请求新的失败重试 | 明确提示停用，不暗中换成 Sunburst |
| T15 | 切换 dry-run、重复 apply、并发 apply、恢复备份 | dry-run 无写；幂等成功；并发不覆盖；分类始终唯一 |
| T16 | fixedCredits 与按量、重复回调 | 沿用计费口径，不重复扣费 |
| T17 | 前端刷新、切换用户/母版、配置变化、窄屏 | 输入隔离恢复、失效值提示、布局可用 |
| T18 | 历史任务缺字段 | 历史值按记录展示，不伪造当前模型和尺寸 |
| T19 | 与现有生图的字段及适配工具对照 | 业务 resolutionTier 大写、网关 resolution 小写；size 分支不混传 intent；没有新增重复尺寸算法 |
| T20 | 新任务使用模型默认质量、旧任务带历史 quality | 前端控件/新请求/详情无质量选择字段；新调用使用模型默认，旧任务沿用已冻结质量，不重读环境变量 |
| T21 | 数据库启用的图片模型改为其他合法 publicId | 新任务自动采用数据库模型，无需修改模型常量或环境变量；零行/多行报 MODEL_NOT_READY，旧任务不换模型 |
| T22 | 前端母版比例选项与 10 个预置比例 | 母版选项实际传4:5等字符串；original不发往后端；所有目标进入网关规划和实际prompt |
| T23 | custom=166:182、缺一边、零/负数/非整数、非custom带宽高 | 合法值约分83:91；其余400，不把输入作为像素输出 |
| T24 | 4:5 母版选择16:9，组合正文仍有保留源比例描述 | 有效 prompt 明确目标16:9且不修改原组合；保持商品几何，产物不裁回4:5 |
| T25 | 比例修改后重试旧失败任务/恢复旧排队任务 | 使用旧任务冻结的比例和prompt，不受当前控件及模板变化影响 |
| T26 | 母版为4:5，前端传16:9；母版为166:182，前端传83:91 | 后端采用前端目标，不以母版尺寸覆盖；任意合法母版比例可经适配生成 |
| T27 | 原图2048×2048、目标16:9@2K，无规划调整 | 调用共用函数，归一为2048×1152，ops与通用生图一致 |
| T28 | 原图3072×2048、目标2:3@4K，规划降档 | 使用cropToRatio，裁为1365×2048，不上采样 |
| T29 | 未降档但原图不足目标尺寸 | 与通用生图TARGET_SIZE分支一致，保留实际upscale/sharpen动作记录 |
| T30 | 归一null、关闭/豁免、超阈值或处理异常 | 返回原图及实际尺寸；不把所有null伪装成成功裁剪，不重复生图/扣费 |
| T31 | alpha/非alpha产物与私有转存恢复 | 格式、MIME、文件后缀一致；normalized.from/to/ops可对账 |

建议新增参数服务、交付薄适配和执行器的单测，并扩展 DTO、service、context、integration 和模型切换脚本测试。复用现有尺寸规划与 gateway-size-normalize 测试，验证裁剪接线及业务回退，不为静态 UI 文案写实现镜像测试。

```bash
# 后端受影响模块
npx jest --runInBand --testPathPatterns='chetaidou|gateway-image-sizing|gateway-size-normalize|gateway-image.provider'

# 构建验证
npm run build
```

前端使用其仓库既有验证命令，并在实际部署 origin 做手动联调。真实生图涉及费用，应在测试账号验证并留存 Call/UsageLog 证据。后端构建和相关自动测试已通过；真实生图待前端联调验收。

## 10. 开发交付顺序与完成标准

1. **能力核实及参数服务**：Schema 夹具、接收参数规则、原 config 契约兼容、参数校验完成。
2. **创建及执行链路**：DTO、幂等、快照、Call、完整尺寸计划贯通。
3. **交付与查询**：复用通用生图裁剪归一、实际尺寸、normalized、warnings、历史兼容完成。
4. **前端接入**：控件、输入记忆、传参、历史展示、不失效组合完成。
5. **模型切换工具**：dry-run、原子切换、备份恢复和测试完成。
6. **联调发布**：测试通过、真实网关请求可核对、模型唯一性和旧任务收敛验证完成。

交付时同步更新 `docs/chetaidou.api.md`、`src/chetaidou/README.integration.md` 和脚本说明，删除旧生图质量/尺寸环境变量的使用说明；保留其他超时和功能开关配置。

完成标准：用户所选比例/尺寸可追溯到实际网关请求和有效提示词；尺寸差异能解释；裁剪复用通用图片生成的目标尺寸与CROP_ONLY分支，原图回退时明确展示实际值；新任务使用 Sunburst；原模型仅在车泰斗分类停用；旧在途任务正常交付结算；旧幂等请求兼容；修改生成选项不使现有组合过期；计费业务口径保持原有规则。


## 11. 实施与验证记录（2026-10-06）

- 后端新增 `ChetaidouImageOptionsService`，生成时模型读取、参数校验、冻结、事务模型复核、重试停用校验均已接入。
- 已复用通用尺寸规划及裁剪纯函数；实际 MIME、文件扩展名、宽高和交付元数据同步落库。
- 新组合模板不锁定画布比例，GENERATE 追加只覆盖画布比例的可信指令；历史质量及母版比例保留执行兼容。
- 已提供带 dry-run、价格继承/显式参数、事务备份和受保护恢复的切换脚本。
- 当前数据库：Sunburst 已启用、ZQ-Image-2 已停用；本地缓存 Schema 版本 1，33 组参数预检通过。没有重复修改当前库。
- `npm run build` 通过；车泰斗及共享 sizing/normalize 测试通过 15 个套件、197 项。
- 未修改相邻前端仓库，未部署后端，未发起付费网关生图。前端接入和真实生图验收依据 [前端联调文档](../车泰斗生图比例尺寸-前端联调文档.md)。


修订：按用户要求，生图控件和选项完全由前端维护；已撤销 imageGeneration 配置下发，生成参数的接收、校验、适配、裁剪和快照冻结保持有效。
