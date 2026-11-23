import { AUDIT_BOARD_CONTRACT } from "../../asin-audit/rules/board-contract"
import { extractJson, parseLlmJson } from "../../asin-audit/rules/extract-json"
import type { AuditScoreLlmPayload } from "../../asin-audit/types/audit.types"
import { ComputerAuditError } from "./computer-audit.types"

const scoreTextFields = [
  "diagnosis",
  "aiVerdict",
  "aiSecondary",
  "actionItems",
  "suggestions",
  "severeDefects",
] as const
const ruleNames = new Map(
  AUDIT_BOARD_CONTRACT.flatMap(board => board.items.map(item => [item.id, item.name] as const))
)

function invalidScore(): never {
  throw new ComputerAuditError("MODEL_RESPONSE_INVALID", "评分原文缺少可验证的完整评分项")
}

// Only repair an unlabeled rule name following an item id. Preserve the existing name if provided.
function repairRuleNames(json: string) {
  return json.replace(
    /(\{\s*"id"\s*:\s*"([A-Z]\d+[a-z]?)"\s*,\s*)("([^"\\\r\n]+)")\s*,(\s*"(name|maxScore)"\s*:)/g,
    (match, prefix, id, literal, label, suffix, nextKey) => {
      if (!ruleNames.has(id)) return match
      if (nextKey === "name") return prefix + suffix
      return ruleNames.get(id) === label ? prefix + '"name":' + literal + "," + suffix : match
    }
  )
}

// Decode only complete top-level members. Never synthesize a closing bracket inside boards.
function readCompleteMembers(text: string): AuditScoreLlmPayload {
  const json = text.trimStart().replace(/^\x60\x60\x60(?:json)?\s*/i, "")
  if (!json.startsWith("{")) return invalidScore()
  const fields: Record<string, unknown> = Object.create(null)
  const brackets: string[] = []
  let inString = false
  let start = 1
  const addMember = (end: number) => {
    const member = JSON.parse("{" + json.slice(start, end) + "}")
    const [key] = Object.keys(member)
    if (!key || Object.hasOwn(fields, key)) return invalidScore()
    fields[key] = member[key]
  }
  for (let i = 1; i < json.length; i++) {
    const ch = json[i]
    if (inString) {
      if (ch === "\\") i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === "{" || ch === "[") brackets.push(ch === "{" ? "}" : "]")
    else if (ch === "}" || ch === "]") {
      if (brackets.pop() !== ch) return invalidScore()
    } else if (ch === "," && !brackets.length) {
      addMember(i)
      start = i + 1
    }
  }
  const tail = json.slice(start).trim()
  const tailKey = /^("(?:[^"\\]|\\.)*")\s*:/.exec(tail)
  if (tailKey && Object.hasOwn(fields, JSON.parse(tailKey[1]))) return invalidScore()
  if (!inString && !brackets.length && tail) {
    // A complete final value may be followed only by EOF (missing outer brace).
    if (!/^"(?:[^"\\]|\\.)*"\s*:?\s*$/.test(tail)) addMember(json.length)
  }
  return fields as AuditScoreLlmPayload
}

function validateRecoveredItems(payload: AuditScoreLlmPayload) {
  // The regular finalizer also validates board count, order, weights and per-rule maximums.
  if (!Array.isArray(payload.boards)) return invalidScore()
  for (const board of payload.boards) {
    if (!Array.isArray(board?.items)) return invalidScore()
    for (const item of board.items) {
      if (
        !item ||
        !["verified", "pending", "na"].includes(item.status) ||
        (item.status === "verified"
          ? typeof item.score !== "number" ||
            !Number.isFinite(item.score) ||
            item.score < 0 ||
            item.score > item.maxScore
          : item.score !== null) ||
        !Array.isArray(item.deductions) ||
        !item.deductions.every(d => typeof d?.reason === "string" && Number.isFinite(d.points))
      )
        return invalidScore()
    }
  }
}

export function parseComputerScoreResponse(text: string): {
  payload: AuditScoreLlmPayload
  missingScoreFields?: string[]
} {
  const json = extractJson(text)
  if (json) {
    try {
      return { payload: parseLlmJson<AuditScoreLlmPayload>(json) }
    } catch (error) {
      const repaired = repairRuleNames(json)
      if (repaired === json) throw error
      const payload: AuditScoreLlmPayload = JSON.parse(repaired)
      validateRecoveredItems(payload)
      return { payload }
    }
  }
  const payload = readCompleteMembers(text)
  validateRecoveredItems(payload)
  return {
    payload,
    missingScoreFields: scoreTextFields.filter(key => !Object.hasOwn(payload, key)),
  }
}
