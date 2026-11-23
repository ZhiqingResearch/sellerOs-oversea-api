import { savedUiLanguage, withOutputLanguage } from "../../common/i18n/ai-language"
import { withUiLanguage } from "../../common/i18n/request-language"
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Prisma, type OpenApiApp } from "@prisma/client"
import { randomUUID } from "node:crypto"
import { PrismaService } from "../../prisma/prisma.service"
import { asJson } from "../automotive-audit/automotive-audit.types"
import {
  buildOptimizationRequest,
  object,
  optimizationModules,
  readOptimization,
  type OptimizationContext,
} from "./asin-optimization.kernel"

@Injectable()
export class AsinOptimizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService
  ) {}

  private async _load(app: OpenApiApp, taskId: string) {
    const task = await this.prisma.asinAuditTask.findFirst({
      where: { taskId, appId: app.appId },
      include: { optimization: { include: { payload: { select: { result: true } } } } },
    })
    if (!task)
      throw new NotFoundException({ code: "AUDIT_TASK_NOT_FOUND", message: "审计任务不存在" })
    const permitted =
      task.auditType === "COMPUTER" ? app.isComputerAuditEnabled : app.isAutomotiveAuditEnabled
    if (app.status !== "ACTIVE" || !permitted)
      throw new ForbiddenException({
        code: "AUDIT_OPTIMIZATION_FORBIDDEN",
        message: "当前接入方未开通该类目审计及优化权限",
      })
    // Do not load image bytes, original prompts or model transcripts on every polling request.
    const [stored] = await this.prisma.$queryRaw<{ phase: Prisma.JsonValue }[]>`
      SELECT JSON_OBJECT('state', JSON_EXTRACT(phases, '$.optimize.state'),
        'result', JSON_EXTRACT(phases, '$.optimize.result'),
        'outputGaps', JSON_EXTRACT(phases, '$.optimize.outputGaps'),
        'completedAt', JSON_EXTRACT(phases, '$.optimize.completedAt')) AS phase
      FROM AsinAuditTaskPayload WHERE taskId = ${task.id}`
    return { ...task, phase: object(stored?.phase) }
  }

  async get(app: OpenApiApp, taskId: string) {
    return this._present(await this._load(app, taskId))
  }

  async create(app: OpenApiApp, taskId: string) {
    const task = await this._load(app, taskId)
    const existing = this._present(task)
    // Read-only reuse includes PARTIAL historical drafts. Do not spend tokens filling old optional modules.
    if (task.optimization || existing.result || existing.status === "UNKNOWN") return existing
    if (["QUEUED", "RUNNING"].includes(task.status))
      throw new ConflictException({
        code: "AUDIT_NOT_READY",
        message: "原审计仍在执行，请先查询原任务，不重复启动优化",
      })
    if (!["COMPUTER", "AUTOMOTIVE"].includes(task.auditType))
      throw new ConflictException({
        code: "OPTIMIZATION_NOT_SUPPORTED",
        message: "该类目尚不支持优化",
      })
    const payload = await this.prisma.asinAuditTaskPayload.findUnique({
      where: { taskId: task.id },
      select: { config: true, input: true, normalizedInput: true, result: true },
    })
    const settings = object(payload?.config)
    const model = typeof settings.model === "string" ? settings.model.trim() : ""
    if (!model || !this.config.get<string>("AI_GATEWAY_API_KEY")?.trim())
      throw new ServiceUnavailableException({
        code: "OPTIMIZATION_MODEL_NOT_CONFIGURED",
        message: "优化模型尚未配置",
      })
    const [stored] = await this.prisma.$queryRaw<{ score: Prisma.JsonValue }[]>`
      SELECT JSON_EXTRACT(phases, '$.score.result') AS score FROM AsinAuditTaskPayload WHERE taskId = ${task.id}`
    const context: OptimizationContext = {
      responseLanguage: savedUiLanguage(settings.responseLanguage),
      auditType: task.auditType,
      asin: task.asin,
      marketplace: task.marketplace,
      input: object(payload?.input),
      normalizedInput: object(payload?.normalizedInput),
      score: object(stored?.score),
      auditResult: object(payload?.result),
    }
    const language = savedUiLanguage(context.responseLanguage)
    const request = withUiLanguage(language, () => buildOptimizationRequest(context))
    request.system = withOutputLanguage(request.system, language)
    try {
      await this.prisma.asinAuditOptimization.create({
        data: {
          taskId: task.id,
          optimizationId: `opt_${randomUUID()}`,
          model,
          payload: { create: { context: asJson(context), request: asJson(request) } },
        },
        select: { id: true },
      })
    } catch (error) {
      // Unique taskId is the durable idempotency key, including simultaneous submissions across servers.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"))
        throw error
    }
    return this.get(app, taskId)
  }

  private _present(task: Awaited<ReturnType<AsinOptimizationService["_load"]>>) {
    const job = task.optimization
    const phase = task.phase
    const historical = readOptimization(phase.result)
    const result = job ? readOptimization(job.payload?.result) : historical
    let status = job?.status ?? (result ? "COMPLETED" : "NOT_STARTED")
    let reason: string | null = null
    if (!job && !result && phase.state) {
      if (
        typeof phase.state === "string" &&
        ["SUBMITTING", "UNKNOWN", "RECEIVED"].includes(phase.state)
      ) {
        status = task.status === "RUNNING" ? "RUNNING" : "UNKNOWN"
        reason = "原审计优化调用尚未取得已校验成品；禁止重复生成，需核对原请求"
      } else if (phase.state === "FAILED" || phase.state === "COMPLETED") {
        status = "FAILED"
        reason = "原审计优化阶段没有可读取成品"
      }
    }
    if (status === "RECEIVED") status = "RUNNING"
    const outputGaps = !job && Array.isArray(phase.outputGaps) ? phase.outputGaps : []
    const modules = optimizationModules(result).map(item=>{
      const partial = item.status==="AVAILABLE" && outputGaps.some(g=>typeof g==="string" &&
        (g===item.path || g.startsWith(item.path+"[") || g.startsWith(item.path+".")))
      return partial ? {...item,status:"PARTIAL",reason:"已保留可校验条目，具体缺口见 outputGaps"} : item
    })
    const missingModules = modules.filter(item => item.status === "MISSING")
    const generatedAt =
      job?.completedAt ?? (typeof phase.completedAt === "string" ? phase.completedAt : null)
    return {
      taskId: task.taskId,
      optimizationId: job?.optimizationId ?? null,
      auditType: task.auditType,
      asin: task.asin,
      sku: task.sku || null,
      marketplace: task.marketplace,
      auditStatus: task.status,
      auditCompletedAt: task.completedAt,
      status,
      ...(outputGaps.length ? {outputGaps} : {}),
      contentStatus: result ? (outputGaps.length || missingModules.length ? "PARTIAL" : "COMPLETE") : "NOT_GENERATED",
      source: job ? "OPTIMIZATION_TASK" : result ? "AUDIT_OPTIMIZE_PHASE" : null,
      generatedAt: result ? generatedAt : null,
      generatedAtReason:
        result && !generatedAt
          ? "历史优化阶段未单独记录生成时间；auditCompletedAt为原审计完成时间"
          : null,
      createdAt: job?.createdAt ?? null,
      startedAt: job?.startedAt ?? null,
      completedAt: job?.completedAt ?? null,
      canGenerate:
        !job && !result && !["QUEUED", "RUNNING"].includes(task.status) && status !== "UNKNOWN",
      pollAfterMs: ["QUEUED", "RUNNING"].includes(status) ? 3000 : null,
      reason:
        reason ??
        (!result && status === "NOT_STARTED"
          ? "原任务尚未生成完整优化稿，可显式POST受理优化"
          : null),
      error:
        job?.error ??
        (status === "UNKNOWN" ? { code: "OPTIMIZATION_OUTCOME_UNKNOWN", message: reason } : null),
      modules,
      missingModules,
      result,
      boundaries: {
        imagesAndAplus: "PLANNING_TEXT_ONLY",
        keywords: "RECOMMENDED_NOT_OBSERVED",
        strategies: "RECOMMENDATIONS_NOT_VERIFIED_FACTS",
      },
    }
  }
}
