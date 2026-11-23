import { uiText } from "../common/i18n/request-language"
import { containsTerm, presentTodo } from "./patent-query.todo-presentation"
import {
  Bag,
  Input,
  input,
  Kind,
  KINDS,
  obj,
  Output,
  output,
  rows,
  str,
  strings,
  Task,
} from "./patent-query.types"
export type Risk = "high" | "mid" | "low" | "UNKNOWN" | "expired"
export interface Match extends Bag {
  targetId: string | null
  decisionKey: string | null
  level: Risk
  dismissed: boolean
  flagged: boolean
  hidden: boolean
  sources?: Bag[]
}
export interface Decision {
  value: "flag" | "dismiss" | "none"
  synced?: boolean
}
export interface Annotations {
  decisions: Record<string, Decision>
  todoDone: Record<string, boolean>
}
export const annotations = (v: unknown): Annotations =>
  ({ decisions: {}, todoDone: {}, ...obj(v) }) as Annotations
export interface Todo {
  id: string
  kind: Kind
  title: string
  patentNumber?: string
  patentName?: string
  description?: string
  done: boolean
  targets: { imageId?: string; targetId: string | null; matchIndex?: number }[]
}
export const highest = (levels: Risk[]): Risk =>
  levels.includes("high")
    ? "high"
    : levels.includes("mid")
      ? "mid"
      : levels.includes("UNKNOWN")
        ? "UNKNOWN"
        : levels.includes("low")
          ? "low"
          : "expired"
export function dateValue(v: unknown): string | null {
  const s = typeof v === "number" ? String(v) : str(v)
  if (!s || s === "0") return null
  const raw = s.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3").replaceAll("/", "-")
  const calendar = raw.match(/^(\d{4}-\d{2}-\d{2})(?:T.*)?$/)?.[1]
  if (!calendar) return null
  const day = new Date(calendar + "T00:00:00Z")
  if (!Number.isFinite(+day) || day.toISOString().slice(0, 10) !== calendar) return null
  if (raw === calendar) return calendar
  const d = new Date(raw)
  return Number.isFinite(+d) ? new Date(+d + 8 * 3600000).toISOString().slice(0, 10) : null
}
export function inactive(m: Bag) {
  return (
    m.expired === true ||
    /^(DEAD|CANCELLED|EXPIRED|ABANDONED)$/i.test(str(m.status)) ||
    /^(DEAD|CANCELLED|EXPIRED|ABANDONED)$/i.test(str(m.legalStatus))
  )
}
export function imageTarget(kind: Kind, m: Bag): string | null {
  const country = str(m.countryCode).trim().toUpperCase() || "US"
  if (kind === "design")
    return str(m.pn).trim() ? `design:${country}:${encodeURIComponent(str(m.pn).trim())}` : null
  if (kind === "copy") return str(m.id) ? `copy:${encodeURIComponent(str(m.id))}` : null
  return str(m.serialNumber).trim()
    ? `gtm:${country}:${encodeURIComponent(str(m.serialNumber).trim())}`
    : null
}
export function decisionKey(kind: Kind, imageId: string | undefined, target: string): string {
  return kind === "tm" ? target : `${kind}:${imageId}:${target.slice(kind.length + 1)}`
}
export function matchRisk(kind: Kind, m: Bag, rerank = true): Risk {
  if (inactive(m)) return "expired"
  if (kind === "copy")
    return m.matchType === "identical"
      ? "high"
      : m.matchType === "verified" || m.matchType === "derivative"
        ? "mid"
        : m.matchType === "similar"
          ? "low"
          : "UNKNOWN"
  if (kind === "tm")
    return ["high", "mid", "low"].includes(str(m.level)) ? (m.level as Risk) : "UNKNOWN"
  if (
    !rerank ||
    ["NOT_COMPARED", "NO_VERDICT"].includes(str(m.reasonCode)) ||
    m.riskLevel === "unscored"
  )
    return "UNKNOWN"
  if (typeof m.score !== "number" || !Number.isFinite(m.score) || m.score < 0 || m.score > 1)
    return "UNKNOWN"
  return m.score >= 0.9 ? "high" : m.score >= 0.7 ? "mid" : "low"
}
function decorated(
  raw: Bag,
  targetId: string | null,
  key: string | null,
  level: Risk,
  a: Annotations,
  filter: boolean
): Match {
  const decision = key ? a.decisions[key]?.value : undefined
  const dateFields = Object.fromEntries(
    ["filingDate", "grantDate", "expiryDate", "regDate"]
      .filter(k => k in raw)
      .map(k => [k, dateValue(raw[k])])
  )
  return {
    ...raw,
    ...dateFields,
    targetId,
    decisionKey: key,
    level,
    dismissed: decision === "dismiss",
    flagged: decision === "flag",
    hidden: filter && level === "low" && typeof raw.score === "number" && raw.score < 0.45,
  }
}
export function textWords(text: Bag, a: Annotations): Bag[] {
  const groupedWords = new Map<string, Bag>()
  for (const w of rows(text.words)) {
    const key = str(w.term).trim().toLowerCase()
    const previous = groupedWords.get(key)
    groupedWords.set(
      key,
      previous ? { ...previous, marks: [...rows(previous.marks), ...rows(w.marks)] } : w
    )
  }
  return [...groupedWords.values()].map(w => {
    const term = str(w.term).trim().toLowerCase()
    const groups = new Map<string, Bag[]>()
    const missing: Bag[][] = []
    for (const m of rows(w.marks)) {
      const serial = str(m.serialNumber).trim()
      // 当前数据源固定美国库；不能用权利人国籍代替商标所属国家。
      const country = str(m.countryCode).trim().toUpperCase() || "US"
      if (!serial || !term) {
        missing.push([m])
        continue
      }
      const key = `tm:${encodeURIComponent(term)}:${country}:${encodeURIComponent(serial)}`
      groups.set(key, [...(groups.get(key) ?? []), m])
    }
    const marks = [...groups.entries(), ...missing.map(s => [null, s] as const)].map(
      ([id, sources]) => {
        const level = highest(sources.map(m => matchRisk("tm", m)))
        const where = [...new Set(sources.flatMap(m => strings(m.where)))]
        const merged = {
          ...sources[0],
          serialNumber: str(sources[0].serialNumber).trim(),
          countryCode: str(sources[0].countryCode).trim().toUpperCase() || "US",
          sources,
          where,
        }
        return decorated(merged, id, id, level, a, false)
      }
    )
    const visible = marks
    return { ...w, marks, level: visible.length ? highest(visible.map(m => m.level)) : "low" }
  })
}
export function imageMatches(
  kind: Kind,
  imageId: string,
  unit: Output["units"][string],
  a: Annotations,
  i: Input
): Match[] {
  return unit.matches.map(m => {
    const target = imageTarget(kind, m)
    const level = matchRisk(
      kind,
      m,
      kind !== "design" || (i.design?.rerank !== false && unit.result.riskLevel !== "unscored")
    )
    const raw =
      kind === "design"
        ? {
            ...m,
            rawPn: m.pn,
            displayPn: str(m.pn).startsWith(str(m.countryCode) || "US")
              ? m.pn
              : `${str(m.countryCode) || "US"}${str(m.pn)}`,
          }
        : m
    return decorated(
      raw,
      target,
      target ? decisionKey(kind, imageId, target) : null,
      level,
      a,
      kind === "design" || kind === "gtm"
    )
  })
}
export function progress(task: Task) {
  const i = input(task.input)
  const units = task.checks.flatMap(check =>
    check.kind === "tm"
      ? [{ kind: check.kind, status: check.status, error: check.error }]
      : i.images.map(image => ({
          kind: check.kind,
          imageId: image.id,
          status: output(check.output).units[image.id]?.status ?? check.status,
          error: output(check.output).units[image.id]?.error ?? check.error,
        }))
  )
  return {
    total: units.length,
    completed: units.filter(u => u.status === "COMPLETED").length,
    failed: units.filter(u => u.status === "FAILED").length,
    units,
  }
}
export function buildReport(task: Task, options: { light?: boolean; summaryOnly?: boolean } = {}) {
  const i = input(task.input),
    a = annotations(task.annotations)
  const design: Record<string, Bag> = {},
    copy: Record<string, Bag> = {},
    gtm: Record<string, Bag> = {}
  const images = { design, copy, gtm }
  let tm: Bag = {}
  const gaps: { kind: string; imageId?: string; message: string }[] = []
  const todos = new Map<string, Todo>()
  const summary = {
    high: 0,
    mid: 0,
    low: 0,
    unknown: 0,
    expired: 0,
    hidden: 0,
    troCases: 0,
    todoTotal: 0,
    todoDone: 0,
    conclusion: "",
  }
  const count = (level: Risk) => {
    if (level === "UNKNOWN") summary.unknown++
    else summary[level]++
  }
  const addTodo = (
    id: string,
    kind: Kind,
    title: string,
    targetId: string | null,
    imageId?: string,
    matchIndex?: number
  ) => {
    const t: Todo = todos.get(id) ?? { id, kind, title, done: a.todoDone[id] === true, targets: [] }
    if (
      !t.targets.some(
        target =>
          target.imageId === imageId &&
          target.targetId === targetId &&
          target.matchIndex === matchIndex
      )
    )
      t.targets.push({ imageId, targetId, ...(matchIndex !== undefined ? { matchIndex } : {}) })
    todos.set(id, t)
    return t
  }
  const caseIds = new Set<string>()
  const addCases = (v: unknown) => {
    for (const c of rows(v)) {
      const id = str(c.caseNumber) || str(c.caseNo)
      if (id) caseIds.add(id)
    }
  }
  for (const check of task.checks) {
    const kind = check.kind as Kind,
      out = output(check.output)
    if (kind === "tm") {
      tm = { ...out.text, words: textWords(out.text ?? {}, a) }
      if (check.status !== "COMPLETED")
        gaps.push({ kind, message: check.error || uiText("文字结果不完整", "Text results are incomplete") })
      if (!i.resolved.classCodes.length)
        gaps.push({ kind, message: uiText("未限定类别，结果可能包含不同类商品的商标", "No classes were selected. Results may include marks for unrelated goods.") })
      for (const ocr of rows(tm.imageOCR))
        if (ocr.error)
          gaps.push({
            kind,
            imageId: str(ocr.imageID),
            message: uiText("图片文字识别失败，未覆盖图片中的文字", "Image text recognition failed. Text in the image was not checked."),
          })
      if (i.tm?.includeImageText)
        for (const image of [...i.images, ...(i.tm.images ?? [])]) {
          if (!rows(tm.imageOCR).some(ocr => ocr.imageID === image.id))
            gaps.push({
              kind,
              imageId: image.id,
              message: uiText("图片文字识别结果缺失，未确认图片文字覆盖", "Image text recognition results are missing. Coverage is unconfirmed."),
            })
        }
      for (const warning of strings(tm.warnings)) gaps.push({ kind, message: warning })
      for (const w of rows(tm.words)) {
        const marks = w.marks as Match[],
          valid = marks.filter(m => m.level !== "expired")
        if (valid.length) count(w.level as Risk)
        if (w.level === "UNKNOWN") gaps.push({ kind, message: uiText(`${str(w.term)} 尚未定档`, `${str(w.term)} has not been rated`) })
        const term = str(w.term).trim()
        if (containsTerm(i.tm?.brand ?? "", term) || containsTerm(i.tm?.title ?? "", term))
          for (const [index, m] of marks.entries())
            if (["high", "mid"].includes(m.level))
              addTodo(
                `tm:${encodeURIComponent(term.toLowerCase())}:prd`,
                kind,
                uiText(`核对用词「${term}」`, `Review term “${term}”`),
                m.targetId,
                undefined,
                m.targetId === null ? index : undefined
              )
        const tro = obj(w.tro)
        addCases(tro.cases)
        addCases(tro.ownerCases)
        addCases(tro.markCases)
        const latestCaseNumber = str(tro.latestCaseNumber).trim()
        if (latestCaseNumber) caseIds.add(latestCaseNumber)
        if (Number(tro.ownerCases) > 0 || Number(tro.markCases) > 0 || Number(tro.total) > 0)
          gaps.push({ kind, message: uiText(`${str(w.term)} 存在 TRO 关联信号，请查看线索`, `Review a possible TRO connection for ${str(w.term)}`) })
      }
      continue
    }
    for (const image of i.images) {
      const unit = out.units[image.id]
      if (!unit) {
        gaps.push({ kind, imageId: image.id, message: check.error || uiText("检测结果尚不可用", "Screening results are not available yet") })
        continue
      }
      const matches = imageMatches(kind, image.id, unit, a, i),
        valid = matches.filter(m => m.level !== "expired")
      const levels = valid.map(m => m.level)
      if (kind === "copy" && obj(unit.result.knownIpMatch).isMatch === true) levels.push("high")
      const level = levels.length
        ? highest(levels)
        : unit.complete && unit.status === "COMPLETED"
          ? "low"
          : "UNKNOWN"
      images[kind][image.id] = {
        ...unit.result,
        status: unit.status,
        error: unit.error,
        upstreamRiskLevel: unit.result.riskLevel,
        riskLevel: level,
        matches,
        complete: unit.complete,
        hiddenCount: matches.filter(m => m.hidden).length,
      }
      if (!unit.complete || unit.status !== "COMPLETED")
        gaps.push({
          kind,
          imageId: image.id,
          message: unit.error || uiText("结果不完整，不能据此排除风险", "Results are incomplete. Risk cannot be ruled out."),
        })
      if (kind === "design" && (i.design?.rerank === false || unit.result.riskLevel === "unscored"))
        gaps.push({ kind, imageId: image.id, message: uiText("未做 AI 比对，请人工确认", "No AI comparison was performed. Review manually.") })
      if (kind === "design") for (const m of matches) count(m.level)
      else if (valid.length || levels.length) count(level)
      summary.hidden += matches.filter(m => m.hidden).length
      if (valid.some(m => m.level === "UNKNOWN"))
        gaps.push({ kind, imageId: image.id, message: uiText("部分命中未定档，请人工核对", "Some matches have not been rated. Review manually.") })
      const hasIdentical = valid.some(m => m.matchType === "identical")
      for (const m of valid)
        if (
          kind === "design"
            ? m.level === "high"
            : kind === "copy"
              ? m.matchType === "identical" || (m.matchType === "verified" && !hasIdentical)
              : ["high", "mid"].includes(m.level)
        ) {
          const id =
            kind === "design"
              ? m.targetId
                ? `${m.targetId}:prd`
                : null
              : kind === "copy"
                ? `copy:${image.id}:${hasIdentical ? "identical" : "verified"}:prd`
                : `gtm:${image.id}:prd`
          if (id)
            addTodo(
              id,
              kind,
              kind === "copy"
                ? uiText("核对图片版权及来源", "Review image copyright and source")
                : kind === "design"
                  ? uiText("核对外观专利", "Review the design patent")
                  : uiText("核对图形商标", "Review the figurative mark"),
              m.targetId,
              image.id,
              m.targetId === null ? matches.indexOf(m) : undefined
            )
        }
      if (kind === "copy" && obj(unit.result.knownIpMatch).isMatch === true)
        addTodo(`copy:${image.id}:knownIp`, kind, uiText("核对图片中的品牌或知名形象", "Review brands and recognizable characters in the image"), null, image.id)
      if (kind === "copy")
        for (const c of rows(unit.result.troCases)) {
          const caseNumber = str(c.caseNumber) || str(c.caseNo)
          if (caseNumber)
            addTodo(
              `copy:prd:tro:${encodeURIComponent(caseNumber)}`,
              kind,
              uiText(`权利人在批量起诉卖家：${caseNumber}`, `Review case ${caseNumber} involving multiple sellers`),
              null,
              image.id
            )
        }
      addCases(unit.result.troCases)
      if (strings(unit.result.riskDrivers).includes("tro"))
        gaps.push({ kind, imageId: image.id, message: uiText("存在 TRO 关联信号，请查看线索", "A possible TRO connection was found. Review the evidence.") })
    }
  }
  const coverage = i.sites.flatMap(site =>
    KINDS.map(kind => {
      const check = task.checks.find(c => c.kind === kind)
      const supported = site === "US" || kind === "copy"
      const state = !i[kind]
        ? "not_selected"
        : i.resolved.skipped.includes(kind) || !supported
          ? "not_covered"
          : check?.status === "COMPLETED"
            ? "checked"
            : check?.status === "PARTIAL"
              ? "partial"
              : "failed"
      return {
        site,
        kind,
        state,
        note:
          state === "not_covered"
            ? uiText("该站点本国专利/商标未查", "Domestic patents and marks in this market were not searched")
            : kind === "copy"
              ? uiText("全球图片来源线索，不代表各国版权确权", "Global image sources are leads only. They do not establish copyright ownership in any country.")
              : uiText("美国库检测", "US database screening"),
      }
    })
  )
  for (const c of coverage)
    if (c.state === "not_covered") gaps.push({ kind: c.kind, message: `${c.site}：${c.note}` })
  summary.troCases = caseIds.size
  summary.todoTotal = todos.size
  summary.todoDone = [...todos.values()].filter(t => t.done).length
  summary.conclusion = summary.high
    ? uiText("发现高风险线索，请核对", "High-risk leads found. Review the evidence.")
    : summary.mid
      ? uiText("发现需留意线索", "Potential issues found")
      : gaps.length
        ? uiText("存在补查缺口", "Additional checks are needed")
        : uiText("本次检测范围内未发现风险线索", "No risk signals found within the scope of this screening")
  return {
    design,
    copy,
    gtm,
    tm,
    summary,
    coverage,
    gaps,
    todos: options.summaryOnly
      ? []
      : [...todos.values()].map(todo => presentTodo(todo, i, images, tm, options.light)),
    disclaimer: uiText("仅提供线索，不构成法律意见", "Screening leads only. This report does not provide legal advice."),
  }
}
export function findMatch(
  report: ReturnType<typeof buildReport>,
  kind: Kind,
  targetId: string,
  imageId?: string
): Match | undefined {
  if (kind === "tm")
    return rows(report.tm.words)
      .flatMap(w => w.marks as Match[])
      .find(m => m.targetId === targetId)
  return (obj(report[kind][imageId || ""]).matches as Match[] | undefined)?.find(
    m => m.targetId === targetId
  )
}
