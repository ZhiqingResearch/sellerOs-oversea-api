import { BadRequestException } from "@nestjs/common"
import { createHash } from "node:crypto"
import { uiText } from "../../common/i18n/request-language"
import { parseListingJsonObject } from "../listing-result-parser"
import { WARRANTY } from "./automotive.prompts"
import {
  object,
  string,
  strings,
  type AutomotiveCheck,
  type AutomotiveData,
  type AutomotiveMarket,
  type AutomotiveSource,
  type JsonRecord,
} from "./automotive.types"

export const characters = (value: string) => Array.from(value).length
export const stableHash = (value: unknown): string => {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map(k => [k, canonical(object(v)[k])])
          )
        : v
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")
}
export function normalizeAutomotiveData(value: unknown): AutomotiveData {
  const v = object(value)
  const electrical = object(v.electrical)
  return {
    brand: string(v.brand),
    product: string(v.product),
    searchKeywords: strings(v.searchKeywords),
    fitments: (Array.isArray(v.fitments) ? (v.fitments as unknown[]).map(object) : [])
      .map(f => ({
        make: string(f.make),
        model: string(f.model),
        years: [
          ...new Set<number>(
            (Array.isArray(f.years) ? (f.years as unknown[]) : []).filter(
              (n): n is number =>
                typeof n === "number" && Number.isInteger(n) && n >= 1000 && n <= 9999
            )
          ),
        ].sort((a, b) => a - b),
        details: string(f.details),
      }))
      .filter(f => f.make && f.model && f.years.length),
    oeNumbers: [...new Set(strings(v.oeNumbers))],
    sellingPoints: (Array.isArray(v.sellingPoints)
      ? (v.sellingPoints as unknown[]).map(object)
      : []
    )
      .map(x => ({ title: string(x.title), detail: string(x.detail) }))
      .filter(x => x.title || x.detail),
    position: string(v.position),
    materialFinish: string(v.materialFinish),
    electrical: {
      voltage: string(electrical.voltage),
      wattage: string(electrical.wattage),
      amperage: string(electrical.amperage),
    },
    packageContents: (Array.isArray(v.packageContents)
      ? (v.packageContents as unknown[]).map(object)
      : []
    )
      .filter(
        x =>
          string(x.name) &&
          typeof x.quantity === "number" &&
          Number.isSafeInteger(x.quantity) &&
          x.quantity > 0
      )
      .map(x => ({ name: string(x.name), quantity: x.quantity as number })),
    fitmentPhrase: v.fitmentPhrase === "COMPATIBLE_WITH" ? "COMPATIBLE_WITH" : "FIT_FOR",
  }
}
export function missingAutomotiveFields(data: AutomotiveData) {
  const keys = {
    brand: uiText("品牌", "Brand"),
    product: uiText("产品名称关键词", "Product name keywords"),
    fitments: uiText("适配车型和年份", "Compatible models and years"),
    oeNumbers: uiText("OE / OEM号", "OE / OEM numbers"),
    packageContents: uiText("包装清单和数量", "Package contents and quantities"),
  }
  return Object.entries(keys)
    .filter(([k]) => !data[k as keyof typeof keys].length)
    .map(([field, label]) => ({
      field,
      label,
      reason: uiText("未提供明确资料，请补充", "Please provide the missing information"),
    }))
}

/** 不自动拼不同来源的车型/OE/套装：最高优先级整组采用，差异留给确认表。 */
export function mergeAutomotiveCandidates(candidates: unknown, sources: AutomotiveSource[]) {
  const result = normalizeAutomotiveData({}) as unknown as JsonRecord
  const fieldSources: Record<string, { sourceId: string; evidence: string }[]> = {}
  const conflicts: JsonRecord[] = []
  const list: unknown[] = Array.isArray(candidates) ? candidates : []
  for (const source of sources.filter(s => s.status === "SUCCEEDED")) {
    const candidate = list.find(x => object(x).sourceId === source.sourceId)
    if (!candidate) continue
    const data = normalizeAutomotiveData(object(candidate).data) as unknown as JsonRecord
    for (const key of Object.keys(data).filter(k => k !== "fitmentPhrase")) {
      const value = data[key]
      const hasValue = Array.isArray(value)
        ? value.length > 0
        : typeof value === "string"
          ? !!value
          : Object.values(object(value)).some(Boolean)
      if (!hasValue) continue
      if (!fieldSources[key]) {
        result[key] = value
        fieldSources[key] = [{ sourceId: source.sourceId, evidence: JSON.stringify(value) }]
      } else if (stableHash(result[key]) !== stableHash(value)) {
        conflicts.push({
          field: key,
          chosenSourceId: fieldSources[key][0].sourceId,
          candidates: [
            { sourceId: fieldSources[key][0].sourceId, value: result[key] },
            { sourceId: source.sourceId, value },
          ],
          message: uiText(
            "不同来源不一致，已采用优先来源，请确认；未自动混合车型、OE或套装。",
            "Sources disagree. Please confirm the preferred source. Fitments, OE numbers and kits have been kept separate."
          ),
        })
      }
    }
  }
  const automotiveData = normalizeAutomotiveData(result)
  return {
    automotiveData,
    fieldSources,
    conflicts,
    missingFields: missingAutomotiveFields(automotiveData),
  }
}
export function productTitle(value: unknown) {
  const p = object(value)
  return string(object(p.data).title) || string(p.name)
}
export function productSource(value: unknown): AutomotiveSource | null {
  const p = object(value),
    data = object(p.data)
  if (!Object.keys(data).length) return null
  // The complete raw data remains available; no source URLs are fetched here.
  return {
    sourceId: "product-1",
    type: "LINK",
    status: "SUCCEEDED",
    name: productTitle(p) || uiText("商品资料", "Product information"),
    url: string(p.url),
    fetchedAt: string(p.fetchedAt),
    acquisition: "REUSED_PRODUCT_DETAIL",
    data,
    content: JSON.stringify(data),
    images: [],
    truncated: false,
  }
}
const escapeHtml = (v: string) =>
  v.replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  )
export function fitmentText(f: AutomotiveData["fitments"][number]) {
  return `${f.make} ${f.model} ${f.years.join(", ")}${f.details ? ` (${f.details})` : ""}`
}
function matchToken(text: string, term: string) {
  if (!term) return false
  const pattern = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "iu").test(text)
}
export function finalizeAutomotive(
  text: string,
  data: AutomotiveData,
  market: AutomotiveMarket,
  sensitiveWords: string[] = []
) {
  const raw = parseListingJsonObject(text),
    checks: AutomotiveCheck[] = []
  const add = (item: string, pass: boolean, value: string, message = "") =>
    checks.push({ item, status: pass ? "PASS" : "FAIL", value, message })
  let title = string(raw.title)
  const titleDropped: string[] = []
  if (characters(title) > 75) {
    for (const oe of data.oeNumbers) {
      title = title.replace(
        new RegExp(
          `(?<![A-Za-z0-9])${oe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`,
          "g"
        ),
        " "
      )
    }
    title = title
      .replace(/\s+/g, " ")
      .replace(/[\s,;|-]+$/, "")
      .trim()
    if (title !== string(raw.title)) titleDropped.push("oe")
  }
  if (characters(title) > 75) {
    const years = new Set(data.fitments.flatMap(f => f.years))
    const next = title
      .replace(/\b(?:19|20|21)\d{2}(?:\s*[-–]\s*(?:19|20|21)\d{2})?\b/g, token => {
        const endpoints = token.match(/\d{4}/g) || []
        return endpoints.every(y => years.has(Number(y))) ? " " : token
      })
      .replace(/\s+/g, " ")
      .replace(/[\s,;|-]+$/, "")
      .trim()
    if (next !== title) titleDropped.push("years")
    title = next
  }
  const highlights = strings(raw.itemHighlights),
    bullets = strings(raw.bullets)
  add(
    uiText("标题≤75字符", "Title at most 75 characters"),
    !!title && characters(title) <= 75,
    `${characters(title)}/75`
  )
  add(
    uiText("品牌和主车型", "Brand and primary model"),
    title.startsWith(data.brand) &&
      title.toLowerCase().includes(data.fitments[0].make.toLowerCase()) &&
      title.toLowerCase().includes(data.fitments[0].model.toLowerCase()),
    title
  )
  const phrases =
    market === "amazon_de"
      ? /(?:für|kompatibel\s+mit|passend\s+für)/i
      : market === "amazon_jp"
        ? /対応|適合|用/
        : /fit\s+for|compatible\s+with/i
  add(uiText("车型适配表达", "Vehicle fitment phrase"), phrases.test(title), title)
  add(
    uiText("商品亮点4条且≤125字符", "Four highlights within 125 characters"),
    highlights.length === 4 && characters(highlights.join(", ")) <= 125,
    uiText(
      `${highlights.length}条 / ${characters(highlights.join(", "))}/125`,
      `${highlights.length} items / ${characters(highlights.join(", "))}/125`
    )
  )
  add(
    uiText("五点固定5条且每条≤200字符", "Five bullets of at most 200 characters each"),
    bullets.length === 5 && bullets.every(b => characters(b) <= 200),
    bullets.map(characters).join(" / ")
  )
  add(
    uiText("适配和OE优先", "Fitment and OE first"),
    !!bullets[0] &&
      bullets[0].toLowerCase().includes(data.fitments[0].model.toLowerCase()) &&
      !!bullets[1] &&
      data.oeNumbers.some(n => bullets[1].includes(n)),
    uiText("①车型 ②OE", "1. Model 2. OE")
  )
  const forbidden = [data.brand, ...data.fitments.flatMap(f => [f.make, f.model])]
  const searchInput = Array.isArray(raw.searchTerms)
    ? strings(raw.searchTerms).join(" ")
    : string(raw.searchTerms)
  const words = searchInput.replace(/[,;|]/g, " ").split(/\s+/).filter(Boolean)
  const terms: string[] = [],
    seen = new Set<string>()
  for (const word of words) {
    const normalized = word.toLowerCase()
    if (!seen.has(normalized)) {
      terms.push(word)
      seen.add(normalized)
    }
  }
  const removed: string[] = []
  while (Buffer.byteLength(terms.join(" "), "utf8") > 249 && terms.length)
    removed.unshift(terms.pop()!)
  const searchText = terms.join(" ")
  add(
    uiText("搜索词≤249 UTF-8字节", "Search terms within 249 UTF-8 bytes"),
    !!searchText && Buffer.byteLength(searchText, "utf8") <= 249,
    `${Buffer.byteLength(searchText, "utf8")}/249`
  )
  add(
    uiText("搜索词无品牌车型", "Search terms exclude brands and models"),
    !forbidden.some(t => matchToken(searchText, t)),
    searchText
  )
  add(
    uiText("搜索词含主OE", "Search terms include the primary OE"),
    terms.includes(data.oeNumbers[0]) || terms.includes(data.oeNumbers[0].replace(/-/g, "")),
    data.oeNumbers[0]
  )
  const missingOes = data.oeNumbers
    .flatMap(n => (n.includes("-") ? [n, n.replace(/-/g, "")] : [n]))
    .filter(n => !terms.includes(n))
  const missingYears = [...new Set(data.fitments.flatMap(f => f.years))].filter(
    y => !terms.includes(String(y))
  )
  if (missingOes.length || missingYears.length)
    checks.push({
      item: uiText("搜索词OE和年份覆盖", "OE and model-year coverage"),
      status: "WARN",
      value: [...missingOes, ...missingYears].join(", "),
      message: uiText(
        "未覆盖项目仍完整保留在参数表/描述，请确认",
        "Please check the remaining items in the specifications and description"
      ),
    })
  const modelHtml = string(raw.description)
  add(
    uiText("描述HTML标签安全", "Safe HTML in description"),
    !!modelHtml && !/<(?!\/?b>|br\s*\/?\s*>)[^>]*>/i.test(modelHtml),
    uiText("仅b/br", "b and br only")
  )
  const prohibited = /<script|<style|on\w+\s*=|javascript:/i.test(modelHtml)
  if (prohibited)
    add(
      uiText("禁止可执行内容", "Executable content prohibited"),
      false,
      uiText("描述包含不允许内容", "Description contains disallowed content")
    )
  // 固定数据区由确认资料构造，模型不能改写OE、包装数量、适配限制或保修承诺。
  const labels =
    market === "amazon_de"
      ? [
          "FAHRZEUGKOMPATIBILITÄT",
          "TEILENUMMERNREFERENZ",
          "HINWEIS",
          "Bitte prüfen Sie vor dem Kauf die Originalteilenummer, um die Kompatibilität sicherzustellen.",
        ]
      : market === "amazon_jp"
        ? [
            "適合車種",
            "部品番号",
            "ご注意",
            "互換性を確認するため、ご購入前に純正部品番号をご確認ください。",
          ]
        : [
            "VEHICLE FITMENT",
            "PART NUMBER REFERENCE",
            "WARM TIPS",
            "To ensure compatibility, please verify your original factory part number before purchase.",
          ]
  const description = `<b>${labels[0]}:</b><br>${data.fitments.map(f => escapeHtml(fitmentText(f))).join("<br>")}<br><br><b>${labels[1]}:</b><br>${escapeHtml(data.oeNumbers.join(", "))}<br><br><b>${labels[2]}:</b><br>${labels[3]}`
  const names =
    market === "amazon_de"
      ? [
          "OEM-Teilenummer",
          "Garantie",
          "Lieferumfang",
          "Einbauposition",
          "Material und Oberfläche",
          "Elektrische Daten",
        ]
      : market === "amazon_jp"
        ? ["OEM部品番号", "保証", "同梱内容", "取付位置", "材質・表面処理", "電気仕様"]
        : [
            "OEM Part Number",
            "Warranty",
            "Included Components",
            "Position",
            "Material & Finish",
            "Voltage / Wattage / Amperage",
          ]
  const attributes = [
    data.oeNumbers.join(", "),
    WARRANTY[market],
    data.packageContents.map(p => `${p.name} x ${p.quantity}`).join(", "),
    data.position,
    data.materialFinish,
    Object.values(data.electrical).filter(Boolean).join(" / "),
  ]
    .map((value, i) => ({ name: names[i], value }))
    .filter(x => x.value)
  add(
    uiText("产品信息必填项", "Required product information"),
    !missingAutomotiveFields(data).length,
    uiText("OE / 保修 / 包装", "OE / warranty / package")
  )
  // 自由正文里的额外OE、年份不能超出确认资料。
  const freeText = [title, ...highlights, ...bullets, searchText].join(" ")
  const knownYears = new Set(data.fitments.flatMap(f => f.years.map(String)))
  const extraYears = (freeText.match(/\b(?:19|20|21)\d{2}\b/g) || []).filter(
    y => !knownYears.has(y) && !data.oeNumbers.some(n => n.includes(y))
  )
  add(
    uiText("年份不超出确认资料", "Years supported by confirmed data"),
    !extraYears.length,
    [...new Set(extraYears)].join(", ")
  )
  const notes = strings(raw.notes)
  if (titleDropped.length)
    notes.push(
      uiText(
        `标题超过75字符，已按规则省略：${titleDropped.join("、")}；完整资料保留在参数表和描述。`,
        `The title exceeded 75 characters. Omitted: ${titleDropped.join(", ")}. Full details are in the specifications and description.`
      )
    )
  if (sensitiveWords.length) {
    const hits = sensitiveWords.filter(word =>
      [freeText, description, ...attributes.map(a => a.value)]
        .join(" ")
        .toLocaleLowerCase()
        .includes(word.toLocaleLowerCase())
    )
    checks.push({
      item: uiText("自定义敏感词", "Custom restricted terms"),
      status: hits.length ? "WARN" : "PASS",
      value: hits.join(", ") || uiText("未命中", "No matches"),
      message: hits.length
        ? uiText(
            "临时词命中，请核查后使用；不修改原始适配资料",
            "A temporary restricted term matched. Review before use."
          )
        : "",
    })
  }
  if (removed.length)
    notes.push(
      uiText(
        `搜索词超过249字节，已从末尾省略：${removed.join(" ")}`,
        `Search terms exceeded 249 bytes. Removed from the end: ${removed.join(" ")}`
      )
    )
  if (missingOes.length || missingYears.length)
    notes.push(
      uiText(
        "搜索词未覆盖全量OE/年份，完整信息已保留在描述和参数表。",
        "See the description and specifications for complete OE and year coverage."
      )
    )
  return {
    platform: "amazon",
    mode: "automotive",
    title,
    itemHighlights: highlights,
    bullets,
    searchTerms: terms,
    description,
    structuredAttributes: attributes,
    checks,
    notes,
    titleDropped: [
      ...new Set([
        ...titleDropped,
        ...strings(raw.titleDropped).filter(x => ["oe", "years", "trimmed"].includes(x)),
      ]),
    ],
    searchTermsBytes: Buffer.byteLength(searchText, "utf8"),
    rulesVersion: "automotive-v1",
  }
}
export function assertAutomotiveReady(data: AutomotiveData) {
  const missing = missingAutomotiveFields(data)
  if (missing.length)
    throw new BadRequestException({
      code: "AUTOMOTIVE_FIELDS_REQUIRED",
      message: uiText("请补齐汽配上架资料", "Please complete the automotive listing information"),
      details: { missingFields: missing },
    })
}
