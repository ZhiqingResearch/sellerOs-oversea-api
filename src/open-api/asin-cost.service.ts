import { uiText } from "../common/i18n/request-language"
import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common"
import { Interval } from "@nestjs/schedule"
import { Prisma, UsageType } from "@prisma/client"
import { CreditService } from "../membership/credit.service"
import { PricingService } from "../pricing/pricing.service"
import { PrismaService } from "../prisma/prisma.service"
import {
  auditCostKey,
  costEndpoint,
  costObject,
  evidenceCallUsage,
  mcpEstimate,
  modelCostUsage,
} from "./asin-cost.kernel"

type CostEntry = {
  provider: string
  sourceId: string
  state: string
  model: string | null
  costCny: Prisma.Decimal | null
  costStatus: string
  usage: Record<string, unknown>
  occurredAt: Date
}

/** Only reads stored receipts. Never calls a provider, deducts credits or changes audit state. */
@Injectable()
export class AsinCostService {
  private readonly logger = new Logger(AsinCostService.name)
  private isRunning = false

  constructor(
    private readonly prisma: PrismaService,
    private readonly credit: CreditService,
    private readonly pricing: PricingService
  ) {}

  async resolveOwner(app: { asinAuditCostUserId?: number | null }): Promise<number | null> {
    if (app.asinAuditCostUserId == null) return null
    const user = await this.prisma.user.findUnique({
      where: { id: app.asinAuditCostUserId },
      select: { id: true, isActive: true },
    })
    if (!user?.isActive)
      throw new ServiceUnavailableException({
        code: "AUDIT_COST_ACCOUNT_UNAVAILABLE",
        message: uiText("审计成本归属账号不存在或已停用", "The audit cost account is missing or inactive."),
      })
    return user.id
  }

  @Interval(15000)
  async tick() {
    if (this.isRunning) return
    this.isRunning = true
    try {
      // Payload/snapshot timestamps include failed calls and late receipts, independently of task status.
      const tasks = await this.prisma.$queryRaw<{ id: number | bigint }[]>`
        SELECT t.id FROM AsinAuditTask t
        WHERE t.costUserId IS NOT NULL AND (
          t.costSyncedAt IS NULL OR t.updatedAt > t.costSyncedAt
          OR EXISTS (SELECT 1 FROM AsinAuditTaskPayload p WHERE p.taskId=t.id AND p.updatedAt > t.costSyncedAt)
          OR EXISTS (SELECT 1 FROM AsinAuditCrawlSnapshot s WHERE s.taskId=t.id AND s.updatedAt > t.costSyncedAt)
          OR EXISTS (SELECT 1 FROM AsinAuditOptimization o LEFT JOIN AsinAuditOptimizationPayload p ON p.optimizationId=o.id
            WHERE o.taskId=t.id AND (o.updatedAt > t.costSyncedAt OR p.updatedAt > t.costSyncedAt))
          OR EXISTS (SELECT 1 FROM AsinAuditCostRecord c WHERE c.taskId=t.id
            AND c.provider IN ('SIF','MCP','CRAWLER')
            AND (COALESCE(JSON_EXTRACT(c.usage,'$.callUsageVersion'),0)<2
              OR (c.provider='MCP' AND JSON_CONTAINS_PATH(c.usage,'one','$.estimateVersion')=0)))
          OR EXISTS (SELECT 1 FROM AsinAuditCostRecord c JOIN PricingConfig p ON p.\`key\`='MCP_CALL'
            WHERE c.taskId=t.id AND c.provider='MCP' AND p.active=1 AND p.unit='call' AND p.markupPriceCny>=0
              AND JSON_EXTRACT(c.usage,'$.successfulCalls')=1
              AND JSON_UNQUOTE(JSON_EXTRACT(c.usage,'$.estimateStatus'))='UNKNOWN')
        ) ORDER BY t.costSyncedAt ASC, t.id ASC LIMIT 20`
      for (const task of tasks) {
        try {
          // MySQL raw unsigned IDs can be BigInt; Prisma model Int inputs require Number.
          const taskId = Number(task.id)
          if (!Number.isSafeInteger(taskId) || taskId <= 0) throw new Error("无效任务ID")
          await this.syncTask(taskId)
        } catch {
          this.logger.error(`审计实际成本归集失败，保留账单等待重记（不重跑审计）：task=${task.id}`)
        }
      }
    } catch {
      this.logger.error("审计成本归集读取失败；未执行扣费或外部调用")
    } finally {
      this.isRunning = false
    }
  }

  async syncTask(taskId: number) {
    // Server DB time avoids deployment host clock skew and never skips a concurrent receipt.
    const [clock] = await this.prisma.$queryRaw<{ now: Date }[]>`SELECT UTC_TIMESTAMP(3) AS now`
    const task = await this.prisma.asinAuditTask.findUniqueOrThrow({ where: { id: taskId } })
    if (task.costUserId == null) return
    const phases = await this.prisma.$queryRaw<
      {
        phase: string
        state: string | null
        billing: Prisma.JsonValue
        tokenUsage: Prisma.JsonValue
        model: string | null
      }[]
    >`
      SELECT j.phaseName AS phase,
        JSON_UNQUOTE(JSON_EXTRACT(p.phases,CONCAT('$.',j.phaseName,'.state'))) AS state,
        JSON_EXTRACT(p.phases,CONCAT('$.',j.phaseName,'.billing')) AS billing,
        JSON_EXTRACT(p.phases,CONCAT('$.',j.phaseName,'.usage')) AS tokenUsage,
        JSON_UNQUOTE(JSON_EXTRACT(p.config,'$.model')) AS model
      FROM AsinAuditTaskPayload p,
        JSON_TABLE(COALESCE(JSON_KEYS(p.phases),JSON_ARRAY()), '$[*]' COLUMNS(phaseName VARCHAR(100) PATH '$')) j
      WHERE p.taskId=${task.id} AND j.phaseName REGEXP '^[a-zA-Z0-9_]+$'`
    const modelPhases = new Set([
      "reviews",
      "consistency",
      "consistencyVerification",
      "score",
      "optimize",
      "semantic",
      "rules",
      "visual",
      "snapshot",
    ])
    const entries: CostEntry[] = []
    for (const phase of phases) {
      if (!modelPhases.has(phase.phase) && !/^(score|optimize)_repair_/.test(phase.phase) && !phase.billing && !phase.tokenUsage) continue
      const data = modelCostUsage(phase.billing, phase.tokenUsage, phase.state ?? "UNKNOWN")
      const billing = costObject(phase.billing)
      entries.push({
        provider: "AI_GATEWAY",
        sourceId: `phase:${phase.phase}`,
        state: phase.state ?? "UNKNOWN",
        model: typeof billing.model === "string" ? billing.model : phase.model,
        ...data,
        occurredAt: task.createdAt,
      })
    }
    const snapshots = await this.prisma.$queryRaw<
      {
        snapshotId: string
        provider: string
        state: string
        httpStatus: number | null
        createdAt: Date
        businessCode: Prisma.JsonValue
        consumedQuota: Prisma.JsonValue
        hasResponse: number
        mcpIsError: Prisma.JsonValue
        mcpContent: Prisma.JsonValue
        endpoint: string | null
        errorCode: string | null
        toolName: string | null
      }[]
    >`
      SELECT snapshotId,provider,state,httpStatus,createdAt,
        IF(JSON_VALID(rawResponse),JSON_EXTRACT(rawResponse,'$.code'),NULL) AS businessCode,
        IF(JSON_VALID(rawResponse),JSON_EXTRACT(rawResponse,'$.consumedQuota'),NULL) AS consumedQuota,
        JSON_VALID(rawResponse) AS hasResponse,
        IF(provider='MCP' AND JSON_VALID(rawResponse),JSON_EXTRACT(rawResponse,'$.isError'),NULL) AS mcpIsError,
        IF(provider='MCP' AND JSON_VALID(rawResponse),JSON_EXTRACT(rawResponse,'$.content'),NULL) AS mcpContent,
        JSON_UNQUOTE(COALESCE(JSON_EXTRACT(request,'$.url'),JSON_EXTRACT(request,'$.name'))) AS endpoint,
        JSON_UNQUOTE(JSON_EXTRACT(request,'$.name')) AS toolName,
        JSON_UNQUOTE(JSON_EXTRACT(error,'$.code')) AS errorCode
      FROM AsinAuditCrawlSnapshot WHERE taskId=${task.id} ORDER BY id`
    const mcpPrice = snapshots.some(snapshot => snapshot.provider === "MCP")
      ? ((await this.pricing.listAll()).find(price => price.key === "MCP_CALL") ?? null)
      : null
    for (const snapshot of snapshots) {
      const data = evidenceCallUsage({ ...snapshot, endpoint: costEndpoint(snapshot.endpoint) })
      entries.push({
        provider: snapshot.provider,
        sourceId: snapshot.snapshotId,
        state: snapshot.state,
        model: null,
        ...data,
        usage:
          snapshot.provider === "MCP"
            ? { ...data.usage, ...mcpEstimate(data.usage, mcpPrice, clock.now) }
            : data.usage,
        occurredAt: snapshot.createdAt,
      })
    }
    const optimization = await this.prisma.asinAuditOptimization.findUnique({
      where: { taskId: task.id },
      include: { payload: { select: { usage: true } } },
    })
    if (optimization && optimization.status !== "QUEUED") {
      const usage = costObject(optimization.payload?.usage)
      const data = modelCostUsage(usage.billing, usage.tokens, optimization.status)
      const billing = costObject(usage.billing)
      entries.push({
        provider: "AI_GATEWAY",
        sourceId: optimization.optimizationId,
        state: optimization.status,
        model: typeof billing.model === "string" ? billing.model : optimization.model,
        ...data,
        occurredAt: optimization.startedAt ?? optimization.createdAt,
      })
    }
    for (const entry of entries) await this._record(task, entry)
    await this.prisma.asinAuditTask.updateMany({
      where: { id: task.id, updatedAt: task.updatedAt, costUserId: task.costUserId },
      data: { costSyncedAt: clock.now, updatedAt: task.updatedAt },
    })
  }

  private async _record(
    task: {
      id: number
      taskId: string
      costUserId: number | null
      appId: string
      auditType: string
      asin: string
    },
    entry: CostEntry
  ) {
    if (task.costUserId == null) return
    const userId = task.costUserId
    const recordKey = auditCostKey(task.id, entry.provider, entry.sourceId)
    await this.prisma.$transaction(
      async tx => {
        // Serialize receipt enrichment across workers so the first price snapshot stays immutable.
        await tx.$queryRaw`SELECT id FROM AsinAuditTask WHERE id=${task.id} FOR UPDATE`
        const requestId =
          entry.costCny !== null && entry.provider === "AI_GATEWAY"
            ? auditCostKey(0, "AI_GATEWAY", String(entry.usage.gatewayRequestId))
            : null
        const prior = requestId ? await tx.usageLog.findUnique({ where: { requestId } }) : null
        if (prior && (prior.userId !== userId || !prior.cost.eq(entry.costCny!)))
          throw new Error("用量账单身份或金额冲突")
        const duplicateKey =
          prior && costObject(prior.meta).costRecordKey !== recordKey
            ? costObject(prior.meta).costRecordKey
            : null
        const existing = await tx.asinAuditCostRecord.findUnique({ where: { recordKey } })
        if (existing && existing.userId !== userId) throw new Error("成本记录归属不一致")
        // Freeze the first usable configured-price snapshot. Replays and later price changes never reprice history.
        const previousUsage = costObject(existing?.usage)
        if (entry.provider === "MCP" && previousUsage.estimateVersion === 1) {
          if (
            previousUsage.estimateStatus === "ESTIMATED" ||
            (previousUsage.estimateStatus === "UNKNOWN" && entry.usage.estimateStatus === "UNKNOWN")
          ) {
            for (const [key, value] of Object.entries(previousUsage)) {
              if (key.startsWith("estimate")) entry.usage[key] = value
            }
          }
        }
        // Once verified, a known invoice cannot silently become unknown or change its amount.
        if (
          existing?.costCny != null &&
          entry.costCny != null &&
          !existing.costCny.eq(entry.costCny)
        )
          throw new Error("上游账单金额变化，需核对")
        const costCny = duplicateKey ? null : (entry.costCny ?? existing?.costCny ?? null)
        const costStatus = duplicateKey ? "DUPLICATE" : costCny === null ? "UNKNOWN" : "KNOWN"
        const usage = duplicateKey
          ? { ...entry.usage, referencedCostRecordKey: duplicateKey }
          : costCny !== null && entry.costCny === null
            ? existing!.usage
            : (entry.usage as Prisma.InputJsonValue)
        await tx.asinAuditCostRecord.upsert({
          where: { recordKey },
          create: {
            recordKey,
            taskId: task.id,
            userId,
            ...entry,
            costCny,
            costStatus,
            usage: usage as Prisma.InputJsonValue,
          },
          update: {
            state: entry.state,
            model: entry.model,
            costCny,
            costStatus,
            usage: usage as Prisma.InputJsonValue,
          },
        })
        if (entry.costCny === null || entry.provider !== "AI_GATEWAY" || !requestId) return
        // A gateway receipt counts once, even if copied into two stored phases.
        if (prior) {
          return
        }
        const balance = await this.credit.consumableBalance(tx, userId)
        await tx.usageLog.create({
          data: {
            userId,
            type: UsageType.TOKEN,
            cost: entry.costCny,
            credits: 0,
            balanceAfter: balance,
            source: "asin.audit",
            requestId,
            createdAt: entry.occurredAt,
            promptTokens:
              typeof entry.usage.promptTokens === "number" ? entry.usage.promptTokens : null,
            completionTokens:
              typeof entry.usage.completionTokens === "number"
                ? entry.usage.completionTokens
                : null,
            thinkingTokens:
              typeof entry.usage.thinkingTokens === "number" ? entry.usage.thinkingTokens : null,
            meta: {
              ...entry.usage,
              accountingMode: "ACTUAL_COST_ONLY",
              invokeType: "API",
              module: "asin_audit",
              model: entry.model,
              appId: task.appId,
              taskId: task.taskId,
              auditType: task.auditType,
              asin: task.asin,
              provider: entry.provider,
              sourceId: entry.sourceId,
              priceMultiplier: 1,
              costRecordKey: recordKey,
              creditsDeducted: false,
            } as Prisma.InputJsonValue,
          },
        })
      },
      { timeout: 20000 }
    )
  }
}
