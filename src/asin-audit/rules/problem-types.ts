import { uiText } from "../../common/i18n/request-language"
import type { AuditGrade } from "../types/audit.types"

/**
 * ASIN 审计等级（v2.0 §四.1）：≥85 优秀 / ≥70 良好 / ≥50 一般 / <50 待优化。
 * 旧 S/A/B+/B/C 与四类问题分数推导（problemTypes）已随十维契约废弃。
 */

export function auditGrade(score: number): AuditGrade {
  if (score >= 85) return "EXCELLENT"
  if (score >= 70) return "GOOD"
  if (score >= 50) return "FAIR"
  return "POOR"
}

export function auditGradeLabel(grade: AuditGrade): string {
  const map: Record<AuditGrade, string> = {
    EXCELLENT: uiText("优秀", "Excellent"),
    GOOD: uiText("良好", "Good"),
    FAIR: uiText("一般", "Fair"),
    POOR: uiText("待优化", "Needs improvement"),
  }
  return map[grade]
}

/** 分档话术（v2.0 §五：≥85 整体健康 / ≥70 基本盘可用 / ≥50 存在明显短板 / <50 系统性重做） */
export function auditGradeNarrative(grade: AuditGrade): string {
  const map: Record<AuditGrade, string> = {
    EXCELLENT: uiText(
      "整体健康，按建议精进即可",
      "Healthy overall; refine using the recommendations"
    ),
    GOOD: uiText(
      "基本盘可用，需补 1–2 处短板",
      "A workable foundation with one or two gaps to address"
    ),
    FAIR: uiText(
      "存在明显短板，建议按优先级逐项修",
      "Significant gaps exist; address them in priority order"
    ),
    POOR: uiText(
      "多域同时失分，需要一轮系统性重做",
      "Multiple areas need improvement; a systematic revision is recommended"
    ),
  }
  return map[grade]
}
