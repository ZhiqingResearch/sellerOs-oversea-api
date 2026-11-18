# /api/auth/me 邮箱注册标识 前端联调文档

## 概览

- `GET /api/auth/me` 的 `user` 对象**新增两个字段**：`email`（注册邮箱）与 `registerType`（注册通道标识）。
- **纯增量变更**：原有字段（`id`/`username`/`phone` 等）含义与结构完全不变，`roles`/`orgs`/`permissions` 不变；前端不改造也不受影响。
- 需要认证：`Authorization: Bearer <token>`。手机号登录、邮箱密码登录、SSO 交接换取的 token 完全互通，登录后统一调本接口取用户信息。
- 背景：邮箱注册用户的 `phone` 是系统生成的伪手机号（9 开头 11 位，非真实号码），此前前端无法区分「邮箱注册账号」，会话栏会展示一个无意义的假手机号。

## 接口信息

```http
GET /api/auth/me?_=1788500899821   # ?_= 时间戳参数仅为前端缓存穿透，后端忽略
Authorization: Bearer <access_token>
```

## 响应结构

### 邮箱注册用户（registerType = EMAIL）

```json
{
  "user": {
    "id": 123,
    "username": "foo",
    "phone": "9123456789",
    "email": "foo@bar.com",
    "registerType": "EMAIL",
    "modelUnlocked": false,
    "mustChangePassword": false,
    "createdAt": "2026-09-01T08:30:00.000Z"
  },
  "roles": [{ "code": "TEST", "name": "测试", "color": null }],
  "orgs": [],
  "permissions": []
}
```

### 手机号注册用户（registerType = PHONE）

```json
{
  "user": {
    "id": 456,
    "username": "test4",
    "phone": "18666190380",
    "email": null,
    "registerType": "PHONE",
    "modelUnlocked": false,
    "mustChangePassword": false,
    "createdAt": "2026-04-20T06:12:00.000Z"
  },
  "roles": [{ "code": "ADMIN", "name": "管理员", "color": "#ff3b30" }],
  "orgs": [{ "id": 1, "name": "深圳总部" }],
  "permissions": []
}
```

## 新增字段说明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user.email` | `string \| null` | 注册邮箱（小写归一）。**仅邮箱注册用户有值**，手机号注册用户恒为 `null`。数据来源是邮箱账号表（`EmailAccount`），不是通知邮箱 |
| `user.registerType` | `"EMAIL" \| "PHONE"` | 注册通道标识。`EMAIL` = 邮箱开放注册的账号；`PHONE` = 手机号验证码/邀请注册的账号 |

## 前端对接要点

1. **账号展示一律按 `registerType` 分支**，不要按 `phone` 是否有值判断：
   - `registerType === "EMAIL"` → 展示 `user.email`；此时 `phone` 是伪手机号（9 开头），**不要展示给用户，也不要用于任何业务**（发短信、改绑、脱敏展示等）。
   - `registerType === "PHONE"` → 照旧展示 `user.phone`；`email` 为 `null`。
2. **不要用 `User.email`（本接口的 `email` 字段之外的通知邮箱概念）做登录相关判断**——后端有存量手机号注册用户带通知邮箱，但只能用手机号登录。能走「邮箱密码登录 / 邮箱找回密码」的账号，判定条件就是 `registerType === "EMAIL"`。
3. **改密 / 找回密码入口**（如前端有账号安全页）：
   - `EMAIL` 用户：找回密码走 `POST /api/auth/email/forgot-password`（发重置码到邮箱）。
   - `PHONE` 用户：走原有手机验证码通道。
4. **取值时机**：登录成功（任一通道拿到 `access_token`）后即可调本接口；也可在会话刷新/页面刷新时重新拉取，字段不会过期失效。

## 邮箱通道相关接口（联调参考）

登录链路配套接口，均返回 `{ "access_token": "..." }`（注册即登录），token 与 `/api/auth/login` 互通：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/auth/email/send-code` | 发送注册验证码（60s 限频；邮箱已注册 400） |
| `POST` | `/api/auth/email/register` | 邮箱开放注册（注册即登录，返回 `access_token`） |
| `POST` | `/api/auth/email/login` | 邮箱密码登录 |
| `POST` | `/api/auth/email/forgot-password` | 忘记密码：发重置码（统一话术，不暴露账号存在性） |
| `POST` | `/api/auth/email/reset-password` | 重置密码（仅邮箱注册账号） |

## 环境与自测

- UAT：`https://uat-api.intelligentselleros.com/api/auth/me`
- 本地开发：`http://127.0.0.1:8000/api/auth/me`
- Swagger（DTO 定义已同步更新）：`/api-docs`

自测 curl：

```bash
curl -s "https://uat-api.intelligentselleros.com/api/auth/me" \
  -H "Authorization: Bearer <access_token>" | jq '.user | {phone, email, registerType}'
```

预期：邮箱注册账号返回 `{"phone":"9xxxxxxxxxx","email":"foo@bar.com","registerType":"EMAIL"}`；手机号注册账号返回 `{"phone":"18xxxxxxxxx","email":null,"registerType":"PHONE"}`。
