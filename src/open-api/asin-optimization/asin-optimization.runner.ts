import { savedUiLanguage } from "../../common/i18n/ai-language"
import { withUiLanguage } from "../../common/i18n/request-language"
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common"
import { Interval } from "@nestjs/schedule"
import { AiGatewayProvider } from "../../common/providers/ai-gateway.provider"
import { PrismaService } from "../../prisma/prisma.service"
import { AutomotiveAuditLockService } from "../automotive-audit/automotive-audit-lock.service"
import { asJson } from "../automotive-audit/automotive-audit.types"
import { finalizeOptimization, object, type OptimizationContext } from "./asin-optimization.kernel"

@Injectable()
export class AsinOptimizationRunner implements OnModuleDestroy {
  private readonly logger = new Logger(AsinOptimizationRunner.name)
  private isStopping = false
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayProvider,
    private readonly lock: AutomotiveAuditLockService
  ) {}

  onModuleDestroy() {
    this.isStopping = true
  }

  @Interval(3000)
  async tick() {
    if (this.isStopping || !this.lock.hasCapacity) return
    try {
      const pending = await this.prisma.asinAuditOptimization.findFirst({
        where: {
          id: { notIn: this.lock.activeIds("optimization") },
          status: { in: ["QUEUED", "RUNNING", "RECEIVED"] },
        },
        orderBy: { id: "asc" },
        select: { id: true },
      })
      if (!pending) return
      await this.lock.runJob("optimization", pending.id, async assertLock => {
        const job = await this.prisma.asinAuditOptimization.findFirst({
          where: { id: pending.id, status: { in: ["QUEUED", "RUNNING", "RECEIVED"] } },
          orderBy: { id: "asc" },
          include: { payload: true, task: true },
        })
        if (!job) return
        // With the shared DB lock acquired, RUNNING belongs to an interrupted worker, never a retry candidate.
        if (job.status === "RUNNING") {
          await this.prisma.asinAuditOptimization.update({
            where: { id: job.id },
            data: {
              status: "UNKNOWN",
              completedAt: new Date(),
              error: {
                code: "OPTIMIZATION_OUTCOME_UNKNOWN",
                message: "上次生成执行中断，结果待核对，不自动重新调用模型",
              },
            },
          })
          return
        }
        if (!job.payload) {
          await this.prisma.asinAuditOptimization.update({
            where: { id: job.id },
            data: {
              status: "FAILED",
              completedAt: new Date(),
              error: { code: "OPTIMIZATION_PAYLOAD_MISSING", message: "生成输入快照缺失" },
            },
          })
          return
        }
        const context = job.payload.context as unknown as OptimizationContext
        const request = object(job.payload.request)
        let text = job.payload.rawResponse ?? ""
        if (job.status === "QUEUED") {
          const app = await this.prisma.openApiApp.findUnique({ where: { appId: job.task.appId } })
          if (
            !app ||
            app.status !== "ACTIVE" ||
            !(job.task.auditType === "COMPUTER"
              ? app.isComputerAuditEnabled
              : app.isAutomotiveAuditEnabled)
          ) {
            await this.prisma.asinAuditOptimization.update({
              where: { id: job.id },
              data: {
                status: "FAILED",
                completedAt: new Date(),
                error: { code: "AUDIT_OPTIMIZATION_FORBIDDEN", message: "执行前接入权限已关闭" },
              },
            })
            return
          }
          await assertLock()
          const claimed = await this.prisma.asinAuditOptimization.updateMany({
            where: { id: job.id, status: "QUEUED" },
            data: { status: "RUNNING", startedAt: new Date() },
          })
          if (!claimed.count) return
          await assertLock()
          const usage: Record<string, unknown> = {}
          try {
            // streamChat makes one generation request; no JSON repair/model retry, no crawler, no scoring, no credit charge.
            for await (const event of this.gateway.streamChat(
              String(request.system),
              String(request.user),
              {
                model: job.model,
                temperature: 0,
                maxOutputTokens: 16000,
                resolveBilling: true,
                operationName: `开放ASIN优化:${job.optimizationId}`,
              }
            )) {
              if (event.type === "text") text += event.content
              if (event.type === "usage") usage.tokens = event.rawUsage ?? event.usage
              if (event.type === "billing") usage.billing = event.billing
            }
          } catch {
            await this.prisma.asinAuditOptimization.update({
              where: { id: job.id },
              data: {
                status: "UNKNOWN",
                completedAt: new Date(),
                error: {
                  code: "OPTIMIZATION_OUTCOME_UNKNOWN",
                  message: "模型连接中断或超时，保存原响应；不得自动重发，请核对原执行号",
                },
                payload: { update: { rawResponse: text, usage: asJson(usage) } },
              },
            })
            return
          }
          // Receipt and RECEIVED are committed atomically; a restarted worker only parses this saved response.
          await this.prisma.asinAuditOptimization.update({
            where: { id: job.id },
            data: {
              status: "RECEIVED",
              payload: { update: { rawResponse: text, usage: asJson(usage) } },
            },
          })
        }
        await assertLock()
        let result: ReturnType<typeof finalizeOptimization>
        try {
          result = withUiLanguage(savedUiLanguage(context.responseLanguage), () => finalizeOptimization(text, context))
        } catch {
          await this.prisma.asinAuditOptimization.update({
            where: { id: job.id },
            data: {
              status: "FAILED",
              completedAt: new Date(),
              error: {
                code: "OPTIMIZATION_RESPONSE_INVALID",
                message: "模型响应未通过成品校验，原文已保存，不自动重生成",
              },
            },
          })
          return
        }
        // A storage failure leaves RECEIVED recoverable; it is not a model validation failure.
        await this.prisma.asinAuditOptimization.update({
          where: { id: job.id },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            payload: { update: { result: asJson(result) } },
          },
        })
      })
    } catch {
      this.logger.error("优化调度中断，保留状态，禁止盲目重新调用")
    }
  }
}
