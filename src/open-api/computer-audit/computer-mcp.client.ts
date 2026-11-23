import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"

/**
 * 卖家精灵 MCP 客户端（取证 C 卡用，asin_competitor 按目标 ASIN 查同款竞品）。
 * Streamable HTTP + secret-key 头、10s 连接超时、任务持久化缓存、不自动重发、工具名兼容匹配。
 * 曾用 keyword 版 competitor_lookup——关键词宽匹配 + 按销量排序会被配件/耗材霸榜
 * （如 HP 笔记本查出打印纸），已废弃；与 competitor-analysis 的 MCP 客户端并存（后者自建实例，不动）。
 * 客户端不扣积分；AsinCostService 从持久化回执统一归集调用次数，未有实际账单不估价。
 */

export class ComputerMcpClient {
  private readonly logger = new Logger(ComputerMcpClient.name)
  private clientPromise: Promise<Client> | null = null
  private toolsCache: Awaited<ReturnType<Client["listTools"]>>["tools"] | null = null

  constructor(
    private readonly config: ConfigService,
    private readonly capture: <T>(
      request: Record<string, unknown>,
      work: () => Promise<T>
    ) => Promise<T>,
    private readonly recordedCompetitorTool?: string
  ) {}
  async close() {
    if (this.clientPromise) await (await this.clientPromise).close()
  }

  private _getClient(): Promise<Client> {
    if (this.clientPromise) return this.clientPromise

    this.clientPromise = (async () => {
      const secretKey = this.config.get<string>("SELLERSPRITE_SECRET_KEY")
      if (!secretKey) throw new Error("SELLERSPRITE_SECRET_KEY not configured")

      const transport = new StreamableHTTPClientTransport(
        new URL(
          this.config.get<string>("SELLERSPRITE_MCP_URL") ?? "https://mcp.sellersprite.com/mcp"
        ),
        {
          requestInit: {
            headers: { "secret-key": secretKey },
          },
        }
      )

      const client = new Client({ name: "amazon-agent", version: "1.0.0" })
      try {
        // 10s 连接超时
        await Promise.race([
          client.connect(transport),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("MCP connection timeout (10s)")), 10000)
          ),
        ])
        return client
      } catch (e) {
        this.clientPromise = null
        throw e
      }
    })()

    return this.clientPromise
  }

  private async _listTools() {
    if (this.toolsCache) return this.toolsCache
    const client = await this._getClient()
    const result = await client.listTools()
    this.toolsCache = result.tools
    return result.tools
  }

  private async _callTool(name: string, args: Record<string, unknown>) {
    return this.capture({ name, arguments: args }, async () => {
      const client = await this._getClient()
      const result = await client.callTool({ name, arguments: args })
      return result
    })
  }

  private async _resolveAsinCompetitorToolName(): Promise<string> {
    const tools = await this._listTools()
    const exact = tools.find(t => t.name === "asin_competitor")
    if (exact) return exact.name
    const fuzzy = tools.find(t => t.name.toLowerCase().includes("competitor"))
    if (fuzzy) return fuzzy.name
    throw new Error(
      `SellerSprite MCP: missing asin competitor tool (e.g. asin_competitor). Got: ${tools.map(t => t.name).join(", ") || "(none)"}`
    )
  }

  private _parseMcpToolJsonResult(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
    const text = (Array.isArray(result.content) ? result.content : [])
      .filter(
        (c): c is { type: "text"; text: string } =>
          typeof c === "object" &&
          c !== null &&
          (c as { type?: string }).type === "text" &&
          typeof (c as { text?: string }).text === "string"
      )
      .map(c => c.text)
      .join("")
    if (!text.trim()) return null
    return JSON.parse(text) as unknown
  }

  /**
   * 调用 MCP「ASIN 竞品查询」，参数顶层平铺（schema 根级 marketplace/asin/size，无 request 包装）。
   * 响应 data 直接是竞品数组（兼容 items 包装），元素含 asin/title/brand/nodeLabelPath 等。
   */
  async callAsinCompetitor(
    asin: string,
    marketplace: string,
    size = 10
  ): Promise<{ items: Record<string, unknown>[]; parsed: unknown }> {
    const toolName = this.recordedCompetitorTool ?? await this._resolveAsinCompetitorToolName()
    const result = await this._callTool(toolName, { marketplace, asin, size })
    if (result.isError) throw new Error("MCP_TOOL_FAILED")
    const parsed = this._parseMcpToolJsonResult(result)
    const root =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    const data = root?.data
    const rawItems = Array.isArray(data)
      ? data
      : data != null &&
          typeof data === "object" &&
          Array.isArray((data as Record<string, unknown>).items)
        ? ((data as Record<string, unknown>).items as unknown[])
        : []
    const items = rawItems.filter(
      (x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)
    )
    return { items, parsed }
  }
}
