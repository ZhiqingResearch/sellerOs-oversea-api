/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// 来源枚举仅由内部成功节点选择；异构 Prisma 委托动态派发，SQL 强制限制实体范围。
import { Prisma, PrismaClient } from "@prisma/client"
import "dotenv/config"
import { setTimeout as delay } from "node:timers/promises"
import {
  GENERATION_SOURCES,
  GenerationSource,
  eligibleGenerationSource,
  generationSnapshotFromRecord,
  projectGenerationSourcePage,
  saveProjectedGenerationRecords,
} from "../src/generation-record/generation-record-sync"
import {
  GENERATION_FUNCTION_LABELS,
  GenerationFunction,
} from "../src/usage/dto/query-generation-records.dto"
import { generationBackfillIdQuery } from "./generation-record-backfill-query"

export function parseGenerationBackfillArgs(args: string[], now = new Date()) {
  const values: Record<string, string> = {}
  let apply = false,
    dryRun = false
  for (let index = 0; index < args.length; index++) {
    const name = args[index]
    if (name === "--apply") apply = true
    else if (name === "--dry-run") dryRun = true
    else if (
      ["--function", "--from", "--to", "--batch-size", "--concurrency", "--cursor"].includes(name)
    ) {
      const value = args[++index]
      if (!value || value.startsWith("--")) throw new Error(`${name} 缺少参数`)
      values[name] = value
    } else throw new Error(`未知参数：${name}`)
  }
  if (apply && dryRun) throw new Error("--apply 与 --dry-run 不可同时使用")
  const fn = values["--function"] as GenerationFunction | undefined
  if (fn && !Object.prototype.hasOwnProperty.call(GENERATION_FUNCTION_LABELS, fn))
    throw new Error("功能标识无效")
  const requestedFrom = values["--from"]
    ? new Date(values["--from"])
    : new Date(now.getTime() - 7 * 86400000)
  const requestedTo = values["--to"] ? new Date(values["--to"]) : now
  if (!Number.isFinite(requestedFrom.getTime()) || !Number.isFinite(requestedTo.getTime()))
    throw new Error("时间范围无效")
  const from = requestedFrom
  const to = new Date(Math.min(requestedTo.getTime(), now.getTime()))
  if (from > to) throw new Error("开始时间不得晚于结束时间")
  const batchSize = Number(values["--batch-size"] ?? 100)
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error("批次须为 1–1000 的整数")
  const concurrency = Number(values["--concurrency"] ?? 4)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error("并发数须为 1–8 的整数")
  const rawCursor = values["--cursor"]
  const separator = rawCursor?.indexOf(":") ?? -1
  const cursor = rawCursor
    ? {
        source: rawCursor.slice(0, separator) as GenerationSource,
        id: rawCursor.slice(separator + 1),
      }
    : null
  if (
    cursor &&
    (separator < 1 ||
      !Object.prototype.hasOwnProperty.call(GENERATION_SOURCES, cursor.source) ||
      !cursor.id)
  )
    throw new Error("断点格式为 source:id")
  if (
    cursor &&
    [
      "generationTask",
      "videoTask",
      "storyboardVideo",
      "beautyTask",
      "rpaCreationTask",
      "inspirationSubscription",
      "history",
      "businessAiRun",
      "categoryAnalysisRecord",
    ].includes(cursor.source) &&
    (!/^[1-9]\d*$/.test(cursor.id) || !Number.isSafeInteger(Number(cursor.id)))
  )
    throw new Error("数字断点必须是正安全整数")
  return { apply, fn, from, to, batchSize, concurrency, cursor }
}

function generationBackfillScope(source: GenerationSource, fn?: GenerationFunction) {
  if (source === "history")
    return { type: { in: fn ? [fn] : ["LISTING_GENERATION", "LISTING_SCORING"] } }
  if (source === "rpaCreationTask") return { mediaType: fn ?? { in: ["IMAGE", "VIDEO"] } }
  if (source === "businessAiRun")
    return {
      module: {
        in:
          fn === "LISTING_SCORING"
            ? ["listing-score"]
            : fn === "COMPETITOR_ANALYSIS"
              ? ["competitor-analysis"]
              : ["listing-score", "competitor-analysis"],
      },
    }
  return {}
}

const NUMERIC_IDS = new Set<GenerationSource>([
  "generationTask",
  "videoTask",
  "storyboardVideo",
  "beautyTask",
  "rpaCreationTask",
  "inspirationSubscription",
  "history",
  "businessAiRun",
  "categoryAnalysisRecord",
])

/** MySQL 原生查询可能把 Int/UNSIGNED INT 返回为 bigint，进入模型委托前恢复其主键类型。 */
export function normalizeGenerationSourceId(
  source: GenerationSource,
  id: unknown
): string | number {
  if (NUMERIC_IDS.has(source)) {
    if (
      !["number", "bigint", "string"].includes(typeof id) ||
      (typeof id === "string" && !/^\d+$/.test(id))
    )
      throw new Error(`回填候选 ID 类型无效 source=${source}`)
    const value = Number(id)
    const max =
      source === "businessAiRun" || source === "categoryAnalysisRecord"
        ? 4_294_967_295
        : 2_147_483_647
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`回填候选 ID 超出 Int 范围 source=${source}`)
    return value
  }
  if (typeof id !== "string" || !id.length) throw new Error(`回填候选 ID 类型无效 source=${source}`)
  return id
}

// 只有一项不可变成功事件的媒体来源能按父 ID 跳过；多版本/多批次来源必须继续检查。
function fixedSnapshotIdentity(
  source: GenerationSource,
  root: { id: string | number; generationMode?: string; sourceJobId?: string | null }
) {
  const types: Partial<Record<GenerationSource, string>> = {
    imageGenJob: "IMAGEGEN",
    videoTask: "VIDEO",
    storyboardVideo: "STORYBOARD_VIDEO",
    beautyTask: "BEAUTY_VIDEO",
  }
  const sourceType =
    source === "generationTask" && root.generationMode === "STANDARD" && !root.sourceJobId
      ? "IMAGE"
      : types[source]
  return sourceType ? { sourceType, sourceId: String(root.id), operation: "" } : null
}

type BackfillResult = { snapshots: Array<{ key: string; credits: string | null }>; written: number }

export async function backfillGenerationRecords(
  prisma: PrismaClient,
  options: ReturnType<typeof parseGenerationBackfillArgs>,
  report: (value: unknown) => void = console.log
) {
  // 仅用于只读查询和本脚本的不可变快照写入，不重跑业务或扣费。
  const withDatabaseRetry = async <T>(
    context: string,
    operation: () => PromiseLike<T>,
    retryOptions: { retryClosedTransaction?: boolean; write?: boolean } = {}
  ): Promise<T> => {
    for (let retry = 0; ; retry++) {
      try {
        return await operation()
      } catch (error) {
        const code =
          error instanceof Prisma.PrismaClientKnownRequestError
            ? error.code
            : error instanceof Prisma.PrismaClientInitializationError
              ? error.errorCode
              : undefined
        if (
          (code !== "P1017" &&
            code !== "P1001" &&
            !(retryOptions.retryClosedTransaction && code === "P2028")) ||
          retry >= 2
        )
          throw error
        const waitMs = (retry + 1) * 500
        report({
          event: retryOptions.write ? "write-retry" : "read-retry",
          context,
          code,
          retry: retry + 1,
          waitMs,
        })
        await delay(waitMs)
      }
    }
  }
  const totals = { scanned: 0, successful: 0, written: 0, unknownCredits: 0, knownCredits: "0" }
  const outcomes = new Map<string, { credits: string | null }>()
  let knownCredits = new Prisma.Decimal(0)
  let resume = !options.cursor
  const sources = Object.keys(GENERATION_SOURCES) as GenerationSource[]
  if (
    (!options.fn || options.fn === "ASIN_AUDIT") &&
    (!options.cursor ||
      sources.indexOf(options.cursor.source) <= sources.indexOf("asinAuditRecord"))
  ) {
    // 按前导列识别等价索引，不要求固定名称，兼容已有 (source, createdAt, id)。
    const indexes = await withDatabaseRetry("UsageLog:indexes", () =>
      prisma.$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT INDEX_NAME AS name FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UsageLog'
        AND SEQ_IN_INDEX IN (1, 2) AND SUB_PART IS NULL
      GROUP BY INDEX_NAME HAVING COUNT(*) = 2
        AND MAX(CASE WHEN SEQ_IN_INDEX = 1 THEN COLUMN_NAME END) = 'source'
        AND MAX(CASE WHEN SEQ_IN_INDEX = 2 THEN COLUMN_NAME END) = 'createdAt'
    `)
    )
    if (!indexes.length)
      throw new Error(
        "缺少 UsageLog(source, createdAt) 前导索引，请先执行 scripts/sql/generation-record-backfill-indexes.sql；已有等价索引可直接复用"
      )
  }
  for (const source of Object.keys(GENERATION_SOURCES) as GenerationSource[]) {
    if (!resume && source === options.cursor!.source) resume = true
    if (!resume) continue
    if (
      options.fn &&
      GENERATION_SOURCES[source] !== options.fn &&
      !(source === "history" && ["LISTING_GENERATION", "LISTING_SCORING"].includes(options.fn)) &&
      !(
        source === "businessAiRun" &&
        ["LISTING_SCORING", "COMPETITOR_ANALYSIS"].includes(options.fn)
      ) &&
      !(source === "rpaCreationTask" && ["IMAGE", "VIDEO"].includes(options.fn))
    )
      continue
    const splitGroups = new Map<string, Promise<BackfillResult>>()
    let after: number | string | undefined =
      options.cursor?.source === source
        ? NUMERIC_IDS.has(source)
          ? Number(options.cursor.id)
          : options.cursor.id
        : undefined
    let readBatchSize = options.batchSize
    for (;;) {
      const rawIds = await withDatabaseRetry(`${source}:candidates`, () =>
        prisma.$queryRaw<Array<{ id: number | string | bigint }>>(
          generationBackfillIdQuery(source, { ...options, batchSize: readBatchSize }, after)
        )
      )
      const ids = rawIds.map(row => ({ id: normalizeGenerationSourceId(source, row.id) }))
      if (!ids.length) break
      const splitGroup = (root: {
        id: string | number
        generationMode?: string
        groupId?: string
        userId?: number
      }) =>
        source === "generationTask" && root.generationMode === "AI_SPLIT" && root.groupId
          ? `${root.userId}:${root.groupId}`
          : ""
      // 每页的根记录、结果、台账来自同一个只读快照，避免业务并发结算造成混读。
      const loadPage = async (tx: Prisma.TransactionClient) => {
        const rows = (await (tx as any)[source].findMany({
          where: {
            id: { in: ids.map(row => row.id) },
            ...generationBackfillScope(source, options.fn),
          },
          orderBy: { id: "asc" },
        })) as Array<{ id: number | string; [field: string]: any }>
        const identities = options.apply
          ? rows.flatMap(root => {
              const identity =
                eligibleGenerationSource(source, root) && fixedSnapshotIdentity(source, root)
              return identity ? [identity] : []
            })
          : []
        const existing = identities.length
          ? await tx.generationRecord.findMany({
              where: { OR: identities },
              select: { sourceType: true, sourceId: true, credits: true },
            })
          : []
        const frozen = new Map(existing.map(row => [`${row.sourceType}:${row.sourceId}`, row]))
        const skipped = new Set<string | number>()
        if (options.apply && source === "generationTask") {
          const jobs = rows.flatMap(root =>
            typeof root.sourceJobId === "string" ? [root.sourceJobId] : []
          )
          const saved = jobs.length
            ? await tx.generationRecord.findMany({
                where: { sourceType: "IMAGEGEN", sourceId: { in: jobs } },
                select: { sourceId: true },
              })
            : []
          for (const root of rows)
            if (saved.some(row => row.sourceId === root.sourceJobId)) skipped.add(root.id)
        }
        if (options.apply && source === "competitorAnalysisRecord" && rows.length) {
          const runs = await tx.businessAiRun.findMany({
            where: {
              module: "competitor-analysis",
              OR: rows
                .filter(root => root.clientRequestId)
                .map(root => ({
                  userId: root.userId as number,
                  runId: root.clientRequestId as string,
                })),
            },
            select: { id: true, userId: true, runId: true },
          })
          const saved = runs.length
            ? await tx.generationRecord.findMany({
                where: {
                  sourceType: "TEXT_RUN",
                  sourceId: { in: runs.map(run => `competitor-analysis:${run.id}`) },
                },
                select: { sourceId: true },
              })
            : []
          for (const root of rows)
            if (
              runs.some(
                run =>
                  run.userId === root.userId &&
                  run.runId === root.clientRequestId &&
                  saved.some(row => row.sourceId === `competitor-analysis:${run.id}`)
              )
            )
              skipped.add(root.id)
        }
        const pending = rows.filter(root => {
          const identity = fixedSnapshotIdentity(source, root)
          return (
            eligibleGenerationSource(source, root) &&
            !skipped.has(root.id) &&
            !(identity && frozen.has(`${identity.sourceType}:${identity.sourceId}`)) &&
            !splitGroups.has(splitGroup(root))
          )
        })
        const projected = await projectGenerationSourcePage(tx, source, pending)
        for (const [id, records] of projected)
          projected.set(
            id,
            records.filter(row => row.createdAt >= options.from && row.createdAt <= options.to)
          )
        const modelIds = options.apply
          ? [
              ...new Set(
                [...projected.values()].flatMap(records =>
                  records.flatMap(row => {
                    const id = generationSnapshotFromRecord(row).modelPublicId
                    return id ? [id] : []
                  })
                )
              ),
            ]
          : []
        const directory = modelIds.length
          ? await tx.aiGatewayModel.findMany({
              where: { publicId: { in: modelIds } },
              select: { publicId: true, displayName: true },
              orderBy: { id: "asc" },
            })
          : []
        const models = new Map<string, { publicId: string; displayName: string }>()
        for (const model of directory)
          if (!models.has(model.publicId)) models.set(model.publicId, model)
        return { rows, frozen, skipped, projected, models }
      }
      let page: Awaited<ReturnType<typeof loadPage>>
      try {
        page = await withDatabaseRetry(
          `${source}:page`,
          () =>
            prisma.$transaction(loadPage, {
              isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
              maxWait: 30000,
              timeout: 30000,
            }),
          { retryClosedTransaction: ids.length === 1 }
        )
      } catch (cause) {
        // 失效的是只读页；不推进断点，缩小批量后建立新快照，不跳过任何候选。
        if (
          cause instanceof Prisma.PrismaClientKnownRequestError &&
          cause.code === "P2028" &&
          ids.length > 1
        ) {
          readBatchSize = Math.max(1, Math.floor(ids.length / 2))
          report({
            event: "page-resize",
            source,
            firstId: ids[0].id,
            code: cause.code,
            previousBatchSize: ids.length,
            batchSize: readBatchSize,
          })
          continue
        }
        throw new Error(
          `回填页面读取失败 source=${source} firstId=${ids[0].id}；可从最后输出的 cursor 继续，无进度则从头重跑`,
          { cause }
        )
      }
      const { rows, frozen, skipped, projected, models } = page
      // 已被硬删除或不属于所选功能的候选也须越过断点。
      if (!rows.length) {
        after = ids[ids.length - 1].id
        continue
      }
      const processRoot = async (root: (typeof rows)[number]): Promise<BackfillResult> => {
        if (!eligibleGenerationSource(source, root) || skipped.has(root.id))
          return { snapshots: [], written: 0 }
        if (options.apply) {
          const identity = fixedSnapshotIdentity(source, root)
          const key = identity ? `${identity.sourceType}:${identity.sourceId}` : ""
          const saved = frozen.get(key)
          if (saved)
            return { snapshots: [{ key, credits: saved.credits?.toString() ?? null }], written: 1 }
          if (!projected.get(root.id)?.length) return { snapshots: [], written: 0 }
          return withDatabaseRetry(
            `${source}:${root.id}`,
            () =>
              prisma.$transaction(
                tx => saveProjectedGenerationRecords(tx, projected.get(root.id) ?? [], models),
                { maxWait: 30000, timeout: 30000 }
              ),
            { write: true }
          )
        }
        // dry-run 只读取来源，不查目标表、不锁行、不写入。
        return { snapshots: projected.get(root.id) ?? [], written: 0 }
      }
      for (let offset = 0; offset < rows.length; offset += options.concurrency) {
        const chunk = rows.slice(offset, offset + options.concurrency)
        // 等待本组全部结束再推进断点；失败可幂等重跑，不覆盖已有快照。
        const results = await Promise.allSettled(
          chunk.map(root => {
            const group = splitGroup(root)
            const cached = group ? splitGroups.get(group) : undefined
            if (cached) return cached
            const work = processRoot(root)
            if (group) splitGroups.set(group, work)
            return work
          })
        )
        const failure = results.findIndex(result => result.status === "rejected")
        if (failure >= 0) {
          const result = results[failure] as PromiseRejectedResult
          throw new Error(
            `回填失败 source=${source} id=${chunk[failure].id}；可从最后输出的 cursor 继续，无进度则从头重跑`,
            { cause: result.reason }
          )
        }
        for (const result of results as PromiseFulfilledResult<BackfillResult>[]) {
          totals.scanned++
          totals.written += result.value.written
          totals.successful += result.value.snapshots.length
          for (const row of result.value.snapshots) {
            const previous = outcomes.get(row.key)
            if (previous) {
              knownCredits = knownCredits.minus(previous.credits ?? 0)
              if (previous.credits == null) totals.unknownCredits--
            }
            outcomes.set(row.key, { credits: row.credits })
            knownCredits = knownCredits.plus(row.credits ?? 0)
            if (row.credits == null) totals.unknownCredits++
          }
        }
        after = chunk[chunk.length - 1].id
        totals.knownCredits = knownCredits.toString()
        report({
          mode: options.apply ? "apply" : "dry-run",
          source,
          cursor: `${source}:${after}`,
          ...totals,
        })
      }
      after = ids[ids.length - 1].id
    }
  }
  // successful/written 是投影尝试数；distinctResults 与金额按事件 key 去重。
  report({
    complete: true,
    distinctResults: outcomes.size,
    mode: options.apply ? "apply" : "dry-run",
    ...totals,
  })
  return totals
}

if (require.main === module) {
  const options = parseGenerationBackfillArgs(process.argv.slice(2))
  const prisma = new PrismaClient()
  backfillGenerationRecords(prisma, options)
    .catch(error => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
