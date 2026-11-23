import { uiText } from "../common/i18n/request-language"
import type { Match, Todo } from "./patent-query.report"
import { Bag, Input, obj, rows, str } from "./patent-query.types"

export interface TodoAction {
  label: string
  section: "matches" | "knownIpMatch" | "troCases" | "words"
  term?: string
  caseNumber?: string
}

const unique = (values: string[]) => [...new Set(values.map(v => v.trim()).filter(Boolean))]
const owners = (m: Bag) =>
  unique([...rows(m.owners), ...rows(m.assignees)].map(o => str(o.name))).join(uiText("、", ", "))
const reasons = (matches: Bag[]) =>
  unique(matches.flatMap(m => [str(m.reason), str(m.categoryMismatchReason)]))
const percent = (score: unknown) =>
  typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1
    ? uiText(`相似度 ${Math.round(score * 1000) / 10}%`, `Similarity ${Math.round(score * 1000) / 10}%`)
    : ""
const statusLabels: Record<string, string> = {
  LIVE: "有效",
  REGISTERED: "已注册",
  PENDING: "申请中",
  DEAD: "已失效",
  CANCELLED: "已撤销",
  EXPIRED: "已过期",
  ABANDONED: "已放弃",
}
const markDescription = (m: Bag) => {
  const classes = [...rows(m.classes), ...rows(m.tmClass)]
    .map(c => [str(c.code), str(c.description) || str(c.text)].filter(Boolean).join(" · "))
    .filter(Boolean)
  return unique([
    str(m.markText) ? uiText(`商标「${str(m.markText)}」`, `Trademark “${str(m.markText)}”`) : uiText("未提供商标名称", "Trademark name unavailable"),
    str(m.serialNumber) ? uiText(`申请号 ${str(m.serialNumber)}`, `Application ${str(m.serialNumber)}`) : "",
    owners(m) ? uiText(`权利人：${owners(m)}`, `Rights holder: ${owners(m)}`) : "",
    classes.length ? uiText(`类别：${unique(classes).join(uiText("、", ", "))}`, `Classes: ${unique(classes).join(", ")}`) : "",
    unique(
      [str(m.status), str(m.legalStatus)].map(status =>
        Object.hasOwn(statusLabels, status.toUpperCase())
          ? uiText(statusLabels[status.toUpperCase()], status)
          : status
      )
    ).join(" · "),
    percent(m.score),
    str(m.reason),
  ]).join("；")
}
export const containsTerm = (text: string, term: string) => {
  if (!term) return false
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text)
}

export function presentTodo(
  todo: Todo,
  i: Input,
  images: Record<"design" | "copy" | "gtm", Record<string, Bag>>,
  tm: Bag,
  light = false
): Todo & { description: string; action: TodoAction } {
  let title = todo.title
  let description = uiText("上游未提供具体说明，请查看检测详情核对。", "No explanation was provided. Review the screening details.")
  let action: TodoAction = { label: uiText("看商标", "View trademark"), section: "matches" }
  if (todo.kind === "tm") {
    const key = decodeURIComponent(todo.id.split(":")[1])
    const word = rows(tm.words).find(w => str(w.term).trim().toLowerCase() === key) ?? {}
    const marks = (rows(word.marks) as Match[]).filter(m => ["high", "mid"].includes(m.level))
    const term = str(word.term).trim()
    const location = containsTerm(i.tm?.brand ?? "", term) ? "品牌名" : "标题"
    const high = marks.some(m => m.level === "high")
    title =
      location === "品牌名"
        ? uiText(`品牌名「${term}」建议换一个`, `Consider replacing “${term}” in the brand name`)
        : high
          ? uiText(`标题里删掉「${term}」`, `Remove “${term}” from the title`)
          : uiText(`核对标题用词「${term}」`, `Review “${term}” in the title`)
    if (light)
      return {
        ...todo,
        title,
        description: "",
        action: { label: uiText("看商标", "View trademark"), section: "words", term },
      }
    const sources = marks.map(
      mark =>
        (mark.sources ?? []).find(
          s =>
            s.level === mark.level &&
            s.expired !== true &&
            !/^(DEAD|CANCELLED|EXPIRED|ABANDONED)$/i.test(str(s.status)) &&
            !/^(DEAD|CANCELLED|EXPIRED|ABANDONED)$/i.test(str(s.legalStatus))
        ) ?? mark
    )
    description =
      marks.length === 1
        ? markDescription(sources[0])
        : uiText(`该词命中 ${marks.length} 件需核对商标，请查看各商标的类别、状态及匹配说明。`, `Review the classes, status and explanations for ${marks.length} matching marks.`)
    if (sources.some(source => !str(source.reason).trim()))
      description += uiText("\n上游未提供部分或全部具体匹配说明，请查看商标详情核对。", "\nSome match explanations are missing. Review the trademark details.")
    action = { label: uiText("看商标", "View trademark"), section: "words", term }
    return { ...todo, title, description: light ? "" : description, action }
  }
  const imageIds = unique(todo.targets.map(t => t.imageId ?? ""))
  const imageLabel = imageIds
    .map(id => uiText(`图 ${i.images.findIndex(image => image.id === id) + 1}`, `Image ${i.images.findIndex(image => image.id === id) + 1}`))
    .join(uiText("、", ", "))
  const matches = todo.targets.flatMap(t =>
    rows(images[todo.kind as "design" | "copy" | "gtm"][t.imageId ?? ""]?.matches).filter(
      (m, index) =>
        t.matchIndex !== undefined
          ? index === t.matchIndex
          : t.targetId !== null &&
            m.targetId === t.targetId &&
            (todo.kind === "design"
              ? m.level === "high"
              : todo.kind === "gtm"
                ? ["high", "mid"].includes(str(m.level))
                : m.matchType === (todo.id.includes(":identical:") ? "identical" : "verified"))
    )
  )
  const first = matches[0] ?? {}
  if (todo.kind === "design") {
    const patentNumber = str(first.displayPn)
    const patentName = str(first.title).trim() || uiText("未提供专利名称", "Patent title unavailable")
    title = uiText(`${imageLabel} 改款避开外观专利 ${patentNumber}：${patentName}`, `${imageLabel}: review the design against ${patentNumber} (${patentName})`)
    if (light)
      return {
        ...todo,
        title,
        patentNumber,
        patentName,
        description: "",
        action: { label: uiText("看比对", "View comparison"), section: "matches" },
      }
    const details = unique(
      matches.flatMap(m => [
        owners(m) ? uiText(`权利人：${owners(m)}`, `Rights holder: ${owners(m)}`) : "",
        str(m.expiryDate) ? uiText(`到期日：${str(m.expiryDate)}`, `Expiry date: ${str(m.expiryDate)}`) : "",
      ])
    )
    description = [...details, ...reasons(matches)].join("\n")
    if (!reasons(matches).length)
      description += uiText(`${description ? "\n" : ""}上游未提供具体对比说明，请查看专利图样人工核对。`, `${description ? "\n" : ""}No comparison details were supplied. Review the patent drawings.`)
    return {
      ...todo,
      title,
      patentNumber,
      patentName,
      description: light ? "" : description,
      action: { label: uiText("看比对", "View comparison"), section: "matches" },
    }
  }
  if (todo.kind === "gtm") {
    const high = matches.some(m => m.level === "high")
    title = uiText(`${imageLabel} ${high ? "更换" : "核对"} Logo / 图案`, `${imageLabel}: ${high ? "replace" : "review"} the logo or motif`)
    if (matches.length === 1) title += uiText(`：图形商标「${str(first.markText) || "未提供名称"}」`, `: figurative mark “${str(first.markText) || "name unavailable"}”`)
    if (light) return { ...todo, title, description: "", action }
    description =
      matches.length === 1
        ? markDescription(first)
        : uiText(`命中 ${matches.length} 件需核对图形商标，请查看各商标的图样、类别及对比说明。`, `Review images, classes and explanations for ${matches.length} figurative marks.`)
    if (!reasons(matches).length) description += uiText("\n上游未提供具体对比说明，请查看商标图样核对。", "\nNo comparison details were supplied. Review the trademark image.")
  } else if (todo.id.includes(":tro:")) {
    const caseNumber = decodeURIComponent(todo.id.split(":tro:")[1])
    if (light)
      return {
        ...todo,
        title: uiText(`核对关联 TRO 案件 ${caseNumber}`, `Review related TRO case ${caseNumber}`),
        description: "",
        action: { label: uiText("看案件", "View case"), section: "troCases", caseNumber },
      }
    const cases = imageIds
      .flatMap(id => rows(images.copy[id]?.troCases))
      .filter(c => (str(c.caseNumber) || str(c.caseNo)) === caseNumber)
    title = uiText(`核对关联 TRO 案件 ${caseNumber}`, `Review related TRO case ${caseNumber}`)
    description =
      unique(
        cases.flatMap(c => [str(c.court), str(c.filingDate), str(c.title), str(c.reason)])
      ).join("；") || uiText("已返回关联案号，其他案件详情未提供。请查看案件线索核实。", "A related case number was returned without case details. Review the evidence.")
    action = { label: uiText("看案件", "View case"), section: "troCases", caseNumber }
  } else if (todo.id.endsWith(":knownIp")) {
    const ip = obj(images.copy[imageIds[0]]?.knownIpMatch)
    title = uiText(`${imageLabel} 含${str(ip.matchedName) ? `「${str(ip.matchedName)}」` : "疑似"}品牌 / IP 元素`, `${imageLabel}: possible brand or IP elements ${str(ip.matchedName)}`)
    description =
      str(ip.note).trim() ||
      uiText("上游识别到品牌或知名形象，但未提供具体说明，请核实授权或更换相关元素。", "A brand or recognizable character was detected without supporting details. Verify the licence or replace it.")
    action = { label: uiText("看识别结果", "View identification"), section: "knownIpMatch" }
  } else {
    const identical = first.matchType === "identical"
    title = uiText(`${imageLabel} ${identical ? "换成自己拍的图" : "核实图片来源"}`, `${imageLabel}: ${identical ? "replace with an original image" : "verify image sources"}`)
    if (matches.length === 1) {
      const host = str(first.sourceHost).trim()
      if (host) title += `（${host}）`
      const sourceTitle = str(first.title).trim()
      if (sourceTitle) title += `：${sourceTitle}`
    }
    if (light)
      return {
        ...todo,
        title,
        description: "",
        action: { label: identical ? uiText("看原图", "View original image") : uiText("看来源", "View source"), section: "matches" },
      }
    description =
      matches.length === 1
        ? [
            str(first.sourceHost) ? uiText(`来源：${str(first.sourceHost)}`, `Source: ${str(first.sourceHost)}`) : uiText("上游未提供来源网站名称。", "Source website unavailable."),
            str(first.title).trim(),
            ...reasons(matches),
          ]
            .filter(Boolean)
            .join("\n")
        : uiText(`发现 ${matches.length} 条${identical ? "完全一致的图片" : "同商品图片"}来源，请查看各条来源和匹配说明。`, `Review the sources and explanations for ${matches.length} ${identical ? "identical" : "same-product"} images.`)
    if (!reasons(matches).length) description += uiText("\n上游未提供具体匹配说明，请查看来源核对。", "\nReview the sources to verify the match.")
    description += identical
      ? uiText("\n建议更换为自有图片；已有授权的请保留凭证。", "\nUse your own image or retain evidence of your licence.")
      : uiText("\n请核实该来源的图片使用授权。", "\nVerify permission to use this image.")
    action = {
      label: identical ? uiText("看原图", "View original image") : uiText("看来源", "View source"),
      section: "matches",
    }
  }
  return { ...todo, title, description: light ? "" : description, action }
}
