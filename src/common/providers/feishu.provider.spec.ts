/* eslint-disable @typescript-eslint/unbound-method */
import { ConfigService } from "@nestjs/config"
import axios from "axios"
import { FeishuProvider } from "./feishu.provider"

jest.mock("axios")

const mockedAxios = jest.mocked(axios)

const COMPLETE_CONFIG: Record<string, string> = {
  FEISHU_APP_ID: "cli_test",
  FEISHU_APP_SECRET: "app-secret",
  FEISHU_BITABLE_APP_TOKEN: "bascn_test",
  FEISHU_BITABLE_TABLE_ID: "tbl_test",
  FEISHU_BITABLE_VIEW_ID: "vew_test",
  FEISHU_BASE_URL: "https://feishu.example.com/",
}

function createProvider(values: Record<string, string> = COMPLETE_CONFIG): FeishuProvider {
  const config = {
    get: jest.fn((key: string) => values[key]),
  }
  return new FeishuProvider(config as unknown as ConfigService)
}

function tokenResponse(token = "tenant-token") {
  return {
    data: {
      code: 0,
      msg: "success",
      tenant_access_token: token,
      expire: 7200,
    },
  }
}

function recordsResponse(
  items: unknown[],
  options: { hasMore?: boolean; pageToken?: string } = {}
) {
  return {
    data: {
      code: 0,
      msg: "success",
      data: {
        items,
        has_more: options.hasMore ?? false,
        page_token: options.pageToken,
      },
    },
  }
}

describe("FeishuProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("isConfigured", () => {
    it("所有必要配置存在时返回 true", () => {
      expect(createProvider().isConfigured()).toBe(true)
    })

    it("任一应用凭证缺失时返回 false", () => {
      expect(
        createProvider({
          ...COMPLETE_CONFIG,
          FEISHU_APP_SECRET: "",
        }).isConfigured()
      ).toBe(false)
    })

    it("未显式配置表格标识时使用需求指定的视图", () => {
      expect(
        createProvider({
          FEISHU_APP_ID: "cli_test",
          FEISHU_APP_SECRET: "app-secret",
        }).isConfigured()
      ).toBe(true)
    })
  })

  it("未配置时返回中文错误且不发请求", async () => {
    const provider = createProvider({})

    await expect(provider.searchStoreRecords()).rejects.toThrow(
      "飞书多维表格配置不完整，请检查应用凭证和表格配置"
    )
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it("按指定视图和字段分页读取记录", async () => {
    const provider = createProvider()
    mockedAxios.post
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        recordsResponse(
          [
            {
              record_id: "rec_1",
              fields: { 店铺ID: "27826971599669", 紫鸟店铺: "测试店铺" },
              last_modified_time: "1720000000000",
            },
          ],
          { hasMore: true, pageToken: "next-page" }
        )
      )
      .mockResolvedValueOnce(
        recordsResponse([
          {
            record_id: "rec_2",
            fields: { 店铺ID: "27826971599670" },
            last_modified_time: 1720000001000,
          },
        ])
      )

    await expect(provider.searchStoreRecords()).resolves.toEqual([
      {
        recordId: "rec_1",
        fields: { 店铺ID: "27826971599669", 紫鸟店铺: "测试店铺" },
        lastModifiedTime: 1720000000000,
      },
      {
        recordId: "rec_2",
        fields: { 店铺ID: "27826971599670" },
        lastModifiedTime: 1720000001000,
      },
    ])

    expect(mockedAxios.post).toHaveBeenNthCalledWith(
      1,
      "https://feishu.example.com/open-apis/auth/v3/tenant_access_token/internal",
      { app_id: "cli_test", app_secret: "app-secret" },
      expect.objectContaining({ timeout: 30_000 })
    )
    expect(mockedAxios.post).toHaveBeenNthCalledWith(
      2,
      "https://feishu.example.com/open-apis/bitable/v1/apps/bascn_test/tables/tbl_test/records/search",
      {
        view_id: "vew_test",
        field_names: [
          "UUID",
          "公司",
          "平台",
          "店铺类型",
          "账号类型",
          "紫鸟店铺",
          "店铺简称",
          "子店铺",
          "站点",
          "备注",
          "店铺ID",
          "是否禁用",
        ],
        automatic_fields: true,
      },
      expect.anything()
    )
    const firstSearchConfig: unknown = mockedAxios.post.mock.calls[1]?.[2]
    expect(firstSearchConfig).toEqual({
      params: { page_size: 500 },
      headers: {
        Authorization: "Bearer tenant-token",
        "Content-Type": "application/json; charset=utf-8",
      },
      timeout: 30_000,
    })
    expect(mockedAxios.post).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("/records/search"),
      expect.anything(),
      expect.objectContaining({
        params: {
          page_size: 500,
          page_token: "next-page",
        },
      })
    )
  })

  it("在 token 有效期内复用缓存", async () => {
    const provider = createProvider()
    mockedAxios.post
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(recordsResponse([]))
      .mockResolvedValueOnce(recordsResponse([]))

    await provider.searchStoreRecords()
    await provider.searchStoreRecords()

    const tokenCalls = mockedAxios.post.mock.calls.filter(call =>
      String(call[0]).includes("tenant_access_token/internal")
    )
    expect(tokenCalls).toHaveLength(1)
  })

  it("记录请求返回 401 时强制刷新 token 并重试一次", async () => {
    const provider = createProvider()
    mockedAxios.post
      .mockResolvedValueOnce(tokenResponse("expired-token"))
      .mockRejectedValueOnce({ response: { status: 401, data: { msg: "token expired" } } })
      .mockResolvedValueOnce(tokenResponse("fresh-token"))
      .mockResolvedValueOnce(recordsResponse([{ record_id: "rec_1", fields: { 店铺ID: "1" } }]))

    await expect(provider.searchStoreRecords()).resolves.toEqual([
      { recordId: "rec_1", fields: { 店铺ID: "1" } },
    ])

    expect(mockedAxios.post).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("/records/search"),
      expect.anything(),
      expect.anything()
    )
    const retriedSearchConfig: unknown = mockedAxios.post.mock.calls[3]?.[2]
    expect(retriedSearchConfig).toEqual(
      expect.objectContaining({
        headers: {
          Authorization: "Bearer fresh-token",
          "Content-Type": "application/json; charset=utf-8",
        },
      })
    )
  })

  it("非 401 请求错误不重试并返回中文错误", async () => {
    const provider = createProvider()
    mockedAxios.post
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce({ response: { status: 500, data: { msg: "upstream error" } } })

    await expect(provider.searchStoreRecords()).rejects.toThrow(
      "读取飞书店铺数据失败：upstream error"
    )
    expect(mockedAxios.post).toHaveBeenCalledTimes(2)
  })

  it("飞书业务响应失败时返回中文上下文", async () => {
    const provider = createProvider()
    mockedAxios.post.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce({
      data: { code: 1254001, msg: "WrongRequestBody" },
    })

    await expect(provider.searchStoreRecords()).rejects.toThrow(
      "读取飞书店铺数据失败：飞书多维表格查询失败：WrongRequestBody"
    )
  })

  it("鉴权失败时不暴露凭证并返回中文上下文", async () => {
    const provider = createProvider()
    mockedAxios.post.mockResolvedValueOnce({
      data: { code: 10003, msg: "凭证无效" },
    })

    await expect(provider.searchStoreRecords()).rejects.toThrow(
      "读取飞书店铺数据失败：飞书鉴权失败：凭证无效"
    )
    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
  })

  describe("独立组织的订单同步", () => {
    const billingConfig = {
      FEISHU_BILLING_APP_ID: "cli_billing",
      FEISHU_BILLING_APP_SECRET: "billing-secret",
      FEISHU_BILLING_APP_TOKEN: "billing-base",
      FEISHU_BILLING_TABLE_ID: "billing-table",
    }
    const orderNo = "SR20261102001"
    const fields = { 订单号: orderNo, 订单金额_人民币元: 100 }
    const existing = recordsResponse([{ record_id: "rec_order", fields: { 订单号: orderNo } }])
    const created = {
      data: { code: 0, data: { record: { record_id: "rec_order", fields } } },
    }

    beforeEach(() => jest.resetAllMocks())

    it("旧组织已配置也不能启用订单同步；订单配置缺项时不请求飞书", async () => {
      expect(createProvider().isBillingConfigured()).toBe(false)
      for (const key of Object.keys(billingConfig)) {
        const provider = createProvider({ ...COMPLETE_CONFIG, ...billingConfig, [key]: "" })
        expect(provider.isBillingConfigured()).toBe(false)
        await expect(provider.syncBillingOrder(orderNo, fields)).rejects.toThrow("配置不完整")
      }
      expect(mockedAxios.post).not.toHaveBeenCalled()
    })

    it("目标订单已存在就跳过新增，查重不受视图筛选影响", async () => {
      const provider = createProvider(billingConfig)
      mockedAxios.post.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(existing)
      await expect(provider.syncBillingOrder(orderNo, fields)).resolves.toBe("rec_order")
      expect(mockedAxios.post).toHaveBeenCalledTimes(2)
      expect(mockedAxios.post).toHaveBeenLastCalledWith(
        "https://open.feishu.cn/open-apis/bitable/v1/apps/billing-base/tables/billing-table/records/search",
        {
          field_names: ["订单号"],
          filter: {
            conjunction: "and",
            conditions: [{ field_name: "订单号", operator: "is", value: [orderNo] }],
          },
        },
        expect.objectContaining({ params: { page_size: 1 } })
      )
    })

    it("超时重试保留相同的 UUIDv4 格式幂等键和数据", async () => {
      const provider = createProvider(billingConfig)
      mockedAxios.post
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(recordsResponse([]))
        .mockRejectedValueOnce(new Error("请求超时"))
        .mockResolvedValueOnce(recordsResponse([]))
        .mockResolvedValueOnce(created)
      await expect(provider.syncBillingOrder(orderNo, fields)).rejects.toThrow("请求超时")
      await expect(provider.syncBillingOrder(orderNo, fields)).resolves.toBe("rec_order")
      const creates = mockedAxios.post.mock.calls.filter(call =>
        String(call[0]).endsWith("/records")
      )
      expect(creates).toHaveLength(2)
      const firstOptions = creates[0][2] as { params: { client_token: string } }
      expect(firstOptions.params.client_token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      )
      expect(creates[1][2]).toEqual(creates[0][2])
      expect(creates[1][1]).toEqual({ fields })
    })

    it("写入已成功但响应丢失时，下一次查到订单后不再新增", async () => {
      const provider = createProvider(billingConfig)
      mockedAxios.post
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(recordsResponse([]))
        .mockRejectedValueOnce(new Error("响应丢失"))
        .mockResolvedValueOnce(existing)
      await expect(provider.syncBillingOrder(orderNo, fields)).rejects.toThrow("响应丢失")
      await expect(provider.syncBillingOrder(orderNo, fields)).resolves.toBe("rec_order")
      expect(
        mockedAxios.post.mock.calls.filter(call => String(call[0]).endsWith("/records"))
      ).toHaveLength(1)
    })

    it("店铺和订单使用各自应用凭证及 token 缓存", async () => {
      const provider = createProvider({ ...COMPLETE_CONFIG, ...billingConfig })
      mockedAxios.post
        .mockResolvedValueOnce(tokenResponse("store-token"))
        .mockResolvedValueOnce(recordsResponse([]))
        .mockResolvedValueOnce(tokenResponse("billing-token"))
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(recordsResponse([]))
        .mockResolvedValueOnce(existing)
      await provider.searchStoreRecords()
      await provider.syncBillingOrder(orderNo, fields)
      await provider.searchStoreRecords()
      await provider.syncBillingOrder(orderNo, fields)
      expect(mockedAxios.post).toHaveBeenNthCalledWith(
        3,
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        { app_id: "cli_billing", app_secret: "billing-secret" },
        expect.anything()
      )
      expect(mockedAxios.post.mock.calls[4][2]?.headers).toMatchObject({
        Authorization: "Bearer store-token",
      })
      expect(mockedAxios.post.mock.calls[5][2]?.headers).toMatchObject({
        Authorization: "Bearer billing-token",
      })
    })

    it("查询失败不能当作不存在新增，业务错误后重试会重新鉴权", async () => {
      const provider = createProvider(billingConfig)
      mockedAxios.post
        .mockResolvedValueOnce(tokenResponse("expired"))
        .mockResolvedValueOnce({ data: { code: 99991663, msg: "token expired" } })
        .mockResolvedValueOnce(tokenResponse("fresh"))
        .mockResolvedValueOnce(existing)
      await expect(provider.syncBillingOrder(orderNo, fields)).rejects.toThrow("token expired")
      await expect(provider.syncBillingOrder(orderNo, fields)).resolves.toBe("rec_order")
      expect(
        mockedAxios.post.mock.calls.filter(call => String(call[0]).endsWith("/records"))
      ).toHaveLength(0)
      expect(mockedAxios.post.mock.calls[3][2]?.headers).toMatchObject({
        Authorization: "Bearer fresh",
      })
    })
  })
})
