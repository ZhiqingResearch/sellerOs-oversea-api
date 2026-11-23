import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { uiText } from "../../common/i18n/request-language"
import { AsyncLocalStorage } from "node:async_hooks"
import type {
  SifAsinKeywordsMonthlyData,
  SifAsinOpTrafficTrendData,
  SifBatchAsinDetailResult,
  SifBatchAsinPriceData,
  SifKeywordOverviewRow,
  SifLastDataTimeData,
  SifVariantLastSalesRow,
} from "../types/sif.types"
import { cachedByKey, memoizeByKey } from "./memoize"

/**
 * SIF 取证客户端（Nest 化，等价迁移交付包 server/sif/{config,client,api}.ts）。
 * 鉴权：`authorization: <SIF_API_KEY>` 原值无 Bearer；country 放 URL Query；
 * 业务成功 code===1（-1 参数/-20 配额/-22 限流/-25 未分配）；1h 缓存、失败不缓存。
 * env 兼容：SIF_BASE_URL 优先，兼容旧名 SIF_API_BASE_URL；未配置时接口运行时明确报错
 * （env.validation 不硬性必配——视频-only 环境要能启动）。
 */

export const SIF_CODE = {
  OK: 1,
  PARAM: -1,
  QUOTA_EXHAUSTED: -20,
  RATE_LIMIT: -22,
  QUOTA_NOT_ALLOCATED: -25,
} as const

export type SifCountry =
  | "US"
  | "UK"
  | "DE"
  | "CA"
  | "JP"
  | "FR"
  | "ES"
  | "IT"
  | "MX"
  | "AU"
  | "AE"
  | "BR"
  | "SA"

const VALID_COUNTRIES = new Set<string>([
  "US",
  "UK",
  "DE",
  "CA",
  "JP",
  "FR",
  "ES",
  "IT",
  "MX",
  "AU",
  "AE",
  "BR",
  "SA",
])

export type SifFailureKind =
  | "input"
  | "auth"
  | "quota"
  | "rate_limit"
  | "transport"
  | "response"
  | "service"
  | "unknown"

export class SifApiError extends Error {
  readonly code: number

  constructor(
    code: number,
    message: string,
    readonly kind: SifFailureKind = code === -20 || code === -25
      ? "quota"
      : code === -22
        ? "rate_limit"
        : code === -1
          ? "input"
          : "unknown"
  ) {
    super(message)
    this.name = "SifApiError"
    this.code = code
  }
}

export function sifCodeMessage(code: number): string {
  const map: Record<string, string> = {
    [String(SIF_CODE.PARAM)]: uiText("参数错误", "Invalid parameters"),
    [String(SIF_CODE.QUOTA_EXHAUSTED)]: uiText("API 配额已用完", "API quota exhausted"),
    [String(SIF_CODE.RATE_LIMIT)]: uiText(
      "访问过于频繁，请稍后重试",
      "Too many requests. Please try again later."
    ),
    [String(SIF_CODE.QUOTA_NOT_ALLOCATED)]: uiText(
      "API 未分配配额",
      "API quota has not been allocated"
    ),
  }
  return map[String(code)] ?? uiText("未知错误", "Unknown error")
}

const SIF_CACHE_TTL_MS = 60 * 60 * 1000 // 1h — 降低重复审计的配额消耗

interface SifEnvelope<T> {
  code: number
  message?: string
  data: T
}

@Injectable()
export class SifClient {
  private readonly logger = new Logger(SifClient.name)
  private readonly accountFailure = new AsyncLocalStorage<SifApiError>()

  constructor(private readonly config: ConfigService) {}

  private apiKey(): string {
    const key = this.config.get<string>("SIF_API_KEY")?.trim()
    if (!key) throw new SifApiError(-1, "主数据源暂不可用", "auth")
    return key
  }

  private baseUrl(): string {
    const base =
      this.config.get<string>("SIF_BASE_URL")?.trim() ||
      this.config.get<string>("SIF_API_BASE_URL")?.trim() || // 兼容竞品分析的旧 env 名
      "https://www.sif.com"
    return base.replace(/\/$/, "")
  }

  private normalizeCountry(input: string | undefined): SifCountry {
    const c =
      input?.trim().toUpperCase() ||
      this.config.get<string>("SIF_DEFAULT_COUNTRY")?.trim().toUpperCase() ||
      "US"
    if (!VALID_COUNTRIES.has(c)) {
      throw new SifApiError(-1, `不支持的 SIF 站点 country: ${c}`)
    }
    return c as SifCountry
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST"
      country?: string
      body?: unknown
      query?: Record<string, string | number | boolean | undefined | null>
    } = {}
  ): Promise<T> {
    const method = options.method ?? "POST"
    const country = this.normalizeCountry(options.country)
    const params = new URLSearchParams({ country })
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== null && v !== "") params.set(k, String(v))
      }
    }
    const sep = path.includes("?") ? "&" : "?"
    const url = `${this.baseUrl()}${path}${sep}${params.toString()}`

    const headers: Record<string, string> = { authorization: this.apiKey() }
    const init: RequestInit = { method, headers }
    if (options.body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json"
      init.body = JSON.stringify(options.body)
    }

    let resp: Response
    try {
      resp = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
    } catch {
      throw new SifApiError(-1, "主数据源请求超时或网络不可用", "transport")
    }
    if (!resp.ok) {
      const kind: SifFailureKind =
        resp.status === 401 || resp.status === 403
          ? "auth"
          : resp.status === 429
            ? "rate_limit"
            : resp.status >= 500
              ? "service"
              : "unknown"
      throw new SifApiError(-1, `主数据源 HTTP ${resp.status}`, kind)
    }
    let json: SifEnvelope<T>
    try {
      json = (await resp.json()) as SifEnvelope<T>
    } catch {
      throw new SifApiError(-1, `SIF 响应非 JSON（HTTP ${resp.status}）`, "response")
    }
    if (!json || typeof json.code !== "number" || !("data" in json)) {
      throw new SifApiError(-1, "主数据源响应结构无效", "response")
    }
    if (json.code !== SIF_CODE.OK) {
      const msg = json.message?.trim() || sifCodeMessage(json.code)
      const auth =
        json.code === -1 &&
        /unauthorized|invalid (api[ _-]?)?key|authentication failed|鉴权失败|密钥无效|凭证失效/i.test(
          msg
        )
      throw new SifApiError(
        json.code,
        uiText(`SIF API 错误 ${json.code}：${msg}`, `SIF API error ${json.code}: ${sifCodeMessage(json.code)}`),
        auth ? "auth" : undefined
      )
    }
    if (json.data !== null && typeof json.data !== "object") {
      throw new SifApiError(-1, "主数据源数据结构无效", "response")
    }
    const arrayData =
      path.includes("batchKeywordSimpleOverview") || path.includes("variantLastSales")
    if (json.data !== null && (arrayData ? !Array.isArray(json.data) : Array.isArray(json.data))) {
      throw new SifApiError(-1, "主数据源数据结构无效", "response")
    }
    if (json.data && !arrayData) {
      const data = json.data as Record<string, unknown>
      const arrayFields = path.includes("asinOpTrafficTrend")
        ? ["dates", "bsr", "buyboxPrice", "couponInfo"]
        : ["list"]
      if (arrayFields.some(field => data[field] != null && !Array.isArray(data[field]))) {
        throw new SifApiError(-1, "主数据源数据结构无效", "response")
      }
      if (Array.isArray(data.list) && data.list.some(row => !row || typeof row !== "object")) {
        throw new SifApiError(-1, "主数据源列表结构无效", "response")
      }
      const dates = data.dates
      if (
        Array.isArray(dates) &&
        arrayFields.some(
          field =>
            field !== "dates" && Array.isArray(data[field]) && data[field].length !== dates.length
        )
      ) {
        throw new SifApiError(-1, "主数据源趋势结构无效", "response")
      }
    }
    return json.data
  }

  private cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const failure = this.accountFailure.getStore()
    if (failure) return cachedByKey<T>(key) ?? Promise.reject(failure)
    return memoizeByKey(
      key,
      async () => {
        const started = Date.now()
        try {
          const value = await fn()
          this.logger.log(
            `operation=${key.split(":")[1]} status=success elapsed=${Date.now() - started}ms cost=unknown`
          )
          return value
        } catch (error) {
          this.logger.warn(
            `operation=${key.split(":")[1]} status=${error instanceof SifApiError ? error.kind : "unknown"} elapsed=${Date.now() - started}ms cost=unknown`
          )
          throw error
        }
      },
      SIF_CACHE_TTL_MS
    )
  }

  cachedOnly<T>(failure: SifApiError, fn: () => Promise<T>): Promise<T> {
    return this.accountFailure.run(failure, fn)
  }

  /** 数据就绪状态检查（granularity 取证链固定 last_30d） */
  getLastDataTime(country: string, granularity = "last_30d"): Promise<SifLastDataTimeData> {
    return this.cached(`sif:lastDataTime:${country}:${granularity}`, () =>
      this.request<SifLastDataTimeData>("/api/search/external/v2/getSifLastDataTime", {
        method: "GET",
        country,
        query: { granularity },
      })
    )
  }

  /** ASIN 反查流量词-按月（近30天核心流量词），取证主请求 */
  asinKeywordsMonthly(
    country: string,
    asinList: string[],
    opts: { last30d?: boolean } = {}
  ): Promise<SifAsinKeywordsMonthlyData> {
    return this.cached(
      `sif:kwMonthly:${country}:${asinList.join(",")}:${JSON.stringify(opts)}`,
      () =>
        this.request<SifAsinKeywordsMonthlyData>(
          "/api/search/external/v2/asinKeywordsSimpleGroupByMonthly",
          {
            country,
            body: {
              asinList,
              last30d: opts.last30d ?? true,
              sortBy: "totalScore",
              desc: true,
              pageNum: 1,
              pageSize: 10000,
            },
          }
        )
    )
  }

  /** 批量关键词搜索量概览 */
  batchKeywordOverview(country: string, keywords: string[]): Promise<SifKeywordOverviewRow[]> {
    return this.cached(`sif:kwOverview:${country}:${keywords.join("|")}`, () =>
      this.request<SifKeywordOverviewRow[]>("/api/search/external/v2/batchKeywordSimpleOverview", {
        country,
        body: { keywords },
      })
    )
  }

  /** 近月前台购买量 */
  variantLastSales(country: string, asin: string): Promise<SifVariantLastSalesRow[]> {
    return this.cached(`sif:variantSales:${country}:${asin}`, () =>
      this.request<SifVariantLastSalesRow[]>("/api/search/external/v2/variantLastSales", {
        method: "GET",
        country,
        query: { asin },
      })
    )
  }

  /** 价格/coupon/上架日期（365 天） */
  batchAsinPrice(country: string, asinList: string[], days = 365): Promise<SifBatchAsinPriceData> {
    return this.cached(`sif:asinPrice:${country}:${asinList.join(",")}:${days}`, () =>
      this.request<SifBatchAsinPriceData>("/api/search/external/v2/batchAsinPrice", {
        country,
        body: { asinList, days },
      })
    )
  }

  /** ASIN 详情批量（title/brand/bsrList 等），C 卡竞品过滤的目标参照 */
  batchAsinDetail(country: string, asins: string[]): Promise<SifBatchAsinDetailResult> {
    return this.cached(`sif:asinDetail:${country}:${asins.join(",")}`, () =>
      this.request<SifBatchAsinDetailResult>("/api/search/external/v2/batchAsinDetail", {
        country,
        body: { asins },
      })
    )
  }

  /** BSR/运营趋势（近 30 天） */
  asinOpTrafficTrend(
    country: string,
    asin: string,
    startDate: string,
    endDate: string
  ): Promise<SifAsinOpTrafficTrendData> {
    return this.cached(`sif:trafficTrend:${country}:${asin}:${startDate}:${endDate}`, () =>
      this.request<SifAsinOpTrafficTrendData>(
        "/api/search/external/v2/timeMachine/asinOpTrafficTrend",
        {
          method: "GET",
          country,
          query: { asin, startDate, endDate },
        }
      )
    )
  }
}
