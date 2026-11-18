# SellerOS KeyB 前端对接文档（可直接交给前端 AI 实施）

更新：2026-09-08。本文已核对 SellerOS 后端当前 `SkillsKeysController`、`SkillsKeysService`、DTO、配置及全局异常处理的实际代码。本文给出独立实施所需的接口、状态、交互、安全规则和验收要求；示例中的密钥均为明确的测试占位值。

**交付状态：后端代码已实现；本文是前端实施说明，不代表前端页面已经实现，也不代表 API/MCP 真实联调已经通过。**

## 1. 给前端 AI 的实施任务

请在现有 SellerOS 前端增加当前登录用户的「Skills 接入密钥」功能，让用户能够查询状态、查看部分字符、主动显示/隐藏完整密钥、首次生成、复制及明确重置自己的 KeyB。

先阅读前端仓库的开发约定，找到现有账户设置入口、登录态、HTTP 请求封装、提示及确认弹窗组件，沿用现有框架与风格实现。本文不指定新的路由、组件库或状态管理库；可在现有账户/个人设置中增加一个接入密钥区域。没有现成设置入口时，按前端现有导航惯例增加入口并在交付时说明位置。

实施顺序：

1. 核对 HTTP 客户端的 `baseURL`、JWT 注入、响应解包、错误归一化、自动重试和日志采集机制。
2. 添加本文的接口类型和四个 API 函数；保持现有认证方式。
3. 实现页面加载、脱敏状态展示、显示/隐藏、首次生成、复制、重置确认及错误处理。
4. 实现同一次生成/重置的 `operationId` 保留、网络故障恢复、有限状态轮询及跨账号清理。
5. 排查 KeyB 是否会进入请求缓存、状态持久化、开发工具、日志或埋点；完成第 9 节验收。

本期只有 `projectCode="selleros"`。它是接入项目代码，与客户工作台的项目 ID、企业团队 ID、外部 API 的项目 ID 无关。页面不需要增加项目选择器、手机号输入、KeyA 配置、服务凭证输入或用户切换代操作功能。生成对象由后端根据 JWT 确定，前端不得提交 `userId`、`phone`、`teamId`、KeyA 或任何扣费金额。

KeyA、OpenApiApp 的 `appSecret` 和加密主密钥只由服务端持有。**浏览器只调用下文四个 SellerOS JWT 接口；不得调用 API 签发接口 `POST /api/v1/projects/keys`，也不得调用服务扣费接口 `POST /api/open/keyb/credit/deduct`。** 业务费用由 API 后端自动上报，前端不重新计算积分、不补发扣费、不因为复制或重置调用扣费接口。

服务的项目扣费授权现由后端数据库和管理脚本维护，前端四个接口的参数、状态和返回结构保持不变。前端无需新增服务授权设置页面；也不能把用户 KeyB 为 `ACTIVE` 等同于调用服务已获扣费授权。

## 2. HTTP 接入约定

四个接口都使用现有 SellerOS 登录态：

```http
Authorization: Bearer <SellerOS 登录 JWT>
Content-Type: application/json
```

这里的 Bearer 是登录 JWT，不能替换成用户 KeyB。无需新增登录系统或手写另一套 Token 存储/刷新流程。普通有效登录用户即可使用；后端每次都会检查当前数据库用户存在且 `isActive=true`。只有生成/重置额外检查当前数据库手机号是否为 `^1[3-9]\d{9}$` 的 11 位手机号，前端不能通过另传手机号绕过。

下表路径是最终 HTTP 路径，均包含全局 `/api` 前缀：

| 功能 | 方法、最终路径 | 参数 | 成功 HTTP 状态 |
| --- | --- | --- | --- |
| 查询状态 | `GET /api/skills/keys` | query：可选 `projectCode=selleros`，省略时后端选择默认项目 | 200 |
| 首次生成 | `POST /api/skills/keys` | JSON：`projectCode`、`operationId` | 201 |
| 重置 | `POST /api/skills/keys/reset` | JSON：`projectCode`、`operationId` | 201 |
| 主动复制/查看 | `POST /api/skills/keys/reveal` | JSON：`projectCode` | 201 |

如果现有 `baseURL` 已以 `/api` 结尾，封装中的路径写 `/skills/keys`；如果 `baseURL` 只有域名，则写 `/api/skills/keys`。先核对客户端实际拼接行为，避免 `/api/api/...` 或缺少 `/api`。

后端成功响应是**直接 JSON 对象**，没有 `{ code, data }`、`{ success, data }` 等统一包装。Axios 自身的 `response.data` 是传输层属性，不能据此再读取业务 `data.data`。现有拦截器如果要求业务 `code===200`，应按该客户端已有机制兼容这四个接口，不能将所有 201 判为失败。

错误按 HTTP 非 2xx 处理，结构见第 7 节。不得依据成功响应是否含 `code`、是否含 `key` 判断状态查询是否成功。

四个接口的正常响应均声明 `Cache-Control: no-store`。前端请求和代理必须保持不缓存；对含明文的响应禁止持久化或放入通用查询缓存。请求封装必须能保留错误的 HTTP 状态及 `code`，但不能将原始请求/响应对象上报日志。

### 2.1 参数校验

| 参数 | 位置 | 约束 |
| --- | --- | --- |
| `projectCode` | GET query 可选；三个 POST body 必填 | 字符串，最长 50，小写字母开头，后续仅小写字母、数字、`_`、`-`；本期实际只允许 `selleros` |
| `operationId` | 生成、重置的 body 必填 | UUID，后端转为小写；前端推荐使用 `crypto.randomUUID()`，一次用户确认操作只生成一次 |

只发送已声明字段。`projectCode` 不能传空串、null、数组或大写 `SellerOS`；不能将外部 API 项目 ID 填进这个参数。查看/复制接口不需要 `operationId`。

## 3. 四个接口及准确响应

### 3.1 查询状态

```http
GET /api/skills/keys?projectCode=selleros
Authorization: Bearer <SellerOS 登录 JWT>
```

从未创建时，HTTP 200 返回**仅有以下三个字段**，其他字段并非全部为 null：

```json
{
  "projectCode": "selleros",
  "status": "NOT_CREATED",
  "maskedKey": null
}
```

已有有效凭证时，HTTP 200 返回：

```json
{
  "projectCode": "selleros",
  "status": "ACTIVE",
  "maskedKey": "zk-****only",
  "operationId": "cb86d8cc-65eb-4674-a814-3a7fc4bbff1c",
  "activatedAt": "2026-09-08T00:00:00.000Z",
  "updatedAt": "2026-09-08T00:00:00.000Z",
  "lastErrorCode": null,
  "recoveryMessage": null
}
```

首次签发进行中时，HTTP 200 示例：

```json
{
  "projectCode": "selleros",
  "status": "ROTATING",
  "maskedKey": null,
  "operationId": "cb86d8cc-65eb-4674-a814-3a7fc4bbff1c",
  "activatedAt": null,
  "updatedAt": "2026-09-08T00:00:00.000Z",
  "lastErrorCode": null,
  "recoveryMessage": null
}
```

签发结果不明确时，HTTP 200 示例：

```json
{
  "projectCode": "selleros",
  "status": "SYNC_UNKNOWN",
  "maskedKey": null,
  "operationId": "cb86d8cc-65eb-4674-a814-3a7fc4bbff1c",
  "activatedAt": null,
  "updatedAt": "2026-09-08T00:00:16.000Z",
  "lastErrorCode": "ISSUE_RESULT_UNKNOWN",
  "recoveryMessage": "密钥签发结果待恢复，已暂停复制及扣费；请联系运维核对远端签发状态，勿自动重新签发"
}
```

重置中的 `ROTATING`、重置异常后的 `SYNC_UNKNOWN` 也可能有旧的 `activatedAt`。不能只凭时间不为 null 判断密钥有效。原凭证有效但外部项目配置变更时，查询显示 `SYNC_UNKNOWN`，其中 `lastErrorCode="SKILLS_PROJECT_CHANGED"`。**此组合允许用户主动重置，不能禁用重置按钮**；查看/复制和首次生成仍禁用。真正签发中或签发失败的状态不会被配置变更覆盖。

状态查询绝不返回 `key`。`maskedKey` 是后端给出的脱敏展示值，直接显示即可，不可用它调用业务 API 或尝试还原完整密钥。当前正常 `ACTIVE` 有脱敏值；类型仍兼容 null，显示「已生成」并允许用户主动复制，由后端核验可读取性。

**默认需要看见密钥的一部分，不要把整个值替换成圆点或星号。** 当前后端规则：总长度大于 11 时保留前 3 位和末 4 位，中间为 `****`，例如 `zk-****4f2a` 或 `sk_****4f2a`；总长度不超过 11 时只保留前 3 位，例如 `sk_****`，避免短密钥被首尾拼接暴露。前端原样展示 `maskedKey`，不自行截取、不根据星号数推测密钥长度，不拼接或校验额外的固定前缀。示例只说明展示格式，不是真实密钥。

### 3.2 首次生成

用户点击「生成 KeyB」后发送：

```http
POST /api/skills/keys
```

```json
{
  "projectCode": "selleros",
  "operationId": "cb86d8cc-65eb-4674-a814-3a7fc4bbff1c"
}
```

HTTP 201 成功示例：

```json
{
  "projectCode": "selleros",
  "status": "ACTIVE",
  "maskedKey": "zk-****only",
  "operationId": "cb86d8cc-65eb-4674-a814-3a7fc4bbff1c",
  "activatedAt": "2026-09-08T00:00:00.000Z",
  "updatedAt": "2026-09-08T00:00:00.000Z",
  "lastErrorCode": null,
  "recoveryMessage": null,
  "key": "zk-documentation-example-only"
}
```

只有远端签发且 SellerOS 加密保存成功后才会交付 `key`。页面可以显示「密钥已生成」，但这不表示已复制到剪贴板。生成结果中的完整 KeyB 只供本次主动交互短暂使用，不能存到持久状态。

已有有效 `ACTIVE` 凭证再以新 UUID 调本接口，返回 409 `SKILLS_KEY_EXISTS`，不会隐式重置；处于 `ROTATING` 或 `SYNC_UNKNOWN` 时按对应状态拒绝操作。不要捕获该错误后自动转调 `/reset`，应刷新状态并提示用户复制当前密钥或主动选择重置。

### 3.3 重置

必须在用户确认第 5 节的提示后发送：

```http
POST /api/skills/keys/reset
```

```json
{
  "projectCode": "selleros",
  "operationId": "e01a00a1-90e1-4ec1-bbeb-88b991942e08"
}
```

HTTP 201 的字段结构与生成成功完全相同，`operationId`、`key`、`maskedKey` 和时间对应新凭证。首次生成的 UUID 不能用于重置；每次新的用户确认重置使用新的 UUID。

**项目变更后的重置（2026-09-14）：**后端始终使用当前配置的 API 地址、项目 ID 和 KeyA 签发，并保存新关联。前端仍传 `projectCode: "selleros"`，不传数字项目 ID 或 KeyA。GET 返回 `SYNC_UNKNOWN` + `lastErrorCode: "SKILLS_PROJECT_CHANGED"` 时，显示「接入项目已变更，请重置密钥」，允许用户确认后携带新 UUID 调 `/reset`；不能复用旧项目的历史 UUID，也不能自动重置。无需用户或运维先改数据库。

重置进行中应立即清除页面内存中的旧完整密钥、禁用显示、复制和其他签发操作。不能保留一个「复制旧 Key」入口。成功提示「密钥已重置，请更新客户端中的 KeyB」；不会自动更新用户的 MCP/其他客户端配置。

### 3.4 主动复制/查看

仅由用户点击复制或主动查看触发：

```http
POST /api/skills/keys/reveal
```

```json
{
  "projectCode": "selleros"
}
```

HTTP 201 返回与生成成功相同的完整结构及 `key`，`operationId` 是当前凭证对应的生成/重置编号，**查看/复制本身不会生成新的 operationId，也不会签发新 KeyB**。

不得在页面挂载、后台轮询、鼠标悬停、预加载或路由预取时调用 `/reveal`。页面只做状态查询；用户点击「显示」或「复制」时才取原值。「隐藏」只清除本地临时原值并恢复 `maskedKey`，不调用接口。

### 3.5 TypeScript 类型

以下是网络 JSON 类型，时间不是 `Date` 对象。可按现有项目文件组织直接采用：

```ts
export const SKILLS_PROJECT_CODE = "selleros" as const;
export type SkillsProjectCode = typeof SKILLS_PROJECT_CODE;
export type OperationKind = "GENERATE" | "RESET";

export interface SkillsProjectRequest {
  projectCode: SkillsProjectCode;
}
export interface SkillsOperationRequest extends SkillsProjectRequest {
  operationId: string;
}

export interface SkillsKeyNotCreated {
  projectCode: SkillsProjectCode;
  status: "NOT_CREATED";
  maskedKey: null;
}
export interface SkillsKeyRecordFields {
  projectCode: SkillsProjectCode;
  operationId: string;
  activatedAt: string | null;
  updatedAt: string;
  lastErrorCode: string | null;
}
export type SkillsKeyActive = SkillsKeyRecordFields & {
  status: "ACTIVE";
  maskedKey: string | null;
  recoveryMessage: null;
};
export type SkillsKeyRotating = SkillsKeyRecordFields & {
  status: "ROTATING";
  maskedKey: null;
  recoveryMessage: null;
};
export type SkillsKeySyncUnknown = SkillsKeyRecordFields & {
  status: "SYNC_UNKNOWN";
  maskedKey: null;
  recoveryMessage: string;
};
export type SkillsKeyStatus =
  | SkillsKeyNotCreated
  | SkillsKeyActive
  | SkillsKeyRotating
  | SkillsKeySyncUnknown;

// 仅生成、重置、主动查看/复制成功返回。不得放入持久化 Store 或通用缓存。
export type SkillsKeyDelivery = SkillsKeyActive & { key: string };
export interface SkillsKeyErrorBody {
  statusCode: number;
  code?: string;
  message: string | string[];
  timestamp: string;
  details?: Record<string, unknown>;
}

// 请求状态与后端凭证状态分开，不能把 null/加载失败当作 NOT_CREATED。
export type SkillsPageState =
  | { phase: "loading" }
  | { phase: "error"; httpStatus?: number; code?: string; message: string }
  | { phase: "ready"; credential: SkillsKeyStatus };
```

四个 API 函数至少提供下面的类型契约。函数内部接入已有 HTTP 客户端，统一返回已解包的直接 JSON；不要直接复制一个不匹配现有客户端的 Axios/fetch 封装：

```ts
export interface SkillsKeysApi {
  getStatus(signal?: AbortSignal): Promise<SkillsKeyStatus>;
  generate(body: SkillsOperationRequest, signal?: AbortSignal): Promise<SkillsKeyDelivery>;
  reset(body: SkillsOperationRequest, signal?: AbortSignal): Promise<SkillsKeyDelivery>;
  reveal(body: SkillsProjectRequest, signal?: AbortSignal): Promise<SkillsKeyDelivery>;
}
```

这些函数的内部路径由第 2 节的 `baseURL` 核对结果决定。GET 推荐显式传 `projectCode=selleros`。`AbortSignal` 是可取消等待的接口约定；如现有客户端用其他取消机制，复用其机制即可。**取消前端请求不等于取消后端签发**，重新进入页面必须重新查询状态。

将交付响应转为页面状态时显式移除 `key`，不能直接把整个响应塞进 Store。若使用解构提取 `key`，只将不含它的状态部分交给页面；完整响应同样不能留在查询库的 mutation result、开发工具快照或错误对象中。

## 4. 页面状态与可用操作

常规展示内容：标题「Skills 接入密钥」、简短说明、状态、脱敏 KeyB、最近生成/重置时间（有值时）、操作按钮。时间按前端既有时区/格式工具展示；完整密钥不作为常驻字段。

`ACTIVE` 状态采用以下交互结构，视觉样式沿用现有页面：

```text
API Key   zk-****4f2a   [显示] [复制] [重置]
```

这里的 `zk-****4f2a` 必须替换为接口的 `maskedKey`；「显示」成功后临时展示完整 `key`，按钮变成「隐藏」。脱敏态使用普通文本或只读文本框，不用会把前后字符也全部遮住的 password 输入框。显示和复制按钮使用同一状态门槛；已有明文时始终允许本地隐藏/清除，不受网络请求锁限制。

| 页面/服务状态 | 展示 | 生成 | 显示/复制 | 重置 | 可做的恢复动作 |
| --- | --- | --- | --- | --- | --- |
| 初始 loading | 「正在查询密钥状态…」 | 禁用 | 禁用 | 禁用 | 等待查询 |
| 查询网络失败/未知错误 | 「密钥状态查询失败，请重试」；可保留旧脱敏信息并标注未刷新 | 禁用 | 禁用 | 禁用 | 重新查询状态 |
| `NOT_CREATED` | 「尚未生成 KeyB」 | 启用 | 隐藏/禁用 | 隐藏/禁用 | 用户首次生成 |
| `ACTIVE` | 「已生成」+ `maskedKey` | 隐藏/禁用 | 启用 | 启用，必须确认 | 用户主动显示/复制/重置 |
| `ROTATING` | 「密钥正在生成或重置，请稍候」；无可复制密钥 | 禁用 | 禁用 | 禁用 | 有限轮询/刷新状态 |
| `SYNC_UNKNOWN` 且 `lastErrorCode=SKILLS_PROJECT_CHANGED` | 「接入项目已变更，请重置密钥」 | 禁用 | 禁用 | 启用，必须确认 | 新 UUID 调 `/reset`，后端按当前配置签发 |
| 其他 `SYNC_UNKNOWN` | 「密钥状态待恢复」+ `recoveryMessage` | 禁用 | 禁用 | 禁用 | 联系管理员；恢复后刷新状态 |
| 503 `SKILLS_KEYS_DISABLED` | 「接入密钥功能尚未配置，请联系管理员」 | 禁用 | 禁用 | 禁用 | 管理员启用后重新查询 |
| 其他 503 | 第 7 节对应中文提示 | 禁用 | 禁用 | 禁用 | 保留操作编号，恢复后查询 |
| 401 登录失效 | 复用已有登录失效流程，清除敏感状态 | 禁用 | 禁用 | 禁用 | 重新登录后重新查询 |
| `SKILLS_USER_INACTIVE` / 无项目权限 / 关联冲突 | 中文说明并提示联系管理员 | 禁用 | 禁用 | 禁用 | 管理员处理后重新查询 |

本地还有独立的「请求处理中」锁。在生成/重置/显示/复制请求未结束时，禁止重复点击及互相交叉触发；加锁要在发送请求前同步生效。轮询 GET 允许与等待中的操作并行，但不允许旧 GET 响应覆盖刚收到的较新操作结果。用请求序号、用户作用域和取消机制丢弃过时响应。

收到新的 `ROTATING`、`SYNC_UNKNOWN`、账号失效、503 或重置操作开始时，清除任何临时完整密钥。不要只禁用按钮却留下可选中的旧完整 KeyB。

## 5. 用户文案、显示/隐藏与安全复制

建议直接采用以下中文文案，也可按产品现有语气调整，但必须保留重置影响：

| 场景 | 文案 |
| --- | --- |
| 功能说明 | 「生成属于当前账号的 KeyB，用于在客户端接入 Skills 服务。请妥善保管，不要公开分享。」 |
| 首次生成按钮 | 「生成 KeyB」 |
| 首次生成中 | 「正在生成…」 |
| 首次生成成功 | 「密钥已生成，请妥善保管」 |
| 显示/隐藏按钮 | 默认「显示」，主动查看成功后变为「隐藏」 |
| 显示请求中 | 「正在读取…」 |
| 复制按钮 | 「复制 KeyB」 |
| 复制确实成功 | 「已复制到剪贴板」 |
| 重置按钮 | 「重置 KeyB」 |
| 重置弹窗标题 | 「确认重置 KeyB？」 |
| 重置弹窗正文 | 「重置后旧 KeyB 将失效，需要在 MCP 或其他客户端更新为新 KeyB。使用旧 KeyB 的在途任务可能扣费失败并需要人工处理。确认继续重置？」 |
| 重置确认按钮 | 「确认重置」；取消按钮「取消」 |
| 重置成功 | 「密钥已重置，请更新客户端中的 KeyB」 |
| 等待结果 | 「正在确认密钥状态，请勿重复生成或重置」 |
| 停止自动查询 | 「尚未确认操作结果，已暂停自动查询。请刷新状态确认」 |
| 复制权限失败 | 「浏览器未允许自动复制，请在本次窗口中手动复制」 |

显示/隐藏步骤：

1. 页面默认只展示 `maskedKey`。最新状态为 `ACTIVE` 时，用户点击「显示」才调用 `/reveal`；成功后把 `key` 放在组件局部临时内存中展示，按钮变成「隐藏」，不写剪贴板。
2. 点击「隐藏」立即清除原值及 DOM 内容并恢复 `maskedKey`，无需网络请求。读取尚未结束时如用户取消查看，应作废该次查看请求；迟到响应不得重新显示。再次点击「显示」重新调用 `/reveal`。
3. 显示最多保留 60 秒；到期、页面隐藏/卸载、切换账号、退出登录、开始重置或状态失效时自动隐藏并清除。任何新状态的 `operationId` 与临时原值对应编号不同，也须清除旧原值。
4. 查看失败按第 7 节处理，不以脱敏值冒充原值，不因失败自动生成或重置。复制完成也恢复脱敏态并清除临时原值。

复制步骤：

1. 仅在最新已查询状态为 `ACTIVE` 时，由用户点击按钮调用 `/reveal`。
2. 取得 `key` 后使用当前项目的剪贴板能力（例如 `navigator.clipboard.writeText`），成功 Promise 完成后才提示「已复制」。不在 toast 中插入完整密钥。
3. 浏览器权限、非安全上下文或用户手势过期可能造成复制失败。**此时只是剪贴板失败，不是签发失败，不得再调用生成或重置接口。** 可以在本次主动动作打开的临时弹窗中显示只读密钥框，提示用户手动选中复制，也可以提供用户再次点击的「复制」按钮。
4. 临时密钥只保存在页面局部内存；关闭弹窗、复制完成、离开页面、切换账号、退出登录、页面隐藏或新重置开始时清除引用及 DOM 内容。使用 60 秒清理定时器；到期后需要用户重新主动点击显示或复制。无法保证 JavaScript 字符串被物理擦除，验收目标是移除应用可访问引用、不持久保存。
5. 复制成功后不自动清空系统剪贴板，以免覆盖用户其他操作；提醒用户妥善保管即可。页面刷新后需要复制时再次调用 `/reveal`，不从本地缓存取回原值。

生成/重置成功返回的原值同样适用上述生命周期。如果不需要在成功弹窗展示，直接丢弃它并只保留脱敏状态；之后用户点击复制时调用 `/reveal`。不能因为成功回调已收到 KeyB 就绕过主动动作自动弹出长期明文展示或写入持久化配置。

## 6. operationId、网络重试与刷新恢复

### 6.1 一次操作的身份

`operationId` 表示一次用户确认的生成或重置，不是每次 HTTP 尝试编号，也不是消费扣费的 `requestId`。

- 用户开始一次生成，或在重置弹窗点击「确认重置」时生成一次 UUID。点击取消不发请求。
- 同一次操作的所有重试必须使用**同一 UUID、同一用户、同一项目、同一操作类型及同一路径**。
- `GENERATE` 对应 `/skills/keys`，`RESET` 对应 `/skills/keys/reset`。不能将生成 UUID 改投重置，也不能为解决 409/超时自动创建新 UUID。
- 同 UUID 只有仍为当前操作、类型相同且状态 `ACTIVE` 时才返回当前 KeyB；后端不会再次请求远端签发。进行中会返回 `SKILLS_KEY_ROTATING`；已被后续重置替代会返回 `SKILLS_OPERATION_SUPERSEDED`。
- 状态响应的 `operationId` **不包含操作类型，也不是“本页面拥有该操作”的凭证**。不能从 `ROTATING`、`ACTIVE` 或 `activatedAt` 推断它是生成还是重置，然后自行重放 POST。

为支持刷新恢复，可只在 `sessionStorage` 保留以下非密钥元数据，并按**当前用户 + 项目 + 操作类型**分开存储。当前用户 ID 来自前端已有可信登录态，仅用于本地隔离，不提交给接口：

```ts
interface PendingSkillsOperation {
  userId: string;
  projectCode: "selleros";
  kind: "GENERATE" | "RESET";
  operationId: string;
  startedAt: number;
}
// 示例存储键：skills-key-operation:<userId>:selleros:<GENERATE 或 RESET>
// 值只含上述元数据，绝不含 key、JWT、手机号、完整接口响应或服务密钥。
```

元数据必须在请求发出前保存；不在每次 render 或网络重试时覆盖成新 UUID。退出登录或切换账号清除该功能所有本地待处理标记、计时器和内存状态，不读取其他用户的记录。只允许恢复来自本地合法记录、作用域及类型一致的原操作；UUID/类型非法的记录丢弃后只查询状态。不要把服务端返回的 UUID 自动写成一个缺失的本地待处理操作。

### 6.2 推荐的恢复流程

1. 正常收到生成/重置的 201：更新脱敏状态、结束本地等待并清除对应待处理标记；根据主动交互处理/清除 `key`。
2. 网络断开、前端超时、请求取消或 503：保留原操作元数据，显示「正在确认密钥状态」，首先 GET 状态。不能直接显示「生成失败，请重新生成」，更不能换 UUID 自动发起重置。
3. 页面刷新/重新进入：先确认当前登录用户，再读取同作用域元数据并 GET。没有本地记录也照常显示后端状态，不能主动签发。
4. GET 为 `ACTIVE`：当前凭证可供用户主动复制。若与本地原操作 UUID 一致且本地类型已知，可结束对应操作等待；无需为了获取明文自动重放原 POST，用户点击复制调用 `/reveal` 即可。若 UUID 不一致，不能据此宣告原操作成功：可能是请求未受理时的旧凭证，也可能是其他页面完成了后续操作。以当前服务状态展示，提示「密钥状态已变化，请使用当前密钥」，不要盲目重放历史重置。
5. GET 为 `ROTATING`：禁用生成/显示/复制/重置并有限轮询。相同 UUID 的原 POST 可以作为查询原结果的重试，但没有必要为轮询反复发 POST；推荐只用 GET。若服务端 UUID 不同，说明页面不能认领该操作，保持只查询。
6. GET 为 `NOT_CREATED`：确实没有当前关联行。若没有待处理操作，可显示首次生成；若刚才请求结果未知且有本地 `GENERATE` 记录，允许用户明确「重试本次生成」并复用原 UUID。不能用 `RESET` 记录调用生成接口，也不自动改成新操作。
7. GET 为 `SYNC_UNKNOWN`：先判断 `lastErrorCode`。若为 `SKILLS_PROJECT_CHANGED`，清除旧临时密钥，允许用户确认后以新 UUID 调 `/reset`，不自动提交。其他 `SYNC_UNKNOWN`，或操作返回 `SKILLS_KEY_SYNC_UNKNOWN`，停止自动重试和签发，展示人工恢复说明；管理员恢复后可手动查询。
8. 收到 `SKILLS_OPERATION_SUPERSEDED`：结束该历史操作的重放，刷新当前状态；不要再请求历史密钥。`SKILLS_OPERATION_CONFLICT` 同样先查询，不把同一个 UUID 换到另一接口。

后端修复签发路径或运维修复 API 的 HTTPS 证书链，也不会自动清除历史 `SYNC_UNKNOWN`。前端继续以 GET 的实际状态控制按钮，不能因版本更新而清空操作记录、自动再次签发或把页面改为已生成。文档路由/TLS 的只读检查通过不代表这个用户的 KeyB 已恢复。

对于状态已经 `ACTIVE` 但原操作结果仍有歧义的情形，推荐让用户复制当前密钥，不自动重放重置。如产品仍提供「重试原重置」，必须由用户主动再次确认可能执行原重置，仅限完整保留的原用户/项目/类型/UUID 记录，且不得在 `ROTATING`、`SYNC_UNKNOWN` 或查询失败时强行启动；不确定原记录归属时只查询。

### 6.3 超时、轮询与请求客户端

SellerOS 向远端签发的单次 HTTP 超时是 15 秒，远端接口非幂等且后端不会自动重试。前端生成/重置请求超时建议使用项目可配置的 25～30 秒以容纳本地处理；前端超时并不能证明签发未发生。

`ROTATING` 的异常残留在**服务端操作开始超过 75 秒**后，会在 GET 等读取路径被懒标为 `SYNC_UNKNOWN`。这不是后台定时恢复，也不是“75 秒后成功”。后端未返回 `operationStartedAt`；不要用 `updatedAt` 或本地计时精确推断服务端超时。

推荐可见页面每 2～3 秒 GET 一次，一次最多等待约 90 秒；串行查询，前一请求结束后才排下一次。超时、组件卸载、账号切换或页面进入后台时停止轮询并取消等待，保留合法的非敏感待处理元数据。返回前台/重新进入后先 GET，再决定是否有限轮询。停止轮询时显示“结果未确认”，不能自行把状态写成 `ACTIVE`、`NOT_CREATED`、签发失败或 `SYNC_UNKNOWN`。

对生成、重置禁用 HTTP 客户端/请求库的通用 POST 自动重试，包括重连、焦点恢复或 Token 刷新后无条件重放。复用现有登录刷新流程，但这些写操作的恢复必须保留原操作元数据、遵守上述规则。GET 可按有限查询策略重试；`reveal` 不在后台自动重试，需要用户重新主动操作。自动重试最多返回同次操作结果，永远不能新建 UUID。

## 7. 错误结构与前端处理

后端典型错误响应：

```json
{
  "statusCode": 409,
  "code": "SKILLS_KEY_ROTATING",
  "message": "密钥正在签发，请稍后使用相同 operationId 查询结果",
  "timestamp": "2026-09-08T00:00:00.000Z"
}
```

`code` 可选；参数校验、JWT 或其他通用异常可能没有 `code`。`message` 可以是字符串或字符串数组，可合并成中文提示。依靠 HTTP 状态 + 固定 `code` 分支，不能靠匹配中文文案控制流程。网络失败可能连 JSON 都没有，使用本地中文兜底，不显示或上传 Axios/fetch 原始错误对象。

| HTTP / code | 含义 | 前端处理 |
| --- | --- | --- |
| 400 / 无固定 code | 缺少参数、UUID/projectCode 格式或 JSON 不合法 | 显示规范化提示；修正实现，不能不断重试或改手机号 |
| 400 / `SKILLS_PHONE_INVALID` | 当前数据库手机号不符合签发要求 | 提示联系管理员更正资料；不增加代传手机号入口 |
| 401 / 无固定 code | JWT 缺失/无效 | 复用现有登录失效处理，清除临时密钥；登录后先查状态 |
| 401 / `SKILLS_USER_INACTIVE` | 用户不存在或已停用 | 停止操作并清理敏感信息，提示联系管理员；不循环登录重试 |
| 403 / `SKILLS_PROJECT_FORBIDDEN` | 项目未登记或无权使用 | 禁用操作，核对固定 `selleros` 及后端配置 |
| 409 / `SKILLS_KEY_NOT_CREATED` | 尚无凭证却复制或重置 | 刷新状态；仅确认 `NOT_CREATED` 后提供首次生成 |
| 409 / `SKILLS_KEY_EXISTS` | 已有凭证却以新 UUID 首次生成 | 刷新状态，使用复制或由用户确认重置；不自动转调重置 |
| 409 / `SKILLS_KEY_ROTATING` | 当前仍在签发 | 禁用复制/新操作，有限 GET 轮询；保留原操作元数据 |
| 409 / `SKILLS_OPERATION_CONFLICT` | UUID 跨类型复用或其他操作先完成 | 停止该次重放，查状态；不换接口/新 UUID 绕过 |
| 409 / `SKILLS_OPERATION_SUPERSEDED` | 历史操作已被后续重置替代 | 不再重放历史操作；清理对应本地标记并查当前状态 |
| 409 / `SKILLS_KEY_ASSOCIATION_CONFLICT` | 用户/项目/签发手机号关联冲突 | 禁用操作并联系管理员；不通过改用户/手机号覆盖 |
| 409 / `SKILLS_PROJECT_CHANGED` | 配置中的外部项目 ID 与旧凭证不符 | GET 刷新状态；若为 `SYNC_UNKNOWN` + `lastErrorCode=SKILLS_PROJECT_CHANGED`，允许用户确认后用新 UUID 调 `/reset`，不自动重签、不手改数据库 |
| 409 / `SKILLS_KEY_SYNC_UNKNOWN` | 远端签发或本地保存结果待恢复 | 清除临时密钥；禁用生成/复制/重置；展示人工恢复说明 |
| 503 / `SKILLS_KEYS_DISABLED` | 接入功能尚未启用 | 显示未配置提示；不将其当作 `NOT_CREATED` |
| 503 / `SKILLS_KEY_CRYPTO_ERROR` | 当前密文/主密钥无法读取 | 清理临时密钥并联系运维；不建议重置来修复配置 |
| 503 / `SKILLS_KEYS_UNAVAILABLE` | 数据访问等内部故障，操作结果可能不明确 | 保留原 operationId；服务恢复后先查状态，不能声称未生成 |
| 其他 HTTP 错误或网络故障 | 尚未归类的失败 | 中文兜底，禁用写操作直到状态查询恢复；已发出的操作视为结果未确认 |

状态 JSON 的 `lastErrorCode` 不是 HTTP `code`。**唯一允许主动重置的特殊组合为 `status=SYNC_UNKNOWN` 且 `lastErrorCode=SKILLS_PROJECT_CHANGED`**，按第 3.3 节处理。其他诊断码（如 `ISSUE_RESULT_UNKNOWN`、`ISSUE_TLS_ERROR`、`ISSUE_HTTP_ERROR`、`KEY_SAVE_FAILED`）只用于排查，按 `SYNC_UNKNOWN` / HTTP `SKILLS_KEY_SYNC_UNKNOWN` 停止操作并展示 `recoveryMessage`，不能据此自动重签。适配器内部错误 `SKILLS_KEY_ISSUE_UNKNOWN` 不要求前端直连远端追查。扣费接口的 `KEYB_*`、`OPEN_*`、`SKILLS_KEY_INVALID` 等服务错误不属于这四个前端接口的对接范围。

## 8. 敏感信息保护要求

- 不在前端 `.env`、`VITE_*`、`NEXT_PUBLIC_*`、运行配置、构建产物或源码中配置 KeyA、`appSecret`、加密主密钥。后端四项 `SKILLS_KEYS_*` 基础配置不需要给前端；服务项目扣费授权由后端 OpenApiApp.keybProjectCodes 管理，也不交由前端配置。
- KeyB 不进入 URL/query/hash、路由参数、LocalStorage、SessionStorage、IndexedDB、Cookie、持久化 Store、Service Worker、离线缓存或 SSR 序列化/HTML。上文允许的 SessionStorage 只有非密钥操作元数据。
- 不 `console.log` 完整响应或原始异常；不将请求/响应 body、Authorization、输入内容或完整 KeyB 放进 Sentry、APM、埋点、用户回放、错误面包屑、录屏和测试报告。接入这些接口的通用拦截器也必须遵守。
- 密钥弹窗/输入框按现有监控 SDK 的隐私机制屏蔽 DOM 采集与回放；只读展示，不走 HTML 注入。截图测试使用固定的测试占位密钥。
- 普通状态只显示服务端 `maskedKey`。只有当前用户主动生成/重置/显示/复制的短暂交互可以接收原值；异步响应回来时如用户已切换、页面已隐藏/卸载或主动取消查看，应丢弃原值，不能写回新页面或新账号状态。
- 同时保留用户确认、网络结果、剪贴板结果三个概念：确认重置不等于已重置；201 不等于已复制；前端断网不等于远端没有签发。
- 运维工单可提供固定错误码、时间、项目代码及非密钥操作 UUID；不得粘贴原始接口响应、完整 KeyB 或 JWT。

## 9. 前端验收用例

使用前端现有测试框架编写必要的状态/交互测试，所有接口替身使用假密钥。完成前端构建及项目要求的静态检查，并人工检查请求地址、浏览器存储和监控行为。

| 用例 | 预期 |
| --- | --- |
| 首屏状态还未返回 | 显示 loading，生成/显示/复制/重置按钮均不能点击，不自动生成 |
| GET 返回 `NOT_CREATED` | 仅生成可用；缺少时间/operationId 字段不崩溃 |
| GET 网络失败、503 disabled | 分别显示错误/未配置，不能展示成「未创建」并开放生成 |
| GET 返回 ACTIVE | 原样显示 maskedKey，保留后端提供的部分字符；页面挂载没有 reveal 请求，不写死前缀 |
| 点击显示/隐藏 | 显示只调用 reveal，不写剪贴板；隐藏零请求并清除原值；再次显示重新请求 |
| 取消查看/60 秒到期/凭证编号变化 | 恢复脱敏态并清除原值；已取消查看的迟到响应不重新显示 |
| 点击生成及快速重复点击 | 只有一次操作 UUID，只有一个前端进行中的提交；不自动附加用户/手机号 |
| 生成 201 | 接受 201 和直接 JSON；显示成功，完整密钥未入缓存/存储 |
| 生成返回 KEY_EXISTS | 查询状态，不自动调用 reset |
| 取消/确认重置 | 取消零请求；确认后新 UUID，禁用旧 Key 复制并显示风险文案 |
| 点击复制 | 只调用 reveal；剪贴板实际写入成功后才提示「已复制」 |
| 剪贴板拒绝 | 临时手动复制弹窗可用；不生成/重置，不提示已自动复制；关闭/超时清理 |
| 请求超时后再试 | 先 GET；重试同次操作保留同 UUID 及类型，不换 UUID |
| 刷新页面恢复 | 只读取当前用户+项目+kind 元数据，先 GET；ACTIVE 时无需盲重放，用户可主动 reveal |
| 无本地记录但 GET 有 operationId | 只查询，不凭该 UUID 推断 kind 或代发重置 |
| 服务端 UUID 与本地不同 | 不将本地原操作误判为成功，不自动重放历史重置 |
| ROTATING/超 75 秒读时转 UNKNOWN | 禁用所有签发/显示/复制；按返回状态展示；不把本地计时当作成功/失败证据 |
| SYNC_UNKNOWN + SKILLS_PROJECT_CHANGED | 显示项目变更提示；允许用户确认后用新 UUID 重置，成功后显示新 maskedKey；不自动重置 |
| 其他 SYNC_UNKNOWN | 展示 recoveryMessage，停止自动重签，提供联系管理员与手动刷新 |
| OPERATION_CONFLICT/SUPERSEDED | 不换接口、不取历史密钥、不生成新 UUID 重试；刷新当前状态 |
| 页面卸载、后台、登出、切换用户 | 停止轮询、清理临时原值；旧请求不能污染新用户状态 |
| 连续网络故障或轮询到限 | 有限停止，提示结果未确认，不无限请求 |
| 400 message 数组、401、未知 5xx | 中文提示正常，错误分支无需必有 code，原错误对象不外发 |
| 敏感信息检查 | 存储、URL、控制台、状态缓存、监控/回放均无完整密钥或服务 Secret |
| 后端暂未启用 | 页面可用并准确展示未配置，不要求浏览器填写四项后端变量或配置服务项目授权 |

真实联调必须在后端已配置和同步数据结构、API 真实签发契约已确认后，使用指定且获准的测试账号完成。重置会使该账号旧 Key 失效，不可用真实用户账号随意验收。API 的自动扣费及 MCP 返回结果是跨服务验收，前端 mock 测试无法证明它们已完成。

## 10. 前端完成后应交付

1. 页面入口、实际实现的功能及变更文件。
2. 四个接口的接入结果，以及 `baseURL`、JWT、201、直接 JSON 解包的核对结论。
3. 部分字符展示、主动显示/隐藏、生成/重置幂等恢复、复制失败、待恢复状态及账号切换的处理说明。
4. 测试和构建命令、真实结果及尚未验证的场景；敏感信息检查结果。
5. 分别说明「前端代码已实现」「前端测试已通过」「指定测试账号的真实签发/重置/复制联调已完成」「API/MCP 自动扣费联调已完成或仍待完成」。未实际验证的项写明未完成，不能把 mock、文档或后端既有测试等同于真实联调。

前端无需执行数据库同步、seed、服务账号脚本或配置后端密钥；这些由 SellerOS/API 部署人员按部署文档处理。本文不授权改动扣费内核、操作真实余额、修改 API/MCP 仓库或提交推送代码。
