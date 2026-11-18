import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/library"
import { randomUUID } from "node:crypto"
import { uiText } from "../common/i18n/request-language"
import { CREDIT_PER_CNY } from "../membership/membership.constants"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { ENHANCE_PROMPT_VERSION } from "./prompts/enhance-prompt"
import { IMAGE_INFERENCE_PROMPT_VERSION } from "./prompts/image-inference"
import { TRANSLATE_PROMPT_VERSION } from "./prompts/translate-prompt"

/**
 * AiGatewayModel 目录类别（建行见 scripts/onboard-llm-toolbox-models.ts）：
 * 每个类别**恰好一条启用行**（enabled + gatewayActive），换模型 = 建新行/启用新行并
 * 停用旧行，代码零改动（与 AI_SPLIT_MULTIMODAL 同款约定）。
 */
export const LLM_TOOLBOX_CATEGORY = "LLM_TOOLBOX" // 一键润色 / 中英互译（文本模型）
export const LLM_TOOLBOX_MULTIMODAL_CATEGORY = "LLM_TOOLBOX_MULTIMODAL" // 由图推理（多模态模型）

/** 计费 source：复用已注册的 llm.generic（P0 §1.3，勿新造枚举） */
const LLM_TOOLBOX_USAGE_SOURCE = "llm.generic"

/** 流水 meta.feature 的展示名（对齐前端现有流水口径，P0 §1.3） */
const TOOL_FEATURE_LABELS = {
  enhance: "一键润色",
  translate: "中英互译",
  "image-inference": "由图推理",
} as const

export type ToolboxTool = keyof typeof TOOL_FEATURE_LABELS

const TOOL_PROMPT_VERSIONS = {
  enhance: ENHANCE_PROMPT_VERSION,
  translate: TRANSLATE_PROMPT_VERSION,
  "image-inference": IMAGE_INFERENCE_PROMPT_VERSION,
} as const

/** 类目解析结果：模型 + 一口价（实时读库，改库即生效） */
export interface ToolboxModel {
  publicId: string
  fixedCredits: Decimal
}

/**
 * 三件套模型解析与固定一口价计费（与图片/视频固定扣费同款逻辑）：
 * 类目单一启用行 → 预检（assertExactCreditsAffordable，service 编排）→ 成功后精确扣。
 * 扣费失败按 P0 现状降级：chargeFixed 返回 false 不抛错，响应 billingHandled:false。
 */
@Injectable()
export class LlmToolboxBilling {
  private readonly logger = new Logger(LlmToolboxBilling.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService
  ) {}

  /**
   * 按类别解析启用模型与一口价（fail-closed）：
   * 启用行数 ≠ 1 → 503（换模型请用 onboard 脚本切换启用行）；
   * fixedCredits 未配 / ≤0 → 503。
   */
  async resolveModel(category: string): Promise<ToolboxModel> {
    const rows = await this.prisma.aiGatewayModel.findMany({
      where: { category, enabled: true, gatewayActive: true },
      select: { publicId: true, fixedCredits: true },
      orderBy: { sortOrder: "asc" },
    })
    if (rows.length === 0) {
      throw new ServiceUnavailableException(
        uiText(
          `AiGatewayModel.${category} 无启用模型行，请先执行 scripts/onboard-llm-toolbox-models.ts 建行`,
          "No model is enabled for this tool. Please contact an administrator."
        )
      )
    }
    if (rows.length > 1) {
      throw new ServiceUnavailableException(
        uiText(
          `AiGatewayModel.${category} 启用了 ${rows.length} 行（${rows.map(r => r.publicId).join("、")}），应恰好为 1——换模型请启用新行并停用旧行`,
          "This tool has conflicting model settings. Please contact an administrator."
        )
      )
    }
    const row = rows[0]
    const credits = row.fixedCredits ? new Decimal(row.fixedCredits) : null
    if (!credits || !credits.greaterThan(0)) {
      throw new ServiceUnavailableException(
        uiText(
          `模型 ${row.publicId}（${category}）未配置有效一口价（fixedCredits 为空或 ≤0）`,
          `Model ${row.publicId} has no valid fixed credit price. Please contact an administrator.`
        )
      )
    }
    return { publicId: row.publicId, fixedCredits: credits }
  }

  /** 成功后扣费（幂等键后端生成）；失败仅记日志返回 false（降级，不阻断结果返回） */
  async chargeFixed(
    userId: number,
    model: string,
    credits: Decimal,
    opts: { tool: ToolboxTool; gatewayRequestId: string }
  ): Promise<boolean> {
    try {
      await this.usage.chargeModel(userId, credits.div(CREDIT_PER_CNY).toString(), {
        source: LLM_TOOLBOX_USAGE_SOURCE,
        model,
        exactCredits: credits.toString(),
        requestId: `toolbox:${opts.tool}:${randomUUID()}`,
        allowOverdraft: true,
        meta: {
          pricingMode: "fixed",
          fixedCredits: credits.toString(),
          fixedPricing: "飞书《SellerOS积分 → 图片视频积分扣除》2026-09-20",
          feature: TOOL_FEATURE_LABELS[opts.tool],
          credits: Number(credits.toString()),
          gatewayRequestId: opts.gatewayRequestId,
          promptVersion: TOOL_PROMPT_VERSIONS[opts.tool],
        },
      })
      return true
    } catch (err) {
      this.logger.error(
        `[llm-toolbox] 扣费失败（降级放行）：tool=${opts.tool} model=${model} credits=${credits.toString()} message=${err instanceof Error ? err.message : String(err)}`
      )
      return false
    }
  }
}
