import { ConflictException } from "@nestjs/common"
import type { PatentQueryCheck, Prisma } from "@prisma/client"
import { isDeepStrictEqual } from "node:util"
import { ExportConflict } from "./patent-query-export.contract"
import { Bag, Output, Task, json, obj, output, rows, str } from "./patent-query.types"

type Db = Pick<
  Prisma.TransactionClient,
  "patentQueryResult" | "patentQueryTextMark" | "patentQueryCache"
>
export interface StoredResult {
  imageId: string | null
  position: number
  data: Prisma.JsonValue
  marks?: Prisma.JsonValue[]
}

// 只改变存储布局；报告计算仍使用原结构，避免改变标记、待办 ID 和前端契约。
export function splitResults(value: unknown) {
  const data = structuredClone(output(value))
  const results: StoredResult[] = []
  const append = (imageId: string | null, values: Bag[]) => {
    for (const item of values) {
      const word = structuredClone(item)
      if (imageId === null && "marks" in word && !Array.isArray(word.marks))
        throw new Error("文字商标 marks 不是数组，保留原数据待核对")
      const marks =
        imageId === null && Array.isArray(word.marks)
          ? word.marks.map(m => json(m) as Prisma.JsonValue)
          : undefined
      if (marks) delete word.marks
      results.push({
        imageId,
        position: results.length,
        data: json(word) as Prisma.JsonObject,
        ...(marks ? { marks } : {}),
      })
    }
  }
  for (const [imageId, unit] of Object.entries(data.units)) {
    append(imageId, rows(unit.matches))
    delete (unit as Partial<typeof unit>).matches
  }
  if (data.text) {
    append(null, rows(data.text.words))
    delete data.text.words
  }
  return { data, results }
}

export function hydrateOutput(value: unknown, results: StoredResult[], verify = false): Output {
  const data = structuredClone(output(value))
  const grouped = new Map<string | null, Bag[]>()
  const ordered = [...results].sort((a, b) => a.position - b.position)
  if (verify && ordered.some((row, index) => row.position !== index))
    throw new ExportConflict("REPORT_DATA_INCOMPLETE")
  for (const row of ordered) {
    const group = grouped.get(row.imageId) ?? []
    const value = structuredClone(obj(row.data))
    if (verify && !Object.keys(value).length) throw new ExportConflict("REPORT_DATA_INCOMPLETE")
    if (row.imageId === null) {
      if ("marks" in value) throw new ConflictException("不支持旧版报告数据，请清理测试记录")
      if (verify && !str(value.term)) throw new ExportConflict("REPORT_DATA_INCOMPLETE")
      value.marks = row.marks ?? []
    }
    group.push(value)
    grouped.set(row.imageId, group)
  }
  if (
    Object.values(data.units).some(unit => rows(unit.matches).length) ||
    rows(data.text?.words).length ||
    Object.keys(data.cache ?? {}).length
  )
    throw new ConflictException("不支持旧版报告数据，请清理测试记录")
  for (const [imageId, unit] of Object.entries(data.units))
    unit.matches = grouped.get(imageId) ?? []
  if (data.text) data.text.words = grouped.get(null) ?? []
  if (verify) {
    const words = rows(data.text?.words)
    if (
      [...grouped.keys()].some(id => (id === null ? !data.text : !data.units[id])) ||
      Object.values(data.units).some(
        unit => unit.savedMatchCount !== undefined && unit.matches.length !== unit.savedMatchCount
      ) ||
      (data.savedWordMarkCounts &&
        (words.length !== data.savedWordMarkCounts.length ||
          data.savedWordMarkCounts.some((count, n) => rows(words[n]?.marks).length !== count)))
    )
      throw new ExportConflict("REPORT_DATA_INCOMPLETE")
  }
  delete data.cache
  return data
}

// 仅从当前商标子表批量加载，在应用内排序。
export async function hydrateResults<T extends StoredResult & { id: number }>(
  db: Db,
  stored: T[],
  verify = false
) {
  const ids = stored.filter(r => r.imageId === null).map(r => r.id)
  const needed = new Set(ids)
  const marks = ids.length
    ? await db.patentQueryTextMark.findMany({ where: { resultId: { in: ids } } })
    : []
  const grouped = new Map<number, typeof marks>()
  for (const mark of marks) {
    const group = grouped.get(mark.resultId) ?? []
    group.push(mark)
    grouped.set(mark.resultId, group)
  }
  for (const group of grouped.values()) {
    group.sort((a, b) => a.position - b.position)
    if (
      verify &&
      group.some((mark, n) => mark.position !== n || !Object.keys(obj(mark.data)).length)
    )
      throw new ExportConflict("REPORT_DATA_INCOMPLETE")
  }
  return stored.map(r => ({
    ...r,
    ...(needed.has(r.id)
      ? {
          marks: (grouped.get(r.id) ?? []).map(m => m.data),
        }
      : {}),
  }))
}

export async function hydrateChecks(db: Db, checks: PatentQueryCheck[], verify = false) {
  const ids = checks.map(c => c.id)
  if (!ids.length) return checks
  const stored = await db.patentQueryResult.findMany({
    where: { checkId: { in: ids } },
    // hydrateOutput 已按分项排序，避免 MySQL 对大 JSON 明细执行全局 filesort。
  })
  const grouped = new Map<number, StoredResult[]>()
  for (const row of await hydrateResults(db, stored, verify)) {
    const group = grouped.get(row.checkId) ?? []
    group.push(row)
    grouped.set(row.checkId, group)
  }
  return checks.map(c => ({
    ...c,
    output: json(hydrateOutput(c.output, grouped.get(c.id) ?? [], verify)),
  }))
}

export async function hydrateTasks(db: Db, tasks: Task[], verify = false): Promise<Task[]> {
  const checks = await hydrateChecks(
    db,
    tasks.flatMap(t => t.checks),
    verify
  )
  const byId = new Map(checks.map(c => [c.id, c]))
  return tasks.map(t => ({
    ...t,
    checks: t.checks.map(c => ({ ...c, output: byId.get(c.id)!.output as Prisma.JsonValue })),
  }))
}

// 调用方必须已锁定 PatentQueryCheck；明细与 output 进度必须在同一事务提交。
export async function saveResults(db: Db, checkId: number, value: Output) {
  const { data, results } = splitResults(value)
  const existing = await db.patentQueryResult.findMany({ where: { checkId } })
  const byPosition = new Map(existing.map(r => [r.position, r]))
  const added: Prisma.PatentQueryResultCreateManyInput[] = []
  for (const row of results) {
    const old = byPosition.get(row.position)
    const next = { imageId: row.imageId, position: row.position, data: json(row.data) }
    if (!old) added.push({ checkId, ...next })
    else if (old.imageId !== row.imageId || !isDeepStrictEqual(json(old.data), json(row.data)))
      await db.patentQueryResult.update({ where: { id: old.id }, data: next })
  }
  if (added.length) await db.patentQueryResult.createMany({ data: added })
  if (existing.some(r => r.position >= results.length))
    await db.patentQueryResult.deleteMany({ where: { checkId, position: { gte: results.length } } })
  const parents = added.length
    ? await db.patentQueryResult.findMany({ where: { checkId } })
    : existing
  const parentIds = parents
    .filter(
      p =>
        p.position < results.length &&
        (p.imageId === null ||
          byPosition.get(p.position)?.imageId === null ||
          results[p.position].imageId === null)
    )
    .map(p => p.id)
  const previous = parentIds.length
    ? await db.patentQueryTextMark.findMany({ where: { resultId: { in: parentIds } } })
    : []
  const byParent = new Map<number, Map<number, (typeof previous)[number]>>()
  for (const mark of previous) {
    const group = byParent.get(mark.resultId) ?? new Map()
    group.set(mark.position, mark)
    byParent.set(mark.resultId, group)
  }
  const appended: Prisma.PatentQueryTextMarkCreateManyInput[] = []
  for (const parent of parents) {
    const row = results[parent.position]
    if (!row) continue
    const marks = row.marks ?? []
    const old = byParent.get(parent.id) ?? new Map<number, (typeof previous)[number]>()
    for (const [position, mark] of marks.entries()) {
      const saved = old.get(position)
      if (!saved) appended.push({ resultId: parent.id, position, data: json(mark) })
      else if (!isDeepStrictEqual(json(saved.data), json(mark)))
        await db.patentQueryTextMark.update({ where: { id: saved.id }, data: { data: json(mark) } })
    }
    if ([...old.keys()].some(position => position >= marks.length))
      await db.patentQueryTextMark.deleteMany({
        where: { resultId: parent.id, position: { gte: marks.length } },
      })
  }
  if (appended.length) await db.patentQueryTextMark.createMany({ data: appended })
  return data
}

export function cacheIdentity(key: string) {
  const split = key.lastIndexOf(":")
  const targetId = key.slice(0, split),
    kind = key.slice(split + 1)
  if (split < 1 || !["detail", "cited", "citedBy"].includes(kind))
    throw new Error("专利缓存标识不合法，保留旧数据待核对")
  return { targetId, kind }
}

export function cacheTime(data: Bag) {
  const date = new Date(str(data.generatedAt))
  // 没有有效生成时间的旧缓存按已过期处理，不伪造新鲜时间。
  return Number.isFinite(+date) ? date : new Date(0)
}
