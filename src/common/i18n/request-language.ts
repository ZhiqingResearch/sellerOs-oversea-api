import type { NextFunction, Request, Response } from "express"
import { AsyncLocalStorage } from "node:async_hooks"

export type UiLanguage = "zh-CN" | "en-US"

const context = new AsyncLocalStorage<UiLanguage>()

export function uiLanguage(): UiLanguage {
  return context.getStore() ?? "zh-CN"
}

export function withUiLanguage<T>(language: UiLanguage, action: () => T): T {
  return context.run(language, action)
}

export function uiText(zh: string, en: string): string {
  return uiLanguage() === "en-US" ? en : zh
}

/** Only UI languages are negotiated here; marketplace copy and translation targets are independent. */
export function negotiateUiLanguage(header: string | undefined): UiLanguage {
  if (!header?.trim()) return "zh-CN"
  const preferences = header
    .split(",")
    .map((part, index) => {
      const [tag, ...parameters] = part.trim().split(";")
      const quality = parameters.find(value => value.trim().startsWith("q="))
      const q = quality === undefined ? 1 : Number(quality.trim().slice(2))
      return { tag: tag.toLowerCase(), q, index }
    })
    .filter(item => Number.isFinite(item.q) && item.q > 0 && item.q <= 1)
    .sort((a, b) => b.q - a.q || a.index - b.index)
  for (const { tag } of preferences) {
    if (tag === "en" || tag.startsWith("en-")) return "en-US"
    if (tag === "zh" || tag.startsWith("zh-")) return "zh-CN"
  }
  return "en-US"
}

export function requestUiLanguage(request: Pick<Request, "headers" | "url" | "body">): UiLanguage {
  // Keep the existing ASIN body parameter authoritative, including before DTO validation.
  if (/^\/api\/asin-audit(?:\/|\?|$)/.test(request.url)) {
    const body: unknown = request.body
    const explicit =
      body && typeof body === "object"
        ? (body as Record<string, unknown>).responseLanguage
        : undefined
    if (explicit === "en-US" || explicit === "zh-CN") return explicit
  }
  const header = request.headers?.["accept-language"]
  return negotiateUiLanguage(Array.isArray(header) ? header.join(",") : header)
}

export function requestLanguageMiddleware(
  request: Request,
  _response: Response,
  next: NextFunction
) {
  withUiLanguage(requestUiLanguage(request), next)
}

const ERROR_MESSAGES: Record<string, string> = {
  服务器内部错误: "Internal server error",
  "请求 JSON 格式不正确": "Invalid JSON request body",
  积分余额不足: "Insufficient credits",
  余额不足: "Insufficient credits",
  未登录: "Please sign in",
  "账号已停用，请联系管理员": "This account is disabled. Please contact an administrator.",
  字段值超出允许范围: "Field value exceeds the allowed range",
  目标记录不存在: "The requested record does not exist",
  "唯一约束冲突，数据已存在": "This record already exists",
  外键约束失败: "The referenced record does not exist",
  字段值无效: "Invalid field value",
  不能为空: "This field is required",
  缺少必需字段: "A required field is missing",
  关联关系冲突: "Conflicting record relationship",
  关联记录未找到: "The related record does not exist",
  数据库连接超时: "Database connection timed out",
  数据库操作异常: "Database operation failed",
}

/** Never expose untranslated upstream errors; retain the original exception in server logs. */
export function localizeErrorMessage(
  message: string,
  status = 500,
  language = uiLanguage()
): string {
  if (language !== "en-US" || !/\p{Script=Han}/u.test(message)) return message
  if (ERROR_MESSAGES[message]) return ERROR_MESSAGES[message]
  if (/积分.*不足|余额.*不足/.test(message))
    return "Insufficient credits. Please top up and try again."
  if (/缺少权限|无权|权限不足/.test(message))
    return "You do not have permission to perform this action."
  if (status === 401) return "Please sign in again."
  if (status === 403) return "You do not have permission to perform this action."
  if (status === 404) return "The requested resource was not found."
  if (status === 409)
    return "The request conflicts with the current state. Please refresh and try again."
  if (status === 429) return "Too many requests. Please try again later."
  if (status < 500)
    return "The request could not be completed. Please check your input and try again."
  return "The service is temporarily unavailable. Please try again later."
}

/** Only task error fields are display text; payloads, prompts and saved results stay untouched. */
export function localizedTaskErrors<T extends object>(row: T): T {
  const result = { ...row } as T & Record<string, unknown>
  for (const field of ["error", "errorMessage"] as const) {
    const message = result[field]
    if (typeof message === "string" && message)
      (result as Record<string, unknown>)[field] = localizeErrorMessage(message)
  }
  return result
}
