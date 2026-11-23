import { BadRequestException, Injectable } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { actualQuota, costEndpoint, costObject } from "./asin-cost.kernel"
import { QueryAsinCostDto } from "./dto/query-asin-cost.dto"

export type CostSummaryRow = {
  provider: string
  costStatus: string
  costCny: Prisma.Decimal | string | number | null
  usage: unknown
}

/** Aggregates known subsets; never claims an incomplete subset is a complete cost/quota total. */
export class AsinCostSummary {
  private actual = new Prisma.Decimal(0)
  private estimate = new Prisma.Decimal(0)
  private quota = new Prisma.Decimal(0)
  private recordCount = 0
  private actualInvoiceCount = 0
  private estimatedRecordCount = 0
  private unknownAmountCount = 0
  private duplicateCount = 0
  private quotaResponseCount = 0
  private unknownQuotaCount = 0
  private confirmedRequestCount = 0
  private successfulCalls = 0
  private failedCalls = 0
  private unknownOutcomeCount = 0

  add(row: CostSummaryRow) {
    this.recordCount++
    const usage = costObject(row.usage)
    if (row.costStatus === "DUPLICATE") {
      this.duplicateCount++
      return
    }
    if (row.costStatus === "KNOWN" && row.costCny != null) {
      this.actual = this.actual.add(String(row.costCny))
      this.actualInvoiceCount++
    } else this.unknownAmountCount++
    if (
      row.provider === "MCP" &&
      usage.estimateStatus === "ESTIMATED" &&
      (typeof usage.estimatedCostCny === "string" || typeof usage.estimatedCostCny === "number") &&
      actualQuota(usage.estimatedCostCny) !== null
    ) {
      this.estimate = this.estimate.add(String(usage.estimatedCostCny))
      this.estimatedRecordCount++
    }
    if (row.provider === "SIF") {
      const quota = actualQuota(usage.consumedQuota)
      if (quota === null) this.unknownQuotaCount++
      else {
        this.quota = this.quota.add(quota)
        this.quotaResponseCount++
      }
    }
    if (row.provider !== "AI_GATEWAY") {
      this.confirmedRequestCount += usage.requestCount === 1 ? 1 : 0
      this.successfulCalls += usage.successfulCalls === 1 ? 1 : 0
      this.failedCalls += usage.failedCalls === 1 ? 1 : 0
      if (usage.successfulCalls == null) this.unknownOutcomeCount++
    }
  }

  result() {
    return {
      recordCount: this.recordCount,
      actualInvoiceCount: this.actualInvoiceCount,
      actualCostCny: this.actualInvoiceCount ? this.actual.toFixed(6) : null,
      completeActualCostCny:
        this.actualInvoiceCount && !this.unknownAmountCount ? this.actual.toFixed(6) : null,
      estimatedRecordCount: this.estimatedRecordCount,
      estimatedCostCny: this.estimatedRecordCount ? this.estimate.toFixed(6) : null,
      unknownAmountCount: this.unknownAmountCount,
      duplicateCount: this.duplicateCount,
      reportedQuota: this.quotaResponseCount ? this.quota.toString() : null,
      totalQuota: this.quotaResponseCount && !this.unknownQuotaCount ? this.quota.toString() : null,
      quotaResponseCount: this.quotaResponseCount,
      unknownQuotaCount: this.unknownQuotaCount,
      confirmedRequestCount: this.confirmedRequestCount,
      successfulCalls: this.successfulCalls,
      failedCalls: this.failedCalls,
      unknownOutcomeCount: this.unknownOutcomeCount,
    }
  }
}

@Injectable()
export class AsinCostQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: QueryAsinCostDto) {
    if (query.startDate && query.endDate && new Date(query.startDate) >= new Date(query.endDate))
      throw new BadRequestException("开始时间必须早于结束时间")
    return this.prisma.$transaction(
      async tx => {
        const users = query.phone
          ? await tx.user.findMany({ where: { phone: query.phone }, select: { id: true } })
          : null
        const where: Prisma.AsinAuditCostRecordWhereInput = {
          ...(query.userId ? { userId: query.userId } : {}),
          ...(users ? { AND: [{ userId: { in: users.map(user => user.id) } }] } : {}),
          ...(query.taskId ? { task: { taskId: query.taskId } } : {}),
          ...(query.provider ? { provider: query.provider } : {}),
          ...(query.startDate || query.endDate
            ? {
                occurredAt: {
                  ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
                  ...(query.endDate ? { lt: new Date(query.endDate) } : {}),
                },
              }
            : {}),
        }
        const summary = new AsinCostSummary()
        const groups = new Map<
          string,
          { provider: string; endpoint: string | null; summary: AsinCostSummary }
        >()
        const page = query.page ?? 1,
          pageSize = query.pageSize ?? 10
        const items: ReturnType<AsinCostQueryService["_present"]>[] = []
        let cursor: number | undefined,
          total = 0
        // One repeatable-read snapshot; bounded memory even when the account has a long history.
        while (true) {
          const rows = await tx.asinAuditCostRecord.findMany({
            where,
            orderBy: { id: "desc" },
            take: 1000,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            include: {
              task: { select: { taskId: true, asin: true, auditType: true, status: true } },
            },
          })
          for (const row of rows) {
            summary.add(row)
            const usage = costObject(row.usage)
            const endpoint = costEndpoint(usage.toolName) ?? costEndpoint(usage.endpoint)
            const key = JSON.stringify([row.provider, endpoint])
            if (!groups.has(key))
              groups.set(key, { provider: row.provider, endpoint, summary: new AsinCostSummary() })
            groups.get(key)!.summary.add(row)
            if (total >= (page - 1) * pageSize && total < page * pageSize)
              items.push(this._present(row))
            total++
          }
          if (rows.length < 1000) break
          cursor = rows[rows.length - 1].id
        }
        const owners = await tx.user.findMany({
          where: { id: { in: [...new Set(items.map(item => item.userId))] } },
          select: { id: true, username: true, phone: true },
        })
        return {
          page,
          pageSize,
          total,
          currency: "CNY",
          creditsDeducted: false,
          summary: summary.result(),
          byEndpoint: [...groups.values()].map(group => ({
            provider: group.provider,
            endpoint: group.endpoint,
            ...group.summary.result(),
          })),
          items: items.map(item => ({
            ...item,
            owner: owners.find(owner => owner.id === item.userId) ?? null,
          })),
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30000 }
    )
  }

  private _present(row: {
    id: number
    userId: number
    provider: string
    sourceId: string
    model: string | null
    state: string
    costStatus: string
    costCny: Prisma.Decimal | null
    usage: unknown
    occurredAt: Date
    task: { taskId: string; asin: string; auditType: string; status: string }
  }) {
    const usage = costObject(row.usage)
    return {
      id: row.id,
      userId: row.userId,
      provider: row.provider,
      sourceId: row.sourceId,
      model: row.model,
      state: row.state,
      costStatus: row.costStatus,
      actualCostCny: row.costStatus === "KNOWN" ? (row.costCny?.toFixed(6) ?? null) : null,
      occurredAt: row.occurredAt,
      task: row.task,
      endpoint: costEndpoint(usage.toolName) ?? costEndpoint(usage.endpoint),
      requestCount: usage.requestCount ?? null,
      successfulCalls: usage.successfulCalls ?? null,
      failedCalls: usage.failedCalls ?? null,
      actualQuota: row.provider === "SIF" ? actualQuota(usage.consumedQuota) : null,
      quotaStatus:
        row.provider !== "SIF"
          ? "NOT_APPLICABLE"
          : actualQuota(usage.consumedQuota) === null
            ? "UNKNOWN"
            : "REPORTED",
      estimatedCostCny: row.provider === "MCP" ? (usage.estimatedCostCny ?? null) : null,
      estimateStatus:
        row.provider === "MCP" ? (usage.estimateStatus ?? "UNKNOWN") : "NOT_APPLICABLE",
      estimateUnitPriceCny: usage.estimateUnitPriceCny ?? null,
      estimatePriceUpdatedAt: usage.estimatePriceUpdatedAt ?? null,
      estimateCapturedAt: usage.estimateCapturedAt ?? null,
      estimateReason: usage.estimateReason ?? null,
      missingReason:
        row.costStatus === "KNOWN" || row.costStatus === "DUPLICATE"
          ? null
          : (usage.missingReason ?? "缺少供应商实际账单"),
      promptTokens: usage.promptTokens ?? null,
      completionTokens: usage.completionTokens ?? null,
      thinkingTokens: usage.thinkingTokens ?? null,
    }
  }
}
