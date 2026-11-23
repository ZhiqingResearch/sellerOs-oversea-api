import { BadRequestException, ConflictException } from "@nestjs/common"
import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { documentUrl, isPublicDocumentAddress } from "./automotive-document-download"
import { AutomotiveDataDto, MatchCategoryDto } from "./automotive.dto"
import { categoryPrompt } from "./automotive.prompts"
import {
  finalizeAutomotive,
  mergeAutomotiveCandidates,
  normalizeAutomotiveData,
  stableHash,
} from "./automotive.rules"
import { AutomotiveService } from "./automotive.service"
import { type AutomotiveSource } from "./automotive.types"

const confirmed = normalizeAutomotiveData({
  brand: "A-Premium",
  product: "Front Brake Pads",
  fitments: [{ make: "Hyundai", model: "Tucson", years: [2016, 2017], details: "" }],
  oeNumbers: ["58101-D3A10"],
  packageContents: [{ name: "Brake Pads", quantity: 4 }],
})
const body = () => ({
  title: "A-Premium Front Brake Pads Fit for Hyundai Tucson 2016-2017",
  itemHighlights: [
    "Hyundai Tucson 2016-2017",
    "OE 58101-D3A10",
    "Brake Pads x 4",
    "Front Position",
  ],
  bullets: [
    "VEHICLE FITMENT: Hyundai Tucson 2016-2017.",
    "OEM PART NUMBER: 58101-D3A10.",
    "WHAT YOU GET: Brake pads x 4.",
    "POSITION: Front.",
    "NOTE: Verify original part number.",
  ],
  searchTerms: ["brake", "pads", "58101-D3A10", "58101D3A10", "2016", "2017"],
  description: "<b>VEHICLE FITMENT:</b><br>Hyundai Tucson",
  titleDropped: ["oe"],
})

function fixture() {
  const data: any = { params: {}, plans: [] }
  const record: any = { id: 1, version: 1, data, listingRun: { id: 2 } }
  const snapshots: any = {}
  const prisma: any = {
    history: {
      findFirst: jest
        .fn()
        .mockImplementation(() => ({ ...record, data: { ...data, ...snapshots } })),
    },
    listingRun: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: 2 }) },
    listingAiStep: {
      create: jest.fn().mockResolvedValue({ id: 3 }),
      update: jest.fn().mockResolvedValue({}),
    },
    listingGenerationTask: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  }
  const runs: any = { create: jest.fn().mockResolvedValue({}) }
  const documents: any = {
    readAutomotive: jest.fn().mockResolvedValue({
      source: {
        sourceId: "document-1",
        type: "DOCUMENT",
        status: "SUCCEEDED",
        name: "spec.pdf",
        content: "DOC_EVIDENCE 原厂号",
      },
      cleanupKey: "private-file",
    }),
    cleanupAutomotive: jest.fn(),
  }
  const gateway: any = {
    generateJson: jest.fn().mockResolvedValue({
      data: {
        category: "Automotive Parts & Accessories",
        classification: { decision: "AUTOMOTIVE", reason: "专用零件", categoryKey: "braking" },
      },
      model: "ZQ-Think-Flash",
      requestId: "r",
      tokenUsage: { promptTokens: 10, completionTokens: 5, thinkingTokens: 0 },
    }),
  }
  const generations: any = {
    submit: jest.fn().mockResolvedValue({ runId: "run", attemptId: "attempt" }),
  }
  const models: any = { assertAllowed: jest.fn() }
  const service = new AutomotiveService(prisma, runs, documents, gateway, generations, models)
  jest.spyOn(service as any, "stage").mockImplementation(async (...args: any[]) => {
    const [, , key, inputHash, value] = args
    if (!value && snapshots[key]) {
      if (snapshots[key].inputHash !== inputHash) throw new ConflictException()
      return { snapshot: snapshots[key], claimed: false }
    }
    snapshots[key] = { ...snapshots[key], inputHash, ...(value || { status: "RUNNING" }) }
    return { snapshot: snapshots[key], claimed: !value }
  })
  return { service, prisma, runs, documents, gateway, generations, models, snapshots }
}

describe("汽配分类和字段提取边界", () => {
  it("分析资料超过4MB时在请求模型之前拒绝", async () => {
    const f = fixture()
    await expect(
      f.service.match(7, {
        runId: "run",
        market: "amazon_us",
        keyword: "A".repeat(4 * 1024 * 1024),
      })
    ).rejects.toThrow("产品资料超过4MB")
    expect(f.gateway.generateJson).not.toHaveBeenCalled()
  })
  it("关键词原调用兼容，分类只发送描述/标题/文档正文，重放不重复模型或解析", async () => {
    const f = fixture()
    const input = {
      runId: "run",
      market: "amazon_us",
      keyword: "完整文字 USER_EVIDENCE",
      productTitle: "Brake pads TITLE_EVIDENCE",
      documentUrl: "https://example.com/spec.pdf",
    }
    const result = await f.service.match(7, input)
    expect(result).toMatchObject({
      category: "Automotive Parts & Accessories",
      matchStatus: "READY",
      tokenUsage: { totalTokens: 15 },
    })
    const prompt = f.gateway.generateJson.mock.calls[0][1]
    for (const evidence of ["USER_EVIDENCE", "TITLE_EVIDENCE", "DOC_EVIDENCE"])
      expect(prompt).toContain(evidence)
    expect(prompt).not.toContain("https://example.com/spec.pdf")
    expect(f.gateway.generateJson.mock.calls[0][2]).toMatchObject({ maxAttempts: 1 })
    expect(f.snapshots.categoryMatch).not.toHaveProperty("productDetail")
    await f.service.match(7, input)
    expect(f.documents.readAutomotive).toHaveBeenCalledTimes(1)
    expect(f.gateway.generateJson).toHaveBeenCalledTimes(1)
  })
  it("分类DTO拒绝完整商品对象，文档只允许URL", async () => {
    const errors = await validate(
      plainToInstance(MatchCategoryDto, {
        market: "amazon_us",
        keyword: "pads",
        productDetail: { data: { secret: "SHOULD_NOT_CLASSIFY" } },
        document: { content: "hidden" },
      }),
      { whitelist: true, forbidNonWhitelisted: true }
    )
    expect(errors.map(e => e.property)).toEqual(
      expect.arrayContaining(["productDetail", "document"])
    )
  })
  it("后续提取使用完整商品数据，不重新分类、下载文档或调用商品提取", async () => {
    const f = fixture()
    await f.service.match(7, {
      runId: "run",
      market: "amazon_us",
      productTitle: "Pads",
      documentUrl: "https://example.com/spec.pdf",
    })
    f.gateway.generateJson.mockResolvedValue({
      data: { candidates: [{ sourceId: "product-1", data: confirmed }], warnings: [] },
      tokenUsage: { promptTokens: 5, completionTokens: 5, thinkingTokens: 0 },
    })
    const request = {
      runId: "run",
      productDetail: {
        url: "https://www.amazon.com/dp/B012345678",
        name: "Pads",
        data: {
          title: "Pads",
          description: "FULL_DETAIL_SENT_ONLY_HERE",
          product_information: [["OE", "58101-D3A10"]],
        },
      },
    }
    const prepared = await f.service.prepare(7, request)
    expect(prepared.preparationStatus).toBe("READY")
    expect(f.gateway.generateJson.mock.calls[0][1]).not.toContain("FULL_DETAIL_SENT_ONLY_HERE")
    expect(f.gateway.generateJson.mock.calls[1][1]).toContain("FULL_DETAIL_SENT_ONLY_HERE")
    expect(f.gateway.generateJson.mock.calls[1][1]).toContain("DOC_EVIDENCE")
    expect(f.documents.readAutomotive).toHaveBeenCalledTimes(1)
    await f.service.prepare(7, request)
    expect(f.gateway.generateJson).toHaveBeenCalledTimes(2)
    await expect(
      f.service.prepare(7, {
        ...request,
        productDetail: { ...request.productDetail, name: "changed", data: { title: "changed" } },
      })
    ).rejects.toThrow(ConflictException)
  })
  it("手选汽配可直接提取，不做类目调用；缺品牌不会补造", async () => {
    const f = fixture()
    f.gateway.generateJson.mockResolvedValue({
      data: { candidates: [{ sourceId: "text-1", data: { product: "刹车片" } }], warnings: [] },
      tokenUsage: { promptTokens: 5, completionTokens: 5, thinkingTokens: 0 },
    })
    const result = await f.service.prepare(7, {
      runId: "run",
      market: "amazon_us",
      text: "刹车片",
      category: { source: "USER", userSelectedAutomotive: true },
    })
    expect((result.classification as { basis: string }).basis).toBe("USER")
    expect(result.missingFields).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "brand" })])
    )
    expect(f.gateway.generateJson).toHaveBeenCalledTimes(1)
    expect(f.gateway.generateJson.mock.calls[0][0]).not.toBe(categoryPrompt("amazon_us"))
  })
  it("缺完整商品数据报错，不能拿分类标题代替；未明确选择不能调用生成", async () => {
    const f = fixture()
    await f.service.match(7, { runId: "run", market: "amazon_us", productTitle: "Pads" })
    await expect(f.service.prepare(7, { runId: "run" })).rejects.toThrow(BadRequestException)
    expect(f.gateway.generateJson).toHaveBeenCalledTimes(1)
  })
})

describe("汽配输出长度整理", () => {
  it("标题超长先完整省略OE，保留品牌和车型，不截断事实", () => {
    const raw = body()
    raw.title = "A-Premium Front Ceramic Brake Pads Fit for Hyundai Tucson 2016-2017 58101-D3A10"
    const result = finalizeAutomotive(JSON.stringify(raw), confirmed, "amazon_us")
    expect(result.title).toBe("A-Premium Front Ceramic Brake Pads Fit for Hyundai Tucson 2016-2017")
    expect(result.titleDropped).toContain("oe")
    expect(result.structuredAttributes[0].value).toContain("58101-D3A10")
    expect(result.checks.find(c => c.item === "标题≤75字符")?.status).toBe("PASS")
  })

  it("本次敏感词只产生规则提示，不修改原OE或写入词库", () => {
    const result = finalizeAutomotive(JSON.stringify(body()), confirmed, "amazon_us", [
      "58101-D3A10",
    ])
    expect(result.checks.find(c => c.item === "自定义敏感词")?.status).toBe("WARN")
    expect(result.structuredAttributes[0].value).toBe("58101-D3A10")
  })
})

describe("汽配纯规则与下载边界", () => {
  it("来源按文字优先且不混合不同套装/OE", () => {
    const sources = [
      { sourceId: "text-1", status: "SUCCEEDED" },
      { sourceId: "product-1", status: "SUCCEEDED" },
    ] as AutomotiveSource[]
    const result = mergeAutomotiveCandidates(
      [
        {
          sourceId: "product-1",
          data: { oeNumbers: ["222"], packageContents: [{ name: "Pads", quantity: 8 }] },
        },
        {
          sourceId: "text-1",
          data: { oeNumbers: ["111"], packageContents: [{ name: "Pads", quantity: 4 }] },
        },
      ],
      sources
    )
    expect(result.automotiveData.oeNumbers).toEqual(["111"])
    expect(result.automotiveData.packageContents[0].quantity).toBe(4)
    expect(result.conflicts).toHaveLength(2)
  })
  it("自检重算字节，保留重复车型亮点；参数及描述使用确认资料", () => {
    const result = finalizeAutomotive(JSON.stringify(body()), confirmed, "amazon_us")
    expect(result.checks.filter(c => c.status === "FAIL")).toEqual([])
    expect(result.itemHighlights[0]).toContain("Hyundai Tucson")
    expect(result.description).toContain("2016, 2017")
    expect(result.structuredAttributes).toContainEqual({
      name: "Included Components",
      value: "Brake Pads x 4",
    })
    const long = body()
    long.searchTerms.push("é".repeat(300))
    const fitted = finalizeAutomotive(JSON.stringify(long), confirmed, "amazon_us")
    expect(fitted.searchTermsBytes).toBeLessThanOrEqual(249)
    expect(fitted.notes.join()).toContain("省略")
  })
  it("注入HTML、超过75标题、缺五点和超出年份均不能按完整结果结算", () => {
    const raw = body()
    raw.title += " more".repeat(20)
    raw.description = '<img src=x onerror="alert(1)">'
    raw.bullets = ["Fits Tucson 2025"]
    expect(
      finalizeAutomotive(JSON.stringify(raw), confirmed, "amazon_us").checks.filter(
        c => c.status === "FAIL"
      ).length
    ).toBeGreaterThanOrEqual(4)
  })
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "198.18.0.98",
    "192.168.1.2",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2001:db8::1",
  ])("拒绝文档私有/保留地址 %s", address => expect(isPublicDocumentAddress(address)).toBe(false))
  it("允许公网地址，禁止URL凭证和非HTTP协议", () => {
    expect(isPublicDocumentAddress("8.8.8.8")).toBe(true)
    expect(() => documentUrl("https://user:password@example.com/a.pdf")).toThrow()
    expect(() => documentUrl("file:///etc/passwd")).toThrow()
    expect(stableHash({ b: 2, a: 1 })).toBe(stableHash({ a: 1, b: 2 }))
  })
  it("DTO缺必填数组或包装数量非法不能提交", async () => {
    const errors = await validate(
      plainToInstance(AutomotiveDataDto, {
        ...confirmed,
        oeNumbers: [],
        packageContents: [{ name: "Pads", quantity: 0 }],
      })
    )
    expect(errors.map(e => e.property)).toEqual(
      expect.arrayContaining(["oeNumbers", "packageContents"])
    )
  })
})
