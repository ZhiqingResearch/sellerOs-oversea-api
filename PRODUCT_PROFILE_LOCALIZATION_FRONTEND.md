# 商品资料多语言前端对接文档

## 适用范围

图片创作 / 电商创作的产品资料配置。接口路径和请求方法保持不变：

```http
GET   /api/image-project/:projectId/product-profile
PATCH /api/image-project/:projectId/product-profile
Authorization: Bearer <token>
```

后端新增 `sourceLocale`、`defaultLocale` 和 `localizations`，用于同时保存抓取原文和翻译版本。原有顶层字段继续保留，现有页面可以渐进接入。

## 数据结构

```ts
interface ProductProfileLocalizationContent {
  productName?: string
  categoryL1?: string
  categoryL2?: string
  categoryL3?: string
  attributes?: Array<{ key: string; value: string }>
  sellingPoints?: string[]
  certifications?: string[]
  audience?: {
    portrait?: string
    ageRange?: string
    consumptionTier?: string
  }
  extra?: string
}

interface ProductProfileLocalization {
  id: number | null
  productProfileId: number
  locale: string
  content: ProductProfileLocalizationContent
  translatedFrom: string | null
  translatedAt: string | null
  createdAt: string
  updatedAt: string
  isLegacy: boolean
}

interface ProductProfile {
  id: number
  projectId: number
  sourceLocale: string | null
  defaultLocale: string

  // 默认语言的兼容字段，现有生图和 Prompt 流程继续读取这些字段
  productName: string | null
  sku: string | null
  brandName: string | null
  categoryL1: string | null
  categoryL2: string | null
  categoryL3: string | null
  targetCountries: string[] | null
  ecommercePlatforms: string[] | null
  commerce: Record<string, unknown> | null
  attributes: Array<{ key: string; value: string }> | null
  sellingPoints: string[] | null
  certifications: string[] | null
  audience: Record<string, unknown> | null
  extra: string | null
  manualPdfUrl: string | null
  sourceUrl: string | null

  localizations: ProductProfileLocalization[]
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}
```

语言使用 BCP 47 标识，例如：

- 中文：`zh-CN`
- 俄文：`ru-RU`
- 英文：`en-US`
- 日文：`ja-JP`

后端会统一语言标识大小写，例如 `ru-ru` 会保存为 `ru-RU`。

## 字段职责

以下字段需要按语言保存，放在 `localizations[].content` 中：

- `productName`
- `categoryL1` / `categoryL2` / `categoryL3`
- `attributes`
- `sellingPoints`
- `certifications`
- `audience`
- `extra`

以下字段与语言无关，继续放在请求顶层：

- `sku`
- `brandName`
- `targetCountries`
- `ecommercePlatforms`
- `commerce`
- `manualPdfUrl`
- `sourceUrl`

顶层的可翻译字段始终代表 `defaultLocale` 对应版本。新前端提交 `localizations` 后，不需要再手动复制一份中文到顶层，后端会自动同步。

## GET 查询

```http
GET /api/image-project/42/product-profile
```

示例响应：

```json
{
  "id": 12,
  "projectId": 42,
  "sourceLocale": "ru-RU",
  "defaultLocale": "zh-CN",
  "productName": "不锈钢保温杯",
  "sku": "SKU-001",
  "localizations": [
    {
      "id": 31,
      "productProfileId": 12,
      "locale": "ru-RU",
      "content": {
        "productName": "Термокружка из нержавеющей стали",
        "sellingPoints": ["Сохраняет тепло 12 часов"]
      },
      "translatedFrom": null,
      "translatedAt": null,
      "createdAt": "2026-07-14T08:00:00.000Z",
      "updatedAt": "2026-07-14T08:00:00.000Z",
      "isLegacy": false
    },
    {
      "id": 32,
      "productProfileId": 12,
      "locale": "zh-CN",
      "content": {
        "productName": "不锈钢保温杯",
        "sellingPoints": ["保温 12 小时"]
      },
      "translatedFrom": "ru-RU",
      "translatedAt": "2026-07-14T08:05:00.000Z",
      "createdAt": "2026-07-14T08:05:00.000Z",
      "updatedAt": "2026-07-14T08:05:00.000Z",
      "isLegacy": false
    }
  ]
}
```

### 旧数据兼容

旧记录没有真实多语言行时，后端会根据原有顶层字段生成一个只读兼容版本：

```json
{
  "localizations": [
    {
      "id": null,
      "locale": "zh-CN",
      "content": {
        "productName": "旧商品名称"
      },
      "isLegacy": true
    }
  ]
}
```

前端可以正常展示该记录。用户下一次保存后，后端会自动创建真实语言版本，无需前端执行迁移。

## 场景一：首次导入俄文商品

抓取完成后，将语言无关字段放在顶层，将俄文内容放入 `localizations`：

```http
PATCH /api/image-project/42/product-profile
Content-Type: application/json
```

```json
{
  "sourceLocale": "ru-RU",
  "sourceUrl": "https://example.ru/product/1001",
  "sku": "SKU-001",
  "brandName": "Example Brand",
  "commerce": {
    "price": "1990 ₽",
    "rating": 4.8,
    "reviewCount": "28956",
    "sourcePlatform": "ozon"
  },
  "localizations": [
    {
      "locale": "ru-RU",
      "content": {
        "productName": "Термокружка из нержавеющей стали",
        "categoryL1": "Дом и кухня",
        "attributes": [
          { "key": "Материал", "value": "Нержавеющая сталь" },
          { "key": "Объем", "value": "500 мл" }
        ],
        "sellingPoints": ["Сохраняет тепло 12 часов"]
      }
    }
  ]
}
```

新建资料且未传 `defaultLocale` 时，后端会自动使用 `sourceLocale`，因此翻译前默认展示俄文。

## 场景二：用户点击翻译为中文

前端完成翻译后，只提交中文版本，并将中文设为默认语言：

```json
{
  "defaultLocale": "zh-CN",
  "localizations": [
    {
      "locale": "zh-CN",
      "translatedFrom": "ru-RU",
      "content": {
        "productName": "不锈钢保温杯",
        "categoryL1": "家居与厨房",
        "attributes": [
          { "key": "材质", "value": "不锈钢" },
          { "key": "容量", "value": "500 毫升" }
        ],
        "sellingPoints": ["保温 12 小时"]
      }
    }
  ]
}
```

后端将执行以下操作：

1. 保留原来的 `ru-RU` 内容。
2. 新增或更新 `zh-CN` 内容。
3. 将 `zh-CN` 内容同步到顶层兼容字段。
4. 记录 `translatedFrom=ru-RU` 和翻译时间。

## 场景三：编辑某个语言版本

语言内容采用增量合并。只修改中文商品名时，可以只传：

```json
{
  "localizations": [
    {
      "locale": "zh-CN",
      "content": {
        "productName": "便携不锈钢保温杯"
      }
    }
  ]
}
```

未传入的中文字段和其他语言版本保持不变。数组和对象字段以整个字段为单位替换，例如修改 `sellingPoints` 时应提交完整数组。

## 场景四：切换默认语言

目标语言必须已经存在，或者在同一次请求的 `localizations` 中提交：

```json
{
  "defaultLocale": "ru-RU"
}
```

切换成功后，顶层可翻译字段同步为俄文。目标语言不存在时返回 `400`：

```json
{
  "statusCode": 400,
  "message": "默认语言对应的商品资料不存在"
}
```

## 一次提交多个语言

`localizations` 是通用数组，以后新增英文、日文等语言无需增加接口：

```json
{
  "localizations": [
    {
      "locale": "en-US",
      "translatedFrom": "ru-RU",
      "content": {
        "productName": "Stainless Steel Travel Mug"
      }
    },
    {
      "locale": "ja-JP",
      "translatedFrom": "ru-RU",
      "content": {
        "productName": "ステンレス製タンブラー"
      }
    }
  ]
}
```

单次请求最多提交 20 个语言版本。

## 旧前端行为

旧前端可以继续只提交顶层字段：

```json
{
  "productName": "不锈钢保温杯",
  "sellingPoints": ["保温 12 小时"]
}
```

后端会把这些字段写入当前 `defaultLocale` 对应的语言版本。新前端接入后，建议所有可翻译字段统一写入 `localizations[].content`。

## 前端展示建议

1. 当前编辑语言优先使用 `defaultLocale`。
2. 语言切换器的数据源使用 `localizations.map(item => item.locale)`。
3. 表单值使用当前语言记录的 `content`。
4. 价格、评分、SKU、品牌和图片始终读取顶层字段。
5. 翻译按钮以当前语言为 `translatedFrom`，生成目标语言的 `content`。
6. 保存后使用接口返回值刷新本地状态，不在前端自行拼接服务端记录。

## 数据库同步

本项目使用 Prisma `db push`，部署或本地更新后执行：

```bash
npx prisma db push
```

Docker 部署会在容器启动时自动执行该命令。
