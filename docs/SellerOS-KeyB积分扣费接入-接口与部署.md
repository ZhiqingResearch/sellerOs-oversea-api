# SellerOS KeyB 积分扣费接入：接口与部署

更新：2026-09-08。本文依据本仓库当前实现、`temp/SellerOS-KeyB积分扣费接入-开发任务书.md` 及已确认的项目授权改为数据库管理调整编写，供 SellerOS 前端、API 后端及部署人员对接。项目授权的最新契约以本文为准。所有示例均为结构示例，不包含真实密钥或真实账户余额。

按使用对象提供两份可独立使用的文档：

- [前端对接文档](./SellerOS-KeyB-前端对接文档.md)：可直接交给前端 AI，包含页面状态、四个 JWT 接口、操作重试、复制与验收要求。
- [部署文档](./SellerOS-KeyB-部署文档.md)：逐项解释四个环境变量的来源/填写方式，并提供数据库升级、既有服务补授权及接入方管理脚本命令。

API 后端的 KeyB 扣费签名、费用参数与服务回执契约继续以本文第 3～5 节为准。

**代码已实现不等于全环境联调已完成。** 本次只修改 SellerOS：新增用户项目凭证管理、KeyB 服务扣费入口和接入校验。dev 环境（api-dev2）已完成真实签发与扣费联调（见第 9 节）；生产部署、API 自动衔接扣费、MCP 结果展示、专用数据库并发验收仍需另行完成，详见最后两节。

## 1. 调用关系与实施边界

```text
SellerOS 用户 -- JWT --> SellerOS 后端
                          └─ KeyA + 当前数据库手机号 --> API 签发接口
                          └─ 加密保存 KeyB，绑定 SellerOS 用户及接入项目

业务调用方 -- KeyB --> API 执行业务、取得可信费用
                        └─ KeyB + OpenApiApp 服务签名 --> SellerOS 新扣费入口
                                                        └─ UsageService.chargeModel()
```

- **KeyA** 是 API 签发给 SellerOS 接入项目的凭证，只由 SellerOS 后端持有，用于申请或轮换 KeyB。
- **KeyB** 是用户项目凭证。SellerOS 根据其 SHA-256 哈希找出消费用户及接入项目。
- **OpenApiApp 的 appId/appSecret** 用于确认上报费用的 API 服务身份，与用户 KeyB、项目 KeyA 分开保管。只有 KeyB 不能自行填写金额完成扣费。
- **OpenApiApp.keybProjectCodes** 保存服务获准扣费的本地项目代码，默认 `[]`，本期可授予 `selleros`。服务身份与项目授权都由数据库管理，新增或撤销服务权限无需改环境变量或重启。
- 本期只登记一个 `projectCode=selleros`，所有有效 SellerOS 用户可使用；这是外部接入项目，不是客户工作台的 `Project` 模型。
- 新入口只整理参数并调用既有 `UsageService.chargeModel()`。积分计算、取整、个人及企业资金路由、折扣、配额、返利、扣费事务均沿用原实现，没有新增授权上下文、结算订单、冻结、退款、补偿平台或 MCP 调用次数费用。
- 原有 `POST /api/usage/deduct/v2` 和 `/api/open/credit/*` 保持原路由及签名契约。新接口的六位小数字符串金额不改变旧接口的金额约束。

## 2. SellerOS 用户接口

四个接口都要求 `Authorization: Bearer <SellerOS JWT>`。此处使用 SellerOS 登录 JWT，不使用 KeyB。`userId` 来自已认证登录态，四个接口均重新确认当前数据库账号有效。生成/重置时还会读取当前数据库手机号，要求其为符合 `^1[3-9]\d{9}$` 的 11 位手机号；状态查询与复制只检查账号有效，不额外要求手机号满足签发格式。

前端不能指定其他用户的 `userId`、`phone` 或项目密钥。全局白名单校验会移除未声明顶层字段，这些字段不会决定操作对象；客户端应只提交本文声明的参数。

| 方法及路径 | 参数 | 正常返回 | 行为 |
| --- | --- | --- | --- |
| `GET /api/skills/keys` | query 可选 `projectCode`，省略为 `selleros` | 200 | 查询本人的状态及脱敏信息 |
| `POST /api/skills/keys` | JSON：`projectCode`、`operationId` | 201 | 首次生成；已有凭证不会隐式重置 |
| `POST /api/skills/keys/reset` | JSON：`projectCode`、`operationId` | 201 | 对当前有效凭证明确发起轮换 |
| `POST /api/skills/keys/reveal` | JSON：`projectCode` | 201 | 用户主动查看或复制当前有效 KeyB |

`projectCode` 须为小写字母开头的字母、数字、下划线或连字符，最长 50；本期实际仅允许 `selleros`。`operationId` 须为 UUID，后端统一转为小写。推荐前端在用户开始一次操作时用 `crypto.randomUUID()` 生成，并保留到操作终态；网络重试继续使用相同值。

生成或重置请求示例：

```json
{
  "projectCode": "selleros",
  "operationId": "cb86d8cc-65eb-4674-a814-3a7fc4bbff1c"
}
```

### 2.1 状态与返回字段

无凭证时，状态接口返回：

```json
{
  "projectCode": "selleros",
  "status": "NOT_CREATED",
  "maskedKey": null
}
```

已有凭证时，状态接口返回以下字段。日期使用 ISO 8601 字符串；生成、重置、主动查看/复制成功在同一结构上增加 `key` 字段，值为本次允许交付的完整 KeyB。状态接口永远不包含 `key`。

| 字段 | 含义 |
| --- | --- |
| `projectCode` | 后端登记的项目代码 |
| `status` | `ACTIVE`、`ROTATING` 或 `SYNC_UNKNOWN`；未创建时为 `NOT_CREATED` |
| `maskedKey` | 仅 `ACTIVE` 且项目配置一致时返回脱敏字符串；其他情况为 null。长度大于 11 的 Key 保留前 3 位和末 4 位，中间 `****`；短 Key 只保留前 3 位，前端原样展示 |
| `operationId` | 当前生成或重置操作 UUID |
| `activatedAt` | 最近保存成功时间，首次未成功时为 null；不代表当前状态一定有效 |
| `updatedAt` | 凭证关联记录更新时间 |
| `lastErrorCode` | 固定错误标识或 null，不含远端原始错误、手机号或密钥 |
| `recoveryMessage` | 签发待恢复时的人工处理提示；项目配置变更时提示主动重置；其他情况为 null |
| `key` | 仅生成、重置、主动显示/复制成功时出现；不可记录到日志、埋点或普通缓存 |

接口响应声明 `Cache-Control: no-store`。前端及代理应保持禁缓存，不将含 KeyB 的响应写入访问日志、错误上报、页面埋点或共享缓存。复制应由当前用户主动触发，前端不获取 KeyA 或 appSecret。

前端默认展示类似 `API Key  zk-****4f2a  [显示] [复制] [重置]`，以实际 `maskedKey` 为准，不拼接或校验额外的固定前缀，也不为展示部分字符请求明文。「显示」和「复制」均使用现有 `POST /api/skills/keys/reveal`；「隐藏」只清除局部临时原值并恢复脱敏展示，不调用接口。完整交互及 60 秒清理规则见 [前端对接文档](./SellerOS-KeyB-前端对接文档.md#5-用户文案显示隐藏与安全复制)。本项不新增接口、配置、数据库字段或迁移脚本。

### 2.2 生成、重置与重试规则

1. 首次生成先建立 `ROTATING` 凭证行，再调用 API。重置通过凭证行 `revision`、状态及操作编号进行条件更新，只有取得操作权的请求会访问非幂等签发接口；不在数据库事务内等待 HTTP。
2. 已有凭证时，用新的 `operationId` 调首次生成接口返回 409 `SKILLS_KEY_EXISTS`，不会轮换旧 Key。用户应主动复制，或明确使用重置接口。
3. 相同 `operationId` 只有在它仍是当前操作、操作类型相同、当前凭证为 `ACTIVE` 时，才返回当前已保存的 KeyB，不再调用 API。同 UUID 不可跨生成与重置复用。
4. 相同操作仍在 `ROTATING` 时返回 409 `SKILLS_KEY_ROTATING`；前端可查询状态，或稍后以原 UUID 重试原接口。不要通过换 UUID 强行触发签发。
5. 新重置已替代的历史 UUID 返回 409 `SKILLS_OPERATION_SUPERSEDED`；后端保存已使用 UUID 列表，不返回历史密钥，也不把历史操作再次当作新签发。
6. API 返回新 Key 且 SellerOS 加密保存成功后才返回成功。远端超时、结果不明确、返回结构异常、本地保存失败等统一进入 `SYNC_UNKNOWN`，接口不会报告生成成功，也不允许旧 Key 继续通过新的扣费鉴权。
7. 签发 HTTP 超时固定为 15 秒，不自动重试、不跟随重定向。进程异常留下的 `ROTATING` 在状态、复制或操作读路径上，超过 75 秒后会懒标记为 `SYNC_UNKNOWN`；这不是后台自动重签或恢复任务。
8. `SYNC_UNKNOWN` 不接受自动重置。处理流程见第 8 节。

**项目切换（2026-09-14）：**明确重置始终使用当前环境变量里的 API 地址、项目 ID 和 KeyA，保存新 KeyB 时自动更新关联。旧项目 ID 不再阻止新重置，无需手改数据库或执行迁移脚本。GET 的 `SYNC_UNKNOWN` + `lastErrorCode=SKILLS_PROJECT_CHANGED` 表示原凭证有效但属于旧项目，前端允许用户确认后用新 UUID 调 `/api/skills/keys/reset`，请求仍只传 `projectCode: "selleros"` 和 `operationId`。历史 UUID 不触发新签发；实际 `ROTATING` 或签发异常 `SYNC_UNKNOWN` 仍拒绝新操作。切换不同 API 环境时，本地重置不代表已向旧环境撤销 Key。

重置前前端须明确提示：**旧 Key 将失效，需要在客户端更新；使用旧 Key 的在途业务可能扣费失败并需要人工处理。** 本次交付的是后端接口和文档，未实现其他仓库的前端交互。

## 3. API 后端扣费接口

### 3.1 请求与身份

```text
POST /api/open/keyb/credit/deduct
Content-Type: application/json
Authorization: Bearer <当前用户 KeyB>
x-sign-version: v2
x-app-id: <API 服务 appId>
x-timestamp: <Unix 毫秒时间戳>
x-nonce: <本次 HTTP 请求随机值>
x-sign: <小写十六进制 HMAC-SHA256>
```

该接口不接受 query 参数。KeyB 兼容 `zk-` 与历史 `sk_` 前缀，后续字符为字母、数字、下划线或连字符，总长不超过 512。鉴权须同时满足：

- OpenApiApp 存在、状态为 `ACTIVE`，服务签名正确且在时间窗内。
- KeyB 哈希命中 SellerOS 的当前 `ACTIVE` 关联；轮换中的、结果未知的及旧 Key 均不能继续通过新请求的凭证鉴权。
- 关联项目与当前配置的外部项目 ID 一致，且数据库中调用服务的 `keybProjectCodes` 包含该关联的 `projectCode`（本期为 `selleros`）。
- 凭证所属 SellerOS 用户存在且未停用。

用户和项目由 KeyB 关联决定，不接受请求体 `userId`、`phone`、`teamId` 改变扣费对象；失败后不会退回手机号扣费，也不会替 API 换用新 Key 或其他用户的 Key。

项目授权逐请求读取数据库，不缓存、不回退到环境白名单。新建服务身份默认没有 KeyB 项目权限，需创建时显式授权或给既有身份补授权。授权/撤权不修改 appId/appSecret、服务状态或消费幂等空间；停用服务即使保留项目授权也不能扣费。API 请求头、签名算法、业务参数和回执结构不因此调整。

### 3.2 业务参数

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `costCny` | 是 | API 服务确认的实际人民币费用；十进制字符串，`0 < costCny <= 999999.999999`，最多六位小数 |
| `source` | 是 | 已登记且有效的 FeatureModule key，最长 50 字符 |
| `model` | 是 | 本次真实使用的模型标识，最长 100 字符 |
| `requestId` | 是 | API 为一笔费用生成的稳定编号，最长 128 字符；重试不改变 |
| `meta` | 否 | 对象，仅允许 `taskId`、`gatewayTaskId`、`channel` |

金额不得使用 JSON 数字、科学计数法、正负号、前导零、空白、零或超过六位小数的值。例如 `"0.000001"`、`"0.35"`、`"1.000000"` 有效，`0.35`、`"1e-6"`、`"01.2"`、`"0"` 无效。适配层沿用 Decimal，不先转换成 Number，也不把小额费用预先四舍五入为零。

最大值来自现有 `UsageLog.cost Decimal(12,6)` 的存储范围。新消费另须满足既有 `OpenApiApp.perCallMaxCny` 配置，null 表示未设置该单笔限额。已成功的相同消费重放以原记录为准，不因后来下调单笔限额而再次失败。

`source`、`model`、`requestId` 及 meta 文本值须非空、无首尾空白、无控制字符，不能包含当前 KeyB 或 `zk-`、`sk_`、`Bearer ` 等凭证特征。

| meta 字段 | 可用类型 |
| --- | --- |
| `taskId` | 最长 128 字符的安全文本，或非负 JavaScript 安全整数 |
| `gatewayTaskId` | 最长 128 字符的安全文本，或非负 JavaScript 安全整数 |
| `channel` | 最长 32 字符的安全文本 |

空对象 `{}` 可用；null、数组、嵌套对象、未声明字段均不可用。不得向 meta 写入凭证、身份、金额或内部保留字段。后端自行写入 `appId`、`keybCharge`，既有内核写入 `model`、`module`。辅助信息不参与费用指纹；同消费编号只改合法辅助信息仍重放首次记录，不覆盖历史 meta。

请求体结构示例：

```json
{
  "costCny": "0.35",
  "source": "listing.generate",
  "model": "gemini-2.5-flash",
  "requestId": "listing-task-123-charge-1",
  "meta": {
    "taskId": "task-123",
    "gatewayTaskId": "gateway-456",
    "channel": "api"
  }
}
```

费用须来自可信网关或服务端用量事实，不接受模型生成的金额或 estimated_cost。不得把未知成本当作零成本，也不得自行新增失败收费或透支参数。多模型业务应按实际消费项分别编号并填写真实模型。

### 3.3 v2 服务签名

签名使用 OpenApiApp 的 appSecret。它不使用 KeyA，也不使用 KeyB 作为 HMAC 密钥。

签名原文为以下八项以单个 LF（`\n`）连接，末尾无额外换行：

```text
v2
大写 HTTP 方法
originalUrl
appId
timestamp
nonce
SHA256_HEX(KeyB)
SHA256_HEX(rawBody)
```

计算 `HMAC_SHA256(appSecret, UTF8(签名原文))`，以 64 位小写十六进制写入 `x-sign`。

- `originalUrl` 必须与 SellerOS 收到的请求目标完全一致，包含 `/api` 前缀；本接口固定为 `/api/open/keyb/credit/deduct`，不传 query 或片段。代理不得修改请求路径而不重建签名。
- `rawBody` 是实际发送的 JSON 原始字节。空白、属性顺序、转义或金额文本表示变化都会改变签名；必须先序列化一次，再用同一字节串签名和发送。
- KeyB 哈希只对 Bearer 后面的原始 KeyB 字符串计算，大小写敏感，不含 `Bearer ` 前缀。
- appId 为 `[A-Za-z0-9_-]{1,32}`；nonce 为 `[A-Za-z0-9_-]{1,128}`，可使用 UUID。
- timestamp 为十进制 Unix 毫秒整数字符串，10～16 位，与 SellerOS 当前时间偏差不得超过正负 5 分钟。服务应保持时钟同步。
- 鉴权相关头必须单值、无换行；重复头被拒绝。新入口强制 `x-sign-version: v2`、JSON Content-Type 和可获取的原始 body，不回退到旧算法。
- nonce 不是持久化防重键。允许窗口内重复投递，真正的消费防重使用下一节的稳定 requestId。新一次 HTTP 重试建议生成新的 timestamp、nonce、签名，同时保留原业务参数。

Node.js 调用示例只接收动态传入的凭证，不打印请求头、请求体、响应原文或密钥。生产调用方应从受控 Secret 或已认证业务上下文提供参数：

```js
import { createHash, createHmac, randomUUID } from "node:crypto"

export async function deductWithSellerOS({
  sellerosOrigin,
  appId,
  appSecret,
  keyB,
  charge,
}) {
  const method = "POST"
  const originalUrl = "/api/open/keyb/credit/deduct"
  const origin = new URL(sellerosOrigin)
  if (
    origin.protocol !== "https:" || origin.username || origin.password ||
    origin.pathname !== "/" || origin.search || origin.hash
  ) {
    throw new Error("SellerOS 地址须为固定 HTTPS origin")
  }
  const timestamp = String(Date.now())
  const nonce = randomUUID()
  const body = JSON.stringify(charge)
  const sha256Hex = value => createHash("sha256").update(value).digest("hex")
  const signText = [
    "v2", method, originalUrl, appId, timestamp, nonce,
    sha256Hex(keyB), sha256Hex(Buffer.from(body, "utf8")),
  ].join("\n")
  const sign = createHmac("sha256", appSecret).update(signText, "utf8").digest("hex")

  let response
  try {
    response = await fetch(new URL(originalUrl, origin), {
      method,
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${keyB}`,
        "x-sign-version": "v2",
        "x-app-id": appId,
        "x-timestamp": timestamp,
        "x-nonce": nonce,
        "x-sign": sign,
      },
      body,
      signal: AbortSignal.timeout(30000),
    })
  } catch {
    // 只向既有任务机制返回未知状态；不记录原始网络异常，不重跑模型。
    return { state: "UNKNOWN", requestId: charge.requestId }
  }
  let receipt
  try {
    receipt = await response.json()
  } catch {
    return { state: "UNKNOWN", requestId: charge.requestId }
  }
  if (!response.ok) {
    return {
      state: "REJECTED_OR_UNKNOWN",
      requestId: charge.requestId,
      httpStatus: response.status,
      code: typeof receipt?.code === "string" ? receipt.code : null,
    }
  }
  if (
    receipt?.requestId !== charge.requestId ||
    typeof receipt.duplicate !== "boolean" ||
    typeof receipt.costCny !== "string" ||
    typeof receipt.creditsCharged !== "string"
  ) {
    return { state: "UNKNOWN", requestId: charge.requestId }
  }
  return { state: "PAID", receipt }
}
```

这是签名与单次请求示例，不包含任务持久化、自动重试或业务产物授权实现。API 仍须验证回执归属及费用字段，按本地任务状态可靠保存结果。客户端超时不是“SellerOS 未扣款”的证明。

### 3.4 成功返回

返回 HTTP 201 和直接 JSON 对象，不额外套 `data`。金额、积分、余额使用 Decimal 字符串：

| 字段 | 含义 |
| --- | --- |
| `costCny` | 本次已提交成功的真实人民币费用，重复时来自首次 UsageLog |
| `creditsCharged` | 既有内核返回的实扣积分；不得由 API 或 MCP 自行伪造 |
| `balance` | 既有内核的扣后余额；重放时为首次 UsageLog.balanceAfter |
| `breakdown` | 首次调用为内核跨桶扣减明细；重复时为 `[]` |
| `source`、`model` | 首次成功记录的功能来源和模型 |
| `sourceLabel`、`module`、`moduleLabel` | 功能及目录展示字段；目录字段可能为 null；重放使用首次保存的标签快照 |
| `requestId` | 回传 API 提交的原始业务消费编号，不暴露内部去重键 |
| `duplicate` | false 表示此次首次成功；true 表示已存在匹配成功记录，此次没有再次扣费 |

`balance` 保持既有 `chargeModel`/`UsageLog.balanceAfter` 含义，**不可解释为个人、邀请人、企业全部资金来源的当前可消费余额总和**。重复时它是首次扣后的快照，也不是实时余额。此接口不额外调用钱包查询或重新汇总余额。

## 4. 消费幂等与重试

外部 requestId 不直接占用 UsageLog 的全局唯一编号空间。当前内部键规则为：

```js
"kb:" + sha256Hex(JSON.stringify([appId, projectCode, originalRequestId])).slice(0, 60)
```

长度为 63，满足 `UsageLog.requestId` 最长 64 的现有约束。KeyB 原值、KeyB 哈希和轮换版本不参与这个编号；服务或项目代码不同会分隔编号空间。当前只开放 selleros 一个项目，跨项目隔离是接入算法能力，未增加项目管理功能。

现有 UsageLog.meta 记录 `keybCharge`，内容包括协议版本、appId、项目代码、外部项目 ID、消费用户、原 requestId、规范化费用、source、model、指纹和首次标签快照。金额通过 Decimal 规范化，因此 `"1.0"` 和 `"1.000000"` 的业务费用相同，但每次发送仍需按各自 JSON 字节重新签名。

接入层在调用内核前查既有 UsageLog，核对归属与指纹；内核返回 `duplicate` 后也再次读取并核对。相同编号但用户、外部项目关联、金额、source 或 model 不一致时返回 409 `KEYB_REQUEST_CONFLICT`。已有记录缺少或不符合该接入协议的审计元数据时，也返回冲突，不冒充此次已经扣成功。

新消费仍由原 `chargeModel()` 在一个既有事务中完成路由扣减和 UsageLog。并发撞 requestId 唯一索引时，由原内核整体回滚并在事务外重查。新适配层不吞事务异常后另扣一次，也不直接改余额。

API 重试必须遵守：

1. 一笔费用从首次尝试起固定 appId、项目及 requestId，并保留真实费用、source、model。不能切换 appId 或换 requestId 绕过去重。
2. 成功或匹配的 `duplicate:true` 回执均可确认该笔已扣费。重放返回首次数据，不能用本次新参数拼出“已扣费”响应。
3. HTTP 超时、连接断开、503、响应无法解析，均保留任务及原编号，先按状态与错误核查，再重试扣费；不重新执行模型、视频生成或其他已完成业务。
4. 400 参数/来源/限额错误、401、403、409 须按错误原因处理，不能无条件循环重试。余额或配额不足需处理资源条件，409 载荷冲突需核对原始消费。
5. 不承诺所有并发失败立刻返回 duplicate。余额竞争、事务竞争或不明确网络结果可能先返回错误，恢复后仍以原编号核查并重试。
6. KeyB 重置后，旧 Key 的新请求被拒绝，任务保留待处理。本期不会自动替换任务凭证。即使在受控人工处理后使用了当前有效 Key，原消费编号仍不能改变。

凭证及项目授权校验与后续扣费事务不是同一个原子操作：重置能阻止之后使用旧 Key 通过新鉴权，撤销项目授权能阻止之后的未授权请求，均不能追溯撤销已经通过鉴权并进入既有扣费流程的请求。用户复制和状态查询也按读取时的当前状态返回；随后的并发重置可能使刚返回的 Key 失效。本次没有为改变这些边界而修改扣费内核。

## 5. 错误返回

全局异常结构：

```json
{
  "statusCode": 409,
  "code": "KEYB_REQUEST_CONFLICT",
  "message": "该消费编号已用于其他用户或不同扣费参数，请核查原消费记录",
  "timestamp": "2026-09-08T00:00:00.000Z"
}
```

`code` 对新增业务错误稳定可用；全局 DTO 校验或沿用的旧扣费异常可能只有 `statusCode`、`message`、`timestamp`，其中 message 也可能为字符串数组。不要假定所有 400 都包含 code，或所有非 2xx 都说明此前从未扣款。

| HTTP / code | 场景 | 处理 |
| --- | --- | --- |
| 400 / 无固定 code | DTO 格式错误；原内核来源未登记、余额或配额等业务异常 | 按消息修正/核查，保留原业务编号；不擅自改收费策略 |
| 400 / `SKILLS_PHONE_INVALID` | 当前数据库手机号不符合签发要求 | 更正用户资料，不允许前端换传其他手机号 |
| 400 / `KEYB_INVALID_PARAMETERS` | 金额或受控文本/meta 不合法 | 修正调用；不得把密钥写进业务字段 |
| 400 / `KEYB_PER_CALL_LIMIT` | 新消费超过现有服务单笔上限 | 核对费用与已授权的服务限额，不拆编号绕过 |
| 401 / 无固定 code | SellerOS JWT 缺失或无效 | 重新完成 SellerOS 登录 |
| 401 / `OPEN_AUTH_INVALID` | 服务头缺失、格式非法、过期、签名错误、请求目标不符等 | 核对服务配置、时间、原始字节及签名；不降级认证 |
| 401 / `SKILLS_KEY_INVALID` | Key 不存在、已轮换或当前不可用 | API 保留原任务，用户查询凭证状态；不回退手机号 |
| 401 / `SKILLS_USER_INACTIVE` | 用户不存在或已停用 | 停止扣费，联系管理员处理账号状态 |
| 403 / `OPEN_APP_DISABLED` | 已正确签名的服务被停用 | 停止调用，联系管理员 |
| 403 / `SKILLS_PROJECT_FORBIDDEN` | 项目未授权，或服务无该项目上报权限 | 检查项目代码及 OpenApiApp.keybProjectCodes；由运维核实后用管理脚本补授权，再以原 requestId 重试，不更换服务身份 |
| 409 / `SKILLS_KEY_NOT_CREATED` | 无凭证时复制或重置 | 先首次生成 |
| 409 / `SKILLS_KEY_EXISTS` | 已有凭证却用新 UUID 调首次生成 | 复制当前 Key 或明确重置 |
| 409 / `SKILLS_KEY_ROTATING` | 当前正在签发 | 查状态；使用原 operationId 重试，不触发新的签发 |
| 409 / `SKILLS_OPERATION_CONFLICT` | UUID 跨操作类型复用或其他操作先完成 | 核对当前状态及原始操作 |
| 409 / `SKILLS_OPERATION_SUPERSEDED` | 历史操作已被后续重置替代 | 查询当前状态；不取回历史 Key |
| 409 / `SKILLS_KEY_ASSOCIATION_CONFLICT` | 用户/项目/签发手机号关联冲突 | 管理员核查关联，不强制覆盖 |
| 409 / `SKILLS_PROJECT_CHANGED` | 当前外部项目 ID 与旧凭证不一致 | 确认当前配置正确后，由用户用新 UUID 调 `/api/skills/keys/reset`；后端按当前配置签发并更新关联 |
| 409 / `SKILLS_KEY_SYNC_UNKNOWN` | 签发远端结果或本地保存结果不明确 | 暂停复制和扣费，执行人工恢复流程 |
| 409 / `KEYB_REQUEST_CONFLICT` | 同消费编号的归属或费用指纹不一致 | 核对首次消费，不换编号再次收费 |
| 503 / `SKILLS_KEYS_DISABLED` | 接入功能四项配置均未启用 | 完成配置和部署后再使用 |
| 503 / `SKILLS_KEY_CRYPTO_ERROR` | 加密版本、主密钥或密文无法读取 | 运维核查，禁止尝试把旧值直接置有效 |
| 503 / `SKILLS_KEYS_UNAVAILABLE` | 凭证数据访问等内部故障 | 保留 operationId，恢复后查询状态 |
| 503 / `KEYB_CHARGE_UNAVAILABLE` | 扣费或读取回执结果不能确定 | API 保留原 requestId 和任务，核查后重试扣费 |

API 签发适配器内部使用 `SKILLS_KEY_ISSUE_UNKNOWN` 包装外部 HTTP 失败；用户生成/重置流程会将它收口为 `SYNC_UNKNOWN` 和 409 `SKILLS_KEY_SYNC_UNKNOWN`。不向客户端透出 Axios/Prisma 的原始异常、请求配置或远端响应。

GET 状态的 `lastErrorCode` 提供固定诊断分类：远端阶段为 `ISSUE_TLS_ERROR`、`ISSUE_TIMEOUT`、`ISSUE_NETWORK_ERROR`、`ISSUE_HTTP_ERROR`、`ISSUE_RESPONSE_INVALID` 或兜底/历史的 `ISSUE_RESULT_UNKNOWN`；本地阶段为 `KEY_ENCRYPT_FAILED`、`KEY_SAVE_FAILED`、`KEY_SAVE_CONFLICT`、`KEY_READBACK_FAILED`、`KEY_READBACK_CONFLICT`、`KEY_DELIVERY_FAILED`。过期 ROTATING 仍使用 `ISSUE_RESULT_UNKNOWN`。这些分类不改变外部 409 或自动重试规则，不能据此推断远端一定没有签发。

固定日志事件 `skills_key_issue_failed` 仅包含 `operationId`、`lastErrorCode`，上游错误可附已校验的数字 `upstreamStatus` 和白名单 `transportCode`；不含 URL、headers、手机号、密钥或原始异常。诊断只记录新版部署后发生的失败，无法追溯还原历史 `ISSUE_RESULT_UNKNOWN`。排查方向见 [部署文档第 9 节](./SellerOS-KeyB-部署文档.md#9-常见故障停用和恢复)。

## 6. 配置与数据结构

### 6.1 四项基础配置

| 配置 | 内容与校验 |
| --- | --- |
| `SKILLS_KEYS_API_ORIGIN` | API 固定 HTTPS origin，例如 `https://skills-api.example.com`；不含用户名、密码、路径、query、片段；可有末尾 `/` |
| `SKILLS_KEYS_PROJECT_ID` | API 中 SellerOS 项目的外部 ID；1～128 字符，首字符字母或数字，后续可用字母、数字、`_ . : -` |
| `SKILLS_KEYS_PROJECT_KEY_A` | 项目 KeyA，经受控 Secret 注入；1～512 位可打印非空白 ASCII；不可进入浏览器、MCP 或日志 |
| `SKILLS_KEYS_ENCRYPTION_KEY` | 32 字节随机加密主密钥的规范 Base64 编码；通过 Secret 单独保管，不能与数据库密文一起公开 |

四项均未设置时功能保持关闭，新功能调用返回 503，不阻止其他已有模块启动。任意一项设置后，四项必须完整且合法；配置不完整或格式非法时拒绝启动，错误仅指出配置名。这四项更改后需重启应用；数据库中的服务项目授权更改无需重启。

appId/appSecret 继续复用现有 OpenApiApp，不新增服务身份表；API 后端须安全持有对应 appSecret。该 Secret 不等于上述 KeyA 或加密主密钥，也不向用户或 MCP 发放。`scripts/create-open-api-app.ts` 管理服务身份及项目授权，创建/授权/撤权会写数据库，必须纳入另行确认的部署操作，本次未执行。

### 6.2 新表 SkillsKeyCredential

新增用户项目凭证关联表和 `User.skillsKeyCredentials` 关系、`SkillsKeyStatus` 枚举，另外为既有 OpenApiApp 增加下节的项目授权列；不新增消费订单或结算账单表。

| 字段组 | 作用 |
| --- | --- |
| `id`、`userId` | 本地关联主键及 SellerOS 用户关系 |
| `projectCode`、`externalProjectId`、`issuedPhone` | 接入项目代码、外部项目 ID、可信签发手机号快照 |
| `keyCiphertext`、`keyHash`、`encryptionVersion`、`maskedKey` | 可恢复密文、SHA-256 查找哈希、加密版本、脱敏展示 |
| `status` | `ROTATING` / `ACTIVE` / `SYNC_UNKNOWN` |
| `operationId`、`operationKind`、`usedOperationIds` | 当前操作、生成/重置类型及已使用 UUID 列表；不保存历史 Key |
| `operationStartedAt`、`activatedAt`、`lastErrorCode` | 操作时间、最后激活时间及安全固定错误码 |
| `revision`、`createdAt`、`updatedAt` | 跨 worker 条件更新版本及记录时间；revision 不参与消费幂等 |

唯一约束为 `(userId, projectCode)`、`(externalProjectId, issuedPhone)`、`keyHash`。字段允许在首次签发未完成时没有密文和哈希。切换项目的重置也会先占用目标项目与手机号的唯一关联、置为 `ROTATING` 并清除旧项目的凭证字段，再访问 API；只有新 KeyB 加密保存成功才变为 `ACTIVE`，目标关联冲突在远端签发前拒绝，操作 UUID 历史保留。本次重置修复没有 schema 变更，不需要执行 `db:push`。

KeyB 使用 AES-256-GCM 加密，每次生成随机 12 字节 IV，认证标签为 16 字节；密文保存为 `base64(iv).base64(tag).base64(ciphertext)`，版本为 `v1`。附加认证数据绑定用户、外部项目 ID、协议和加密版本，防止把一份密文直接挪给另一用户/项目。明文不存入普通流水或日志。

加密主密钥更换会影响已有凭证解密。本期没有主密钥轮换、批量重新加密或自动恢复工具；不要直接替换主密钥后期待旧密文仍能读取。备份密文时须同时规划独立受控的主密钥恢复能力。

UsageLog 沿用原表、原 `requestId` 唯一约束、原金额精度和扣费事务，只在已有 meta 中增加审计信息。

### 6.3 OpenApiApp 项目授权列与脚本

新增 `OpenApiApp.keybProjectCodes Json @default("[]")`。值是本地项目代码数组，例如 `["selleros"]`；不是外部项目 ID 或 appId。新旧记录默认 `[]`，代表无 KeyB 项目权限。空值、非数组或包含非字符串的无效授权数据均不会放行；服务还须为 `ACTIVE`。

注意：`@default("[]")` 是 Prisma 客户端层默认值，`db push` 给既有表加列时**不会回填存量行**——旧 OpenApiApp 行的该列实际为 NULL（2026-09-08 dev 实测如此）。NULL 同样不会放行扣费，但管理脚本对非数组数据报「接入方项目权限数据格式异常」并拒绝执行；需先把存量 NULL 行归一化为 `[]`（与默认语义一致、不放行任何项目），再执行 `--grant-keyb`，具体命令见 [部署文档第 4.2 节](./SellerOS-KeyB-部署文档.md#42-已创建过-skills-api给现有身份补授权写-openapiapp-表)。这项授权只用于新 KeyB 入口，不改变 `/api/open/credit/*` 的既有规则。

已执行旧版创建命令的环境，**复用既有 Skills API 身份**。经确认完成 schema 同步后，从仓库根目录执行：

```bash
node --env-file=.env -r ts-node/register scripts/create-open-api-app.ts --list
node --env-file=.env -r ts-node/register scripts/create-open-api-app.ts --grant-keyb '<已创建的 Skills API appId>' selleros
```

`--list` 只读，显示身份状态、限额和项目权限，不显示 appSecret。`--grant-keyb` 只追加缺少的项目代码；重复运行不重复授权。`--revoke-keyb '<实际 appId>' selleros` 幂等撤销本项目权限，其他身份字段不变，不追溯已完成消费。恢复授权再次 grant 即可；grant 不会恢复 `DISABLED` 状态。若脚本报「接入方项目权限数据格式异常」，说明存量行该列为 NULL（见本节上文），先归一化为 `[]` 再重试。

只有没有可复用身份时才创建：

```bash
node --env-file=.env -r ts-node/register scripts/create-open-api-app.ts "Skills API" --keyb-project selleros
```

有已确认单笔限额时，金额写在名称后、flag 前，例如 `"Skills API" 100 --keyb-project selleros`，其中 100 只是格式示例。创建每次都会产生新身份，不能当作幂等 seed；不带 `--keyb-project` 保持原创建语义，只登记服务身份、没有项目权限。项目管理支持的 code 本期仅 `selleros`；未知选项及多余参数会报错，不隐式创建服务。

授予或撤销权限后，后续扣费鉴权读取数据库即生效；不需要修改环境变量、重新分发 appSecret、重置用户 KeyB 或重启实例。不要为给已创建身份补授权而重复运行创建命令：appId 变化会改变消费去重空间。

## 7. 部署说明

**本次未执行 `db:push`、seed、真实账户操作或真实服务调用。** Schema 文件修改和本地 Prisma Client 生成不等于数据库已经完成同步。

部署应由有权限人员审核完整 schema 差异、确认目标数据库及备份后，显式授权执行。仓库约定使用 `npm run db:push`，不新增或运行 migrate。若 Prisma 提示存在数据损失，不添加 `--accept-data-loss` 继续操作，应先停下核对差异。

**先同步 OpenApiApp.keybProjectCodes 列，再启用连接目标库的新版 Prisma Client/应用和管理脚本。** Client 生成和构建可以提前完成；不能先上线新版进程再补库，因为旧手机号开放接口的鉴权也使用 OpenApiApp 全字段查询，新 Client 查询缺失列时同样失败。

已核对当前 [Dockerfile](../Dockerfile)：默认 CMD 为 `npx prisma db push --accept-data-loss --skip-generate && node dist/main.js`。这是现有行为，本次没有修改 Dockerfile；**不可用该默认启动命令做本次验收或直接启动连接真实数据库的容器**，它会自动执行带数据损失选项的同步。经授权完成单独 schema 同步后，部署系统应覆盖容器启动命令为仅启动应用，例如 `node dist/main.js`，避免启动时再次自动同步数据库。

建议部署顺序：

1. 审核本次新增表、OpenApiApp.keybProjectCodes 新列、全仓 schema 差异、目标库及备份；取得数据库同步的明确确认。
2. 在隔离测试环境先进行 schema 同步及专用数据库验收；真正执行时仅用 `npm run db:push`，不使用数据损失选项。
3. 安装既有依赖、生成对应 Prisma Client，再执行构建。私有包安装继续使用仓库既有 `PACKAGES_TOKEN`/BuildKit Secret 机制，密钥不写镜像层或文档。
4. 在 schema 同步后用本版脚本 `--list` 查找既有身份，对获准的服务逐个 `--grant-keyb`，保持原 appId/appSecret、限额和状态，不全量默认授权。由 API 提供 SellerOS 外部项目 ID 和 KeyA，注入四项基础配置；旧版升级保持项目 ID 和加密主密钥原值，移除旧 `SKILLS_KEYS_ALLOWED_APP_IDS` 变量后再发布本版代码。新代码不读取旧白名单，也没有兼容兜底；默认 `[]` 的旧身份未补授权会被拒绝。
5. 核对 API 真实签发响应形状；在指定测试账户、明确授权的测试数据库上做签发/轮换与扣费联调。
6. 按实际业务需要使用既有 FeatureModule source；如新增 source，按仓库原注册表流程审核、登记。本次未执行 seed，不自动改变生产功能注册表。
7. 配置代理及 APM：保持签名路径和 JSON 字节，禁缓存凭证响应，不采集 Authorization、KeyA、服务签名密钥、含 KeyB 的响应或异常原文。SellerOS 的新凭证/扣费路径在应用日志中只保留固定路由，不记录 query、任意路径后缀或 User-Agent；这些路径的 JSON 解析错误使用固定中文消息，凭证特征脱敏，5xx 不记录原异常/堆栈。其他路由保持原行为；代理自身的日志规则仍须部署侧确认。
8. 执行第 9 节的专用数据库和跨服务验收，再决定启用入口。应用启动也可能运行已有定时任务的启动补偿，不应把连接真实数据库的启动当作无副作用检查。

## 8. SYNC_UNKNOWN 人工恢复

`SYNC_UNKNOWN` 表示不能确定 API 远端当前凭证与 SellerOS 本地保存值是否一致。API 的签发接口本身会轮换，当前没有幂等签发、操作查询、自动对账或找回 Key 原值能力；再次调用可能使现有 Key 再次失效。

人工处理应遵循以下顺序，任何实际数据库或凭证变更均须单独授权：

1. 暂停受影响的签发及相关业务扣费入口，必要时停用相关服务身份；确认所有 worker、超时请求和远端签发请求已经结束。避免在仍有迟到响应时人工覆盖记录。
2. 保留当前关联行、operationId、usedOperationIds、revision、时间及固定错误码；核对可信用户手机号、外部项目 ID 和 API 的项目用户状态，不能单凭 SellerOS 本地旧密文推断远端仍使用旧 Key。
3. 如果能够通过受控流程确认 API 当前有效 Key 与已有密文一致，核对哈希、加密版本及用户/项目归属后，再由运维按审核方案恢复；不要盲目把旧 Key 标为 ACTIVE。
4. 若远端新 Key 原值已经丢失且无法取回，必须与 API 团队协调一次明确、受控的轮换及 SellerOS 加密凭证修复，或制定其他经确认的恢复方案。该操作不是普通网络重试，不应由前端换 UUID 自动触发。
5. 恢复需保持操作历史，防止旧 UUID 重新签发；不能删除凭证行或清空 usedOperationIds 来绕过保护。随后在指定测试范围核验新 Key、旧 Key 拒绝和原业务消费编号。

本次没有提供自动恢复脚本或恢复 API。运维应记录恢复行为，但不得把 KeyA、KeyB、加密主密钥或包含这些值的原始异常写进工单、普通日志或队列。

发布签发路径修复或修复 HTTPS 证书链不会自动解除历史 `SYNC_UNKNOWN`；普通生成/重置接口仍会拒绝该状态。需先确认基础故障已解决和远端签发状态，再按上述流程单独审核恢复。证书链和只读检查命令见 [部署文档第 9.1 节](./SellerOS-KeyB-部署文档.md#91-签发路由和-https-证书链)。2026-09-08 dev 环境：证书链修复后受影响凭证已恢复 ACTIVE 并完成真实重新签发（reset），无遗留 `SYNC_UNKNOWN` 行；同日完成真实扣费联调（含真实余额变动，dev 测试账户 10 积分）。

## 9. 验证状态及跨服务依赖

### 9.1 SellerOS 验证记录

| 层次 | 当前状态 |
| --- | --- |
| 代码实现 | 用户生成/状态/重置/复制、加密关联、服务签名、KeyB 扣费适配、数据库项目授权及管理脚本已实现；本轮修正签发路径并补充安全错误诊断 |
| 相关单元、回归及 HTTP 测试 | **17 个测试套件、503 项通过**，含签发适配器 50 项及管理脚本 42 项 mock 测试；专用数据库套件及其 2 项测试按配置跳过 |
| HTTP 控制器测试边界 | 使用本机 HTTP 与 mock 依赖，没有连接外部 API 或数据库，不是 API 真实联调 |
| 构建和静态检查 | **本轮通过**：`npm run build`、变更 TypeScript 文件定向 ESLint、文档示例语法及相对链接检查；此前已通过管理脚本 TypeScript 检查与 Prisma validate/generate，本轮未改 schema 或脚本，未执行数据库同步 |
| 专用数据库测试 | **未运行**；尚未实证验证真实 MySQL 锁竞争、唯一索引事务回滚、多进程 CAS、实际资金流水与返利 |
| 数据库结构同步与旧服务补授权 | **dev 已执行**（2026-09-08）：存量 OpenApiApp 行 `keybProjectCodes` 由 NULL 归一化为 `[]`，并对既有 Skills API 身份（appId `4496cd54a56b6201`）执行 `--grant-keyb selleros`；**生产未执行** `npm run db:push`、grant 或 seed，生产存量行预计同为 NULL，须先归一化再补授权（见第 6.3 节） |
| API 真实签发与扣费联调 | **dev 已完成**（2026-09-08）：证书链修复后真实签发（reset）成功落 ACTIVE；扣费实测通过——首次 201（1 元扣 10 积分，RECHARGE 桶）、同 requestId 重放 `duplicate:true` 不重复扣、错误签名 401 `OPEN_AUTH_INVALID`、未授权接入方 403 `SKILLS_PROJECT_FORBIDDEN`、UsageLog 与 CreditTransaction 落库同回执一致。**生产未执行** |
| 2026-09-08 线上只读取证 | 已核对公开 OpenAPI 的 `/api/v1/projects/keys` 签发路径，并复现 Node.js 证书链验证失败（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`，服务器缺中间证书）；**当日 API 侧已换发含中间证书的 DigiCert 全链证书**，openssl `Verify return code: 0` 与 SellerOS 运行环境 Node.js 双侧复核通过 |
| API/MCP/前端跨仓库改动 | **未实施**，本次仅 SellerOS |

本轮实际运行的相关 Jest 回归命令：

```bash
RUN_KEYB_DB_TESTS=0 node node_modules/jest/bin/jest.js --runInBand --testPathPatterns='skills-keys|open-api|usage/|membership/credit.service.spec|team/team.service.spec|common/filters/http-exception.filter.spec|common/utils/keyb-log-url.spec'
```

上述 `open-api` 范围包含 `src/open-api/open-api-app-script.spec.ts` 的管理脚本测试，使用 mock 数据库，不执行真实授权变更。本轮同时通过 `npm run build`、变更 TypeScript 文件的定向 ESLint及文档检查。新增回归覆盖固定版本路由、TLS/超时/网络/HTTP/响应格式分类、本地加密/保存/回读/交付阶段诊断、日志不泄漏原异常以及失败后不自动重签；既有授权与撤销、撤权后拒绝历史扣费回放等回归也通过。这些检查未启用数据库测试或执行 schema 同步。

专用测试库至少要验证：跨 worker 同用户同项目只发一次、重置保存 CAS 与超时状态、项目手机号唯一约束；同消费编号并发只提交一次、冲突事务整体回滚、不同归属或参数返回冲突；个人及企业成员在既有资金路由、折扣、配额和返利下的流水保持原行为。只有完成这些测试才能报告“真实数据库并发/回滚已验证”。

已提供 `src/open-api/keyb-credit.integration.spec.ts` 两个数据库用例，默认 `describe.skip`。它们测试真实 UsageService/CreditService/MySQL 的同编号并发回滚及跨用户冲突，凭证解析和未用的定价依赖仍为隔离替身；即使未来通过，也不等于 KeyA 签发或 API/MCP 真实联调，更不覆盖所有企业资金/返利场景。

只有在另行授权并准备好专用 schema 后，才可显式设置 `RUN_KEYB_DB_TESTS=1` 与 `TEST_DATABASE_URL` 运行该文件。连接仅接受本机 `localhost`、`127.0.0.1` 或 `[::1]` 的 MySQL，库名须为 `selleros_keyb_test` 或后缀为小写字母/数字/下划线的 `selleros_keyb_test_*`；不允许 URL query/hash，也不允许现有 DATABASE_URL 与专用 URL 不一致。测试禁用 Prisma 自动读取 `.env`，不会替操作者创建或同步 schema；运行时会建立测试用户、积分批次及流水并清理本次数据，因此本期未启用运行。

### 9.2 API 仓库待配合

- 2026-09-08 已通过开发环境公开 OpenAPI 核对签发路径为 `POST /api/v1/projects/keys`。请求头 `X-Project-Key` 携带项目 KeyA，JSON 仅 `{phone}`；同项目手机号再次调用会轮换而非查询已有 Key。此处路径核对没有执行真实签发。
- API 网关/反向代理需正确提供完整 HTTPS 证书链（`fullchain`），确保 SellerOS 的 Node.js 运行环境能验证站点证书。本轮只读排查复现缺少中间证书导致的 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`；**2026-09-08 已由 API 入口维护方修复**（换发含中间证书的 DigiCert 全链证书，openssl 与 SellerOS 运行环境 Node.js 双侧复核通过），后续证书续期必须继续下发完整链。任何时候都不能要求 SellerOS 关闭 TLS 校验。
- 当前 SellerOS 适配器要求 HTTP 2xx、对象 `data` 包含同一 phone 及合法 key，并至少有一个成功标志：`code` 为 0/200/201，或 `success` 为 true，或 `statusCode` 为 200/201；出现的所有标志都须表明成功。不接受裸 `{phone,key}`、无成功标志包装、数组或不匹配手机号。**实际统一响应包装须在真实联调中确认**，本文不声称已核验 API 当前响应。
- API 在用户 KeyB 验证及业务执行后，获取可信实际费用和真实模型，固定每个消费项 requestId，由代码自动调用 SellerOS；不能将扣费暴露成让大模型决定是否调用的工具。
- 通过 MCP 和直接调用 API 的业务必须走同一扣费衔接。成功或匹配的 duplicate 回执才标记已扣费；billed、credits 来自 SellerOS 回执。
- 对同步 Listing 与异步视频分别衔接：同步业务扣费成功后交付结果；视频先返回任务编号，后台生成及扣费完成后才向查询方交付可使用产物，不提前暴露下载地址或其他未付费旁路。
- 超时、余额不足、旧 Key 失效等情况在既有任务中保存业务结果、费用、模型、原 requestId 和扣费状态；不重跑生成、不换编号。结果未知不能当作已付。
- 需要跨进程保存待扣费 KeyB 时使用加密存储或受控 Secret 引用，不在任务/队列/日志存明文。本期不强制新增队列系统。
- API 侧仍需明确处理未知费用、明确零成本、失败业务及 KeyB 轮换中的待处理任务，不能自行放宽 SellerOS 的扣费对象、旧 Key 校验或费用政策。
- 后续若改进可靠签发重试，应由 API 提供幂等签发及可查询操作结果的协议，再独立更新 SellerOS；当前实现不具备此能力。

### 9.3 MCP 与前端待配合

- MCP 只调用业务 API 和展示业务结果，不持有 KeyA 或 OpenApiApp.appSecret，不额外发起扣费，不把占位 billed/credits 当作真实回执。
- SellerOS 前端接入四个 JWT 接口、保存 operationId、默认展示 maskedKey、支持主动显示/隐藏与复制，并避免缓存/埋点泄漏；重置前显示第 2 节提示。
- 直接 API 与 MCP 两条路径最终都应验证未扣费产物不可绕过获取；这项验收依赖 API/MCP 配套代码，SellerOS mock 测试不能覆盖。

## 10. 变更文件清单

生产与配置文件：

| 分组 | 文件 |
| --- | --- |
| 配置示例、模型、模块接入 | `.env.example`、`prisma/schema.prisma`、`src/app.module.ts` |
| 服务身份及项目授权管理脚本 | `scripts/create-open-api-app.ts` |
| 正式交付文档白名单 | `.gitignore`（仅为本文档增加现有忽略规则的例外） |
| 用户凭证接口 | `src/skills-keys/skills-keys.module.ts`、`src/skills-keys/skills-keys.controller.ts`、`src/skills-keys/skills-keys.service.ts`、`src/skills-keys/dto/skills-key.dto.ts` |
| 凭证项目配置、加密与远端签发 | `src/skills-keys/skills-key-config.service.ts`、`src/skills-keys/skills-key-crypto.service.ts`、`src/skills-keys/skills-key-issuer.service.ts` |
| 开放接口接入与鉴权 | `src/open-api/open-api.module.ts`、`src/open-api/open-api-auth.guard.ts`、`src/open-api/open-api-keyb-signature.decorator.ts` |
| KeyB 扣费适配 | `src/open-api/keyb-credit.controller.ts`、`src/open-api/keyb-credit.service.ts`、`src/open-api/dto/keyb-deduct.dto.ts` |
| 仅新接口路径的日志及异常脱敏 | `src/common/utils/keyb-log-url.ts`、`src/common/middleware/logger.middleware.ts`、`src/common/filters/http-exception.filter.ts` |
| 对接及部署文档 | `docs/SellerOS-KeyB积分扣费接入-接口与部署.md`、`docs/SellerOS-KeyB-前端对接文档.md`、`docs/SellerOS-KeyB-部署文档.md` |

测试文件：

| 分组 | 文件 |
| --- | --- |
| 项目配置、加密、签发 | `src/skills-keys/skills-key-config.service.spec.ts`、`src/skills-keys/skills-key-crypto.service.spec.ts`、`src/skills-keys/skills-key-issuer.service.spec.ts` |
| 用户凭证状态及 HTTP 接口 | `src/skills-keys/skills-keys.service.spec.ts`、`src/skills-keys/skills-keys.controller.spec.ts` |
| 新旧服务鉴权 | `src/open-api/open-api-auth.guard.spec.ts`、`src/open-api/open-api-keyb-auth.guard.spec.ts` |
| 服务管理脚本参数、项目授权及安全输出 | `src/open-api/open-api-app-script.spec.ts` |
| 扣费 DTO、适配与可选专用数据库用例 | `src/open-api/dto/keyb-deduct.dto.spec.ts`、`src/open-api/keyb-credit.service.spec.ts`、`src/open-api/keyb-credit.integration.spec.ts` |
| 脱敏 | `src/common/utils/keyb-log-url.spec.ts`、`src/common/filters/http-exception.filter.spec.ts` |

上述变更不包含 `src/usage/usage.service.ts`、会员或团队的扣费实现修改。相关原有测试参与回归，未因此改写原有资金路由、配额、折扣、返利及事务规则。没有修改 API/MCP 仓库，没有提交或推送代码。
