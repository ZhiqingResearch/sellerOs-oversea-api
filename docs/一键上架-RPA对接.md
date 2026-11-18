# 一键上架—RPA 对接协议

> 本文档是可直接交给 RPA 同事或实现型 AI 的完整协议。三种业务动作全部由后端主动调起影刀脚本；`startTask` 哪怕返回成功也只表示脚本已被调起。RPA 执行完成后必须将业务结果 POST 到后端结果接口。

## 1. 整体流程

```text
后端生成内部调度关联号
  → 构造 Amazon/tasks_info 业务数组
  → 将 JSON 数组写入 UTF-8 .txt 文件
  → 调用影刀文件上传接口得到 fileKey
  → 调用 startTask，paramsFile=fileKey、type=file
  → startTask 返回 taskUuid/jobUuidList，后端记录“调度已接收”
  → RPA 读取文件并执行对应 task_type
  → RPA POST /api/product-publish/internal/rpa/results
  → 后端验证 X-API-Key，按 task_type 对应业务键找回内部调度日志后落库
```

后端把影刀调度结果与 RPA 业务结果分成两个阶段记录。`taskUuid`/`jobUuidList` 只是影刀调度标识，不能代替 Amazon 业务结果。

## 2. 影刀调度传输

### 2.1 应用入参

影刀已发布应用必须声明两个入参：

| 参数名 | 类型 | 内容 |
| --- | --- | --- |
| `paramsFile` | `file` | UTF-8 JSON 文件，后缀 `.txt` |
| `profile` | `string` | 当前后端环境，只可能是 `dev`、`dev1`、`uat`、`prod` |

后端可通过 `YINGDAO_PRODUCT_PUBLISH_PARAM_NAME` 覆盖文件参数名；`profile` 参数名固定不变。RPA 已发布应用的入参名必须与后端一致。

### 2.2 `startTask` 请求

```json
{
  "scheduleUuid": "<YINGDAO_PRODUCT_PUBLISH_TASK_UUID>",
  "idempotentUuid": "<后端幂等调度 ID>",
  "scheduleRelaParams": [
    {
      "robotUuid": "<YINGDAO_PRODUCT_PUBLISH_APP_ID>",
      "runTimeout": 3600,
      "params": [
        {
          "name": "paramsFile",
          "value": "<fileKey>",
          "type": "file"
        },
        {
          "name": "profile",
          "value": "uat",
          "type": "string"
        }
      ]
    }
  ]
}
```

- `scheduleUuid` 是影刀控制台任务 ID，不是定时表达式。
- `robotUuid` 是已发布的一键上架应用 ID。
- `idempotentUuid` 是后端内部非空幂等调度 ID；业务文件中的 `task_id` 仍固定为空字符串。
- `profile` 用于区分发起请求的后端环境，RPA 必须按该值选择对应的回调地址和环境相关配置，不得忽略或自行改写。
- 三种 `task_type` 共用同一个任务和应用，RPA 必须按 `task_type` 分支。

### 2.3 `startTask` 成功响应

```json
{
  "code": 200,
  "success": true,
  "data": {
    "taskUuid": "<影刀调度任务 UUID>",
    "jobUuidList": ["<影刀作业 UUID>"],
    "idempotentFlag": false
  }
}
```

此响应只表示影刀已接收调度。不得从该响应推断模板 URL、Amazon `upload_id` 或处理结果。

## 3. 通用业务请求

`paramsFile` 内容永远是数组：

```ts
interface RpaRequest {
  business_type: "Amazon"
  business_id: string
  tasks_info: Array<{
    task_type: "download_listing" | "upload_listing" | "check_feed_status"
    task_id: ""
    rpa_storage: ""
    task_param:
      | { category: string }
      | { file_url: string }
      | { upload_id: string; skus: string[] }
  }>
}

type ParamsFile = RpaRequest[]
```

通用规则：

- `business_id` 是 1–32 位纯数字字符串，不得转换为浮点数。
- 模板下载按批次发送：相同 `business_id` 的任务合并到同一个 `tasks_info`，不同店铺放在外层数组。日常刷新、全量手工刷新、失败重试共用此格式；每批只上传一个参数文件、调用一次 `startTask`。提交上架与结果查询仍为单任务。
- `task_id` 是业务结构保留字段，当前固定为空字符串 `""`。不得将后端 `request_id`、影刀 `taskUuid` 或 Amazon `upload_id` 写入此字段。
- `rpa_storage` 为业务结构保留字段。影刀官方调度契约未定义其含义，当前生产值固定为空字符串 `""`；它不是后端结果接口地址。
- 其他非必要字段按当前协议传空字符串，RPA 不得用 `taskUuid`/`jobUuidList` 自行填充。

### 3.1 模板下载批量示例

```json
[
  {
    "business_type": "Amazon",
    "business_id": "27537578181301",
    "tasks_info": [
      { "task_type": "download_listing", "task_id": "", "rpa_storage": "", "task_param": { "category": "NOTEBOOK COMPUTER" } },
      { "task_type": "download_listing", "task_id": "", "rpa_storage": "", "task_param": { "category": "PERSONAL COMPUTER" } }
    ]
  },
  {
    "business_type": "Amazon",
    "business_id": "27826971599669",
    "tasks_info": [
      { "task_type": "download_listing", "task_id": "", "rpa_storage": "", "task_param": { "category": "NOTEBOOK COMPUTER" } }
    ]
  }
]
```

**批量下发、逐个类目回调**：RPA 必须遍历外层店铺和内层 `tasks_info`，每完成一个类目立即回调一次，成功和失败都要回调；某类目失败不能中断其它任务。店铺登录失败时，该店铺尚未执行的类目也分别回调失败，再继续其它店铺。不能只读取 `[0]`，不能只回整批“成功”。回调路径、鉴权和 JSON 结构不变，`data` 必须包含 `task_type`、`business_id`、`category`，成功时另带 `template_url`，失败时顶层带 `ok: false` 和 `error`。

后端每个类目保持独立请求锁、审计日志、结果和重试次数；同批日志共享 `idempotentUuid` 和影刀任务标识，但 `requestId` 各自独立。默认每 5 分钟扫描失败项，失败至少 5 分钟后才重新发起下载；初次加最多 3 次自动重试（总计 4 次），次日刷新开启新一轮。重试只汇总失败/超时且没有进行中请求的类目，成功项不重发。启动接口结果未知时先等待回调或超时，不立即重发。

多类目批量下载的运行超时由 `YINGDAO_PRODUCT_PUBLISH_TEMPLATE_BATCH_RUN_TIMEOUT_SECONDS` 控制，默认 10800 秒（3 小时），且不低于普通运行超时。回调窗口 = 批量运行超时 + 原有回调缓冲（默认 4200−3600=600 秒），默认 11400 秒。每条日志保存本次 `expiresAt`，超时扫描据此判断。RPA 的调度队列/机器人占用仍可能耗尽此窗口，应结合整批实际耗时调整；本次不会修改影刀平台配置。

刷新中或失败时继续保留并使用最近成功保存的 `templateUrl`，不要求文件日期是当天。新回调成功后才切换模板；从未成功下载过且没有 URL 的类目仍需先取得模板。

兼容说明：现有输入 `task_id` 固定为空，现有回调可不带 `request_id`。没有请求编号的旧回调无法区分重试前后的同店铺同类目任务，因此不要在旧任务仍运行时强制重跑；如需严格隔离迟到回调，后续需与 RPA 双方约定下发并原样回传逐任务请求编号，本次未擅自变更该契约。

## 4. 异步结果接口与通用封装

RPA 执行完成后请求：

```http
POST /api/product-publish/internal/rpa/results
Content-Type: application/json
X-API-Key: <YINGDAO_PRODUCT_PUBLISH_CALLBACK_API_KEY>
```

该接口不使用用户 JWT。`X-API-Key` 必须与后端 `YINGDAO_PRODUCT_PUBLISH_CALLBACK_API_KEY` 一致，不得写入 `paramsFile`、`rpa_storage` 或业务日志。RPA 部署时单独配置完整结果接口 URL 和 API Key。

后端成功接收并幂等保存后返回 `2xx`。网络错误或 `5xx` 时，RPA 应对同一业务键的完全相同请求体以有限次数指数退避重试；`400/401/404/409` 属于契约、鉴权或关联错误，应停止无限重试并告警。

成功处理（包括业务失败结果已成功落库）统一返回 HTTP `200`：

```json
{
  "success": true,
  "duplicate": false,
  "taskType": "upload_listing",
  "requestId": "后端内部关联号",
  "businessSuccess": true
}
```

同一结果重复提交且此前已完成处理时仍返回 HTTP `200`，其中 `duplicate=true`；RPA 应将其视为成功并停止重试。错误状态含义：`400`=字段或组合不合法，`401`=`X-API-Key` 错误，`404`=业务键/关联请求不存在，`409`=关联冲突或同一回调正在处理，`500/503`=服务端暂时失败。

后端使用 `YINGDAO_PRODUCT_PUBLISH_CALLBACK_TIMEOUT_SECONDS`（默认 `4200` 秒）定义调度后等待结果的时间窗口；该值必须至少比影刀脚本运行超时多 60 秒。RPA 应在此时间内完成结果 POST；超时后后端会在请求日志和业务任务中保留超时信息。对 `upload_listing` 而言，超时不授权再次向 Amazon 提交。

### 4.1 成功

```ts
interface BusinessSuccess<T> {
  contract_version: "1.0"
  request_id?: string
  ok: true
  data: T
}
```

### 4.2 失败

```ts
interface BusinessFailure<TLocator> {
  contract_version: "1.0"
  request_id?: string
  ok: false
  data: TLocator
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}
```

严格规则：

- `contract_version` 只能是 `"1.0"`。
- `request_id` 可选。RPA 无法获取后端内部关联号时应省略，不得从空字符串 `task_id` 推导或自行生成；如确实能带回，后端会用它与业务键定位的日志做交叉校验。
- 后端主要按业务键定位调度记录：`download_listing = business_id + category`；`upload_listing = business_id + file_url 的 origin/pathname`（忽略 query/fragment 后计算唯一哈希）；`check_feed_status = business_id + upload_id`。
- `data` 在成功和失败结果中都必须存在，并包含 `task_type`、`business_id` 与对应业务键，否则后端无法定位调度记录。
- `ok=true` 时不提供 `error`；`ok=false` 时必须同时提供定位用 `data` 和 `error`。
- 对接协议要求 `code` 是可用于日志聚合的稳定英文码，`message` 是可排查的文字。后端仅为兼容历史脚本对空对象提供默认值，RPA 新实现不得依赖该容错。
- RPA 必须捕获 Amazon 请求、文件解析和业务校验异常，并以 `ok=false` 返回；不得仅让影刀任务无结果结束。

由本服务定义的 `data` 必填字段如下，字段名和大小写必须完全一致：

| `task_type` | 成功 `data` 必填字段 | 失败 `data` 必填定位字段 |
| --- | --- | --- |
| `download_listing` | `task_type`、`business_id`、`category`、`template_url` | `task_type`、`business_id`、`category` |
| `upload_listing` | `task_type`、`business_id`、`file_url`、`upload_id` | `task_type`、`business_id`、`file_url` |
| `check_feed_status` | `task_type`、`business_id`、`upload_id`、`status`、`total_count`、`success_count`、`failed_count`、`sku_asin_mapping`；`result_file_url` 可选/可为 `null` | `task_type`、`business_id`、`upload_id` |

这些是“RPA 请求本服务结果接口”的自定义业务字段，不是影刀开放 API 的返回字段；RPA 同事必须按本节组装 HTTP JSON。

## 5. `download_listing`—获取模板

### 5.1 请求

```json
[
  {
    "business_type": "Amazon",
    "business_id": "27826971599669",
    "tasks_info": [
      {
        "task_type": "download_listing",
        "task_id": "",
        "rpa_storage": "",
        "task_param": { "category": "HEADPHONES" }
      }
    ]
  }
]
```

`category` 是 1–100 位大写字母、数字和单个空格组成的分类文本；原分类中的下划线统一替换为空格，例如 `NOTEBOOK_COMPUTER` 转为 `NOTEBOOK COMPUTER`。RPA 必须逐字符使用后端传入值。

### 5.2 成功结果请求体

```json
{
  "contract_version": "1.0",
  "ok": true,
  "data": {
    "task_type": "download_listing",
    "business_id": "27826971599669",
    "category": "HEADPHONES",
    "template_url": "https://files.example.com/templates/27826971599669/headphones.xlsm"
  }
}
```

`template_url` 必须：

- 使用 HTTPS；
- 永久有效；
- 允许公开直接访问；
- 指向该店铺与该分类的模板。

`business_id` 和 `category` 必须逐字符带回输入值，后端使用这两个字段找回 `templateRequestId` 及对应调度日志。

不得返回影刀临时 `fileKey`、需登录的页面或短时预签名 URL。

## 6. `upload_listing`—提交上架

### 6.1 请求

```json
[
  {
    "business_type": "Amazon",
    "business_id": "27826971599669",
    "tasks_info": [
      {
        "task_type": "upload_listing",
        "task_id": "",
        "rpa_storage": "",
        "task_param": {
          "file_url": "https://files.example.com/product-publish/listing.xlsm"
        }
      }
    ]
  }
]
```

RPA 必须下载 `file_url`，校验文件可读后仅提交一次 Amazon。

### 6.2 成功结果请求体

```json
{
  "contract_version": "1.0",
  "ok": true,
  "data": {
    "task_type": "upload_listing",
    "business_id": "27826971599669",
    "file_url": "https://files.example.com/product-publish/listing.xlsm",
    "upload_id": "6b1ccdde-16f4-41e4-99d1-5d1ff273c02d"
  }
}
```

`upload_id` 是 RPA 调用 Amazon 服务后由 Amazon 生成的业务文件批次 ID。RPA 只负责传输它，不得自行生成，不得用影刀 `taskUuid`、`jobUuid` 或 `task_id` 代替。

`business_id` 必须逐字符带回输入值，`file_url` 应原样带回输入值，便于联调排障。后端关联时使用 `business_id + file_url 的 origin/pathname` 计算唯一哈希，因此签名 query/fragment 不参与关联；日志展示时同样移除敏感 query/fragment。RPA 仍不得无故改写文件域名或路径。

同一 `business_id + file_url origin/pathname` 重复到达时，RPA 必须返回首次执行的同一 `upload_id`，不得再次向 Amazon 提交。该映射需持久化，不能只保存在进程内存。

## 7. `check_feed_status`—查询结果

### 7.1 请求

```json
[
  {
    "business_type": "Amazon",
    "business_id": "27826971599669",
    "tasks_info": [
      {
        "task_type": "check_feed_status",
        "task_id": "",
        "rpa_storage": "",
        "task_param": {
          "upload_id": "6b1ccdde-16f4-41e4-99d1-5d1ff273c02d",
          "skus": ["SKU-001", "SKU-002"]
        }
      }
    ]
  }
]
```

### 7.2 成功结果请求体

```json
{
  "contract_version": "1.0",
  "ok": true,
  "data": {
    "task_type": "check_feed_status",
    "business_id": "27826971599669",
    "upload_id": "6b1ccdde-16f4-41e4-99d1-5d1ff273c02d",
    "status": "PARTIAL_SUCCESS",
    "total_count": 2,
    "success_count": 1,
    "failed_count": 1,
    "result_file_url": "https://files.example.com/results/result.xlsx",
    "sku_asin_mapping": [
      {
        "sku": "SKU-001",
        "asin": "B000000001",
        "status": "SUCCESS"
      },
      {
        "sku": "SKU-002",
        "asin": null,
        "status": "FAILED",
        "error_code": "INVALID_ATTRIBUTE",
        "error_message": "Required attribute is missing"
      }
    ]
  }
}
```

`status` 只允许：

| 值 | 含义 | 是否终态 |
| --- | --- | --- |
| `ACCEPTED` | Amazon 已接收 | 否 |
| `PROCESSING` | Amazon 处理中 | 否 |
| `SUCCESS` | 全部成功 | 是 |
| `PARTIAL_SUCCESS` | 部分成功 | 是 |
| `FAILED` | 全部失败 | 是 |

`business_id` 和 `upload_id` 必须逐字符带回输入值，后端使用这两个字段找回 `resultRequestId` 及对应调度日志。

`upload_id` 的后端约束：长度 1–100，只能包含字母、数字、`.`、`_`、`:`、`-`，且首字符必须是字母或数字。它必须是 Amazon 实际生成的批次 ID。

`skus` 是前端首次提交上架时由后端冻结的原始 SKU 列表。每次主动刷新和每 5 分钟定时查询都会携带同一列表：

- 必须是非空 JSON 字符串数组，最多 100000 项；
- 每项去除首尾空格后长度为 1–200，且列表内不能重复；
- RPA 只查询该列表中的 SKU，不得自行新增、替换或删除查询条件；
- `sku_asin_mapping` 可以在非终态返回当前已有结果，但不得包含 `skus` 之外的 SKU，也不得重复同一 SKU。

计数规则：

- `total_count` / `success_count` / `failed_count` 都是大于等于 0 的安全整数。
- `success_count + failed_count <= total_count`。
- 非终态允许 `result_file_url=null`，`sku_asin_mapping=[]`。
- 终态应返回当前可得的全部 SKU 结果。
- `result_file_url` 非空时必须为可直接访问的 HTTPS URL。
- `sku_asin_mapping` 必须是数组，最多 100000 项，且整个 HTTP JSON 仍受服务端请求体大小限制。
- 每项 `sku` 为 1–200 字符；`asin` 为 `null` 或 1–50 字符；`status` 只能是 `SUCCESS` / `FAILED`。
- 每项可选 `error_code` / `error_message` 字符串；失败项建议提供，成功项可省略。

## 8. 主动轮询规则

后端每 5 分钟查询到期的 `PUBLISHING` 任务，每次都是新的后端主动 `check_feed_status` 请求：

1. 用户点击刷新和后端定时轮询使用同一业务契约。
2. 每次查询在后端生成新的内部关联号，业务文件中 `task_id` 仍为空，`business_id`、`upload_id` 和冻结的 `skus` 保持不变。
3. 非终态继续保持 `PUBLISHING`。
4. 终态后后端停止查询。
5. 默认每 5 分钟一次，最多 288 次（约 24 小时）；超限后由后端标记超时。

RPA 无需连接前端。RPA 将结果回传本接口且后端事务落库成功后，后端会通过自己的 SSE 通道通知对应用户；这不改变 RPA 请求或结果字段。

## 9. 错误码建议

| code | 场景 |
| --- | --- |
| `INVALID_PARAMS_FILE` | 参数文件无法读取或 JSON 无效 |
| `UNSUPPORTED_TASK_TYPE` | `task_type` 不支持 |
| `STORE_NOT_FOUND` | Amazon 店铺不存在 |
| `CATEGORY_NOT_FOUND` | 分类无模板 |
| `FILE_DOWNLOAD_FAILED` | `file_url` 下载失败 |
| `AMAZON_SUBMIT_FAILED` | Amazon 提交失败 |
| `AMAZON_STATUS_FAILED` | Amazon 结果查询失败 |
| `BUSINESS_TIMEOUT` | 单次业务执行超时 |
| `INTERNAL_ERROR` | RPA 未分类内部错误 |

失败示例：

```json
{
  "contract_version": "1.0",
  "ok": false,
  "data": {
    "task_type": "upload_listing",
    "business_id": "27826971599669",
    "file_url": "https://files.example.com/product-publish/listing.xlsm"
  },
  "error": {
    "code": "AMAZON_SUBMIT_FAILED",
    "message": "Amazon 拒绝了上架文件",
    "details": { "amazon_code": "InvalidInput" }
  }
}
```

联调时必须先调度一次真实操作，再使用与该日志匹配的业务键模拟提交：

```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <YINGDAO_PRODUCT_PUBLISH_CALLBACK_API_KEY>' \
  -d '{
    "contract_version":"1.0",
    "ok":true,
    "data":{
      "task_type":"upload_listing",
      "business_id":"27826971599669",
      "file_url":"https://files.example.com/product-publish/listing.xlsm",
      "upload_id":"6b1ccdde-16f4-41e4-99d1-5d1ff273c02d"
    }
  }' \
  https://<API域名>/api/product-publish/internal/rpa/results
```

不得用随意 `business_id + file_url origin/pathname` 验收，因为后端会拒绝无法关联到已调度日志的结果。`request_id` 在此请求中可省略。

## 10. 安全与日志

- 影刀 accessKey Secret 只保存在后端环境变量，RPA 业务文件不包含密钥。
- 结果 API Key 只保存在后端和 RPA 安全配置中，不写入 Git、业务文件或明文日志。
- RPA 日志可记录 `task_type`、`business_id`、对应业务键、耗时和结果码，不记录完整密钥或短时签名参数。
- 上传文件和结果文件 URL 可包含签名查询参数，日志展示时去除 query/fragment。
- 后端将保存影刀 `taskUuid`/`jobUuidList`、业务键与可选 `request_id`，用于联调排障。查询结果日志只保存 `sku_asin_mapping` 的数量和 SHA-256 摘要，完整映射保存在业务任务中，避免大 JSON 在同一事务内重复写入。

`ProductPublishRpaLog.status` 的阶段是：

```text
DISPATCHING
  → WAITING_CALLBACK        # 影刀已确认接收，或启动请求结果未知但需等待可能到达的回调
  → FAILED                  # 文件上传/启动发生确定性失败，日志与业务锁在同一事务处理

WAITING_CALLBACK
  → PROCESSING_CALLBACK     # 结果已进入后端校验/落库
  → TIMEOUT                 # 超过本次日志 expiresAt（模板批量窗口见 §3.1）

PROCESSING_CALLBACK
  → SUCCESS | FAILED        # 业务结果与日志终态原子落库
  → WAITING_CALLBACK        # 落库失败或处理租约超时，释放后允许相同结果重试
  → TIMEOUT                 # 已超过总等待窗口且处理租约也已过期
```

`startTask` 成功只能将日志推进到 `WAITING_CALLBACK`，不得直接标记 `SUCCESS`。`dispatchedAt` 记录影刀接收时间，`callbackReceivedAt` 记录 RPA 结果到达时间，`expiresAt` 用于判断超时。

## 11. RPA 实现伪代码

```python
def main(params_file):
    requests = parse_utf8_json_array(params_file)
    for request in requests:
        for task in request["tasks_info"]:
            try:
                if task["task_type"] == "download_listing":
                    data = download_listing(request["business_id"], task["task_param"])
                elif task["task_type"] == "upload_listing":
                    data = upload_listing_once(request["business_id"], task["task_param"])
                elif task["task_type"] == "check_feed_status":
                    data = check_feed_status(request["business_id"], task["task_param"])
                else:
                    raise BusinessError("UNSUPPORTED_TASK_TYPE", "不支持的 task_type")

                result = {
                    "contract_version": "1.0",
                    "ok": True,
                    "data": data,
                }
            except BusinessError as error:
                result = {
                    "contract_version": "1.0",
                    "ok": False,
                    "data": business_routing_fields(request["business_id"], task),
                    "error": {
                        "code": error.code,
                        "message": error.message,
                    },
                }

            post_json(
                url=RESULT_API_URL + "/api/product-publish/internal/rpa/results",
                headers={"X-API-Key": RESULT_API_KEY},
                body=result,
            )
```

每个任务无论 Amazon 业务成功或失败，RPA 都必须单独执行结果 POST；回调网络失败应记录待重发结果，不能因此丢弃后续任务。`request_id` 可省略，后端按 `task_type` 对应业务键找回调度记录。输入 `task_id` 固定为空字符串，不承担关联职责。

## 12. 联调验收清单

- [ ] 已发布应用的文件入参名与 `YINGDAO_PRODUCT_PUBLISH_PARAM_NAME` 一致。
- [ ] 已发布应用声明 `profile` 字符串入参，并正确处理 `dev/dev1/uat/prod`。
- [ ] 能从 `fileKey` 读取 UTF-8 JSON 数组，遍历全部店铺及全部 `tasks_info`。
- [ ] 同批部分失败时其它任务继续执行，每个类目独立回调成功或失败，验证只补发失败类目。
- [ ] 能区分三种 `task_type`。
- [ ] `task_id` 和 `rpa_storage` 都固定为 `""`，不承担结果关联或地址职责。
- [ ] `startTask` 响应只用于记录 `taskUuid`/`jobUuidList`。
- [ ] 成功与失败结果都包含完整业务键；可选 `request_id` 只做交叉校验，不从 `task_id` 推导。
- [ ] 成功/失败都 POST 到 `/api/product-publish/internal/rpa/results`。
- [ ] `X-API-Key` 与后端配置一致，且不出现在业务日志。
- [ ] `download_listing` 返回永久公开 HTTPS 模板 URL。
- [ ] `upload_listing` 返回 Amazon 生成的 `upload_id`。
- [ ] 同一 `business_id + file_url origin/pathname` 重复到达不会再次向 Amazon 提交。
- [ ] `check_feed_status` 能读取 `task_param.skus`，只查询这些 SKU，并返回无重复、无额外 SKU 的 `sku_asin_mapping`。
- [ ] `check_feed_status` 所有状态、数量和 SKU-ASIN 字段通过真实数据验证。
- [ ] 业务结果不使用影刀调度 ID 代替 Amazon 业务 ID。


### 配置缺失错误不自动重试

失败补发扫描遇到当前 `lastSyncError` 或最新下载日志中包含「未查询到店铺」「传入密码为空」时，跳过该类目，不新建下载请求，不清空最近成功的模板 URL、成功时间或错误信息。页面仍可使用已保存模板；从未成功下载且没有模板 URL 的情况无法凭空恢复文件。普通登录失败、网络错误和超时仍按原重试策略处理。每日正常刷新与手工刷新保持可用，以便店铺或账号配置修复后重新获取模板。已经提交给 RPA 的运行中批次不受此跳过规则影响。


### 指定店铺取消模板下载

业务店铺 `27859233726983`（联昌）从模板下载派发中排除：每日刷新、失败自动重试、手工全量刷新均跳过，不再认领类目或创建下载日志。保留店铺、类目映射、历史模板及草稿；不修改飞书同步源，不使用会影响店铺选择的整店禁用开关。已经提交到影刀的批次不能通过此代码撤回，规则只影响版本上线后的新派发。
