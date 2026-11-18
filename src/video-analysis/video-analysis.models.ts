import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/library"
import { uiText } from "../common/i18n/request-language"
import { PrismaService } from "../prisma/prisma.service"
import type { VideoAnalysisDto } from "./dto/video-analysis.dto"

/**
 * 视频分析模型目录（AiGatewayModel.VIDEO_ANALYSIS 类别统一管理，代码不写死模型）：
 * - 白名单 = 该类别全部启用行（enabled + gatewayActive）
 * - 默认模型 = 启用行中 sortOrder 最小者
 * - 一口价 = 行上 fixedCredits（实时读库，改库即生效）
 * - 能力开关 = 行上 gatewayConfig.videoAnalysis（onboard 脚本写入；缺省 fail-closed，
 *   防止换模型后 mime_type/response_format/音频行为静默错乱）
 *
 * 换模型：建新行（onboard 脚本）→ 前端 model 字段传新 publicId 即入白名单；
 * 下架模型：停用旧行即从白名单移除。
 */
export const VIDEO_ANALYSIS_CATEGORY = "VIDEO_ANALYSIS"

/** 「模型没收到视频」守卫阈值：50 token/秒（约为实测值的 1/8，P0 §5.5 附） */
const VIDEO_TOKENS_PER_SECOND_THRESHOLD = 50

/** 单条视频时长上限：10 分钟（P0 §5.1 冻结） */
export const MAX_ANALYSIS_DURATION_SECONDS = 600

/** focus 服务端截断长度（P0 §5.1） */
export const FOCUS_MAX_LENGTH = 500

export interface VideoAnalysisModel {
  publicId: string
  fixedCredits: Decimal
  supportsAudio: boolean
  sendsMimeType: boolean
  supportsJsonMode: boolean
  promptTokensIncludeVideo: boolean
}

@Injectable()
export class VideoAnalysisModels {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 进流之前的 HTTP 层校验（P0 §5.1，文案逐字冻结）+ 模型解析：
   * 结构校验 / 白名单 / 默认模型在这里抛 400，配置缺失抛 503，
   * 由 controller 级过滤器渲染 {"error": message}。返回解析后的模型行。
   */
  async assertRequest(dto: VideoAnalysisDto): Promise<VideoAnalysisModel> {
    if (typeof dto.videoUrl !== "string" || !/^https:\/\//i.test(dto.videoUrl)) {
      throw new BadRequestException(
        uiText(
          "videoUrl 必填，且必须是公网可访问的 https 地址",
          "videoUrl is required and must be a publicly accessible HTTPS URL"
        )
      )
    }
    const duration = Number(dto.duration)
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new BadRequestException(
        uiText("duration 必填且必须大于 0", "duration is required and must be greater than 0")
      )
    }
    if (duration > MAX_ANALYSIS_DURATION_SECONDS) {
      throw new BadRequestException(
        uiText("单条视频时长不能超过 10 分钟", "A video cannot exceed 10 minutes")
      )
    }
    if (typeof dto.chargeRequestId !== "string" || dto.chargeRequestId.trim().length === 0) {
      throw new BadRequestException(
        uiText(
          "chargeRequestId 必填（前端进流前生成，重试复用以防重复扣费）",
          "chargeRequestId is required. Generate it before starting the stream and reuse it for retries."
        )
      )
    }

    const rows = await this.prisma.aiGatewayModel.findMany({
      where: { category: VIDEO_ANALYSIS_CATEGORY, enabled: true, gatewayActive: true },
      select: { publicId: true, fixedCredits: true, sortOrder: true, gatewayConfig: true },
      orderBy: { sortOrder: "asc" },
    })
    if (rows.length === 0) {
      throw new ServiceUnavailableException(
        uiText(
          `AiGatewayModel.${VIDEO_ANALYSIS_CATEGORY} 无启用模型行，请先执行 scripts/onboard-llm-toolbox-models.ts 建行`,
          "No video-analysis model is enabled. Please contact an administrator."
        )
      )
    }

    const requested = dto.model?.trim()
    const row = requested ? rows.find(r => r.publicId === requested) : rows[0] // 缺省 → sortOrder 最小的启用行
    if (!row) {
      throw new BadRequestException(
        uiText(
          `不支持的模型：${requested}。可选：${rows.map(r => r.publicId).join(" / ")}`,
          `Unsupported model: ${requested}. Available models: ${rows.map(r => r.publicId).join(" / ")}`
        )
      )
    }
    return this.toModel(row)
  }

  /** 行 → 模型（能力开关/一口价缺失一律 fail-closed，给出可操作的报错） */
  private toModel(row: {
    publicId: string
    fixedCredits: Decimal | null
    gatewayConfig: unknown
  }): VideoAnalysisModel {
    const credits = row.fixedCredits ? new Decimal(row.fixedCredits) : null
    if (!credits || !credits.greaterThan(0)) {
      throw new ServiceUnavailableException(
        uiText(
          `模型 ${row.publicId}（${VIDEO_ANALYSIS_CATEGORY}）未配置有效一口价（fixedCredits 为空或 ≤0）`,
          `Model ${row.publicId} has no valid fixed credit price. Please contact an administrator.`
        )
      )
    }
    const caps = (row.gatewayConfig as { videoAnalysis?: Record<string, unknown> } | null)
      ?.videoAnalysis
    const flag = (key: string): boolean | undefined => {
      const value = caps?.[key]
      return typeof value === "boolean" ? value : undefined
    }
    const supportsAudio = flag("supportsAudio")
    const sendsMimeType = flag("sendsMimeType")
    const supportsJsonMode = flag("supportsJsonMode")
    const promptTokensIncludeVideo = flag("promptTokensIncludeVideo")
    if (
      supportsAudio === undefined ||
      sendsMimeType === undefined ||
      supportsJsonMode === undefined ||
      promptTokensIncludeVideo === undefined
    ) {
      throw new ServiceUnavailableException(
        uiText(
          `模型 ${row.publicId}（${VIDEO_ANALYSIS_CATEGORY}）缺少能力开关配置（gatewayConfig.videoAnalysis 需含 supportsAudio/sendsMimeType/supportsJsonMode/promptTokensIncludeVideo 四布尔值，用 onboard 脚本建行写入）`,
          `Model ${row.publicId} is missing video-analysis capability settings. Please contact an administrator.`
        )
      )
    }
    return {
      publicId: row.publicId,
      fixedCredits: credits,
      supportsAudio,
      sendsMimeType,
      supportsJsonMode,
      promptTokensIncludeVideo,
    }
  }
}

/** 「模型没收到视频」守卫（仅 promptTokensIncludeVideo 模型启用；触发发 error 而非 result） */
export function isVideoPayloadMissing(
  model: VideoAnalysisModel,
  promptTokens: number,
  durationSec: number
): boolean {
  if (!model.promptTokensIncludeVideo) return false
  return promptTokens < VIDEO_TOKENS_PER_SECOND_THRESHOLD * durationSec
}

const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
}

/** mimeType 缺省时按 URL 扩展名推导（照前端 resolveVideoMimeType，P0 §5.1） */
export function resolveVideoMimeType(videoUrl: string, mimeType?: string): string {
  const explicit = mimeType?.trim()
  if (explicit) return explicit
  const path = videoUrl.split("?")[0]?.toLowerCase() ?? ""
  const dot = path.lastIndexOf(".")
  const extension = dot >= 0 ? path.slice(dot) : ""
  return VIDEO_MIME_BY_EXTENSION[extension] ?? "video/mp4"
}
