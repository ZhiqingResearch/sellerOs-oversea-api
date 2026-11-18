# ASIN 审计记录前端联调文档

## 概览

- 所有接口需要 Bearer JWT，只能访问当前用户自己的记录。
- 一次取证与评分创建一条主记录；同一 ASIN 重新取证可创建新记录。
- 第一步快照创建后不可修改。
- 每次内容不同的 AI 优化在同一主记录下新增一个 revision。
- 详情默认返回第一步快照和最新优化结果，不会重新调用爬虫或 AI。

## 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/asin-audit/records` | 创建审计记录和第一步快照 |
| `PUT` | `/api/asin-audit/records/{recordId}` | 新增一个优化版本 |
| `GET` | `/api/asin-audit/records` | 分页查询当前用户记录 |
| `GET` | `/api/asin-audit/records/{recordId}` | 查询第一步快照和最新优化 |
| `DELETE` | `/api/asin-audit/records/{recordId}` | 软删除 |

## 创建记录

```http
POST /api/asin-audit/records
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "clientRequestId": "23fd58d7-3810-4a16-8a39-61520e134994",
  "schemaVersion": 1,
  "asin": "B0C9L8ZR6Q",
  "marketplace": "US",
  "country": "US",
  "category": {
    "nodeId": "172282",
    "name": "Electronics",
    "path": "Electronics:Wearable Technology:Smart Glasses"
  },
  "productTitle": "Example Smart Glasses",
  "adIncluded": false,
  "evidence": {
    "A": {},
    "P": {},
    "B": {},
    "C": {},
    "D": {},
    "E": {},
    "meta": {}
  },
  "scoreResult": {
    "overallScore": 76,
    "grade": "B+",
    "contentScore": 80,
    "trafficScore": 72,
    "adScore": null,
    "dimensions": [
      { "code": "D1", "criteria": [{}] },
      { "code": "D2", "criteria": [{}] },
      { "code": "D3", "criteria": [{}] },
      { "code": "D4", "criteria": [{}] },
      { "code": "D5", "criteria": [{}] },
      { "code": "D6", "criteria": [{}] },
      { "code": "D7", "criteria": [{}] },
      { "code": "D8", "criteria": [{}] },
      { "code": "D9", "criteria": [{}] },
      { "code": "D10", "criteria": [{}] }
    ],
    "problemTypes": {},
    "recommendations": []
  }
}
```

关键校验：

- `clientRequestId` 必须为 UUID v4；相同请求重试返回同一条记录。
- `schemaVersion` 当前只支持 `1`。
- `evidence` 必须包含对象类型的 `A/P/B/C/D/E/meta`。
- `scoreResult.dimensions` 必须恰好十项，每项的 `criteria` 必须是非空数组。
- `adIncluded=false` 时 `adScore` 必须为 `null`；为 `true` 时必须是 `0～100` 的数字。
- 图片不能使用 `blob:` 或 Base64；`A.aplusImages` 只能是 HTTPS URL 数组。
- 创建请求最大 `4 MiB`。

成功响应：

```json
{
  "recordId": "b9912892-6909-468c-a252-6a40ec697d5a",
  "version": 1,
  "status": "SCORED",
  "idempotentReplay": false,
  "createdAt": "2026-08-25T08:00:00.000Z",
  "updatedAt": "2026-08-25T08:00:00.000Z"
}
```

## 新增优化版本

```http
PUT /api/asin-audit/records/b9912892-6909-468c-a252-6a40ec697d5a
```

```json
{
  "expectedVersion": 1,
  "schemaVersion": 1,
  "optimizationResult": {
    "listing": {
      "title": "Optimized title",
      "bullets": []
    }
  }
}
```

```json
{
  "recordId": "b9912892-6909-468c-a252-6a40ec697d5a",
  "version": 2,
  "status": "OPTIMIZED",
  "optimizationRevision": 1,
  "changed": true,
  "updatedAt": "2026-08-25T08:05:00.000Z"
}
```

- 第二次不同优化携带 `expectedVersion=2`，成功后主记录 `version=3`、`optimizationRevision=2`。
- 相同优化请求重复提交返回 `changed=false`，不新增 revision，也不增加 version。
- 内容不同但 `expectedVersion` 过期时返回 `409 AUDIT_RECORD_VERSION_CONFLICT`。
- 单次优化结果最大 `2 MiB`。

## 列表

```http
GET /api/asin-audit/records?page=1&pageSize=10&keyword=B0C9L8ZR6Q&marketplace=US&dateFrom=2026-08-01&dateTo=2026-08-25
```

- `keyword` 匹配 ASIN、标题、站点、国家、类目名称和类目路径。
- `dateFrom/dateTo` 使用 `YYYY-MM-DD`，按北京时间的创建时间过滤，两端日期均包含。
- 默认按 `createdAt` 倒序。
- 列表只返回摘要，不返回三个大型 JSON 字段。

## 详情

```http
GET /api/asin-audit/records/b9912892-6909-468c-a252-6a40ec697d5a
```

响应包含创建时的 `evidence`、`scoreResult`，以及最新的 `optimizationResult`。尚未优化时：

```json
{
  "optimizationRevision": null,
  "optimizationResult": null
}
```

## 删除

```http
DELETE /api/asin-audit/records/b9912892-6909-468c-a252-6a40ec697d5a
```

成功返回 `204 No Content`。删除后不能再用原 `clientRequestId` 创建，需要生成新 UUID。

## 业务错误码

| HTTP | code | 前端处理建议 |
| --- | --- | --- |
| 400 | `INVALID_AUDIT_RECORD_PAYLOAD` | 修正请求数据 |
| 400 | `UNSUPPORTED_AUDIT_SCHEMA_VERSION` | 更新前端数据版本 |
| 404 | `AUDIT_RECORD_NOT_FOUND` | 返回记录列表 |
| 409 | `CLIENT_REQUEST_ID_REUSED` | 生成新的创建 UUID |
| 409 | `AUDIT_RECORD_ALREADY_DELETED` | 开启新一轮审计 |
| 409 | `AUDIT_RECORD_VERSION_CONFLICT` | 重新加载详情后再编辑 |
| 413 | `AUDIT_RECORD_PAYLOAD_TOO_LARGE` | 减少证据或优化数据量 |
