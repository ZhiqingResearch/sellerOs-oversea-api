import { AUDIT_BOARD_CONTRACT } from "../../asin-audit/rules/board-contract"
import { canonicalJson } from "../../common/utils/canonical-json"
import { readComputerJsonPrefix } from "./computer-json-prefix"

type RecordValue = Record<string, unknown>
type Segment = string | number
export type OutputGap = {
  path: Segment[]
  kind: "item" | "value" | "append"
  rule?: { id: string; maxScore: number }
  offset?: number
  source?: unknown
}
export interface RecoveryPlan {
  draft: RecordValue
  gaps: OutputGap[]
  corrections: string[]
  missingScoreFields: string[]
}
const isRecord = (v: unknown): v is RecordValue => !!v && typeof v === "object" && !Array.isArray(v)
const scoreFields = [
  "diagnosis",
  "aiVerdict",
  "aiSecondary",
  "actionItems",
  "suggestions",
  "severeDefects",
]
const modules = [
  "imageSellingPoints",
  "aplusModules",
  "keywordTiers",
  "reviewStrategies",
  "differentiationUSPs",
  "launchPhases",
  "fieldRewrites",
  "improvementPriorities",
]
const listingKeys = [
  "title",
  "longTitle",
  "itemHighlights",
  "bullets",
  "description",
  "searchTerms",
  "qaCandidates",
]
const listingArrays = new Set(["itemHighlights", "bullets", "searchTerms", "qaCandidates"])

function validItem(v: unknown, rule: { id: string; maxScore: number }) {
  if (
    !isRecord(v) ||
    v.id !== rule.id ||
    v.maxScore !== rule.maxScore ||
    !Array.isArray(v.deductions)
  )
    return false
  const validScore =
    v.status === "verified"
      ? typeof v.score === "number" &&
        Number.isFinite(v.score) &&
        v.score >= 0 &&
        v.score <= rule.maxScore
      : (v.status === "na" || v.status === "pending") && v.score === null
  return (
    validScore &&
    v.deductions.every(
      d =>
        isRecord(d) &&
        typeof d.reason === "string" &&
        typeof d.points === "number" &&
        Number.isFinite(d.points)
    )
  )
}
export function planScoreRecovery(text: string): RecoveryPlan {
  const { root, closed, corrections } = readComputerJsonPrefix(text)
  if (!Array.isArray(root.boards)) throw new Error("缺少可恢复的评分板块")
  const originals = root.boards
  const gaps: OutputGap[] = []
  const draft: RecordValue = {}
  for (const [key, value] of Object.entries(root)) {
    if (key !== "boards" && closed.has(key)) draft[key] = value
  }
  draft.boards = AUDIT_BOARD_CONTRACT.map((spec, b) => {
    const matches = originals
      .map((board, index) => ({ board, index }))
      .filter(x => x.board?.id === spec.id)
    const match = matches.length === 1 ? matches[0] : undefined
    const board = match?.board
    const items = spec.items.map((rule, i) => {
      const path = ["boards", b, "items", i]
      const candidates = (Array.isArray(board?.items) ? board.items : [])
        .map((item: unknown, index: number) => ({ item, index }))
        .filter((x: { item: unknown }) => isRecord(x.item) && x.item.id === rule.id)
      const entry = candidates.length === 1 ? candidates[0] : undefined
      if (
        entry &&
        board.maxScore === spec.maxScore &&
        board.weight === spec.weight &&
        closed.has(["boards", match!.index, "items", entry.index].join(".")) &&
        validItem(entry.item, rule)
      )
        return entry.item
      gaps.push({
        path,
        kind: "item",
        rule: { id: rule.id, maxScore: rule.maxScore },
        source: entry?.item,
      })
      return null
    })
    return { id: spec.id, name: spec.name, maxScore: spec.maxScore, weight: spec.weight, items }
  })
  const missingScoreFields = scoreFields.filter(key => !closed.has(key))
  for (const key of missingScoreFields) {
    const value = root[key]
    if (Array.isArray(value)) {
      const kept = value.filter((item, i) => closed.has(key + "." + i) && typeof item === "string")
      draft[key] = kept
      gaps.push({ path: [key], kind: "append", offset: kept.length })
    } else gaps.push({ path: [key], kind: "value", source: value })
  }
  return { draft, gaps, corrections, missingScoreFields }
}

// These are editorial instructions sometimes returned in otherwise English copy.
// Match a complete known instruction, retaining the exact stated measurements.
function normalizeEnglish(text: string): string {
  return text
    .replace(/^\(移除该属性\)$/, "(Remove this attribute)")
    .replace(/^The宣称 (?=\d)/, "The claimed ")
    .replace(
      /^待卖家测量确认准确宽度后更新后台属性（长度 ([\d.]+) 英寸，厚度 ([\d.]+) 英寸，宽度需更正非正方形真实数值）$/,
      "Measure and verify the actual width before updating this attribute. Length: $1 inches. Thickness: $2 inches. Use the measured width."
    )
}

export function planOptimizationRecovery(text: string): RecoveryPlan {
  const { root, closed, corrections } = readComputerJsonPrefix(text)
  const gaps: OutputGap[] = []
  const draft: RecordValue = {}
  function retain(
    source: RecordValue,
    target: RecordValue,
    key: string,
    path: Segment[],
    isArray: boolean,
    required: boolean
  ) {
    const value = source[key]
    const label = path.join(".")
    if (closed.has(label) && (isArray ? Array.isArray(value) : typeof value === "string")) {
      if (required && (!value || (Array.isArray(value) && !value.length)))
        gaps.push({ path, kind: "value" })
      target[key] = value
    } else if (isArray && Array.isArray(value) && !closed.has(label)) {
      const kept = value.filter((_, i) => closed.has(label + "." + i))
      target[key] = kept
      gaps.push({ path, kind: "append", offset: kept.length, source: value[kept.length] })
    } else if (value !== undefined || required || !closed.has("")) {
      gaps.push({ path, kind: "value" })
    }
  }
  const listing: RecordValue = {}
  draft.listing = listing
  for (const key of listingKeys)
    retain(
      isRecord(root.listing) ? root.listing : {},
      listing,
      key,
      ["listing", key],
      listingArrays.has(key),
      ["title", "longTitle", "itemHighlights"].includes(key)
    )
  for (const key of modules) retain(root, draft, key, [key], true, false)
  function checkEnglish(parent: RecordValue | unknown[], key: string | number, path: Segment[]) {
    const values = parent as RecordValue
    const value = values[key]
    if (typeof value !== "string" || !/\p{Script=Han}/u.test(value)) return
    const fixed = normalizeEnglish(value)
    if (!/\p{Script=Han}/u.test(fixed)) {
      values[key] = fixed
      corrections.push(path.join("."))
    } else {
      values[key] = null
      gaps.push({ path, kind: "value", source: value })
    }
  }
  for (const key of listingKeys) {
    const value = listing[key]
    if (!Array.isArray(value)) checkEnglish(listing, key, ["listing", key])
    else
      value.forEach((v, i) => {
        if (key === "qaCandidates" && isRecord(v)) {
          for (const field of ["q", "a"]) checkEnglish(v, field, ["listing", key, i, field])
        } else checkEnglish(value, i, ["listing", key, i])
      })
  }
  if (Array.isArray(draft.fieldRewrites))
    draft.fieldRewrites.forEach((v, i) => {
      if (isRecord(v)) checkEnglish(v, "rewritten", ["fieldRewrites", i, "rewritten"])
    })
  return { draft, gaps, corrections, missingScoreFields: [] }
}

export function mergeOutputGap(draft: RecordValue, gap: OutputGap, value: unknown) {
  let parent = draft
  for (const segment of gap.path.slice(0, -1)) parent = parent[segment] as RecordValue
  const key = gap.path[gap.path.length - 1]
  if (gap.kind === "item" && (!gap.rule || !validItem(value, gap.rule)))
    throw new Error("补充评分项未通过原规则校验")
  if (scoreFields.includes(String(key)) && gap.path.length === 1) {
    const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === "string")
    const ok =
      key === "diagnosis"
        ? isRecord(value) &&
          strings(value.weakestBoards) &&
          typeof value.contentNarrative === "string" &&
          typeof value.operationsNarrative === "string" &&
          Array.isArray(value.issues) &&
          value.issues.every(
            x =>
              isRecord(x) &&
              typeof x.boardId === "string" &&
              typeof x.summary === "string" &&
              strings(x.evidences)
          )
        : ["aiVerdict", "aiSecondary"].includes(String(key))
          ? typeof value === "string"
          : strings(value)
    if (!ok) throw new Error("补充诊断文字格式无效")
  } else if (gap.kind !== "item") {
    const leaf = String(key)
    const expectsArray = gap.path.length === 1 || (gap.path.length === 2 && listingArrays.has(leaf))
    if (expectsArray ? !Array.isArray(value) : typeof value !== "string" || !value.trim())
      throw new Error("补充字段类型错误")
    if (leaf === "itemHighlights" && Array.isArray(value) && !value.length)
      throw new Error("商品亮点为空")
    const section = String(gap.path[0])
    const entries = Array.isArray(value) ? value : [value]
    for (const entry of entries) {
      if (section === "listing") {
        const copy =
          gap.path[1] === "qaCandidates" && expectsArray
            ? isRecord(entry)
              ? [entry.q, entry.a]
              : [null]
            : [entry]
        if (copy.some(x => typeof x !== "string" || !x.trim() || /\p{Script=Han}/u.test(x)))
          throw new Error("补充商品文案无效")
      } else if (expectsArray) {
        if (!isRecord(entry)) throw new Error("补充模块条目无效")
        const required: Record<string, string[]> = {
          imageSellingPoints: ["name", "description"],
          aplusModules: ["name", "description"],
          keywordTiers: ["tier", "label"],
          reviewStrategies: ["painPoint", "improvement"],
          differentiationUSPs: ["title", "analysis"],
          launchPhases: ["name", "goal"],
          fieldRewrites: ["field", "rewritten", "reason"],
          improvementPriorities: ["level", "title", "action"],
        }
        if (
          (required[section] ?? []).some(
            k => typeof entry[k] !== "string" || !(entry[k] as string).trim()
          )
        )
          throw new Error("补充模块条目缺必需字段")
        if (
          section === "improvementPriorities" &&
          !["P0", "P1", "P2", "P3"].includes(String(entry.level))
        )
          throw new Error("优先级无效")
        if (
          section === "keywordTiers" &&
          (!["S", "A", "B", "longtail"].includes(String(entry.tier)) ||
            !Array.isArray(entry.keywords) ||
            !entry.keywords.every(k => typeof k === "string"))
        )
          throw new Error("关键词分层无效")
        if (section === "fieldRewrites" && /\p{Script=Han}/u.test(String(entry.rewritten)))
          throw new Error("改写须使用站点语言")
      } else if (section === "fieldRewrites") {
        const copy = isRecord(entry) ? entry.rewritten : entry
        if (typeof copy !== "string" || !copy.trim() || /\p{Script=Han}/u.test(copy))
          throw new Error("补充改写文案无效")
      }
    }
  }
  if (gap.kind === "append") {
    const prefix = parent[key]
    if (
      !Array.isArray(prefix) ||
      !Array.isArray(value) ||
      prefix.length !== gap.offset ||
      !value.length
    )
      throw new Error("续写位置不匹配")
    const prior = new Set(prefix.map(canonicalJson))
    for (const item of value) {
      const encoded = canonicalJson(item)
      if (prior.has(encoded)) throw new Error("续写重复返回了既有条目")
      prior.add(encoded)
    }
    if (isRecord(gap.source)) {
      const first = value[0]
      if (
        !isRecord(first) ||
        Object.entries(gap.source).some(
          ([k, v]) => (typeof v === "string" || typeof v === "number") && first[k] !== v
        )
      )
        throw new Error("续写改变了截断条目中已返回的字段")
    }
    parent[key] = [...prefix, ...value]
  } else parent[key] = value
}
