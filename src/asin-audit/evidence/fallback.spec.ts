import { ConfigService } from "@nestjs/config"
import { normalizeAuditEvidence } from "../rules/normalize-evidence"
import { computeBsrTrendPrecompute } from "../rules/traffic-precompute"
import { buildTrafficSuggestionsFromPrecompute } from "../rules/traffic-suggestions"
import { adaptAsinPerformanceE } from "./adapters"
import { EvidenceService, type EvidenceSseEvent } from "./evidence.service"
import { __memoizeTesting, memoizeByKey } from "./memoize"
import { SifApiError, SifClient } from "./sif.client"
import { adaptXiyouD, xiyouBsrSeries } from "./xiyou-adapters"
import { XiyouApiError, XiyouClient, finiteNumber } from "./xiyou.client"

const asin = "B0FKT9TSP6"
const keyword = {
  asin,
  keyword: "laptop",
  totalScore: 100,
  naturalScore: 30,
  adScore: 70,
  searchVolume: 1000,
}
const xyRow = {
  searchTerm: "laptop",
  trafficSummary: { traffic: { total: 80, organic: 30, advertising: 50 } },
}
const failure = (kind: "service" | "response" | "transport" | "input" | "auth" = "service") =>
  new SifApiError(-1, "private error", kind)

function setup(primarySource?: string) {
  const sif = {
    getLastDataTime: jest.fn().mockResolvedValue({ list: [] }),
    asinKeywordsMonthly: jest.fn().mockResolvedValue({ list: [keyword] }),
    batchKeywordOverview: jest.fn().mockResolvedValue([]),
    batchAsinDetail: jest.fn().mockResolvedValue({ list: [] }),
    variantLastSales: jest.fn().mockResolvedValue([
      { asin: "B0OTHER000", boughtInPastMonth: 0 },
      { asin, boughtInPastMonth: 50 },
    ]),
    batchAsinPrice: jest.fn().mockResolvedValue({ list: [{ asin, currentPrice: 295.55 }] }),
    asinOpTrafficTrend: jest.fn().mockResolvedValue({ dates: [], bsr: [] }),
  }
  const xiyou = {
    keywords: jest.fn().mockResolvedValue({ list: [xyRow], total: 1 }),
    market: jest.fn().mockResolvedValue({
      list: [{ searchTerm: "laptop", abaReport: { weeklySearchVolume: 500, topAsins: [] } }],
    }),
    info: jest.fn().mockResolvedValue({
      entities: [{ asin, price: "288.88", amzCategoryTree: { path: [{ categoryId: "541966" }] } }],
    }),
    orders: jest.fn().mockResolvedValue({
      entities: [
        { asin: "B0OTHER000", orders: 0 },
        { asin, orders: 50 },
      ],
    }),
    prices: jest.fn().mockResolvedValue({
      trends: [{ date: "2026-10-28", priceDistribution: { display: "251.10", coupon: [] } }],
    }),
    bsr: jest.fn().mockResolvedValue({ categoryTree: [], trends: [] }),
  }
  const mcp = { callAsinCompetitor: jest.fn().mockResolvedValue({ items: [] }) }
  const audit = { findDetail: jest.fn().mockRejectedValue(new Error("offline")) }
  const billing = { assertFixedStageAffordable: jest.fn(), chargeFixedStage: jest.fn() }
  const config = {
    get: jest.fn((key: string) =>
      key === "ASIN_EVIDENCE_PRIMARY_SOURCE" ? primarySource : undefined
    ),
  }
  const service = new EvidenceService(
    sif as never,
    mcp as never,
    audit as never,
    billing as never,
    {} as never,
    {} as never,
    xiyou as never,
    config as never
  )
  const run = async (scene?: "audit" | "evidence-module", signal?: AbortSignal) => {
    const events: EvidenceSseEvent[] = []
    const dto = { asin, model: "test", scene }
    await service.run(dto, service.resolve(dto), 7, event => events.push(event), signal)
    return (
      events.find(event => event.type === "done") as Extract<EvidenceSseEvent, { type: "done" }>
    ).result
  }
  return { sif, xiyou, mcp, service, run, billing, config }
}

describe("SIF primary / Xiyou fallback", () => {
  beforeEach(() => {
    __memoizeTesting.reset()
  })
  it.each([undefined, "audit", "evidence-module"] as const)(
    "SIF success has zero Xiyou calls, scene=%s",
    async scene => {
      const { run, xiyou } = setup()
      const result = await run(scene)
      expect(result.D.group?.source).toBe("sif")
      for (const fn of Object.values(xiyou)) expect(fn).not.toHaveBeenCalled()
      expect(result.E.boughtInPastMonth).toBe(50)
    }
  )
  it.each([
    new SifApiError(-22, "rate"),
    failure("transport"),
    failure("service"),
    failure("response"),
  ])("only failing D group falls back: %s", async error => {
    const { sif, run, xiyou } = setup()
    sif.asinKeywordsMonthly.mockRejectedValueOnce(error)
    const result = await run()
    expect(result.D.group).toMatchObject({
      source: "xiyou",
      status: "success",
      fallbackAttempted: true,
    })
    expect(xiyou.keywords).toHaveBeenCalledTimes(1)
    expect(sif.variantLastSales).toHaveBeenCalledTimes(1)
    expect(result.E.groups?.orders?.source).toBe("sif")
  })
  it.each([new SifApiError(-20, "quota"), new SifApiError(-25, "quota"), failure("auth")])(
    "account failure skips later outgoing SIF calls: %s",
    async error => {
      const { sif, run, xiyou } = setup()
      sif.getLastDataTime.mockRejectedValueOnce(error)
      const result = await run()
      expect(sif.asinKeywordsMonthly).not.toHaveBeenCalled()
      expect(sif.variantLastSales).not.toHaveBeenCalled()
      expect(xiyou.orders).toHaveBeenCalledTimes(1)
      expect(result.E.ordersLast30Days).toBe(50)
      expect(result.E.boughtInPastMonth).toBeNull()
    }
  )
  it("ordinary readiness failure and false readiness do not trigger fallback", async () => {
    const { sif, run, xiyou } = setup()
    sif.getLastDataTime
      .mockRejectedValueOnce(failure())
      .mockResolvedValueOnce({ list: [{ moduleCode: "last_30d", dataReady: false }] })
    await run()
    await run()
    expect(xiyou.keywords).not.toHaveBeenCalled()
  })
  it("valid empty keyword success remains empty without fallback", async () => {
    const { sif, run, xiyou } = setup()
    sif.asinKeywordsMonthly.mockResolvedValue({ list: [] })
    const result = await run()
    expect(result.D.filled).toBe(false)
    expect(xiyou.keywords).not.toHaveBeenCalled()
  })
  it("parameter errors do not use a paid fallback", async () => {
    const { sif, run, xiyou } = setup()
    sif.asinKeywordsMonthly.mockRejectedValue(failure("input"))
    await expect(run()).rejects.toBeInstanceOf(SifApiError)
    expect(xiyou.keywords).not.toHaveBeenCalled()
  })
  it("supplement failure switches the entire D group", async () => {
    const { sif, run } = setup()
    sif.batchKeywordOverview.mockRejectedValueOnce(failure())
    const result = await run()
    expect(result.D.group?.source).toBe("xiyou")
    expect(result.D.kwTop[0].weeklySearchVolume).toBe(500)
  })
  it("double supplementary failure preserves SIF pool and marks partial", async () => {
    const { sif, run, xiyou } = setup()
    sif.batchKeywordOverview.mockRejectedValueOnce(failure())
    xiyou.market.mockRejectedValueOnce(new Error("offline"))
    const result = await run()
    expect(result.D.group).toMatchObject({
      source: "sif",
      status: "partial",
      fallbackResult: "unavailable",
    })
    expect(result.D.kwTop[0]).toMatchObject({ kw: "laptop", searchVol: "未知" })
    expect(result.D.trafficPrecompute?.pendingRules).toEqual(["G1", "G3", "J2"])
  })
  it("Xiyou reverse success with supplement failure retains partial pool", async () => {
    const { sif, run, xiyou } = setup()
    sif.asinKeywordsMonthly.mockRejectedValueOnce(failure())
    xiyou.market.mockRejectedValueOnce(new Error("offline"))
    const result = await run()
    expect(result.D.group).toMatchObject({ source: "xiyou", status: "partial" })
    expect(result.D.kwTop[0].weeklySearchVolume).toBeNull()
  })
  it.each(["quota-network", "quota-quota"])("主备最终失败 %s 不扣独立取证积分", async mode => {
    const { sif, xiyou, run, billing } = setup()
    sif.asinKeywordsMonthly.mockRejectedValueOnce(new SifApiError(-20, "private quota"))
    xiyou.keywords.mockRejectedValueOnce(mode === "quota-quota" ? new XiyouApiError("quota") : new Error("offline"))
    await expect(run("evidence-module")).rejects.toThrow("数据未获取，未扣除积分")
    expect(billing.chargeFixedStage).not.toHaveBeenCalled()
  })
  it("主源额度拒绝、备用成功，仍按原独立取证规则收费", async () => {
    const { sif, run, billing } = setup()
    sif.asinKeywordsMonthly.mockRejectedValueOnce(new SifApiError(-20, "private quota"))
    const result = await run("evidence-module")
    expect(result.D.group?.source).toBe("xiyou")
    expect(JSON.stringify(result)).not.toContain("未扣除积分")
    expect(billing.chargeFixedStage).toHaveBeenCalledTimes(1)
  })
  it("both main pools failing ends the report", async () => {
    const { sif, run, xiyou } = setup()
    sif.asinKeywordsMonthly.mockRejectedValueOnce(failure())
    xiyou.keywords.mockRejectedValueOnce(new Error("offline"))
    await expect(run()).rejects.toThrow("主备数据源")
  })
  it("E-only fallback preserves SIF D and current price, each trend fact independent", async () => {
    const { sif, run, xiyou } = setup()
    sif.asinOpTrafficTrend.mockRejectedValueOnce(failure())
    xiyou.bsr.mockRejectedValueOnce(new Error("offline"))
    const result = await run()
    expect(result.D.group?.source).toBe("sif")
    expect(result.D.trafficPrecompute?.pendingRules).toBeUndefined()
    expect(result.E.priceBsr).toMatchObject({
      currentPrice: 295.55,
      displayPrice: 251.1,
      buyboxPrice: null,
      coupon: "未知",
    })
    expect(result.E.groups?.bsr?.status).toBe("unavailable")
    expect(result.E.groups?.priceTrend?.source).toBe("xiyou")
  })
  it("next request tries recovered SIF despite a previous Xiyou result", async () => {
    const { sif, run, xiyou } = setup()
    sif.asinKeywordsMonthly.mockRejectedValueOnce(failure())
    expect((await run()).D.group?.source).toBe("xiyou")
    expect((await run()).D.group?.source).toBe("sif")
    expect(xiyou.keywords).toHaveBeenCalledTimes(1)
  })
  it("existing six-card consumers can ignore every new optional field", async () => {
    const { sif, mcp, run } = setup()
    sif.getLastDataTime.mockRejectedValueOnce(new SifApiError(-20, "quota"))
    mcp.callAsinCompetitor.mockResolvedValue({
      items: [{ asin: "B0COMPET001", title: "Laptop" }],
    } as never)
    const result = await run()
    // Read only the pre-existing display contract, without group/source/period or new price facts.
    const legacy = {
      cards: [result.A, result.P, result.B, result.C, result.D, result.E].map(card => card.filled),
      keywords: result.D.kwTop.map(row => ({
        kw: row.kw,
        searchVol: row.searchVol,
        ranking: row.ranking,
        tags: row.tags,
      })),
      details: result.D.kwDetail.map(row => row.kw),
      competitors: result.C.keywords?.map(row => ({
        kw: row.kw,
        tier: row.tier,
        searches: row.searches,
      })),
      price: result.E.priceBsr.buyboxPrice,
      bought: result.E.boughtInPastMonth,
      coupon: result.E.priceBsr.coupon,
    }
    expect(legacy.cards).toHaveLength(6)
    expect(legacy.keywords[0]).toMatchObject({ kw: "laptop", searchVol: "500（周）", tags: [] })
    expect(legacy.details).toEqual(["laptop"])
    expect(legacy.competitors?.[0]).toMatchObject({ kw: "laptop", searches: "500（周）" })
    expect(legacy.price).toBeNull()
    expect(legacy.bought).toBeNull()
    expect(typeof legacy.coupon).toBe("string")
  })
  it("coupon uses provider text directly in the existing string field", async () => {
    const { sif, xiyou, run } = setup()
    sif.asinOpTrafficTrend.mockRejectedValueOnce(failure())
    xiyou.prices.mockResolvedValueOnce({
      trends: [
        {
          date: "2026-10-28",
          priceDistribution: { display: "251.10", coupon: ["Save 10% with coupon", "$5 coupon"] },
        },
      ],
    } as never)
    const result = await run()
    expect(result.E.priceBsr.coupon).toBe("Save 10% with coupon；$5 coupon")
    expect(result.E.priceBsr.trendPriceObservation?.coupon).toEqual([
      "Save 10% with coupon",
      "$5 coupon",
    ])
  })
  it("C fails independently, merges candidates by maximum traffic and retains contributing ASINs", async () => {
    const { sif, mcp, run, xiyou } = setup()
    mcp.callAsinCompetitor.mockResolvedValue({
      items: [
        { asin: "B0COMPET001", title: "Laptop" },
        { asin: "B0COMPET002", title: "Laptop" },
      ],
    } as never)
    sif.asinKeywordsMonthly
      .mockResolvedValueOnce({ list: [keyword] })
      .mockRejectedValueOnce(failure())
    const result = await run()
    expect(result.D.group?.source).toBe("sif")
    expect(result.C.group).toMatchObject({ source: "xiyou", status: "success", fetchedCount: 1 })
    expect(result.C.group).toMatchObject({
      providerTotal: 2,
      coverage: "unknown",
      providerCounts: [
        { asin: "B0COMPET001", fetchedCount: 1, providerTotal: 1 },
        { asin: "B0COMPET002", fetchedCount: 1, providerTotal: 1 },
      ],
    })
    expect(xiyou.keywords).toHaveBeenCalledTimes(2)
    expect(result.C.keywords?.[0].tier).toBe("未知")
  })
  it("C supplementary double failure retains its SIF pool with unknown tiers", async () => {
    const { sif, mcp, run, xiyou } = setup()
    mcp.callAsinCompetitor.mockResolvedValue({
      items: [{ asin: "B0COMPET001", title: "Laptop" }],
    } as never)
    sif.batchKeywordOverview.mockResolvedValueOnce([]).mockRejectedValueOnce(failure())
    xiyou.keywords.mockRejectedValue(new Error("offline"))
    const result = await run()
    expect(result.C.group).toMatchObject({ source: "sif", status: "partial" })
    expect(result.C.keywords?.[0]).toMatchObject({ kw: "laptop", searches: "未知", tier: "未知" })
  })
  it("disconnect never starts a fallback", async () => {
    const { run, xiyou } = setup()
    const abort = new AbortController()
    abort.abort()
    await expect(run(undefined, abort.signal)).rejects.toThrow("已关闭")
    expect(xiyou.keywords).not.toHaveBeenCalled()
  })
  it("normalize preserves mixed source metadata and appends upload", async () => {
    const { sif, run } = setup()
    sif.variantLastSales.mockRejectedValueOnce(failure())
    const result = await run()
    result.E.adCleaning = {} as never
    const normalized = normalizeAuditEvidence(result as never, "amazon_us")
    expect(normalized.meta.sources.E).toEqual(["xiyou", "sif", "upload"])
    expect(normalized.E.groups).toEqual(result.E.groups)
    expect(normalized.D.group).toEqual(result.D.group)
  })
})

describe("provider boundaries", () => {
  beforeEach(() => {
    __memoizeTesting.reset()
  })
  afterEach(() => jest.restoreAllMocks())
  it.each([
    [400, "input"],
    [401, "auth"],
    [402, "quota"],
    [429, "rate_limit"],
    [500, "service"],
    [499, "unknown"],
  ])("Xiyou business status %s is classified as %s", async (status, kind) => {
    const paid = jest.fn().mockResolvedValue({ structuredContent: { status }, content: [] })
    const xiyou = new XiyouClient({ get: () => "test" } as unknown as ConfigService)
    jest.spyOn(xiyou as never, "getClient" as never).mockResolvedValue({ callTool: paid } as never)
    await expect(xiyou.orders("US", asin)).rejects.toMatchObject({ kind })
    expect(paid).toHaveBeenCalledTimes(1)
  })
  it.each([
    [{ isError: true, content: [{ type: "text", text: "insufficient credits" }] }, "quota"],
    [{ structuredContent: { status: 403, data: { reason: "MONTHLY_EXHAUSTED" } }, content: [] }, "quota"],
    [{ structuredContent: { status: 403 }, content: [] }, "auth"],
    [{ isError: true, content: [{ type: "text", text: "insufficient permissions" }] }, "unknown"],
  ])("西柚 MCP 业务原因与权限失败分开识别 %j", async (response, kind) => {
    const xiyou = new XiyouClient({ get: () => "test" } as unknown as ConfigService)
    jest.spyOn(xiyou as never, "getClient" as never).mockResolvedValue({ callTool: jest.fn().mockResolvedValue(response) } as never)
    await expect(xiyou.orders("US", asin)).rejects.toMatchObject({ kind })
  })
  const client = (key = "test") =>
    new SifClient({
      get: (name: string) => (name === "SIF_API_KEY" ? key : undefined),
    } as ConfigService)
  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limit"],
    [500, "service"],
    [400, "unknown"],
  ])("HTTP %s is %s even with a success body", async (status, kind) => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 1, data: [] }), { status: status as number })
      )
    await expect(client().variantLastSales("US", asin)).rejects.toMatchObject({ kind })
  })
  it.each(["html", JSON.stringify({ code: 1, data: { list: "bad" } })])(
    "invalid JSON/shape is evicted, then recovers",
    async body => {
      const fetch = jest
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(new Response(body))
        .mockResolvedValueOnce(new Response(JSON.stringify({ code: 1, data: { list: [] } })))
      const sif = client()
      await expect(sif.asinKeywordsMonthly("US", [asin])).rejects.toMatchObject({
        kind: "response",
      })
      await expect(sif.asinKeywordsMonthly("US", [asin])).resolves.toEqual({ list: [] })
      expect(fetch).toHaveBeenCalledTimes(2)
    }
  )
  it("network errors, missing key and input have distinct categories", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("timeout"))
    await expect(client().variantLastSales("US", asin)).rejects.toMatchObject({ kind: "transport" })
    await expect(client("").variantLastSales("UK", asin)).rejects.toMatchObject({ kind: "auth" })
    await expect(client().variantLastSales("INVALID", asin)).rejects.toMatchObject({
      kind: "input",
    })
  })
  it("account skip still reuses an existing valid SIF cache", async () => {
    const fetch = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ code: 1, data: [] })))
    const sif = client()
    await sif.variantLastSales("US", asin)
    await expect(
      sif.cachedOnly(failure("auth"), () => sif.variantLastSales("US", asin))
    ).resolves.toEqual([])
    await expect(
      sif.cachedOnly(failure("auth"), () => sif.variantLastSales("DE", asin))
    ).rejects.toMatchObject({ kind: "auth" })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it("concurrent Xiyou callers share one paid call and cache successful responses", async () => {
    const paid = jest.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: 200, cost_credits: 1, data: { entities: [] } }),
        },
      ],
    })
    const xiyou = new XiyouClient({ get: () => "test" } as unknown as ConfigService)
    jest.spyOn(xiyou as never, "getClient" as never).mockResolvedValue({ callTool: paid } as never)
    await Promise.all([xiyou.orders("US", asin), xiyou.orders("US", asin)])
    await xiyou.orders("US", asin)
    expect(paid).toHaveBeenCalledTimes(1)
  })
  it("failed paid calls are not replayed, but later independent requests can recover", async () => {
    const paid = jest
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ status: 200, data: { entities: [] } }) }],
      })
    const xiyou = new XiyouClient({ get: () => "test" } as unknown as ConfigService)
    jest.spyOn(xiyou as never, "getClient" as never).mockResolvedValue({ callTool: paid } as never)
    await expect(xiyou.orders("US", asin)).rejects.toThrow("备用数据源")
    expect(paid).toHaveBeenCalledTimes(1)
    await xiyou.orders("US", asin)
    expect(paid).toHaveBeenCalledTimes(2)
  })
  it.each(["", "Infinity", Infinity, NaN, null, undefined])(
    "non-finite or empty values remain unknown: %s",
    value => expect(finiteNumber(value)).toBeNull()
  )
  it("zero share stays zero, absent target share unknown, and no labels are fabricated", () => {
    const d = adaptXiyouD(
      asin,
      [xyRow],
      [{ searchTerm: "laptop", abaReport: { topAsins: [{ asin, conversionShare: "0" }] } }]
    )
    expect(d.kwTop[0].conversionSharePct).toBe(0)
    expect(d.kwTop[0].tags).toEqual([])
    expect(d.trafficPrecompute?.homepageHitTier).toBeNull()
    expect(
      buildTrafficSuggestionsFromPrecompute(d.trafficPrecompute)
        ?.filter(block => ["G1", "G3", "J2"].includes(block.ruleId))
        .every(block => block.level === "pending")
    ).toBe(true)
    expect(adaptXiyouD(asin, [xyRow], []).kwTop[0].conversionSharePct).toBeNull()
  })
  it("root=false category matched by product path keeps the original I3 formula", () => {
    const trends = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-10-${String(i + 1).padStart(2, "0")}`,
      values: [{ categoryId: "541966", rank: i < 7 ? 100 : 200 }],
    }))
    const series = xiyouBsrSeries(
      { categoryTree: [{ categoryId: "541966", root: false }], trends },
      { asin, amzCategoryTree: { path: [{ categoryId: "541966" }] } },
      "2026-10-01",
      "2026-10-14"
    )
    expect(computeBsrTrendPrecompute(series).tier.score).toBe(4)
    expect(
      xiyouBsrSeries(
        { categoryTree: [{ categoryId: "541966", root: false }], trends },
        undefined,
        "2026-10-01",
        "2026-10-14"
      )
    ).toEqual({})
  })
  it("orders match target second item and coupon null stays unknown", () => {
    const e = adaptAsinPerformanceE(
      asin,
      [
        { asin: "B0OTHER000", boughtInPastMonth: 0 },
        { asin, boughtInPastMonth: 50 },
      ],
      { list: [] },
      { dates: ["2026-10-27"], couponInfo: [null] }
    )
    expect(e.boughtInPastMonth).toBe(50)
    expect(e.priceBsr.coupon).toBe("未知")
  })
})
describe("configured evidence provider order", () => {
  beforeEach(() => __memoizeTesting.reset())
  it("provider truncation uses each ASIN's original count rather than the merged union", async () => {
    const { run, xiyou } = setup("xiyou")
    xiyou.keywords.mockResolvedValue({ list: [xyRow], total: 2 })
    const result = await run()
    expect(result.D.group).toMatchObject({
      fetchedCount: 1,
      providerTotal: 2,
      coverage: "truncated",
    })
    expect(result.D.group?.period).toEqual({ completeness: "unknown" })
    expect(result.D.group?.requestedPeriod?.endDate).toBeDefined()
  })
  it("observed trend period does not claim the unreturned final requested day", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-29T03:00:00Z"))
    try {
      const { run, xiyou } = setup("xiyou")
      xiyou.prices.mockResolvedValue({
        trends: [{ date: "2026-10-27", priceDistribution: { display: "251.10", coupon: [] } }],
      })
      const result = await run()
      expect(result.E.groups?.priceTrend?.requestedPeriod?.endDate).toBe("2026-10-28")
      expect(result.E.groups?.priceTrend?.period).toMatchObject({
        startDate: "2026-10-27",
        endDate: "2026-10-27",
        completeness: "unknown",
      })
    } finally {
      now.mockRestore()
    }
  })
  it.each([undefined, "", "invalid", "XIYOU", "sif"])(
    "%s keeps SIF as the default, independently of Apify",
    async value => {
      const { run, xiyou, config } = setup(value)
      config.get.mockImplementation(key => (key === "ASIN_AUDIT_PRIMARY_SOURCE" ? "apify" : value))
      const result = await run()
      expect(result.meta.primarySource).toBe("sif")
      expect(result.D.group).toMatchObject({
        source: "sif",
        primarySource: "sif",
        fallbackAttempted: false,
      })
      for (const method of Object.values(xiyou)) expect(method).not.toHaveBeenCalled()
    }
  )
  it.each([undefined, "audit", "evidence-module"] as const)(
    "Xiyou success never requests any SIF endpoint, scene=%s",
    async scene => {
      const { run, sif, mcp, xiyou } = setup("xiyou")
      mcp.callAsinCompetitor.mockResolvedValue({
        items: [
          { asin: "B0COMPET001", title: "Laptop" },
          { asin: "B0COMPET002", title: "Laptop" },
        ],
      } as never)
      const result = await run(scene)
      for (const method of Object.values(sif)) expect(method).not.toHaveBeenCalled()
      expect(result.meta).toMatchObject({ primarySource: "xiyou", sifDataReady: null })
      expect(result.D.group).toMatchObject({
        source: "xiyou",
        primarySource: "xiyou",
        primaryResult: "success",
        fallbackAttempted: false,
      })
      expect(result.C.group?.source).toBe("xiyou")
      expect(result.C.targetReference?.source).toBe("xiyou")
      expect(Object.values(result.E.groups!).every(group => group.source === "xiyou")).toBe(true)
      expect(xiyou.info).toHaveBeenCalledTimes(1)
    }
  )
  it("only the failed Xiyou group returns to SIF, retaining SIF scoring and later Xiyou priority", async () => {
    const { run, sif, xiyou } = setup("xiyou")
    xiyou.keywords.mockRejectedValueOnce(new XiyouApiError("service"))
    const result = await run()
    expect(result.D.group).toMatchObject({
      source: "sif",
      primarySource: "xiyou",
      primaryResult: "service",
      fallbackResult: "success",
      fallbackAttempted: true,
    })
    expect(result.D.trafficPrecompute?.pendingRules).toBeUndefined()
    expect(sif.getLastDataTime).toHaveBeenCalledTimes(1)
    expect(sif.asinKeywordsMonthly).toHaveBeenCalledTimes(1)
    expect(sif.variantLastSales).not.toHaveBeenCalled()
    expect(sif.batchAsinPrice).not.toHaveBeenCalled()
    expect(result.E.groups?.orders?.source).toBe("xiyou")
  })
  it("Xiyou supplementary failure can switch the entire keyword group to complete SIF", async () => {
    const { run, xiyou } = setup("xiyou")
    xiyou.market.mockRejectedValueOnce(new XiyouApiError("transport"))
    const result = await run()
    expect(result.D.group).toMatchObject({
      source: "sif",
      primarySource: "xiyou",
      status: "success",
    })
    expect(result.D.kwTop[0].weeklySearchVolume).toBeUndefined()
    expect(result.D.trafficPrecompute?.pendingRules).toBeUndefined()
  })
  it("both supplementary failures retain the configured primary Xiyou pool", async () => {
    const { run, xiyou, sif } = setup("xiyou")
    xiyou.market.mockRejectedValueOnce(new XiyouApiError("transport"))
    sif.batchKeywordOverview.mockRejectedValueOnce(failure())
    const result = await run()
    expect(result.D.group).toMatchObject({
      source: "xiyou",
      primarySource: "xiyou",
      status: "partial",
      fallbackResult: "unavailable",
    })
    expect(result.D.kwTop[0].traffic?.total).toBe(80)
    expect(result.D.kwTop[0].weeklySearchVolume).toBeNull()
  })
  it("Xiyou valid empty and missing optional facts do not trigger SIF", async () => {
    const { run, xiyou, sif } = setup("xiyou")
    xiyou.keywords.mockResolvedValue({ list: [], total: 0 })
    xiyou.info.mockResolvedValue({ entities: [] })
    xiyou.orders.mockResolvedValue({ entities: [] })
    xiyou.prices.mockResolvedValue({ trends: [] })
    const result = await run()
    expect(result.D.filled).toBe(false)
    for (const method of Object.values(sif)) expect(method).not.toHaveBeenCalled()
  })
  it.each([new XiyouApiError("input"), new XiyouApiError("unknown")])(
    "Xiyou %s errors do not call SIF",
    async error => {
      const { run, xiyou, sif } = setup("xiyou")
      xiyou.keywords.mockRejectedValueOnce(error)
      await expect(run()).rejects.toBe(error)
      for (const method of Object.values(sif)) expect(method).not.toHaveBeenCalled()
    }
  )
  it("one failed Xiyou trend falls back without replacing its successful sibling", async () => {
    const { run, xiyou, sif } = setup("xiyou")
    xiyou.bsr.mockRejectedValueOnce(new XiyouApiError("rate_limit"))
    const result = await run()
    expect(result.E.groups?.priceTrend?.source).toBe("xiyou")
    expect(result.E.groups?.bsr).toMatchObject({
      source: "sif",
      primarySource: "xiyou",
      fallbackAttempted: true,
    })
    expect(result.E.priceBsr.displayPrice).toBe(251.1)
    expect(sif.asinOpTrafficTrend).toHaveBeenCalledTimes(1)
    expect(sif.getLastDataTime).toHaveBeenCalledTimes(1)
  })
  it("both primary keyword pools failing ends D but E failures remain local", async () => {
    const { run, xiyou, sif } = setup("xiyou")
    xiyou.keywords.mockRejectedValueOnce(new XiyouApiError("service"))
    sif.asinKeywordsMonthly.mockRejectedValueOnce(failure())
    await expect(run()).rejects.toThrow("主备数据源")
  })
  it("changing order selects the configured source despite the previous source's valid fact cache", async () => {
    const { run, sif, xiyou, config } = setup("sif")
    // These memoized fixtures model each client's independent successful fact cache.
    const sifFetch = jest.fn().mockResolvedValue({ list: [keyword] })
    const xyFetch = jest.fn().mockResolvedValue({ list: [xyRow], total: 1 })
    sif.asinKeywordsMonthly.mockImplementation(() =>
      memoizeByKey("sif:test-order", sifFetch, 3600000)
    )
    xiyou.keywords.mockImplementation(() => memoizeByKey("xiyou:test-order", xyFetch, 3600000))
    expect((await run()).D.group?.source).toBe("sif")
    config.get.mockReturnValue("xiyou")
    expect((await run()).D.group?.source).toBe("xiyou")
    expect(xyFetch).toHaveBeenCalledTimes(1)
    config.get.mockReturnValue("sif")
    expect((await run()).D.group?.source).toBe("sif")
    expect(sifFetch).toHaveBeenCalledTimes(1)
  })
})
