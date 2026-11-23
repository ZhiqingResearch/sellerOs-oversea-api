import { ConfigService } from "@nestjs/config"
import axios from "axios"
import { createHash } from "crypto"
import { PrismaService } from "../prisma/prisma.service"
import { buildReads, calculateStatistics } from "./category-analysis.statistics"
import { focusEvidence, keywordConsistency } from "./category-enrichment"
import { CategoryEvidenceProvider } from "./category-evidence.provider"

jest.mock("axios")

// 快照源自海外 dev 9ad0adb 的未优化 Provider。
// 仅生成基线时传入该版本转译的本地文件；正常回归始终测试当前实现。
const Provider: typeof CategoryEvidenceProvider = process.env.CATEGORY_EVIDENCE_BASELINE
  ? jest.requireActual<{
      CategoryEvidenceProvider: typeof CategoryEvidenceProvider
    }>(process.env.CATEGORY_EVIDENCE_BASELINE).CategoryEvidenceProvider
  : CategoryEvidenceProvider
const category = { nodeId: "123", nodeIdPath: "1:123", name: "Storage", path: "家居 > 收纳" }
const usageOf = () => ({ totalCalls: 0, callDetail: {}, endpointCalls: {} })
const checksum = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

describe("正式分支原产出等价性", () => {
  beforeEach(() => {
    jest.resetAllMocks()
    jest.useFakeTimers({ now: Date.parse("2026-09-18T10:30:00Z") })
  })
  afterEach(() => jest.useRealTimers())

  it.each(["完整数据", "详情逆序与销量并列", "缺失及显式空值", "可选接口失败", "跨批次350样本"])(
    "%s：冷缓存、重复读取的完整证据、报告指标与AI输入不变",
    async scenario => {
      const productCount = scenario === "跨批次350样本" ? 350 : 35
      const sampleCount = scenario === "跨批次350样本" ? 300 : 30
      const products = Array.from({ length: productCount }, (_, index) => ({
        asin: `B${String(index).padStart(9, "0")}`,
        title: index % 3 ? "Spice rack storage" : "Storage shelf",
        brand: `Brand ${index % 4}`,
        price: 10 + index,
        boughtInPastMonth: scenario === "详情逆序与销量并列" ? 100 : Math.max(1, 500 - index * 5),
        firstAvailableDay: index < 20 ? "2025-01-01" : "2026-07-01",
        review: 10 + index,
        rating: 4.2 + (index % 5) / 10,
        packageWeight: 453.592,
        packageLength: 304.8,
        packageWidth: 304.8,
        packageHeight: 304.8,
        bsrList: [{ id: "kitchen/123", name: "Storage", rank: index + 1 }],
      }))
      const mockedAxios = axios as unknown as { request: jest.Mock; get: jest.Mock }
      const request = mockedAxios.request
      request.mockImplementation(
        (options: {
          url: string
          data?: Record<string, unknown>
          params?: Record<string, unknown>
        }) => {
          const endpoint = options.url.split("/v2/")[1]
          const payload = options.data ?? options.params ?? {}
          if (
            scenario === "可选接口失败" &&
            [
              "asinsHistorySales",
              "keywordConversionLast",
              "timeMachine/asinOpTrafficTrend",
            ].includes(endpoint)
          )
            throw new Error("fixture failure")
          let data: unknown = []
          const words = (payload.keywords ?? []) as string[]
          if (endpoint === "category/suggestion")
            data = [{ categoryId: 123, categoryName: "Storage" }]
          if (endpoint === "relevanceScreen/keywordByCategory")
            data = [
              {
                keyword: "storage",
                topAsin: products.slice(0, sampleCount).map(({ asin }) => ({ asin })),
              },
              {
                keyword: "spice rack",
                topAsin: products.slice(5, 15).map(({ asin }) => ({ asin })),
              },
            ]
          if (endpoint === "categoryNewReleases") data = { list: products.slice(sampleCount) }
          if (endpoint === "batchAsinDetail") {
            let selected = products.filter(row => (payload.asins as string[]).includes(row.asin))
            if (scenario === "详情逆序与销量并列") selected = selected.reverse()
            if (scenario === "缺失及显式空值")
              selected = selected.filter(row => row.asin !== products[34].asin)
            data = { list: selected }
          }
          if (endpoint === "asinsHistorySales")
            data = Object.fromEntries(
              (payload.asins as string[])
                .filter(asin => scenario !== "缺失及显式空值" || asin !== products[33].asin)
                .map(asin => [
                  asin,
                  scenario === "缺失及显式空值" && asin === products[32].asin
                    ? null
                    : {
                        "2026-01": 40,
                        "2026-02": 50,
                        "2026-03": 80,
                        "2026-04": 60,
                        "2026-05": 90,
                        "2026-06": 100,
                        "2026-07": 70,
                        "2026-08": 120,
                      },
                ])
            )
          if (endpoint === "batchKeywordSimpleOverview")
            data = words.map(keyword => ({ keyword, estSearchesNum: 12000, searchesRank: 100 }))
          if (endpoint === "estSearchesHistory")
            data = words.map(keyword => ({
              keyword,
              estSearchesNumHistoryMap: { "2025-08": 10000, "2026-08": 12000 },
            }))
          if (endpoint === "keywordCompetitorGroupByMonthly")
            data = words.map(keyword => ({ keyword, totalAsinNum: 200, startDate: "2026-08-01" }))
          if (endpoint === "keywordConversionLast")
            data = words.map(keyword => ({
              keyword,
              ppc: { median: 0.5 },
              clickPurchaseRatio: 0.1,
              acos: { median: 0.3 },
            }))
          if (endpoint === "competePatternFlexibleGroupByMonthly")
            data = {
              list: words.flatMap(keyword =>
                products.slice(0, 20).map((row, index) => ({
                  keyword,
                  asin: row.asin,
                  totalScoreRatio: (20 - index) / 210,
                  keywordAllNaturalScore: 60,
                  keywordTotalScore: 100,
                }))
              ),
            }
          if (endpoint === "timeMachine/asinOpTrafficTrend")
            data = {
              dates: ["2026-08-01", "2026-08-31"],
              review: [10, 40],
              seller: [1, 3],
              bsr: [200, 100],
              buyboxPrice: [10, 20],
              nfScoreRatios: [0.7, 0.8],
            }
          return Promise.resolve({ data: { code: 1, data } })
        }
      )
      mockedAxios.get.mockResolvedValue({ data: { tokensLeft: 0 } })
      const provider = new Provider(
        new ConfigService({ SIF_API_KEY: "test", KEEPA_API_KEY: "test" }),
        {} as PrismaService
      )
      const keywords = ["spice rack"]
      const resolution = await provider.resolveKeywords(keywords, "US", usageOf())
      const evidence = await provider.collect(7, category, "US", usageOf(), keywords)
      const repeated = await provider.collect(8, category, "US", usageOf(), keywords)
      expect(repeated).toEqual(evidence)
      const partiallyCached = new Provider(
        new ConfigService({ SIF_API_KEY: "test", KEEPA_API_KEY: "test" }),
        {} as PrismaService
      )
      for (let index = 0; index < Math.min(200, products.length); index += 10) {
        await partiallyCached["_sif"](
          "asinsHistorySales",
          "US",
          {
            asins: products.slice(index + 1, index + 3).map(row => row.asin),
            month: 18,
          },
          usageOf()
        ).catch(() => undefined)
      }
      expect(await partiallyCached.collect(9, category, "US", usageOf(), keywords)).toEqual(
        evidence
      )
      const input = calculateStatistics(category, "US", evidence)
      const focused = focusEvidence(evidence, keywords)
      // 每个摘要覆盖完整对象、数组顺序及 null，不只比较样本数或总和。
      expect({
        resolution: checksum(resolution),
        evidence: checksum(evidence),
        input: checksum(input),
        reads: checksum(buildReads(input)),
        focused: checksum(focused),
        consistency: checksum(keywordConsistency(evidence, resolution)),
        aiInput: checksum(
          JSON.stringify(input, (key, value: unknown) =>
            ["keepa", "listing_bar"].includes(key) ? undefined : value
          )
        ),
      }).toMatchSnapshot()
    }
  )
})
