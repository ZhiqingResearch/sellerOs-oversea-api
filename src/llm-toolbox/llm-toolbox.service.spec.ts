import { UpstreamQuotaError } from "../common/errors/upstream-quota"
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/library"
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import { withUiLanguage } from "../common/i18n/request-language"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import {
  LLM_TOOLBOX_CATEGORY,
  LLM_TOOLBOX_MULTIMODAL_CATEGORY,
  LlmToolboxBilling,
} from "./llm-toolbox.billing"
import { LlmToolboxService } from "./llm-toolbox.service"
import { ENHANCE_SYSTEM_PROMPT_EN, IMAGE_INFERENCE_SYSTEM_PROMPT_EN } from "./prompts/english"
import { TRANSLATE_TO_ZH_SYSTEM_PROMPT } from "./prompts/translate-prompt"

const CREDITS = new Decimal(2)
const TEXT_MODEL = "ZQ-Think-Flash"
const MULTIMODAL_MODEL = "ZQ-Multimodal-Gemini-3.1-Pro"

/** AiGatewayModel 单一启用行（类目解析的返回形状） */
function modelRow(publicId: string, fixedCredits: Decimal | null = CREDITS) {
  return { publicId, fixedCredits }
}

function completion(content: string, usage?: Record<string, unknown>) {
  return {
    choices: [{ message: { content } }],
    ...(usage ? { usage } : {}),
  }
}

describe("LlmToolboxService（模型/一口价走 AiGatewayModel 类目解析）", () => {
  let gateway: { completeMultimodal: jest.Mock }
  let usage: {
    assertExactCreditsAffordable: jest.Mock
    chargeModel: jest.Mock
  }
  let aiGatewayModel: { findMany: jest.Mock }
  let service: LlmToolboxService

  beforeEach(() => {
    gateway = { completeMultimodal: jest.fn() }
    usage = {
      assertExactCreditsAffordable: jest.fn().mockResolvedValue(undefined),
      chargeModel: jest.fn().mockResolvedValue({
        costCny: new Decimal("0.2"),
        creditsCharged: CREDITS,
        balance: new Decimal(100),
        breakdown: [],
      }),
    }
    aiGatewayModel = {
      findMany: jest.fn().mockResolvedValue([modelRow(TEXT_MODEL)]),
    }
    const billing = new LlmToolboxBilling(
      { aiGatewayModel } as unknown as PrismaService,
      usage as unknown as UsageService
    )
    service = new LlmToolboxService(
      gateway as unknown as AiGatewayProvider,
      usage as unknown as UsageService,
      billing
    )
  })

  /** chargeModel 第 1 次调用的 (userId, costCny, params)，收窄避免 any 访问 */
  const chargeCall = (): [
    number,
    string,
    {
      source: string
      model: string
      exactCredits: string
      requestId?: string
      allowOverdraft?: boolean
      meta: Record<string, unknown>
    },
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  ] => usage.chargeModel.mock.calls[0]

  const chargeParams = () => chargeCall()[2]

  /** completeMultimodal 第 index 次调用的请求体（首个入参），收窄避免 any 访问 */
  const gatewayCall = (
    index = 0
  ): {
    model: string
    temperature: number
    messages: { role: string; content: unknown }[]
  } => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return gateway.completeMultimodal.mock.calls[index][0]
  }

  it("英文界面使用英文润色指令，空回复不回显中文且不扣费", async () => {
    gateway.completeMultimodal.mockResolvedValue({ completion: completion(""), requestId: "empty" })
    await expect(
      withUiLanguage("en-US", () => service.enhance(7, { prompt: "一只猫" }))
    ).rejects.toThrow("empty prompt")
    expect(gatewayCall().messages[0].content).toBe(ENHANCE_SYSTEM_PROMPT_EN)
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("英文由图推理保留两段协议并识别英文 Subject 备用分隔", async () => {
    gateway.completeMultimodal.mockResolvedValue({
      completion: completion("A cat on a sofa.\n[Subject]: A cat\n[Details]: Soft fur"),
      requestId: "english-image",
    })
    const result = await withUiLanguage("en-US", () =>
      service.imageInference(7, {
        buffer: Buffer.from("image"),
        mimetype: "image/png",
        size: 5,
        originalname: "cat.png",
      })
    )
    expect(gatewayCall().messages[0].content).toBe(IMAGE_INFERENCE_SYSTEM_PROMPT_EN)
    expect(result.visualDescription).toBe("A cat on a sofa.")
    expect(result.structuredPrompt).toContain("[Subject]: A cat")
  })

  it("英文界面不覆盖明确的英译中目标方向", async () => {
    gateway.completeMultimodal.mockResolvedValue({
      completion: completion("一只猫"),
      requestId: "translate-zh",
    })
    const result = await withUiLanguage("en-US", () =>
      service.translate(7, { prompt: "A cat", direction: "en-to-zh" })
    )
    expect(gatewayCall().messages[0].content).toBe(TRANSLATE_TO_ZH_SYSTEM_PROMPT)
    expect(result.translated).toBe("一只猫")
  })

  it("英文由图推理遇到空回复返回错误且不扣费", async () => {
    gateway.completeMultimodal.mockResolvedValue({
      completion: completion(""),
      requestId: "empty-image",
    })
    await expect(
      withUiLanguage("en-US", () =>
        service.imageInference(7, {
          buffer: Buffer.from("image"),
          mimetype: "image/png",
          size: 5,
          originalname: "cat.png",
        })
      )
    ).rejects.toThrow("empty image analysis")
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  describe("enhance", () => {
    it("happy path：模型取自类目启用行，响应/扣费入参符合一口价口径", async () => {
      gateway.completeMultimodal.mockResolvedValue({
        completion: completion("增强后的文案", {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        }),
        requestId: "gw-req-1",
      })

      const result = await service.enhance(7, { prompt: "一只猫在沙发上" })

      expect(aiGatewayModel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { category: LLM_TOOLBOX_CATEGORY, enabled: true, gatewayActive: true },
        })
      )
      expect(result).toEqual({
        enhanced: "增强后的文案",
        tokenUsage: {
          promptTokens: 10,
          completionTokens: 20,
          thinkingTokens: 0,
          totalTokens: 30,
        },
        billingHandled: true,
      })
      expect(gateway.completeMultimodal).toHaveBeenCalledWith(
        expect.objectContaining({ model: TEXT_MODEL, temperature: 0.7 })
      )
      expect(usage.chargeModel).toHaveBeenCalledTimes(1)
      expect(chargeCall()[0]).toBe(7)
      expect(chargeCall()[1]).toBe("0.2")
      expect(chargeParams()).toMatchObject({
        source: "llm.generic",
        model: TEXT_MODEL,
        exactCredits: "2",
        allowOverdraft: true,
      })
      expect(chargeParams().requestId).toMatch(/^toolbox:enhance:[0-9a-f-]{36}$/)
      expect(chargeParams().meta).toMatchObject({
        pricingMode: "fixed",
        feature: "一键润色",
        gatewayRequestId: "gw-req-1",
      })
    })

    it("网关未回 usage → 响应省略 tokenUsage 字段", async () => {
      gateway.completeMultimodal.mockResolvedValue({
        completion: completion("结果"),
        requestId: "gw-req-2",
      })

      const result = await service.enhance(7, { prompt: "原文" })

      expect(result).not.toHaveProperty("tokenUsage")
    })

    it("空回复兜底：回显原始 prompt", async () => {
      gateway.completeMultimodal.mockResolvedValue({
        completion: completion("   "),
        requestId: "gw-req-3",
      })

      const result = await service.enhance(7, { prompt: "原始文案" })

      expect(result.enhanced).toBe("原始文案")
    })

    it("prompt 缺失/空白 → 400 文案冻结，网关与扣费均未调用", async () => {
      await expect(service.enhance(7, { prompt: "   " })).rejects.toThrow(
        new BadRequestException("`prompt` is required")
      )
      expect(gateway.completeMultimodal).not.toHaveBeenCalled()
      expect(usage.chargeModel).not.toHaveBeenCalled()
    })

    it("类目无启用行 → 503 fail-closed，不触网关", async () => {
      aiGatewayModel.findMany.mockResolvedValue([])

      await expect(service.enhance(7, { prompt: "x" })).rejects.toThrow(ServiceUnavailableException)
      expect(gateway.completeMultimodal).not.toHaveBeenCalled()
    })

    it("类目启用多行 → 503（单槽类目应恰好一条启用行）", async () => {
      aiGatewayModel.findMany.mockResolvedValue([modelRow(TEXT_MODEL), modelRow("Another-Model")])

      await expect(service.enhance(7, { prompt: "x" })).rejects.toThrow(/应恰好为 1/)
      expect(gateway.completeMultimodal).not.toHaveBeenCalled()
    })

    it("启用行未配一口价 → 503 fail-closed", async () => {
      aiGatewayModel.findMany.mockResolvedValue([modelRow(TEXT_MODEL, null)])

      await expect(service.enhance(7, { prompt: "x" })).rejects.toThrow(/未配置有效一口价/)
      expect(gateway.completeMultimodal).not.toHaveBeenCalled()
    })

    it("预检不足 → 400，网关与扣费均未调用", async () => {
      usage.assertExactCreditsAffordable.mockRejectedValue(new BadRequestException("积分余额不足"))

      await expect(service.enhance(7, { prompt: "x" })).rejects.toThrow(BadRequestException)
      expect(gateway.completeMultimodal).not.toHaveBeenCalled()
      expect(usage.chargeModel).not.toHaveBeenCalled()
    })

    it("扣费失败 → 降级：结果照返 billingHandled=false", async () => {
      gateway.completeMultimodal.mockResolvedValue({
        completion: completion("结果"),
        requestId: "gw-req-4",
      })
      usage.chargeModel.mockRejectedValue(new Error("扣费服务异常"))

      const result = await service.enhance(7, { prompt: "原文" })

      expect(result.enhanced).toBe("结果")
      expect(result.billingHandled).toBe(false)
    })
  })

  describe("translate", () => {
    it("direction=en-to-zh → 用英译中提示词，temperature 0.1", async () => {
      gateway.completeMultimodal.mockResolvedValue({
        completion: completion("一只猫"),
        requestId: "gw-req-5",
      })

      await service.translate(7, { prompt: "a cat", direction: "en-to-zh" })

      const request = gatewayCall()
      expect(request.messages[0].content).toBe(TRANSLATE_TO_ZH_SYSTEM_PROMPT)
      expect(request.temperature).toBe(0.1)
      expect(chargeParams().meta.feature).toBe("中英互译")
    })

    it("direction 缺省/拼错 → 静默回落 zh-to-en（不报错）", async () => {
      gateway.completeMultimodal.mockResolvedValue({
        completion: completion("a cat"),
        requestId: "gw-req-6",
      })

      await expect(service.translate(7, { prompt: "一只猫" })).resolves.toMatchObject({
        translated: "a cat",
      })
      await expect(
        service.translate(7, { prompt: "一只猫", direction: "zh_2_en-typo" })
      ).resolves.toMatchObject({ billingHandled: true })
      expect(gateway.completeMultimodal).toHaveBeenCalledTimes(2)
    })
  })

  describe("imageInference", () => {
    const file = {
      buffer: Buffer.from("fake-image"),
      mimetype: "image/png",
      size: 10,
      originalname: "a.png",
    }

    it("happy path：模型取自 LLM_TOOLBOX_MULTIMODAL 类目，dataUrl 部件在前、followUp 在后", async () => {
      aiGatewayModel.findMany.mockResolvedValue([modelRow(MULTIMODAL_MODEL)])
      gateway.completeMultimodal.mockResolvedValue({
        completion: completion("视觉复述\n\n---\n\n[主体]: 橘猫", {
          prompt_tokens: 1,
          completion_tokens: 2,
        }),
        requestId: "gw-req-7",
      })

      const result = await service.imageInference(7, file)

      expect(aiGatewayModel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { category: LLM_TOOLBOX_MULTIMODAL_CATEGORY, enabled: true, gatewayActive: true },
        })
      )
      expect(result).toEqual({
        visualDescription: "视觉复述",
        structuredPrompt: "[主体]: 橘猫",
        raw: "视觉复述\n\n---\n\n[主体]: 橘猫",
        tokenUsage: {
          promptTokens: 1,
          completionTokens: 2,
          thinkingTokens: 0,
          totalTokens: 3,
        },
        billingHandled: true,
      })
      const request = gatewayCall()
      expect(request.model).toBe(MULTIMODAL_MODEL)
      expect(request.temperature).toBe(0.2)
      const parts = request.messages[1].content as unknown[]
      expect(parts[0]).toEqual({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${file.buffer.toString("base64")}` },
      })
      expect((parts[1] as { type: string }).type).toBe("text")
      expect(chargeParams().meta.feature).toBe("由图推理")
    })

    it("mimetype 缺失回落 image/png（无白名单校验）", async () => {
      aiGatewayModel.findMany.mockResolvedValue([modelRow(MULTIMODAL_MODEL)])
      gateway.completeMultimodal.mockResolvedValue({
        completion: completion("x"),
        requestId: "gw-req-8",
      })

      await service.imageInference(7, { ...file, mimetype: "" })

      const parts = gatewayCall().messages[1].content as {
        image_url: { url: string }
      }[]
      expect(parts[0].image_url.url).toMatch(/^data:image\/png;base64,/)
    })

    it("未传文件 → 400 冻结文案", async () => {
      await expect(service.imageInference(7, undefined)).rejects.toThrow(
        new BadRequestException("Reference image (`image`) is required")
      )
      expect(gateway.completeMultimodal).not.toHaveBeenCalled()
    })

    it("文件读取失败（空 buffer）→ 400 冻结文案", async () => {
      await expect(service.imageInference(7, { ...file, buffer: Buffer.alloc(0) })).rejects.toThrow(
        new BadRequestException("Failed to read reference image")
      )
    })

    it("空回复无回显兜底 → 三字段空串", async () => {
      aiGatewayModel.findMany.mockResolvedValue([modelRow(MULTIMODAL_MODEL)])
      gateway.completeMultimodal.mockResolvedValue({
        completion: completion(""),
        requestId: "gw-req-9",
      })

      const result = await service.imageInference(7, file)

      expect(result).toMatchObject({
        visualDescription: "",
        structuredPrompt: "",
        raw: "",
        billingHandled: true,
      })
    })
  })
  it("网关额度拒绝时提示未扣积分，保持用户余额预检与扣费分离", async () => {
    gateway.completeMultimodal.mockRejectedValue(new UpstreamQuotaError("ai-gateway"))
    await expect(service.enhance(7, { prompt: "一只猫" })).rejects.toThrow("数据未获取，未扣除积分")
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

})
