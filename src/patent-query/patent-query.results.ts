import { uiText } from "../common/i18n/request-language"
import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { ResultPageDto, ResultsQueryDto } from "./dto/patent-query.dto"
import {
  annotations,
  buildReport,
  dateValue,
  decisionKey,
  imageTarget,
  Match,
  Risk,
} from "./patent-query.report"
import { Bag, input, Kind, obj, PAID, rows, str, Task } from "./patent-query.types"

type Db = Prisma.TransactionClient
const fields = (alias: string, names: string[]) =>
  Prisma.raw(
    `JSON_OBJECT(${names.map(name => `'${name}', JSON_EXTRACT(${alias}, '$.${name}')`).join(",")})`
  )
// All paths and identifiers below are module constants. Client references never become SQL paths.
const RULE_FIELDS = [
  "pn",
  "id",
  "serialNumber",
  "countryCode",
  "score",
  "reasonCode",
  "riskLevel",
  "expired",
  "status",
  "legalStatus",
  "matchType",
  "level",
  "term",
  "title",
  "markText",
  "sourceHost",
]
const ruleProjection = (alias: string) => fields(alias, RULE_FIELDS)
const cases = (alias: string, path: string) =>
  Prisma.raw(
    `COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('caseNumber',JSON_EXTRACT(t.data,'$.caseNumber'),'caseNo',JSON_EXTRACT(t.data,'$.caseNo'))) FROM JSON_TABLE(${alias}, '${path}[*]' COLUMNS(data JSON PATH '$')) t), JSON_ARRAY())`
  )
const troProjection = (alias: string) =>
  Prisma.sql`JSON_OBJECT('cases',${cases(alias, "$.cases")},'ownerCases',IF(JSON_TYPE(JSON_EXTRACT(${Prisma.raw(alias)},'$.ownerCases'))='ARRAY',${cases(alias, "$.ownerCases")},JSON_EXTRACT(${Prisma.raw(alias)},'$.ownerCases')),'markCases',IF(JSON_TYPE(JSON_EXTRACT(${Prisma.raw(alias)},'$.markCases'))='ARRAY',${cases(alias, "$.markCases")},JSON_EXTRACT(${Prisma.raw(alias)},'$.markCases')),'total',JSON_EXTRACT(${Prisma.raw(alias)},'$.total'),'latestCaseNumber',JSON_EXTRACT(${Prisma.raw(alias)},'$.latestCaseNumber'))`
const cardProjection = (
  alias: string
) => Prisma.sql`JSON_MERGE_PATCH(${ruleProjection(alias)}, JSON_OBJECT(
 'filingDate',JSON_EXTRACT(${Prisma.raw(alias)},'$.filingDate'),'grantDate',JSON_EXTRACT(${Prisma.raw(alias)},'$.grantDate'),'expiryDate',JSON_EXTRACT(${Prisma.raw(alias)},'$.expiryDate'),'regDate',JSON_EXTRACT(${Prisma.raw(alias)},'$.regDate'),'locs',JSON_EXTRACT(${Prisma.raw(alias)},'$.locs'),
 'reason',LEFT(JSON_UNQUOTE(JSON_EXTRACT(${Prisma.raw(alias)},'$.reason')),240),
 'image',JSON_EXTRACT(${Prisma.raw(alias)},'$.image'),
 'imageUrl',JSON_EXTRACT(${Prisma.raw(alias)},'$.imageUrl'),
 'thumbnail',JSON_EXTRACT(${Prisma.raw(alias)},'$.imageUrls[0]'),
 'owners',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',p.name)) FROM JSON_TABLE(${Prisma.raw(alias)},'$.owners[*]' COLUMNS(name VARCHAR(255) PATH '$.name')) p),JSON_ARRAY()),
 'assignees',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',p.name)) FROM JSON_TABLE(${Prisma.raw(alias)},'$.assignees[*]' COLUMNS(name VARCHAR(255) PATH '$.name')) p),JSON_ARRAY()),
 'classCodes',COALESCE((SELECT JSON_ARRAYAGG(p.code) FROM JSON_TABLE(${Prisma.raw(alias)},'$.classes[*]' COLUMNS(code VARCHAR(64) PATH '$.code')) p),JSON_ARRAY()),
 'tmClassCodes',COALESCE((SELECT JSON_ARRAYAGG(p.code) FROM JSON_TABLE(${Prisma.raw(alias)},'$.tmClass[*]' COLUMNS(code VARCHAR(64) PATH '$.code')) p),JSON_ARRAY())))`
export interface LightRow {
  id: number
  checkId: number
  imageId: string | null
  position: number
  data: Bag
}
interface MarkRow {
  id: number
  resultId: number
  position: number
  data: Bag
}
export interface LightReport {
  task: Task
  report: ReturnType<typeof buildReport>
  results: LightRow[]
  marks: MarkRow[]
}
export function assertPaid(task: Pick<Task, "status" | "error">) {
  if (PAID.includes(task.status)) return
  const payment = task.status === "SETTLING" && task.error?.startsWith("[PAYMENT_REQUIRED]")
  throw new HttpException(
    payment
      ? uiText("报告待结算，请补足积分或解除配额限制后重试", "Settlement pending. Check the credit balance and quota, then retry.")
      : task.status === "SETTLING"
        ? uiText("报告结算尚未完成", "Settlement is pending")
        : uiText("报告尚不可用", "Report not available yet"),
    payment ? 402 : 409
  )
}
export async function readLight(
  db: Db,
  userId: number,
  id: number,
  paid = true
): Promise<LightReport> {
  return (await readLightBatch(db, userId, [id], paid))[0]
}
export async function readLightBatch(
  db: Db,
  userId: number,
  ids: number[],
  paid = false
): Promise<LightReport[]> {
  if (!ids.length) return []
  const headers = await db.$queryRaw<
    Task[]
  >(Prisma.sql`SELECT id,userId,requestId,status,quotedCredits,annotations,error,createdAt,finishedAt,deletedAt,
    JSON_OBJECT('images',JSON_EXTRACT(input,'$.images'),'sites',JSON_EXTRACT(input,'$.sites'),'resolved',JSON_EXTRACT(input,'$.resolved'),'design',JSON_EXTRACT(input,'$.design'),'copy',JSON_EXTRACT(input,'$.copy'),'gtm',JSON_EXTRACT(input,'$.gtm'),
      'tm',IF(JSON_TYPE(JSON_EXTRACT(input,'$.tm'))='OBJECT', JSON_OBJECT('brand',JSON_EXTRACT(input,'$.tm.brand'),'title',JSON_EXTRACT(input,'$.tm.title'),'includeImageText',JSON_EXTRACT(input,'$.tm.includeImageText'),'images',JSON_EXTRACT(input,'$.tm.images')),NULL)) AS input
    FROM PatentQueryTask WHERE id IN (${Prisma.join(ids)}) AND userId=${userId} AND deletedAt IS NULL`)
  const tasks = new Map(headers.map(task => [Number(task.id), task]))
  if (ids.some(id => !tasks.has(id))) throw new NotFoundException("检测记录不存在")
  for (const task of headers) {
    task.id = Number(task.id)
    if (paid) assertPaid(task)
  }
  const checks = (await db.patentQueryCheck.findMany({
    where: { taskId: { in: ids } },
    select: { id: true, taskId: true, kind: true, status: true, upstreamTaskId: true, error: true },
  })) as Task["checks"]
  for (const task of headers) task.checks = checks.filter(c => c.taskId === task.id)
  const settledIds = headers.filter(task => PAID.includes(task.status)).map(task => task.id)
  const units = await db.$queryRaw<
    { checkId: number; imageId: string; data: Bag; inline: number }[]
  >(Prisma.sql`
    SELECT c.id AS checkId,k.imageId,
      JSON_OBJECT('status',JSON_EXTRACT(u.data,'$.status'),'error',JSON_EXTRACT(u.data,'$.error'),'complete',JSON_EXTRACT(u.data,'$.complete'),
       'result',JSON_OBJECT('riskLevel',JSON_EXTRACT(u.data,'$.result.riskLevel'),'knownIpMatch',JSON_OBJECT('isMatch',JSON_EXTRACT(u.data,'$.result.knownIpMatch.isMatch'),'matchedName',JSON_EXTRACT(u.data,'$.result.knownIpMatch.matchedName')),'troCases',${cases("u.data", "$.result.troCases")},'riskDrivers',JSON_EXTRACT(u.data,'$.result.riskDrivers'))) AS data,
      JSON_CONTAINS_PATH(u.data,'one','$.matches') AS inline
    FROM PatentQueryCheck c
    JOIN JSON_TABLE(COALESCE(JSON_KEYS(c.output,'$.units'),JSON_ARRAY()),'$[*]' COLUMNS(imageId VARCHAR(64) PATH '$')) k
    JOIN JSON_TABLE(JSON_ARRAY(JSON_EXTRACT(c.output,CONCAT('$.units.',JSON_QUOTE(k.imageId)))),'$[*]' COLUMNS(data JSON PATH '$')) u
    WHERE c.taskId IN (${Prisma.join(ids)})`)
  const texts = await db.$queryRaw<{ checkId: number; data: Bag; inline: number }[]>(Prisma.sql`
    SELECT c.id AS checkId, JSON_OBJECT('warnings',JSON_EXTRACT(c.output,'$.text.warnings'),
      'imageOCR',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('imageID',JSON_EXTRACT(o.data,'$.imageID'),'error',JSON_EXTRACT(o.data,'$.error'))) FROM JSON_TABLE(c.output,'$.text.imageOCR[*]' COLUMNS(data JSON PATH '$')) o),JSON_ARRAY())) AS data,
      (JSON_CONTAINS_PATH(c.output,'one','$.text.words','$.cache')) AS inline FROM PatentQueryCheck c WHERE c.taskId IN (${Prisma.join(ids)})`)
  const settledChecks = new Set(checks.filter(c => settledIds.includes(c.taskId)).map(c => c.id))
  if (
    units.some(u => settledChecks.has(Number(u.checkId)) && Number(u.inline)) ||
    texts.some(t => settledChecks.has(Number(t.checkId)) && Number(t.inline))
  )
    throw new ConflictException("不支持旧版报告数据，请清理测试记录")
  const results = settledIds.length
    ? await db.$queryRaw<LightRow[]>(
        Prisma.sql`SELECT r.id,r.checkId,r.imageId,r.position,JSON_MERGE_PATCH(${ruleProjection("r.data")},JSON_OBJECT('genericity',JSON_OBJECT('kind',JSON_EXTRACT(r.data,'$.genericity.kind'),'kindLabel',JSON_EXTRACT(r.data,'$.genericity.kindLabel'),'label',JSON_EXTRACT(r.data,'$.genericity.label')),'where',JSON_EXTRACT(r.data,'$.where'),'tro',${troProjection("JSON_EXTRACT(r.data,'$.tro')")},'_inline',(r.imageId IS NULL AND JSON_CONTAINS_PATH(r.data,'one','$.marks')))) AS data FROM PatentQueryResult r JOIN PatentQueryCheck c ON c.id=r.checkId WHERE c.taskId IN (${Prisma.join(settledIds)}) ORDER BY r.checkId,r.position,r.id`
      )
    : []
  if (results.some(r => r.imageId === null && Number(r.data._inline)))
    throw new ConflictException("不支持旧版报告数据，请清理测试记录")
  const marks = settledIds.length
    ? await db.$queryRaw<MarkRow[]>(
        Prisma.sql`SELECT m.id,m.resultId,m.position,${ruleProjection("m.data")} AS data FROM PatentQueryTextMark m JOIN PatentQueryResult r ON r.id=m.resultId JOIN PatentQueryCheck c ON c.id=r.checkId WHERE c.taskId IN (${Prisma.join(settledIds)}) ORDER BY r.position,r.id,m.position,m.id`
      )
    : []
  for (const r of results) {
    r.id = Number(r.id)
    r.checkId = Number(r.checkId)
    r.data._rowId = `r-${r.id}`
  }
  for (const m of marks) {
    m.id = Number(m.id)
    m.resultId = Number(m.resultId)
    m.data._rowId = `m-${m.id}`
  }
  const marksByParent = new Map<number, Bag[]>()
  for (const m of marks) {
    const group = marksByParent.get(m.resultId) ?? []
    group.push(m.data)
    marksByParent.set(m.resultId, group)
  }
  const resultsByCheck = new Map<number, Map<string | null, Bag[]>>()
  for (const r of results) {
    const groups = resultsByCheck.get(r.checkId) ?? new Map<string | null, Bag[]>(),
      group = groups.get(r.imageId) ?? []
    group.push(r.imageId === null ? { ...r.data, marks: marksByParent.get(r.id) ?? [] } : r.data)
    groups.set(r.imageId, group)
    resultsByCheck.set(r.checkId, groups)
  }
  for (const c of checks) {
    const groups = resultsByCheck.get(c.id),
      out = {
        units: {} as Record<string, unknown>,
        ...(c.kind === "tm"
          ? {
              text: {
                ...texts.find(t => Number(t.checkId) === c.id)?.data,
                words: groups?.get(null) ?? [],
              },
            }
          : {}),
      }
    for (const u of units.filter(u => Number(u.checkId) === c.id))
      out.units[u.imageId] = { ...u.data, matches: groups?.get(u.imageId) ?? [] }
    c.output = out as unknown as Prisma.JsonValue
  }
  const checkOwners = new Map(checks.map(c => [c.id, c.taskId]))
  const resultOwners = new Map<number, number>()
  const resultsByTask = new Map<number, LightRow[]>()
  const marksByTask = new Map<number, MarkRow[]>()
  for (const row of results) {
    const owner = checkOwners.get(row.checkId)!
    resultOwners.set(row.id, owner)
    const group = resultsByTask.get(owner) ?? []
    group.push(row)
    resultsByTask.set(owner, group)
  }
  for (const row of marks) {
    const owner = resultOwners.get(row.resultId)!
    const group = marksByTask.get(owner) ?? []
    group.push(row)
    marksByTask.set(owner, group)
  }
  return ids.map(id => {
    const task = tasks.get(id)!
    let report: ReturnType<typeof buildReport> | undefined
    return {
      task,
      results: resultsByTask.get(id) ?? [],
      marks: marksByTask.get(id) ?? [],
      get report() {
        return (report ??= buildReport(task, { light: true }))
      },
    }
  })
}

export const wordId = (word: Bag) => `w-${str(word._rowId).slice(2)}`
export function word(light: LightReport, id: string) {
  const found = rows(light.report.tm.words).find(w => wordId(w) === id)
  if (!found) throw new NotFoundException("商标词不在本报告中")
  return found
}
export function matches(light: LightReport, kind: Kind, imageId?: string): Match[] {
  if (kind === "tm") return rows(light.report.tm.words).flatMap(w => w.marks as Match[])
  const i = input(light.task.input)
  if (imageId && !i.images.some(image => image.id === imageId))
    throw new BadRequestException("图片不属于当前报告")
  return i.images
    .filter(image => !imageId || image.id === imageId)
    .flatMap(
      image =>
        rows(light.report[kind][image.id]?.matches).map(m => ({
          ...m,
          imageId: image.id,
        })) as unknown as Match[]
    )
}
export function findRow(light: LightReport, id: string) {
  for (const kind of ["design", "copy", "gtm", "tm"] as const) {
    const match = matches(light, kind).find(m => m._rowId === id)
    if (match) return { kind, match }
  }
  throw new NotFoundException("命中不在本报告中")
}
export function page<T>(items: T[], dto: ResultPageDto) {
  return {
    total: items.length,
    page: dto.page,
    pageSize: dto.pageSize,
    pageCount: Math.ceil(items.length / dto.pageSize),
    items: items.slice((dto.page - 1) * dto.pageSize, dto.page * dto.pageSize),
  }
}
export function riskPage(
  items: Bag[],
  dto: ResultsQueryDto | (ResultPageDto & { risk?: string }),
  fold = "show"
) {
  const facets = { all: items.length, high: 0, mid: 0, low: 0, UNKNOWN: 0, expired: 0 }
  for (const item of items) facets[item.level as Risk]++
  const risk = dto.risk ?? "all",
    matched = items.filter(m => risk === "all" || m.level === risk)
  const visible = risk === "all" && fold === "hide" ? matched.filter(m => !m.hidden) : matched
  return {
    ...page(visible, dto),
    risk,
    fold: risk === "all" ? fold : "show",
    facets,
    matchedTotal: matched.length,
    hiddenExcluded: matched.length - visible.length,
  }
}
export async function cards(db: Db, light: LightReport, selected: Bag[]) {
  const ids = selected.map(m => str(m._rowId)),
    resultIds = ids.filter(id => id.startsWith("r-")).map(id => Number(id.slice(2))),
    markIds = ids.filter(id => id.startsWith("m-")).map(id => Number(id.slice(2)))
  const data = new Map<string, Bag>()
  if (resultIds.length)
    for (const row of await db.$queryRaw<{ id: number; data: Bag }[]>(
      Prisma.sql`SELECT r.id,${cardProjection("r.data")} AS data FROM PatentQueryResult r JOIN PatentQueryCheck c ON c.id=r.checkId WHERE c.taskId=${light.task.id} AND r.id IN (${Prisma.join(resultIds)})`
    ))
      data.set(`r-${row.id}`, row.data)
  if (markIds.length)
    for (const row of await db.$queryRaw<{ id: number; data: Bag }[]>(
      Prisma.sql`SELECT m.id,${cardProjection("m.data")} AS data FROM PatentQueryTextMark m JOIN PatentQueryResult r ON r.id=m.resultId JOIN PatentQueryCheck c ON c.id=r.checkId WHERE c.taskId=${light.task.id} AND m.id IN (${Prisma.join(markIds)})`
    ))
      data.set(`m-${row.id}`, row.data)
  return selected.map(m => {
    const { sources, _rowId, _inline, tro, ...rest } = m
    void _inline
    void tro
    const { _rowId: ignored, ...card } = data.get(str(_rowId)) ?? {}
    void ignored
    return {
      ...card,
      ...rest,
      ...Object.fromEntries(
        ["filingDate", "grantDate", "expiryDate", "regDate"]
          .filter(key => key in card)
          .map(key => [key, dateValue(card[key])])
      ),
      rowId: _rowId,
      value: m.decisionKey
        ? (annotations(light.task.annotations).decisions[str(m.decisionKey)]?.value ?? "none")
        : "none",
      ...(sources ? { sourceCount: rows(sources).length } : {}),
    }
  })
}
export function resultPage(light: LightReport, dto: ResultsQueryDto) {
  if (dto.kind === "tm" && dto.imageId) throw new BadRequestException("文字商标不支持图片筛选")
  const items =
    dto.kind === "tm"
      ? rows(light.report.tm.words).map(w => ({
          wordId: wordId(w),
          term: w.term,
          level: w.level,
          markCount: rows(w.marks).length,
          genericity: w.genericity,
          where: w.where,
          tro: {
            total: obj(w.tro).total,
            ownerCases: Array.isArray(obj(w.tro).ownerCases)
              ? rows(obj(w.tro).ownerCases).length
              : obj(w.tro).ownerCases,
            markCases: Array.isArray(obj(w.tro).markCases)
              ? rows(obj(w.tro).markCases).length
              : obj(w.tro).markCases,
            caseCount: rows(obj(w.tro).cases).length,
            latestCaseNumber: obj(w.tro).latestCaseNumber,
          },
        }))
      : matches(light, dto.kind, dto.imageId)
  return {
    taskId: light.task.id,
    kind: dto.kind,
    imageId: dto.imageId,
    countUnit: dto.kind === "tm" ? "word" : "match",
    ...riskPage(items, dto, dto.fold),
  }
}
export async function detailRow(db: Db, light: LightReport, id: string, sources?: ResultPageDto) {
  const { kind, match } = findRow(light, id)
  const selected = sources ? page(rows(match.sources), sources) : null
  if (sources && kind !== "tm") throw new BadRequestException("仅文字商标支持来源分页")
  const refs = selected?.items ?? [match]
  const markIds = refs
    .map(ref => str(ref._rowId))
    .filter(id => id.startsWith("m-"))
    .map(id => Number(id.slice(2)))
  const resultIds = refs
    .map(ref => str(ref._rowId))
    .filter(id => id.startsWith("r-"))
    .map(id => Number(id.slice(2)))
  const saved = new Map<string, Bag>()
  if (markIds.length)
    for (const row of await db.patentQueryTextMark.findMany({
      where: { id: { in: markIds }, result: { check: { taskId: light.task.id } } },
      select: { id: true, data: true },
    }))
      saved.set(`m-${row.id}`, obj(row.data))
  if (resultIds.length)
    for (const row of await db.patentQueryResult.findMany({
      where: { id: { in: resultIds }, check: { taskId: light.task.id } },
      select: { id: true, data: true },
    }))
      saved.set(`r-${row.id}`, obj(row.data))
  const values = refs.map(ref => {
    const rowId = str(ref._rowId),
      raw = { ...saved.get(rowId) }
    delete raw.sources
    delete raw.marks
    return {
      ...raw,
      ...Object.fromEntries(
        ["filingDate", "grantDate", "expiryDate", "regDate"]
          .filter(key => key in raw)
          .map(key => [key, dateValue(raw[key])])
      ),
      rowId,
      targetId: match.targetId,
      decisionKey: match.decisionKey,
      level: match.level,
      dismissed: match.dismissed,
      flagged: match.flagged,
      hidden: match.hidden,
      sourceCount: rows(match.sources).length,
    }
  })
  return selected ? { ...selected, items: values } : values[0]
}

// Decision validation reads only identifiers for the requested kind/target, never a report.
export async function decisionTarget(
  db: Db,
  id: number,
  kind: Kind,
  targetId: string,
  imageId?: string
) {
  let found = false
  if (kind === "tm") {
    const words = await db.$queryRaw<{ id: number; data: Bag }[]>(
      Prisma.sql`SELECT r.id,JSON_OBJECT('term',JSON_EXTRACT(r.data,'$.term')) AS data FROM PatentQueryResult r JOIN PatentQueryCheck c ON c.id=r.checkId WHERE c.taskId=${id} AND c.kind='tm' AND r.imageId IS NULL`
    )
    const parts = targetId.split(":")
    let term = "",
      serial = ""
    try {
      term = decodeURIComponent(parts[1] ?? "")
      serial = decodeURIComponent(parts[3] ?? "")
    } catch {
      throw new BadRequestException("未找到可标记的命中")
    }
    const parents = words
      .filter(w => str(w.data.term).trim().toLowerCase() === term)
      .map(w => Number(w.id))
    if (parents.length && parts.length === 4 && parts[0] === "tm" && term && serial) {
      const marks = await db.$queryRaw<{ data: Bag }[]>(
        Prisma.sql`SELECT JSON_OBJECT('serialNumber',JSON_EXTRACT(m.data,'$.serialNumber'),'countryCode',JSON_EXTRACT(m.data,'$.countryCode')) AS data FROM PatentQueryTextMark m WHERE m.resultId IN (${Prisma.join(parents)}) AND LOCATE(${serial},JSON_UNQUOTE(JSON_EXTRACT(m.data,'$.serialNumber')))>0`
      )
      found = marks.some(
        m =>
          `tm:${encodeURIComponent(term)}:${str(m.data.countryCode).trim().toUpperCase() || "US"}:${encodeURIComponent(str(m.data.serialNumber).trim())}` ===
          targetId
      )
    }
  } else if (imageId) {
    const parts = targetId.split(":"),
      identifier = kind === "copy" ? parts[1] : parts[2]
    let decoded = ""
    try {
      decoded = decodeURIComponent(identifier ?? "")
    } catch {
      throw new BadRequestException("未找到可标记的命中")
    }
    const path =
      kind === "design"
        ? Prisma.sql`JSON_EXTRACT(r.data,'$.pn')`
        : kind === "copy"
          ? Prisma.sql`JSON_EXTRACT(r.data,'$.id')`
          : Prisma.sql`JSON_EXTRACT(r.data,'$.serialNumber')`
    // 显式统一 JSON_TABLE、表列和入参的比较规则；图片 ID 区分大小写。
    const candidates = await db.$queryRaw<{ data: Bag }[]>(
      Prisma.sql`SELECT JSON_OBJECT('pn',JSON_EXTRACT(r.data,'$.pn'),'id',JSON_EXTRACT(r.data,'$.id'),'serialNumber',JSON_EXTRACT(r.data,'$.serialNumber'),'countryCode',JSON_EXTRACT(r.data,'$.countryCode')) AS data FROM PatentQueryResult r JOIN PatentQueryCheck c ON c.id=r.checkId JOIN PatentQueryTask t ON t.id=c.taskId JOIN JSON_TABLE(t.input,'$.images[*]' COLUMNS(imageId VARCHAR(64) PATH '$.id')) im ON im.imageId COLLATE utf8mb4_bin=r.imageId COLLATE utf8mb4_bin WHERE c.taskId=${id} AND c.kind=${kind} AND r.imageId COLLATE utf8mb4_bin=${imageId} AND LOCATE(${decoded},JSON_UNQUOTE(${path}))>0`
    )
    found = candidates.some(r => imageTarget(kind, r.data) === targetId)
  }
  if (!found) throw new BadRequestException("未找到可标记的命中")
  return decisionKey(kind, imageId, targetId)
}

export async function contextPage(
  db: Db,
  light: LightReport,
  dto: import("./dto/patent-query.dto").ContextQueryDto
) {
  const i = input(light.task.input)
  if (
    dto.imageId &&
    !i.images.some(image => image.id === dto.imageId) &&
    !(i.tm?.images ?? []).some(image => image.id === dto.imageId)
  )
    throw new BadRequestException("图片不属于当前报告")
  if (dto.section === "gaps")
    return {
      taskId: light.task.id,
      section: dto.section,
      ...page(
        light.report.gaps.filter(
          g => (!dto.kind || g.kind === dto.kind) && (!dto.imageId || g.imageId === dto.imageId)
        ),
        dto
      ),
    }
  const unitFrom = Prisma.sql`PatentQueryCheck c JOIN JSON_TABLE(COALESCE(JSON_KEYS(c.output,'$.units'),JSON_ARRAY()),'$[*]' COLUMNS(imageId VARCHAR(64) PATH '$')) k JOIN JSON_TABLE(JSON_ARRAY(JSON_EXTRACT(c.output,CONCAT('$.units.',JSON_QUOTE(k.imageId)))),'$[*]' COLUMNS(data JSON PATH '$')) u`
  let query: Prisma.Sql
  // OCR references include one row per line, or one metadata row for an empty/failed image.
  if (dto.section === "ocr")
    query = Prisma.sql`SELECT c.id AS parentId,c.kind,o.imageId,NULL AS wordId,'ocr' AS source,o.n AS position,COALESCE(o.lineNo,0) AS childPosition FROM PatentQueryCheck c JOIN JSON_TABLE(c.output,'$.text.imageOCR[*]' COLUMNS(n FOR ORDINALITY,imageId VARCHAR(64) PATH '$.imageID',NESTED PATH '$.lines[*]' COLUMNS(lineNo FOR ORDINALITY))) o WHERE c.taskId=${light.task.id}`
  else if (dto.section === "knownIp")
    query = Prisma.sql`SELECT c.id AS parentId,c.kind,k.imageId,NULL AS wordId,'knownIp' AS source,0 AS position,0 AS childPosition FROM ${unitFrom} WHERE c.taskId=${light.task.id} AND JSON_TYPE(JSON_EXTRACT(u.data,'$.result.knownIpMatch'))='OBJECT'`
  else {
    const wordCases = ["cases", "ownerCases", "markCases"].map(source => {
      const path = `$.tro.${source}`
      return Prisma.sql`SELECT r.id AS parentId,c.kind,NULL AS imageId,CONCAT('w-',r.id) AS wordId,${source} AS source,r.position AS position,v.n AS childPosition FROM PatentQueryResult r JOIN PatentQueryCheck c ON c.id=r.checkId JOIN JSON_TABLE(IF(JSON_TYPE(JSON_EXTRACT(r.data,${path}))='ARRAY',JSON_EXTRACT(r.data,${path}),JSON_ARRAY()),'$[*]' COLUMNS(n FOR ORDINALITY)) v WHERE c.taskId=${light.task.id} AND c.kind='tm'`
    })
    query = Prisma.sql`SELECT c.id AS parentId,c.kind,k.imageId,NULL AS wordId,'tro' AS source,0 AS position,v.n AS childPosition FROM ${unitFrom} JOIN JSON_TABLE(u.data,'$.result.troCases[*]' COLUMNS(n FOR ORDINALITY)) v WHERE c.taskId=${light.task.id} UNION ALL ${Prisma.join(wordCases, " UNION ALL ")}`
  }
  const conditions = [Prisma.sql`1=1`]
  if (dto.kind) conditions.push(Prisma.sql`q.kind=${dto.kind}`)
  if (dto.imageId) conditions.push(Prisma.sql`q.imageId=${dto.imageId}`)
  const where = Prisma.join(conditions, " AND ")
  const count = await db.$queryRaw<{ total: bigint }[]>(
    Prisma.sql`SELECT COUNT(*) AS total FROM (${query}) q WHERE ${where}`
  )
  // Sort/page identifiers before fetching JSON: a large OCR line/case must not enter filesort.
  const refs = await db.$queryRaw<
    {
      parentId: number
      kind: Kind
      imageId: string | null
      wordId: string | null
      source: string
      position: number
      childPosition: number
    }[]
  >(
    Prisma.sql`SELECT q.* FROM (${query}) q WHERE ${where} ORDER BY q.kind,q.imageId,q.parentId,q.source,q.position,q.childPosition LIMIT ${dto.pageSize} OFFSET ${(dto.page - 1) * dto.pageSize}`
  )
  const detailQueries: Prisma.Sql[] = []
  for (const [refIndex, ref] of refs.entries()) {
    let query: Prisma.Sql
    if (ref.source === "ocr")
      query = Prisma.sql`SELECT JSON_OBJECT('imageID',JSON_EXTRACT(o.data,'$.imageID'),'width',JSON_EXTRACT(o.data,'$.width'),'height',JSON_EXTRACT(o.data,'$.height'),'error',JSON_EXTRACT(o.data,'$.error'),'line',IF(${Number(ref.childPosition)}=0,NULL,JSON_EXTRACT(o.data,CONCAT('$.lines[',${Number(ref.childPosition) - 1},']')))) AS data FROM PatentQueryCheck c JOIN JSON_TABLE(c.output,'$.text.imageOCR[*]' COLUMNS(n FOR ORDINALITY,data JSON PATH '$')) o WHERE c.id=${Number(ref.parentId)} AND c.taskId=${light.task.id} AND o.n=${Number(ref.position)}`
    else if (ref.source === "knownIp" || ref.source === "tro") {
      const path =
        ref.source === "knownIp"
          ? Prisma.sql`JSON_EXTRACT(u.data,'$.result.knownIpMatch')`
          : Prisma.sql`JSON_EXTRACT(u.data,CONCAT('$.result.troCases[',${Number(ref.childPosition) - 1},']'))`
      query = Prisma.sql`SELECT ${path} AS data FROM ${unitFrom} WHERE c.id=${Number(ref.parentId)} AND c.taskId=${light.task.id} AND k.imageId=${ref.imageId}`
    } else {
      const path =
        ref.source === "cases"
          ? "$.tro.cases"
          : ref.source === "ownerCases"
            ? "$.tro.ownerCases"
            : "$.tro.markCases"
      query = Prisma.sql`SELECT JSON_EXTRACT(r.data,CONCAT(${path},'[',${Number(ref.childPosition) - 1},']')) AS data FROM PatentQueryResult r JOIN PatentQueryCheck c ON c.id=r.checkId WHERE r.id=${Number(ref.parentId)} AND c.taskId=${light.task.id}`
    }
    detailQueries.push(Prisma.sql`SELECT ${refIndex} AS refIndex,v.data FROM (${query}) v`)
  }
  const loaded = detailQueries.length
    ? await db.$queryRaw<{ refIndex: number; data: Bag }[]>(
        Prisma.join(detailQueries, " UNION ALL ")
      )
    : []
  const dataByIndex = new Map(loaded.map(row => [Number(row.refIndex), row.data]))
  const items: Bag[] = []
  for (const [refIndex, ref] of refs.entries()) {
    let normalizedWordId = ref.wordId
    if (ref.wordId) {
      const raw = light.results.find(r => r.id === Number(ref.parentId))
      const w = rows(light.report.tm.words).find(
        w => str(w.term).trim().toLowerCase() === str(raw?.data.term).trim().toLowerCase()
      )
      if (w) normalizedWordId = wordId(w)
    }
    items.push({
      kind: ref.kind,
      imageId: ref.imageId,
      wordId: normalizedWordId,
      ...(ref.source === "ocr"
        ? { lineIndex: Number(ref.childPosition) ? Number(ref.childPosition) - 1 : null }
        : {}),
      data: dataByIndex.get(refIndex) ?? null,
    })
  }
  const total = Number(count[0].total)
  return {
    taskId: light.task.id,
    section: dto.section,
    total,
    page: dto.page,
    pageSize: dto.pageSize,
    pageCount: Math.ceil(total / dto.pageSize),
    items,
  }
}
