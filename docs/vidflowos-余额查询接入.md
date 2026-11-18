# vidflowos 按手机号查询钱包（个人与企业）

独立内部接口，由 vidflowos 后端调用。鉴权与视频转发 `/api/internal/generation/video-tasks` 相同：请求头 `X-Internal-Token` 与服务端 `INTERNAL_GENERATION_TOKEN` 一致。

## 请求

```http
GET /api/internal/credits/balance?phone=13800001234
X-Internal-Token: <与视频转发相同的内部令牌>
```

`phone` 必填，为以 `1` 开头的 11 位数字字符串，与平台登记手机号一致；首尾空白自动去除。

## 与钱包接口的关系

响应直接包含 `GET /api/membership/wallet` 的完整数据，保留其字段名、嵌套结构和类型，再追加 `userId` 与原 VidFlowOS 额度字段。新接入的页面优先使用原生钱包字段，已接入的额度展示可继续使用兼容字段。

| 钱包字段 | 含义 |
| --- | --- |
| `level` / `identity` / `canInvite` | 等级、个人或企业身份、邀请权 |
| `buckets` / `total` | 个人充值、套餐、赠送、返利分桶及个人可消费余额；total 不含返利 |
| `monthUsed` / `totalConsumed` | 钱包本月与累计消费统计，沿用原钱包统计范围 |
| `nextExpireAt` / `nextExpireAmount` | 最近到期时间与积分 |
| `discount` / `rebateRate` / `subscriptionExpiresAt` | 生效折扣、返利比例、订阅到期时间 |
| `inviter` / `inviterShareCredits` | 邀请人摘要、是否共享额度 |
| `team` | 完整企业钱包块；个人用户为 null，含配额、共享池余额、生命周期、席位等 |
| `lots` | 个人积分批次明细，按获得时间倒序，最多 100 条；不是消费流水列表 |

金额沿用钱包的十进制字符串；`team.monthlyQuota` 仍为 number 或 null。当前内部调用不带用户 JWT 的 `currentOrgId`，因此 `team.orgName` 沿用钱包未指定当前组织时的回落规则，其余数据直接来自同一个 `WalletService.getWallet`。

### 兼容字段

| 顶层字段 | 来源 / 含义 |
| --- | --- |
| `userId` | 手机号对应的用户 ID |
| `totalQuota` | `team.monthlyQuota` 转积分字符串；个人或未设置月配额时 null |
| `remainingQuota` | 企业取 `team.myAvailable`，个人取 `total` |
| `teamId` / `teamStatus` | `team.teamId` / `team.status`，个人为 null |
| `quotaMode` / `overLimitPolicy` | `team` 同名字段，个人为 null |

- 企业 `remainingQuota` 是配额剩余与池余额的较小值；无月度配额时取池余额。个人余额、邀请人共享额度不合入企业兼容字段。
- 顶层 `total` 始终是个人可消费余额，不等于成员月度配额 `totalQuota` 或企业累计发放 `team.poolGrantedTotal`。
- 北京自然月、宽限冻结、归档保留期、停用成员回落个人身份、透支负余额均沿用钱包逻辑。展示值不能代替扣费权限或预检：GRACE 可能显示冻结余额，INDEPENDENT 未分配额度仍受扣费限制。
- 无企业身份时正常返回个人钱包，不返回 `TEAM_NOT_FOUND`。旧 `balance` 字段不恢复。
- 不发起扣费；钱包读取沿用历史到期待生效套餐的激活逻辑。

## 响应示例

以下为 HTTP 200 主要字段示例，省略部分钱包字段、批次明细和企业附加字段；金额均为示例。

个人用户：

```json
{
  "userId": 12,
  "level": "NONE",
  "identity": "NONE",
  "canInvite": false,
  "buckets": { "recharge": "100", "package": "0", "gift": "23.45", "rebate": "0" },
  "total": "123.45",
  "monthUsed": "10",
  "totalConsumed": "50",
  "team": null,
  "totalQuota": null,
  "remainingQuota": "123.45",
  "teamId": null,
  "teamStatus": null,
  "quotaMode": null,
  "overLimitPolicy": null
}
```

企业成员：

```json
{
  "userId": 7,
  "level": "NONE",
  "identity": "TEAM_MEMBER",
  "canInvite": false,
  "buckets": { "recharge": "100", "package": "0", "gift": "0", "rebate": "0" },
  "total": "100",
  "monthUsed": "10",
  "totalConsumed": "50",
  "team": {
    "teamId": 42,
    "name": "示例企业",
    "status": "ACTIVE",
    "role": "MEMBER",
    "quotaMode": "SHARED",
    "overLimitPolicy": "BLOCK",
    "monthlyQuota": 1000,
    "quotaUsedThisMonth": "200",
    "quotaRemaining": "800",
    "poolPackage": "300",
    "poolRecharge": "200",
    "poolRemaining": "500",
    "poolGrantedTotal": "10000",
    "myAvailable": "500"
  },
  "totalQuota": "1000",
  "remainingQuota": "500",
  "teamId": 42,
  "teamStatus": "ACTIVE",
  "quotaMode": "SHARED",
  "overLimitPolicy": "BLOCK"
}
```

## 错误与调用示例

| HTTP 状态 | 含义 |
| --- | --- |
| 400 | 手机号缺失或格式错误 |
| 404 | `code=USER_NOT_FOUND`，该手机号未注册 |
| 503 | 未配置内部令牌、令牌缺失或错误，与视频转发 Guard 一致 |

失败格式为 `{ statusCode, message, timestamp }`，上述 404 另带顶层 `code`；参数校验的 `message` 可能为数组。

```bash
curl --get "${SOURCING_API_ORIGIN}/api/internal/credits/balance" \
  --data-urlencode 'phone=13800001234' \
  --header "X-Internal-Token: ${INTERNAL_GENERATION_TOKEN}"
```

`SOURCING_API_ORIGIN` 为服务域名（不含 `/api`）；令牌仅保存在后端。vidflowos 从已认证用户的可信手机号发起查询，通过 HTTPS 调用。无需新增凭据、数据库结构或依赖。
