/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
// 来源枚举仅由内部成功节点选择；异构 Prisma 委托动态派发，SQL 强制限制实体范围。
import { Prisma } from "@prisma/client"
import { resolveGatewayModel } from "../image-generation/providers/gateway-mapping"
import { PrismaService } from "../prisma/prisma.service"
import { RPA_MODEL_LABELS } from "../rpa-creation/rpa-creation.capabilities"
import { AuditPrismaService } from "../usage/audit-prisma.service"
import { GenerationFunction } from "../usage/dto/query-generation-records.dto"
import { GenerationRecord, GenerationRecordService } from "../usage/generation-record.service"
import { TextGenerationRecordService } from "../usage/text-generation-record.service"
import { projectAsinGenerationEvents, projectAsinGenerationPage } from "./asin-generation-events"
import {
  projectListingGenerationPage,
  projectListingGenerationRecords,
} from "./listing-generation-snapshot"
import { projectRpaGenerationEvents, projectRpaGenerationPage } from "./rpa-generation-events"

export type RecordClient = Prisma.TransactionClient
export const GENERATION_SOURCES = {
  generationTask: "IMAGE",
  imageGenJob: "IMAGE",
  videoTask: "VIDEO",
  storyboardVideo: "VIDEO",
  beautyTask: "VIDEO",
  rpaCreationTask: "IMAGE",
  inspirationSubscription: "INSPIRATION_RADAR",
  asinEvidenceRecord: "ASIN_EVIDENCE",
  asinAuditRecord: "ASIN_AUDIT",
  competitorAnalysisRecord: "COMPETITOR_ANALYSIS",
  history: "LISTING_GENERATION",
  businessAiRun: "LISTING_SCORING",
  categoryAnalysisRecord: "CATEGORY_ANALYSIS",
  selectionAnalysisRecord: "PRODUCT_SELECTION",
  smartPricingRecord: "SMART_PRICING",
  promotionPlanRecord: "PROMOTION_PLAN",
  videoAnalysisRecord: "VIDEO_ANALYSIS",
  chetaidouTask: "CHETAIDOU_TEXT",
} as const
export type GenerationSource = keyof typeof GENERATION_SOURCES
const TEXT_MODELS = new Set([
  "history",
  "businessAiRun",
  "categoryAnalysisRecord",
  "selectionAnalysisRecord",
  "smartPricingRecord",
  "promotionPlanRecord",
  "videoAnalysisRecord",
  "asinEvidenceRecord",
  "asinAuditRecord",
  "competitorAnalysisRecord",
  "chetaidouTask",
  "chetaidouCall",
])
const MEDIA_MODELS = new Set([
  "generationTask",
  "imageGenJob",
  "videoTask",
  "storyboardVideo",
  "beautyTask",
  "rpaCreationTask",
  "inspirationSubscription",
])
const SUCCESS = new Set(["SUCCESS", "COMPLETED", "SUCCEEDED", "SCORED", "OPTIMIZED"])
const MIN_DATE = "1970-01-01T00:00:00.000Z"
const MAX_DATE = "9999-12-31T23:59:59.999Z"

type SourceRow = Record<string, any>
type MediaLog = {
  userId: number
  source: string | null
  meta: Prisma.JsonValue | null
  credits: Prisma.Decimal | null
}

/** 列表兼容身份；operation 只在 ASIN key 中出现，其余沿旧 key。 */
export function generationIdentity(row: Pick<GenerationRecord, "key" | "operation" | "function">) {
  const separator = row.key.indexOf(":")
  const sourceType = row.key.slice(0, separator)
  let sourceId = row.key.slice(separator + 1)
  const operation = row.operation ?? ""
  if (row.function === "ASIN_AUDIT") sourceId = sourceId.slice(0, -(operation.length + 1))
  return { sourceType, sourceId, operation }
}

// 单实体投影只允许明确引用的台账，历史近邻匹配缺少完整双向上下文时保持未知。
function withoutTimeFallback(value: any): any {
  if (!value || typeof value !== "object" || value instanceof Date) return value
  if (Array.isArray(value)) return value.map(withoutTimeFallback).filter(Boolean)
  const result = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "createdAt")
      .map(([key, child]) => [key, withoutTimeFallback(child)])
  )
  return Object.keys(result).length ? result : undefined
}

/** 复用既有来源映射和严格费用匹配，但根查询在 SQL 中限制为一个实体/拆图组。 */
export async function projectGenerationSource(
  tx: RecordClient,
  source: GenerationSource,
  root: SourceRow,
  options?: { requireSettlement?: boolean }
) {
  if (!eligibleGenerationSource(source, root)) return []
  if (source === "asinAuditRecord")
    return projectAsinGenerationEvents(
      tx,
      root as Parameters<typeof projectAsinGenerationEvents>[1],
      undefined,
      options?.requireSettlement === true
    )
  if (source === "history") return projectListingGenerationRecords(tx, root as any)
  if (source === "rpaCreationTask")
    return projectRpaGenerationEvents(tx, root as Parameters<typeof projectRpaGenerationEvents>[1])
  return (await projectLegacyGenerationPage(tx, source, [root], options)).get(root.id) ?? []
}

/** 回填按页取关联数据，事件映射仍复用线上相同逻辑。 */
export async function projectGenerationSourcePage(
  tx: RecordClient,
  source: GenerationSource,
  inputs: SourceRow[]
): Promise<Map<string | number, GenerationRecord[]>> {
  const roots = inputs.filter(root => eligibleGenerationSource(source, root))
  if (!roots.length) return new Map()
  if (source === "asinAuditRecord") return projectAsinGenerationPage(tx, roots as any)
  if (source === "history") return projectListingGenerationPage(tx, roots as any)
  if (source === "rpaCreationTask") return projectRpaGenerationPage(tx, roots as any)
  if (source === "businessAiRun") {
    const result = new Map<string | number, GenerationRecord[]>()
    for (const module of ["listing-score", "competitor-analysis"]) {
      const group = roots.filter(root => root.module === module)
      if (group.length)
        for (const [id, rows] of await projectLegacyGenerationPage(tx, source, group, {
          batch: true,
        }))
          result.set(id, rows)
    }
    return result
  }
  // 旧拆图映射以 groupId 分组；跨用户偶然同名的组分开投影，避免合并。
  if (source === "generationTask") {
    const owners = new Map<string, number>()
    const collision = roots.some(root => {
      if (!root.groupId) return false
      const previous = owners.get(root.groupId)
      owners.set(root.groupId, root.userId)
      return previous != null && previous !== root.userId
    })
    if (collision) {
      const result = new Map<string | number, GenerationRecord[]>()
      for (const owner of new Set(roots.map(root => root.userId)))
        for (const [id, rows] of await projectLegacyGenerationPage(
          tx,
          source,
          roots.filter(root => root.userId === owner),
          { batch: true }
        ))
          result.set(id, rows)
      return result
    }
  }
  return projectLegacyGenerationPage(tx, source, roots, { batch: true })
}

async function projectLegacyGenerationPage(
  tx: RecordClient,
  source: GenerationSource,
  inputs: SourceRow[],
  options?: { requireSettlement?: boolean; batch?: boolean }
): Promise<Map<string | number, GenerationRecord[]>> {
  let roots = inputs.filter(
    root => !(source === "chetaidouTask" && root.rootTaskId && root.rootTaskId !== root.id)
  )
  if (source === "competitorAnalysisRecord") {
    const pending = await tx.businessAiRun.findMany({
      where: {
        module: "competitor-analysis",
        status: { in: ["RUNNING", "READY"] },
        OR: roots
          .filter(root => root.clientRequestId)
          .map(root => ({ userId: root.userId, runId: root.clientRequestId })),
      },
      select: { userId: true, runId: true },
    })
    roots = roots.filter(
      root => !pending.some(run => run.userId === root.userId && run.runId === root.clientRequestId)
    )
  }
  if (!roots.length) return new Map()
  const root = roots[0]
  const fn: GenerationFunction =
    source === "businessAiRun"
      ? root.module === "listing-score"
        ? "LISTING_SCORING"
        : "COMPETITOR_ANALYSIS"
      : GENERATION_SOURCES[source]
  const grouped = source === "generationTask" ? roots.filter(row => row.groupId) : []
  const groupTasks = grouped.length
    ? await tx.generationTask.findMany({
        where: { OR: grouped.map(row => ({ groupId: row.groupId, userId: row.userId })) },
        select: { id: true, groupId: true, userId: true },
      })
    : []
  const references = roots.map(row => {
    const ids = row.groupId
      ? groupTasks
          .filter(task => task.groupId === row.groupId && task.userId === row.userId)
          .map(task => task.id)
      : [row.id]
    const OR: Prisma.UsageLogWhereInput[] =
      source === "imageGenJob" || row.sourceJobId
        ? [{ meta: { path: "$.jobId", equals: row.sourceJobId ?? row.id } }]
        : ids.map(id => ({ meta: { path: "$.taskId", equals: id } }))
    if (source === "generationTask" && row.groupId)
      OR.push({ meta: { path: "$.groupId", equals: row.groupId } })
    return options?.batch ? { userId: row.userId, OR } : { OR }
  })
  // 同页积分汇总、拆图阶段和结算证明共用一次精确引用读取，不再重复扫描台账。
  let mediaLogs: Promise<MediaLog[]> | undefined
  const readMediaLogs =
    options?.batch && ["generationTask", "imageGenJob"].includes(source)
      ? () =>
          (mediaLogs ??= tx.usageLog.findMany({
            where: {
              userId: { in: [...new Set(roots.map(row => row.userId as number))] },
              OR: [
                { source: { startsWith: "aicreative.image_generate" } },
                { source: "aicreative.ai_split" },
                { source: "chetaidou.image" },
              ],
              AND: [{ OR: references }],
            },
            select: { userId: true, source: true, meta: true, credits: true },
          }))
      : undefined
  const allowed = new Map<string, any>([
    [
      source,
      {
        OR: roots.map(row =>
          source === "generationTask" && row.generationMode === "AI_SPLIT" && row.groupId
            ? { groupId: row.groupId, userId: row.userId }
            : { id: row.id }
        ),
      },
    ],
  ])
  const taskRoots = new Map(roots.map(row => [row.id, row.id]))
  if (source === "chetaidouTask") {
    const attempts = await tx.chetaidouTask.findMany({
      where: { OR: roots.map(row => ({ rootTaskId: row.id, ownerId: row.ownerId })) },
      select: { id: true, rootTaskId: true },
    })
    for (const task of attempts) taskRoots.set(task.id, task.rootTaskId)
    allowed.set("chetaidouCall", { taskId: { in: [...taskRoots.keys()] } })
  }
  if (source === "competitorAnalysisRecord")
    allowed.set("businessAiRun", {
      OR: roots.map(row => ({
        userId: row.userId,
        module: "competitor-analysis",
        runId: row.clientRequestId,
      })),
    })
  if (["smartPricingRecord", "promotionPlanRecord"].includes(source))
    allowed.set("businessAiRun", { userId: { in: [...new Set(roots.map(row => row.userId))] } })
  if (source === "businessAiRun" && root.module === "competitor-analysis")
    allowed.set("competitorAnalysisRecord", {
      OR: roots.map(row => ({ userId: row.userId, clientRequestId: row.runId })),
    })
  let reports: SourceRow[] = []
  const scoped = new Proxy(tx as any, {
    get(target, model: string) {
      if (model === "creditTransaction")
        return new Proxy(target[model], {
          get(logs, method: string) {
            if (method !== "findMany") return logs[method].bind(logs)
            return (args: any) =>
              source !== "inspirationSubscription"
                ? Promise.resolve([])
                : logs.findMany({
                    ...args,
                    where: {
                      ...args.where,
                      type: { in: ["CONSUME", "TEAM_CONSUME"] },
                      AND: [
                        {
                          OR: roots
                            .filter(row => row.lastRefreshedAt)
                            .map(row => ({
                              AND: [
                                { meta: { path: "$.subscriptionId", equals: row.id } },
                                {
                                  meta: {
                                    path: "$.refreshedAt",
                                    equals: row.lastRefreshedAt.toISOString(),
                                  },
                                },
                              ],
                            })),
                        },
                      ],
                    },
                  })
          },
        })
      if (model === "usageLog")
        return new Proxy(target[model], {
          get(logs, method: string) {
            if (method !== "findMany") return logs[method].bind(logs)
            return (args: any) => {
              if (TEXT_MODELS.has(source) && !args.where?.OR) return Promise.resolve([])
              const where = withoutTimeFallback(args.where)
              if (!where || (Array.isArray(where.OR) && !where.OR.length))
                return Promise.resolve([])
              const sources = where.source
                ? [where.source]
                : where.OR?.map((clause: any) => clause.source)
              if (
                readMediaLogs &&
                Array.isArray(where.userId?.in) &&
                Object.keys(where.userId).length === 1 &&
                Object.keys(where).every(key => ["userId", "source", "OR"].includes(key)) &&
                !(where.source && where.OR) &&
                (!where.OR ||
                  where.OR.every(
                    (clause: any) => Object.keys(clause).length === 1 && clause.source !== undefined
                  )) &&
                sources?.length &&
                sources.every(
                  (filter: any) =>
                    typeof filter === "string" ||
                    (typeof filter?.startsWith === "string" && Object.keys(filter).length === 1)
                )
              )
                return readMediaLogs().then(rows =>
                  rows.filter(
                    log =>
                      where.userId.in.includes(log.userId) &&
                      sources.some((filter: any) =>
                        typeof filter === "string"
                          ? log.source === filter
                          : log.source?.startsWith(filter.startsWith)
                      )
                  )
                )
              return logs.findMany({
                ...args,
                where: TEXT_MODELS.has(source)
                  ? where
                  : { AND: [where, options?.batch ? { OR: references } : references[0]] },
              })
            }
          },
        })
      if (!TEXT_MODELS.has(model) && !MEDIA_MODELS.has(model)) return target[model]
      return new Proxy(target[model], {
        get(entity, method: string) {
          if (!["findMany", "count", "groupBy"].includes(method)) return entity[method].bind(entity)
          return async (args: any) => {
            const restriction = allowed.get(model)
            if (!restriction || (options?.batch && method === "count"))
              return method === "count" ? 0 : []
            const select = args.select ? { ...args.select } : undefined
            for (const child of ["generatedImages", "outputs"])
              if (select?.[child])
                select[child] = {
                  ...select[child],
                  where: { ...select[child].where, deletedAt: null },
                }
            const result = await entity[method]({
              ...args,
              ...(select ? { select } : {}),
              where: { AND: [args.where ?? {}, restriction] },
            })
            if (model === "competitorAnalysisRecord") reports = result
            return model === "chetaidouCall" && source === "chetaidouTask"
              ? result.map((call: any) => ({ ...call, taskId: taskRoots.get(call.taskId) }))
              : result
          }
        },
      })
    },
  }) as AuditPrismaService
  const text = new TextGenerationRecordService(scoped)
  const legacy = new GenerationRecordService(scoped as unknown as PrismaService, scoped, text)
  const projected = await legacy.list(
    { function: fn, page: 1, pageSize: 10000, dateFrom: MIN_DATE, dateTo: MAX_DATE },
    true
  )
  const successful = projected.items
    .filter(row => SUCCESS.has(row.status))
    .map(row => ({ ...row, createdAt: new Date(row.createdAt) }))
  const standards =
    source === "generationTask" ? roots.filter(row => row.generationMode === "STANDARD") : []
  const counts = standards.length
    ? options?.batch
      ? await tx.generatedImage.groupBy({
          by: ["taskId"],
          where: {
            taskId: { in: standards.map(row => row.id) },
            source: "platform",
            status: "SUCCESS",
            deletedAt: null,
            url: { not: null },
          },
          _count: { _all: true },
        })
      : [
          {
            taskId: root.id as number,
            _count: {
              _all: await tx.generatedImage.count({
                where: {
                  taskId: root.id,
                  source: "platform",
                  status: "SUCCESS",
                  deletedAt: null,
                  url: { not: null },
                },
              }),
            },
          },
        ]
    : []
  const ct =
    source === "chetaidouTask"
      ? roots
      : source === "imageGenJob"
        ? roots.filter(row => row.businessType === "CHETAIDOU")
        : []
  const imageItems =
    source === "imageGenJob" && ct.length
      ? await tx.imageGenItem.findMany({
          where: { jobId: { in: ct.map(row => row.id) } },
          select: { id: true, jobId: true },
        })
      : []
  const calls = ct.length
    ? await tx.chetaidouCall.findMany({
        where:
          source === "chetaidouTask"
            ? { rootTaskId: { in: ct.map(row => row.id) }, kind: "TEXT" }
            : { imageGenItemId: { in: imageItems.map(item => item.id) }, kind: "IMAGE" },
        select: {
          rootTaskId: true,
          imageGenItemId: true,
          billingStatus: true,
          chargedCredits: true,
        },
      })
    : []
  const settlements = await mediaSettlementPage(tx, source, roots, readMediaLogs)
  const result = new Map<string | number, GenerationRecord[]>()
  for (const row of roots) {
    let records = successful.filter(record => {
      if ((row.userId ?? row.ownerId) != null && record.userId !== (row.userId ?? row.ownerId))
        return false
      if (source === "generationTask" && row.generationMode === "AI_SPLIT")
        return record.key === `AI_SPLIT:${row.groupId ?? `task:${row.id}`}`
      if (source === "businessAiRun" && row.module === "competitor-analysis")
        return (
          record.key === `TEXT_RUN:competitor-analysis:${row.id}` ||
          reports.some(
            report =>
              report.userId === row.userId &&
              report.clientRequestId === row.runId &&
              report.id === record.id
          )
        )
      return record.id === row.id
    })
    if (source === "generationTask" && row.generationMode === "STANDARD")
      records = records.map(record => ({
        ...record,
        resultCount: counts.find(count => count.taskId === row.id)?._count._all ?? 0,
      }))
    if (ct.includes(row)) {
      const owned = calls.filter(call =>
        source === "chetaidouTask"
          ? call.rootTaskId === row.id
          : imageItems.some(item => item.jobId === row.id && item.id === call.imageGenItemId)
      )
      const complete =
        owned.length > 0 &&
        owned.every(
          call =>
            call.billingStatus === "FREE" ||
            (call.billingStatus === "SETTLED" && call.chargedCredits != null)
        )
      const credits = complete
        ? owned
            .reduce(
              (sum, call) => sum.plus(call.billingStatus === "FREE" ? 0 : call.chargedCredits!),
              new Prisma.Decimal(0)
            )
            .toString()
        : null
      records = records.map(record => ({ ...record, credits }))
    }
    if (source === "chetaidouTask" && row.finishedAt)
      records = records.map(record => ({ ...record, createdAt: row.finishedAt }))
    if (source === "inspirationSubscription")
      records = records.map(record => ({
        ...record,
        key: `INSPIRATION_RADAR:${row.id}:refresh:${row.lastRefreshedAt.getTime()}`,
      }))
    const settlement = settlements.get(row.id)
    if (options?.requireSettlement && settlement && !settlement.complete) records = []
    if (settlement)
      records = records.map(record => ({
        ...record,
        credits:
          !settlement.complete || settlement.unknown
            ? null
            : settlement.free
              ? "0"
              : record.credits,
      }))
    result.set(row.id, records)
  }
  return result
}

export function eligibleGenerationSource(source: GenerationSource, root: SourceRow): boolean {
  const hasStatus = [
    "generationTask",
    "imageGenJob",
    "videoTask",
    "storyboardVideo",
    "beautyTask",
    "businessAiRun",
    "categoryAnalysisRecord",
    "selectionAnalysisRecord",
    "chetaidouTask",
  ].includes(source)
  if (
    hasStatus &&
    !(source === "generationTask" && root.generationMode === "AI_SPLIT") &&
    !SUCCESS.has(root.status) &&
    !(source === "imageGenJob" && root.businessType === "CHETAIDOU" && root.status === "PARTIAL")
  )
    return false
  if (
    source === "chetaidouTask" &&
    !["BREAKDOWN", "IDEATION", "REFRESH_GROUP", "DIVERGE", "COMPOSE"].includes(root.type)
  )
    return false
  if (source === "history" && !["LISTING_GENERATION", "LISTING_SCORING"].includes(root.type))
    return false
  if (source === "businessAiRun" && !root.outputText?.trim()) return false
  return true
}

export async function lockGenerationSource(
  tx: RecordClient,
  source: GenerationSource,
  id: string | number
) {
  // 拆图所有成员/子项修改与回填先拿同一组最小任务行，避免并发末席位各自读到旧状态。
  if (source === "generationTask") {
    const task = await tx.generationTask.findUnique({
      where: { id: Number(id) },
      select: { groupId: true, userId: true, generationMode: true },
    })
    if (task?.groupId)
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM GenerationTask
          WHERE userId = ${task.userId} AND generationMode = ${task.generationMode} AND groupId = ${task.groupId}
          ORDER BY id ASC LIMIT 1 FOR UPDATE`
      )
  }
  const table = source[0].toUpperCase() + source.slice(1)
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM ${Prisma.raw("`" + table + "`")} WHERE id = ${id} FOR UPDATE`
  )
  return (tx as any)[source].findUnique({ where: { id } }) as Promise<SourceRow | null>
}

async function mediaSettlementPage(
  tx: RecordClient,
  source: GenerationSource,
  roots: SourceRow[],
  readMediaLogs?: () => Promise<MediaLog[]>
) {
  const candidates = roots.filter(
    root =>
      (source === "imageGenJob" && root.businessType === "IMAGE_CREATIVE") ||
      (source === "generationTask" && root.executionSpec?.provider)
  )
  const result = new Map<string | number, { complete: boolean; unknown: boolean; free: boolean }>()
  if (!candidates.length) return result
  const job = source === "imageGenJob"
  const children = job
    ? (
        await tx.imageGenItem.findMany({
          where: {
            jobId: { in: candidates.map(root => root.id) },
            status: "SUCCEEDED",
            deletedAt: null,
          },
          select: { jobId: true, providerJobId: true, gatewayImage: true },
        })
      ).map(child => ({
        rootId: child.jobId,
        providerJobId: child.providerJobId,
        metadata: child.gatewayImage,
      }))
    : (
        await tx.generatedImage.findMany({
          where: {
            taskId: { in: candidates.map(root => root.id) },
            status: "SUCCESS",
            deletedAt: null,
          },
          select: { taskId: true, providerJobId: true, deliveryMeta: true },
        })
      ).map(child => ({
        rootId: child.taskId,
        providerJobId: child.providerJobId,
        metadata: child.deliveryMeta,
      }))
  const logs = readMediaLogs
    ? (await readMediaLogs()).filter(log => log.source?.startsWith("aicreative.image_generate"))
    : await tx.usageLog.findMany({
        where: {
          userId: { in: [...new Set(candidates.map(root => root.userId as number))] },
          source: { startsWith: "aicreative.image_generate" },
          OR: candidates.map(root => ({
            userId: root.userId,
            meta: { path: job ? "$.jobId" : "$.taskId", equals: root.id },
          })),
        },
        select: { userId: true, meta: true, credits: true },
      })
  for (const root of candidates) {
    const owned = children.filter(child => child.rootId === root.id)
    const charges = logs.filter(
      log =>
        log.userId === root.userId &&
        (log.meta as Record<string, unknown> | null)?.[job ? "jobId" : "taskId"] === root.id
    )
    const gateways = new Set(
      charges
        .filter(log => log.credits != null)
        .flatMap(log => {
          const id = (log.meta as { gatewayTaskId?: unknown } | null)?.gatewayTaskId
          return typeof id === "string" && id ? [id] : []
        })
    )
    const evidence = owned.map(
      child =>
        (child.metadata as { generationRecordCredits?: unknown } | null)?.generationRecordCredits
    )
    const hasLog = (child: (typeof owned)[number]) =>
      Boolean(child.providerJobId && gateways.has(child.providerJobId))
    const complete =
      owned.length > 0 &&
      owned.every(
        (child, index) =>
          evidence[index] === null ||
          (typeof evidence[index] === "string" && /^\d+(?:\.\d+)?$/.test(evidence[index])) ||
          hasLog(child)
      )
    result.set(root.id, {
      complete,
      unknown: owned.some((child, index) => evidence[index] === null && !hasLog(child)),
      free:
        complete &&
        evidence.every(value => value === "0") &&
        !charges.some(log => log.credits?.gt(0)),
    })
  }
  return result
}

export type SuccessfulGenerationSnapshot = {
  sourceType: string
  sourceId: string
  operation?: string
  function: string
  userId: number
  prompt: string
  modelPublicId?: string | null
  credits?: string | Prisma.Decimal | null
  resultUrl?: string | null
  resultCount?: number | null
  occurredAt: Date
}

/** 同一成功业务事件重放只返回首份快照，不改变先前的提示词、模型、费用或时间。 */
export async function saveGenerationSnapshot(
  tx: RecordClient,
  input: SuccessfulGenerationSnapshot,
  models?: ReadonlyMap<string, { publicId: string; displayName: string }>
) {
  const { sourceType, sourceId, operation = "", modelPublicId = null, ...rest } = input
  const gateway = models
    ? (models.get(modelPublicId ?? "") ?? null)
    : modelPublicId
      ? await tx.aiGatewayModel.findFirst({
          where: { publicId: modelPublicId },
          select: { publicId: true, displayName: true },
          orderBy: { id: "asc" },
        })
      : null
  const directory =
    gateway ??
    (input.sourceType.startsWith("RPA_") && modelPublicId && RPA_MODEL_LABELS[modelPublicId]
      ? { publicId: modelPublicId, displayName: RPA_MODEL_LABELS[modelPublicId] }
      : null)
  const identity = { sourceType, sourceId, operation }
  return tx.generationRecord.upsert({
    where: { sourceType_sourceId_operation: identity },
    create: {
      ...identity,
      ...rest,
      modelPublicId: directory?.publicId ?? null,
      modelDisplayName: directory?.displayName ?? null,
      credits: input.credits == null ? null : new Prisma.Decimal(input.credits),
      resultUrl: input.resultUrl ?? null,
      resultCount: input.resultCount ?? null,
      deletedAt: null,
    },
    update: {},
  })
}

export function generationSnapshotFromRecord(
  row: GenerationRecord,
  override?: { modelPublicId?: string; credits?: Prisma.Decimal | string | number }
): SuccessfulGenerationSnapshot {
  const candidateModel =
    override?.modelPublicId || row.actualModel || (row.model !== "fixed-module" ? row.model : null)
  return {
    ...generationIdentity(row),
    userId: row.userId,
    function: row.function,
    prompt: row.prompt,
    modelPublicId:
      candidateModel && row.function === "IMAGE"
        ? resolveGatewayModel(candidateModel)
        : candidateModel,
    credits: override?.credits != null ? new Prisma.Decimal(override.credits) : row.credits,
    resultUrl: row.resultUrl,
    resultCount: row.resultCount ?? (row.resultUrl ? 1 : null),
    occurredAt: row.createdAt,
  }
}

/** 回填已按页读取并核对的结果；逐事件 upsert 返回实际冻结的积分，兼容并发首次写入。 */
export async function saveProjectedGenerationRecords(
  tx: RecordClient,
  rows: GenerationRecord[],
  models?: ReadonlyMap<string, { publicId: string; displayName: string }>
) {
  const snapshots: Array<{ key: string; credits: string | null }> = []
  for (const row of rows) {
    const frozen = await saveGenerationSnapshot(tx, generationSnapshotFromRecord(row), models)
    snapshots.push({ key: row.key, credits: frozen.credits?.toString() ?? null })
  }
  return { snapshots, written: rows.length }
}

/** 在线成功捕获在源实体锁内重读；回填按页投影后复用同一快照映射。 */
export async function syncGenerationSource(
  tx: RecordClient,
  source: GenerationSource,
  id: string | number,
  range?: {
    from?: Date
    to?: Date
    credits?: Prisma.Decimal | string | number
    requireSettlement?: boolean
    modelPublicId?: string
  }
) {
  const root = await lockGenerationSource(tx, source, id)
  if (!root)
    return {
      written: 0,
      unknownCredits: 0,
      snapshots: [] as Array<{ key: string; credits: string | null }>,
    }
  if (!eligibleGenerationSource(source, root)) {
    return {
      written: 0,
      unknownCredits: 0,
      snapshots: [] as Array<{ key: string; credits: string | null }>,
    }
  }
  if (
    source === "generationTask" &&
    root.sourceJobId &&
    (await tx.generationRecord.findFirst({
      where: { sourceType: "IMAGEGEN", sourceId: root.sourceJobId },
    }))
  )
    return {
      written: 0,
      unknownCredits: 0,
      snapshots: [] as Array<{ key: string; credits: string | null }>,
    }
  if (source === "competitorAnalysisRecord" && root.clientRequestId) {
    const run = await tx.businessAiRun.findFirst({
      where: { userId: root.userId, module: "competitor-analysis", runId: root.clientRequestId },
      select: { id: true },
    })
    if (
      run &&
      (await tx.generationRecord.findFirst({
        where: { sourceType: "TEXT_RUN", sourceId: `competitor-analysis:${run.id}` },
      }))
    )
      return {
        written: 0,
        unknownCredits: 0,
        snapshots: [] as Array<{ key: string; credits: string | null }>,
      }
  }
  const rows = (await projectGenerationSource(tx, source, root, range)).filter(
    row =>
      !range ||
      ((!range.from || row.createdAt >= range.from) && (!range.to || row.createdAt <= range.to))
  )
  let unknownCredits = 0
  const snapshots: Array<{ key: string; credits: string | null }> = []
  for (const row of rows) {
    const frozen = await saveGenerationSnapshot(tx, generationSnapshotFromRecord(row, range))
    if (frozen.credits == null) unknownCredits++
    snapshots.push({ key: row.key, credits: frozen.credits?.toString() ?? null })
  }
  return { written: rows.length, unknownCredits, snapshots }
}
