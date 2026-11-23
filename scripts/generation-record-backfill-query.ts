import { Prisma } from "@prisma/client"
import type { GenerationSource } from "../src/generation-record/generation-record-sync"

type Window = { from: Date; to: Date; batchSize: number }

// 标识符仅来自内部来源注册表；日期、断点及分页大小均使用绑定参数。
function identifier(value: string) {
  return Prisma.raw("`" + value + "`")
}

function afterId(reference: Prisma.Sql, after?: string | number) {
  return after == null ? Prisma.empty : Prisma.sql`AND ${reference} > ${after}`
}

function recentIds(
  table: string,
  field: string,
  window: Window,
  after?: string | number,
  reference = "id",
  scope = Prisma.empty
) {
  return Prisma.sql`SELECT ${reference === "id" ? Prisma.empty : Prisma.sql`DISTINCT`} ${identifier(reference)} AS id
    FROM ${identifier(table)}
    WHERE ${identifier(field)} >= ${window.from} AND ${identifier(field)} <= ${window.to}
      ${afterId(identifier(reference), after)} ${scope}`
}

/** 优先复用主键、状态/时间及关联索引，只有近期账本入口需要新增索引。 */
export function generationBackfillIdQuery(
  source: GenerationSource,
  window: Window,
  after?: string | number
) {
  const table = source[0].toUpperCase() + source.slice(1)
  const queries =
    source === "asinAuditRecord"
      ? [
          recentIds("AsinAuditScoreSnapshot", "createdAt", window, after, "recordId"),
          recentIds("AsinAuditOptimizationRevision", "createdAt", window, after, "recordId"),
          // 同正文再次收费不会新增 revision；明确报告 ID 的近期流水也要反查原报告。
          Prisma.sql`SELECT DISTINCT JSON_UNQUOTE(JSON_EXTRACT(meta, '$.recordId')) COLLATE utf8mb4_unicode_ci AS id
          FROM UsageLog
          WHERE source = 'asin.audit' AND createdAt >= ${window.from} AND createdAt <= ${window.to}
            AND JSON_TYPE(JSON_EXTRACT(meta, '$.recordId')) = 'STRING'
            ${afterId(Prisma.sql`JSON_UNQUOTE(JSON_EXTRACT(meta, '$.recordId')) COLLATE utf8mb4_unicode_ci`, after)}`,
          Prisma.sql`SELECT DISTINCT v.recordId AS id
          FROM UsageLog AS l
          STRAIGHT_JOIN AsinAuditOptimizationRevision AS v ON v.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(l.meta, '$.revisionId')) AS UNSIGNED)
          WHERE l.source = 'asin.audit' AND l.createdAt >= ${window.from} AND l.createdAt <= ${window.to}
            AND JSON_TYPE(JSON_EXTRACT(l.meta, '$.revisionId')) = 'INTEGER'
            ${afterId(Prisma.sql`v.recordId`, after)}`,
        ]
      : [
          recentIds(
            table,
            source === "inspirationSubscription" ? "lastRefreshedAt" : "createdAt",
            window,
            after,
            "id",
            // 复用 ImageGenJob(status, createdAt)、ChetaidouTask(status, createdAt)。
            source === "imageGenJob" || source === "chetaidouTask"
              ? Prisma.sql`AND status IN ('SUCCESS', 'COMPLETED', 'SUCCEEDED', 'SCORED', 'OPTIMIZED'${source === "imageGenJob" ? Prisma.sql`, 'PARTIAL'` : Prisma.empty})`
              : Prisma.empty
          ),
        ]
  if (source === "history") {
    for (const child of ["ListingGenerationTask", "ListingAiStep"]) {
      queries.push(Prisma.sql`SELECT DISTINCT r.historyId AS id
        FROM ${identifier(child)} AS t
        JOIN ListingRun AS r ON r.id = t.listingRunId
        WHERE t.updatedAt >= ${window.from} AND t.updatedAt <= ${window.to} AND t.status = 'COMPLETED'
          ${afterId(Prisma.sql`r.historyId`, after)}`)
    }
  }
  if (source === "rpaCreationTask") queries.push(recentIds(table, "completedAt", window, after))
  if (source === "chetaidouTask") queries.push(recentIds(table, "finishedAt", window, after))
  const page = (query: Prisma.Sql) => Prisma.sql`${query} ORDER BY id ASC LIMIT ${window.batchSize}`
  // 底层 MySQL 驱动也可能把注释里的 :name 当作命名参数，诊断标签使用空格。
  if (queries.length === 1)
    return Prisma.sql`/* generation-backfill ${Prisma.raw(source)} */ ${page(queries[0])}`
  return Prisma.sql`/* generation-backfill ${Prisma.raw(source)} */
    SELECT DISTINCT id FROM (${Prisma.join(
      queries.map(query => Prisma.sql`(${page(query)})`),
      " UNION ALL "
    )}) AS recent
    WHERE id IS NOT NULL ${after == null ? Prisma.empty : Prisma.sql`AND id > ${after}`}
    ORDER BY id ASC LIMIT ${window.batchSize}`
}
