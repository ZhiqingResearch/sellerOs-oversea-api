import { ApiHeader } from "@nestjs/swagger"
import { localizeErrorMessage, requestUiLanguage, uiText } from "../common/i18n/request-language"
// 视频分析 SSE 入口（P0 契约冻结 §5.2/§5.3）：
//   POST /api/video-analysis → text/event-stream
//   线格式：data: {JSON}\n\n；正常事件循环走完后发裸字面量 data: [DONE]\n\n；
//   error 事件后直接 close（无 [DONE]）；开流前校验失败走 HTTP 400 {"error": message}。

import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Header,
  HttpException,
  Post,
  Request,
  Res,
  UseFilters,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from "@nestjs/swagger"
import type { Request as ExpressRequest, Response } from "express"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { VideoAnalysisDto } from "./dto/video-analysis.dto"
import { VideoAnalysisModels } from "./video-analysis.models"
import { VideoAnalysisService, VideoAnalysisSseEvent } from "./video-analysis.service"

interface AuthedRequest {
  user: { id: number }
}

const SSE_HEARTBEAT_INTERVAL_MS = 15_000

/** 进流前 400 的错误包络：{"error": message}（P0 §5.1 文案在 models.ts 冻结） */
@Catch()
class VideoAnalysisErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>()
    if (exception instanceof HttpException) {
      const body = exception.getResponse()
      const rawMessage = typeof body === "string" ? body : (body as { message?: unknown }).message
      const message =
        typeof rawMessage === "string"
          ? rawMessage
          : Array.isArray(rawMessage) && typeof rawMessage[0] === "string"
            ? rawMessage[0]
            : exception.message
      res.status(exception.getStatus()).json({
        error: localizeErrorMessage(
          message,
          exception.getStatus(),
          requestUiLanguage(host.switchToHttp().getRequest<ExpressRequest>())
        ),
      })
      return
    }
    res.status(500).json({
      error: localizeErrorMessage(
        exception instanceof Error ? exception.message : "Internal Server Error",
        500,
        requestUiLanguage(host.switchToHttp().getRequest<ExpressRequest>())
      ),
    })
  }
}

@ApiTags("视频分析")
@ApiBearerAuth()
@ApiHeader({
  name: "Accept-Language",
  required: false,
  description: "界面/分析说明语言：en-US 或 zh-CN；未传保留中文",
})
@Controller("video-analysis")
@UseGuards(JwtAuthGuard)
@UseFilters(VideoAnalysisErrorFilter)
export class VideoAnalysisController {
  constructor(
    private readonly models: VideoAnalysisModels,
    private readonly service: VideoAnalysisService
  ) {}

  @Post()
  @ApiProduces("text/event-stream")
  @Header("X-Accel-Buffering", "no")
  @ApiOperation({
    summary: "视频分析（SSE：progress → usage → usage_detail → charge → result → [DONE]）",
    description:
      "成功结果自动保存，result 事件新增 recordId；同 chargeRequestId 重试返回已保存报告，不重复调用模型或扣费。",
  })
  async analyze(
    @Request() request: AuthedRequest,
    @Body() dto: VideoAnalysisDto,
    @Res() response: Response
  ): Promise<void> {
    // 冻结文案的 HTTP 层校验（https / duration / 白名单 / chargeRequestId），进流之前；
    // 白名单/默认模型/一口价/能力开关从 AiGatewayModel.VIDEO_ANALYSIS 启用行解析
    const model = await this.models.assertRequest(dto)

    await this.openStream(response, () => this.service.stream(dto, request.user.id, model))
  }

  /**
   * SSE 骨架（照抄 asin-audit openStream，P0 §5.2/§5.3）：
   * - 写前查 destroyed/writableEnded：客户端断开静默跳过，但生成器继续跑完（含扣费，防断开绕过扣费）
   * - error 事件后不发 result、不发 [DONE]，直接 close
   */
  private async openStream(
    response: Response,
    events: () => AsyncGenerator<VideoAnalysisSseEvent>
  ): Promise<void> {
    response.status(200)
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8")
    response.setHeader("Cache-Control", "no-cache, no-transform")
    response.setHeader("Connection", "keep-alive")
    response.flushHeaders()

    const writable = () => !response.destroyed && !response.writableEnded
    const heartbeatTimer = setInterval(() => {
      if (writable()) response.write(": heartbeat\n\n")
    }, SSE_HEARTBEAT_INTERVAL_MS)
    heartbeatTimer.unref()

    try {
      for await (const event of events()) {
        if (writable()) response.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      if (writable()) response.write("data: [DONE]\n\n")
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : uiText("视频分析调用失败", "Video analysis failed")
      if (writable())
        response.write(
          `data: ${JSON.stringify({ type: "error", message: localizeErrorMessage(message, error instanceof HttpException ? error.getStatus() : 502) })}\n\n`
        )
    } finally {
      clearInterval(heartbeatTimer)
      response.end()
    }
  }
}
