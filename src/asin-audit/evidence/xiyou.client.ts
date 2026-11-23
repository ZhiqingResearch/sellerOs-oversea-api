import { isQuotaResponse } from "../../common/errors/upstream-quota"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { memoizeByKey } from "./memoize"

export type XiyouFailureKind =
  | "input"
  | "auth"
  | "quota"
  | "rate_limit"
  | "transport"
  | "response"
  | "service"
  | "unknown"
export class XiyouApiError extends Error {
  constructor(readonly kind: XiyouFailureKind) {
    super("备用数据源暂不可用")
    this.name = "XiyouApiError"
  }
}
function statusKind(status: number): XiyouFailureKind {
  return status === 400 || status === 422 || status === -32602
    ? "input"
    : status === 401 || status === 403
      ? "auth"
      : status === 402
        ? "quota"
        : status === 429
          ? "rate_limit"
          : status >= 500 && status < 600
            ? "service"
            : "unknown"
}

export interface XiyouKeyword {
  searchTerm: string
  trafficSummary?: { traffic?: { total?: unknown; organic?: unknown; advertising?: unknown } }
  ranks?: Array<{
    position: string
    page?: unknown
    pageRank?: unknown
    totalRank?: unknown
    rankTime?: string
  }>
  contributingAsins?: string[]
}
export interface XiyouKeywordData {
  list: XiyouKeyword[]
  total?: number
  startDate?: string
  endDate?: string
}
export interface XiyouMarketRow {
  searchTerm: string
  abaReport?: {
    weeklySearchVolume?: unknown
    searchFrequencyRank?: unknown
    reportFromDate?: string
    reportToDate?: string
    topAsins?: Array<{ asin: string; conversionShare?: unknown }>
  }
}
export interface XiyouInfo {
  asin: string
  title?: string
  brand?: string
  price?: unknown
  streetDate?: string
  currency?: string
  amzCategoryTree?: { path?: Array<{ categoryId: string }> }
}
export interface XiyouPriceTrend {
  trends: Array<{
    date: string
    priceDistribution?: { display?: unknown; deal?: unknown; coupon?: unknown[] }
  }>
  dateRangeNotice?: string
}
export interface XiyouBsrTrend {
  categoryTree: Array<{ categoryId: string; root?: boolean }>
  trends: Array<{ date: string; values: Array<{ categoryId: string; rank: unknown }> }>
  dateRangeNotice?: string
}

@Injectable()
export class XiyouClient implements OnModuleDestroy {
  private readonly logger = new Logger(XiyouClient.name)
  private connection: Promise<Client> | null = null
  constructor(private readonly config: ConfigService) {}

  async onModuleDestroy(): Promise<void> {
    const connection = this.connection
    this.connection = null
    if (connection) await connection.then(client => client.close()).catch(() => undefined)
  }

  private getClient(): Promise<Client> {
    if (this.connection) return this.connection
    const token = this.config.get<string>("XIYOU_MCP_TOKEN")?.trim()
    if (!token) return Promise.reject(new XiyouApiError("auth"))
    this.connection = (async () => {
      const client = new Client({ name: "asin-evidence", version: "1.0.0" })
      const transport = new StreamableHTTPClientTransport(new URL("https://mcp.xydc.com/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          client.connect(transport),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("备用数据源连接超时")), 10_000)
          }),
        ])
        return client
      } catch (error) {
        void client.close().catch(() => undefined)
        this.connection = null
        const status =
          error && typeof error === "object"
            ? ((error as { status?: number; code?: number }).status ??
              (error as { code?: number }).code)
            : undefined
        throw new XiyouApiError(typeof status === "number" ? statusKind(status) : "transport")
      } finally {
        clearTimeout(timer)
      }
    })()
    return this.connection
  }

  private call<T>(name: string, args: Record<string, unknown>, arrayKey: string): Promise<T> {
    return memoizeByKey(
      `xiyou:v1:${name}:${JSON.stringify(args)}`,
      async () => {
        const started = Date.now()
        let connection: Promise<Client> | null = null
        let cost: number | null = null
        let responded = false
        try {
          connection = this.getClient()
          const client = await connection
          // A timed-out paid call is never replayed automatically.
          const result = await client.callTool({ name, arguments: args }, undefined, {
            timeout: 30_000,
          })
          responded = true
          if (result.isError) {
            const text = (Array.isArray(result.content) ? result.content : []).filter(b => b.type === "text").map(b => b.text).join(" ")
            throw new XiyouApiError(isQuotaResponse(result.structuredContent) || isQuotaResponse(text) ? "quota" : "unknown")
          }
          const blocks = Array.isArray(result.content) ? result.content : []
          const raw =
            result.structuredContent ??
            JSON.parse(
              blocks
                .filter(b => b.type === "text")
                .map(b => b.text)
                .join("")
            )
          const envelope = raw as {
            status?: number
            data?: Record<string, unknown>
            cost_credits?: unknown
          }
          cost = finiteNumber(envelope.cost_credits)
          if (typeof envelope.status === "number" && envelope.status !== 200)
            throw new XiyouApiError(isQuotaResponse(envelope) ? "quota" : statusKind(envelope.status))
          if (envelope.status !== 200 || !envelope.data || !Array.isArray(envelope.data[arrayKey]))
            throw new XiyouApiError("response")
          const field =
            arrayKey === "entities" ? "asin" : arrayKey === "trends" ? "date" : "searchTerm"
          if (
            (envelope.data[arrayKey] as unknown[]).some(
              row =>
                !row ||
                typeof row !== "object" ||
                typeof (row as Record<string, unknown>)[field] !== "string"
            )
          )
            throw new XiyouApiError("response")
          if (
            name === "get_asin_bsr_trends" &&
            (!Array.isArray(envelope.data.categoryTree) ||
              (envelope.data.trends as Array<{ values?: unknown }>).some(
                row => !Array.isArray(row.values)
              ))
          )
            throw new XiyouApiError("response")
          this.logger.log(
            `tool=${name} status=success elapsed=${Date.now() - started}ms cost_credits=${finiteNumber(envelope.cost_credits) ?? "unknown"}`
          )
          return envelope.data as T
        } catch (error) {
          if (!responded && this.connection === connection) {
            this.connection = null
            void connection?.then(client => client.close()).catch(() => undefined)
          }
          this.logger.warn(
            `tool=${name} status=failed elapsed=${Date.now() - started}ms cost_credits=${cost ?? "unknown"}`
          )
          if (error instanceof XiyouApiError) throw error
          if (isQuotaResponse(error)) throw new XiyouApiError("quota")
          const status =
            error && typeof error === "object"
              ? ((error as { status?: number; code?: number }).status ??
                (error as { code?: number }).code)
              : undefined
          throw new XiyouApiError(
            typeof status === "number" ? statusKind(status) : responded ? "response" : "transport"
          )
        }
      },
      3_600_000
    )
  }

  keywords(country: string, asin: string, startDate: string, endDate: string) {
    return this.call<XiyouKeywordData>(
      "get_asin_keywords_daily",
      {
        country,
        asin,
        start_date: startDate,
        end_date: endDate,
        page: 1,
        page_size: 10000,
        sort_field: "traffic",
        sort_order: "desc",
      },
      "list"
    )
  }
  market(country: string, keywords: string[]) {
    return this.call<{ list: XiyouMarketRow[] }>(
      "get_keyword_info",
      { country, keywords: [...new Set(keywords.map(k => k.trim().toLowerCase()))].sort() },
      "list"
    )
  }
  info(country: string, asin: string) {
    return this.call<{ entities: XiyouInfo[] }>(
      "get_asin_info",
      { country, asins: [asin] },
      "entities"
    )
  }
  orders(country: string, asin: string) {
    return this.call<{ entities: Array<{ asin: string; orders?: unknown }> }>(
      "get_asin_orders_last_30_days",
      { country, asins: [asin] },
      "entities"
    )
  }
  prices(country: string, asin: string, startDate: string, endDate: string) {
    return this.call<XiyouPriceTrend>(
      "get_asin_info_trends",
      { country, asin, start_date: startDate, end_date: endDate },
      "trends"
    )
  }
  bsr(country: string, asin: string, startDate: string, endDate: string) {
    return this.call<XiyouBsrTrend>(
      "get_asin_bsr_trends",
      { country, asin, start_date: startDate, end_date: endDate },
      "trends"
    )
  }
}

export function finiteNumber(value: unknown): number | null {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && !value.trim())
  )
    return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
