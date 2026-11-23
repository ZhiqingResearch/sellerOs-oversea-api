import { localizeErrorMessage, uiText } from "../common/i18n/request-language"
import { UPSTREAM_QUOTA_CODE, quotaMessage } from "../common/errors/upstream-quota"
/** 面向用户的组合失败提示；技术详情保留在 Call 账本中。 */
export const COMPOSITION_INVALID_MESSAGE =
  "本次未能完成组合，请点击「重新组织」再试一次，已选内容会保留。"

export const TEXT_TIMEOUT_MESSAGE = "等待超时，请重试。"
export const BREAKDOWN_UNRELATED_MESSAGE = "上传图片明显与当前商品无关，请上传该商品的相关素材。"

interface GenerationError {
  status?: string | null
  errorCode?: string | null
  errorMessage?: string | null
}

/** 联想读接口只输出产品提示；原始模型、校验及服务错误留在数据库中排查。 */
function ideationErrorMessage(error: GenerationError, fallback: string): string | null {
  if (error.errorCode === UPSTREAM_QUOTA_CODE) return error.errorMessage ?? quotaMessage("unknown", "step")
  if (error.errorCode === "PROVIDER_TIMEOUT") return uiText(TEXT_TIMEOUT_MESSAGE, "Timed out. Please retry.")
  if (
    error.errorCode === "CALL_STATUS_UNKNOWN" ||
    error.status === "UNKNOWN" ||
    error.status === "WAITING_RECONCILIATION"
  ) {
    return uiText("生成结果正在核对，请稍后查看，暂勿重复提交。", "The generation result is being reconciled. Check again later and do not submit it again.")
  }
  if (error.status === "CANCELLED") return uiText("本次生成已取消。", "This generation was cancelled.")
  if (!error.errorCode && !error.errorMessage && error.status !== "FAILED") return null
  return fallback
}

export function groupErrorMessage(group: GenerationError): string | null {
  return ideationErrorMessage(group, uiText("该维度暂未生成可用方案，请点击「重试该维度」。", "No usable options were generated for this dimension. Select Retry dimension."))
}

/** 读路径兼容历史技术错误，不改写历史记录；待核对状态单独提示。 */
export function taskErrorMessage(task: GenerationError & { type: string }): string | null {
  if (task.errorCode === UPSTREAM_QUOTA_CODE) return task.errorMessage ?? quotaMessage("unknown", "step")
  if (task.type === "BREAKDOWN" && task.errorCode === "IMAGE_UNRELATED_TO_SKU") {
    return uiText(BREAKDOWN_UNRELATED_MESSAGE, "The uploaded image is unrelated to this product. Upload relevant product materials.")
  }
  if (task.type === "BREAKDOWN" && task.status === "FAILED") return uiText("与母版差异太大", "The image differs too much from the master template")
  if (task.errorCode === "PROVIDER_TIMEOUT") return uiText(TEXT_TIMEOUT_MESSAGE, "Timed out. Please retry.")
  const ideationMessages: Record<string, string> = {
    IDEATION: uiText("本次联想未能完成，请稍后重试，已生成的方案会保留。", "Ideation could not be completed. Retry later; generated options will be retained."),
    REFRESH_GROUP: uiText("本次未能更新选项，请稍后重试，原有方案会保留。", "Options could not be refreshed. Retry later; existing options will be retained."),
    DIVERGE: uiText("本次未能生成扩展方案，请稍后重试。", "Additional options could not be generated. Please retry later."),
  }
  if (ideationMessages[task.type]) {
    return ideationErrorMessage(task, ideationMessages[task.type])
  }
  if (
    task.type === "COMPOSE" &&
    (task.errorCode === "MODEL_OUTPUT_INVALID" ||
      /^组合输出不合格[:：]/.test(task.errorMessage ?? ""))
  ) {
    return uiText(COMPOSITION_INVALID_MESSAGE, "Composition could not be completed. Select Recompose to retry; your selections will be retained.")
  }
  return task.errorMessage ? localizeErrorMessage(task.errorMessage) : null
}
