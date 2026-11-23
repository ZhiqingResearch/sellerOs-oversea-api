/** 能力标识（计费 meta.action 与日志用） */
export type AsinAuditAction = "review-pain-points" | "review-analysis" | "score" | "optimize"

/** 固定一口价模型：Gemini 3.8 Flash；计费仍兼容旧 ZQ-Think-Flash。 */
export const FIXED_CREDITS_MODEL = "ZQ-Multimodal-Gemini-3.8-Flash"
export type AsinAuditFixedStage = "evidence" | "score" | "optimize"
/** 审计链取证不另扣，由评分 20 积分覆盖；独立取证模块为 5 积分。 */
export const ASIN_AUDIT_FIXED_CREDITS: Record<AsinAuditFixedStage, number> = {
  evidence: 5,
  score: 20,
  optimize: 15,
}

const ACTION_LABEL: Record<AsinAuditAction, string> = {
  "review-pain-points": "评论痛点",
  "review-analysis": "评论分析",
  score: "审计打分",
  optimize: "优化交付物",
}

export function asinAuditActionLabel(action: AsinAuditAction): string {
  return ACTION_LABEL[action]
}

/** 下发给前端的 SSE 事件（[DONE] 与 error 由控制器收尾） */
export type AsinAuditSseEvent =
  | { type: "thinking" | "text"; content: string }
  | {
      type: "usage"
      usage: {
        promptTokens: number
        completionTokens: number
        thinkingTokens: number
        totalTokens: number
      }
    }
  | { type: "result"; data: unknown; billingHandled: boolean; requestId: string }
