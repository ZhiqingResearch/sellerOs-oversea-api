import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import axios from "axios"
import { Bag, Kind, obj, str } from "../../patent-query/patent-query.types"

type ErrorCategory =
  | "rate_limit"
  | "auth"
  | "quota"
  | "subscription"
  | "permission"
  | "business"
  | "validation"
  | "not_found"
  | "temporary"
  | "unknown"
const ERROR_CODES: Record<string, { category: ErrorCategory; message: string }> = {
  UNAUTHORIZED_AUTH_REQUIRED: {
    category: "auth",
    message: "检测服务认证失败，服务凭证可能无效或已停用，请联系管理员",
  },
  BUSINESS_INSUFFICIENT_QUOTA: {
    category: "quota",
    message: "检测服务额度不足，请联系管理员",
  },
  // 公开错误码表暂未列出；2026-10-26 实测为 HTTP 400，不能按参数错误处理。
  BUSINESS_SUBSCRIPTION_REQUIRED: {
    category: "subscription",
    message: "检测服务订阅未生效或已到期，请联系管理员",
  },
  BUSINESS_RATE_LIMIT_EXCEEDED: {
    category: "rate_limit",
    message: "检测服务繁忙，请稍后重试",
  },
  VALIDATION_VISUAL_SEARCH_IMAGE_TOO_SMALL: {
    category: "validation",
    message: "图片尺寸过小，最长边需至少 200 像素，请更换图片",
  },
  RATE_LIMITER_UNAVAILABLE: {
    category: "temporary",
    message: "检测服务限流组件暂不可用，请稍后重试",
  },
  INTERNAL_ERROR_UNKNOWN: {
    category: "temporary",
    message: "检测服务内部异常，请稍后重试",
  },
  NETWORK_ERROR: { category: "temporary", message: "检测服务连接异常，请稍后重试" },
  INVALID_RESULT: { category: "temporary", message: "检测结果格式不完整，请稍后重试" },
}
const safeErrorCode = (code: string) => (/^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : "")
export class TrohubError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string
  ) {
    super(message ?? TrohubError.messageFor(status, code))
  }
  private static categoryFor(status: number, code: string): ErrorCategory {
    if (Object.hasOwn(ERROR_CODES, code)) return ERROR_CODES[code].category
    if (code.startsWith("VALIDATION_")) return "validation"
    if (code.startsWith("BUSINESS_")) return "business"
    // 已知业务码优先；缺失或不认识的错误码才按 HTTP 状态兜底。
    if (status === 429) return "rate_limit"
    if (status === 401) return "auth"
    if (status === 403) return "permission"
    if (status === 400) return "validation"
    if (status === 404 || status === 410) return "not_found"
    if (status === 0 || status >= 500) return "temporary"
    return "unknown"
  }
  private static messageFor(status: number, code: string) {
    if (Object.hasOwn(ERROR_CODES, code)) return ERROR_CODES[code].message
    const category = TrohubError.categoryFor(status, code)
    const messages: Record<ErrorCategory, string> = {
      rate_limit: "检测服务繁忙，请稍后重试",
      auth: "检测服务认证失败，请联系管理员",
      quota: "检测服务额度不足，请联系管理员",
      subscription: "检测服务订阅未生效或已到期，请联系管理员",
      permission: "检测服务拒绝访问，请联系管理员检查服务权限",
      business: "检测服务未受理本次请求，请联系管理员核查服务状态",
      validation: "检测参数未被服务接受，请检查输入",
      not_found: "检测结果暂未找到",
      temporary: "检测服务暂不可用，请稍后重试",
      unknown: "检测服务请求失败",
    }
    const reference = safeErrorCode(code)
    return reference ? `${messages[category]}（错误码：${reference}）` : messages[category]
  }
  get category() {
    return TrohubError.categoryFor(this.status, this.code)
  }
  get rateLimited() {
    return this.category === "rate_limit"
  }
  get unavailable() {
    return ["auth", "quota", "subscription", "permission", "business"].includes(this.category)
  }
  get invalidInput() {
    return this.category === "validation"
  }
  get notFound() {
    return this.category === "not_found"
  }
  get retryable() {
    return this.rateLimited || this.category === "temporary"
  }
}
export const TROHUB_ROUTES: Record<Kind, string> = {
  design: "/ip/patent/design",
  copy: "/ip/copyright",
  gtm: "/ip/trademark/design",
  tm: "/ip/trademark/text",
}
type Method = "GET" | "POST"
interface Group {
  limit: number
  nextAt: number
  blockedUntil: number
  active: number
}
interface PendingRequest {
  method: Method
  path: string
  endpoint: string
  data?: Bag
  params?: Bag
  resolve: (data: Bag) => void
  reject: (error: unknown) => void
}
const positiveInteger = (v: unknown) => {
  const n = typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

@Injectable()
export class TrohubProvider {
  private readonly logger = new Logger(TrohubProvider.name)
  private readonly groups = new Map<string, Group>()
  private readonly routes = new Map<string, string>()
  private readonly pending: PendingRequest[] = []
  private active = 0
  private timer?: ReturnType<typeof setTimeout>
  constructor(private readonly config: ConfigService) {}
  enabled() {
    return Boolean(this.config.get<string>("TROHUB_API_KEY")?.trim())
  }
  assertConfigured() {
    if (!this.enabled()) throw new ServiceUnavailableException("检测服务暂不可用")
  }
  private group(name: string, limit = 10): Group {
    let group = this.groups.get(name)
    if (!group) {
      group = { limit, nextAt: 0, blockedUntil: 0, active: 0 }
      this.groups.set(name, group)
    }
    return group
  }
  private endpoint(method: Method, path: string) {
    // 模板键不含任务 ID：新任务继承已学习的接口分组，不形成逐任务限额。
    const base = Object.values(TROHUB_ROUTES).find(
      route => path === route || path.startsWith(`${route}/`)
    )
    const template = base
      ? `${base}${path.slice(base.length).replace(/^\/[^/]+/, "/:taskID")}`
      : path
    const endpoint = `${method} ${template}`
    if (!this.routes.has(endpoint)) {
      let name = "fallback",
        limit = 10
      if (base === TROHUB_ROUTES.design) name = "patents.design"
      else if (base === TROHUB_ROUTES.copy) name = "copyright"
      else if (base === TROHUB_ROUTES.gtm) {
        name = "trademarks.design"
        limit = 30
      } else if (base === TROHUB_ROUTES.tm && method === "POST" && path === base) {
        name = "trademarks.text"
        limit = 30
      } else if (base === TROHUB_ROUTES.tm && method === "GET" && template === `${base}/:taskID`) {
        name = "trademarks.text.poll"
        limit = 30
      } else if (["/ip/patent/detail", "/ip/patent/citation"].includes(path)) {
        name = "patent-lookup"
        limit = 30
      }
      this.routes.set(endpoint, name)
      this.group(name, limit)
    }
    return endpoint
  }
  request(method: Method, path: string, data?: Bag, params?: Bag): Promise<Bag> {
    this.assertConfigured()
    const endpoint = this.endpoint(method, path)
    return new Promise((resolve, reject) => {
      this.pending.push({ method, path, endpoint, data, params, resolve, reject })
      this.pump()
    })
  }
  private pump() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    // 组内串行，账号最多三个在途；冷却中的分组不占 HTTP 槽位，不挡其他分组。
    while (this.active < 3) {
      const now = Date.now()
      const index = this.pending.findIndex(job => {
        const group = this.group(this.routes.get(job.endpoint)!)
        return !group.active && Math.max(group.nextAt, group.blockedUntil) <= now
      })
      if (index < 0) break
      const [job] = this.pending.splice(index, 1),
        group = this.group(this.routes.get(job.endpoint)!)
      this.active++
      group.active++
      group.nextAt = now + Math.ceil(60000 / group.limit) + 100
      void this.perform(job, group)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--
          group.active--
          this.pump()
        })
    }
    if (this.active >= 3) return
    const wakeAt = this.pending.reduce((earliest, job) => {
      const group = this.group(this.routes.get(job.endpoint)!)
      return group.active
        ? earliest
        : Math.min(earliest, Math.max(group.nextAt, group.blockedUntil))
    }, Infinity)
    if (Number.isFinite(wakeAt))
      this.timer = setTimeout(
        () => this.pump(),
        Math.min(2147483647, Math.max(1, wakeAt - Date.now()))
      )
  }
  private readLimits(job: PendingRequest, previous: Group, headers: Bag, rateLimited: boolean) {
    const now = Date.now(),
      route = str(headers["x-ratelimit-route"]).trim()
    const limit = positiveInteger(headers["x-ratelimit-limit"])
    const group = route ? this.group(route, limit ?? previous.limit) : previous
    if (route) this.routes.set(job.endpoint, route)
    if (limit) group.limit = limit
    // 分组变更时保留已消耗的间隔及冷却，待执行请求每次调度重新查映射。
    group.nextAt = Math.max(
      group.nextAt,
      previous.nextAt,
      now + Math.ceil(60000 / group.limit) + 100
    )
    group.blockedUntil = Math.max(group.blockedUntil, previous.blockedUntil)
    const reset = positiveInteger(headers["x-ratelimit-reset"])
    const resetAt = reset && Number.isFinite(reset * 1000) && reset * 1000 > now ? reset * 1000 : 0
    const rawRetry = headers["retry-after"]
    const seconds =
      typeof rawRetry === "number" || (typeof rawRetry === "string" && rawRetry.trim() !== "")
        ? Number(rawRetry)
        : NaN
    const retryAt =
      Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Date.parse(str(rawRetry))
    const rawRemaining = headers["x-ratelimit-remaining"]
    const remaining =
      rawRemaining === 0 || str(rawRemaining).trim() === "0" ? 0 : positiveInteger(rawRemaining)
    if (rateLimited || remaining === 0) {
      const until = Math.max(resetAt, Number.isFinite(retryAt) && retryAt > now ? retryAt : 0)
      group.blockedUntil = Math.max(group.blockedUntil, until || now + 60000)
    } else if (remaining && resetAt) {
      // 剩余额度可能被同账号的其他调用消耗；均匀分配至下一次重置。
      group.nextAt = Math.max(group.nextAt, now + Math.ceil((resetAt - now) / remaining) + 100)
    }
  }
  private async perform(job: PendingRequest, group: Group): Promise<Bag> {
    try {
      const r = await axios.request<unknown>({
        method: job.method,
        url: `https://api.trohub.com/v2${job.path}`,
        data: job.data,
        params: job.params,
        headers: { Authorization: `Bearer ${this.config.get<string>("TROHUB_API_KEY")!.trim()}` },
        timeout: 60000,
        maxRedirects: 0,
        validateStatus: () => true,
      })
      const body = obj(r.data),
        code = str(obj(body.error).code) || str(body.code)
      const error =
        r.status >= 400 || body.ok !== true ? new TrohubError(r.status, code) : undefined
      this.readLimits(job, group, obj(r.headers), error?.rateLimited === true)
      if (error) {
        const requestId = str(r.headers["x-request-id"])
        const clientRequestId = str(job.data?.clientRequestId)
        this.logger.warn({
          message: error.message,
          endpoint: job.endpoint,
          status: r.status,
          code: safeErrorCode(code) || "UNKNOWN",
          requestId: /^[A-Za-z0-9_-]{1,128}$/.test(requestId) ? requestId : undefined,
          clientRequestId: /^[A-Za-z0-9_-]{1,128}$/.test(clientRequestId)
            ? clientRequestId
            : undefined,
        })
        throw error
      }
      if (!body.data || Array.isArray(body.data) || typeof body.data !== "object")
        throw new TrohubError(502, "INVALID_RESULT", "检测结果格式不完整")
      return obj(body.data)
    } catch (e) {
      if (e instanceof TrohubError) throw e
      throw new TrohubError(0, "NETWORK_ERROR", "检测服务连接异常")
    }
  }
  submit(kind: Kind, body: Bag) {
    return this.request("POST", TROHUB_ROUTES[kind], body)
  }
  detail(kind: Kind, id: string) {
    return this.request("GET", `${TROHUB_ROUTES[kind]}/${encodeURIComponent(id)}`)
  }
  matches(kind: Kind, id: string, imageId: string, offset: number) {
    return this.request(
      "GET",
      `${TROHUB_ROUTES[kind]}/${encodeURIComponent(id)}/matches`,
      undefined,
      { imageId, offset, limit: 100 }
    )
  }
  patentDetail(pn: string, taskID: string) {
    return this.request("POST", "/ip/patent/detail", { patentNumbers: [pn], taskID })
  }
  citations(pn: string, direction: "cited" | "citedBy") {
    return this.request("POST", "/ip/patent/citation", {
      patentNumbers: [pn],
      includeCited: direction === "cited",
      includeCitedBy: direction === "citedBy",
      limit: 200,
    })
  }
}
