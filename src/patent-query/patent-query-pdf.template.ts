import { withUiLanguage } from "../common/i18n/request-language"
import { englishScreeningMessage } from "./patent-query-english"
import { ExportConflict } from "./patent-query-export.contract"
import { reportTitle } from "./patent-query.constants"
import { annotations, buildReport, progress } from "./patent-query.report"
import { Bag, input, Kind, KINDS, obj, output, rows, Task } from "./patent-query.types"

const escape = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  )
const imageFields = new Set(["image", "imageUrl", "imageUrls", "thumbnail"])
const internal = new Set(["_rowId", "decisionKey", "hidden", "dismissed", "flagged"])
const labels: Record<string, string> = {
  pn: "Patent number",
  rawPn: "Original patent number",
  displayPn: "Patent number",
  serialNumber: "Application number",
  regNumber: "Registration number",
  markText: "Mark text",
  owners: "Owners",
  assignees: "Assignees",
  filingDate: "Filing date",
  expiryDate: "Expiry date",
  regDate: "Registration date",
  grantDate: "Grant date",
  where: "Occurrence",
  tmClass: "Trademark classes",
  status: "Status",
  legalStatus: "Legal status",
  level: "Risk level",
  reason: "Reason",
  term: "Term",
  score: "Similarity",
  name: "Name",
  description: "Description",
  relation: "Class relation",
  classes: "Classes",
  sources: "Original sources",
  image: "Source image",
  imageID: "Image ID",
  imageId: "Image ID",
  knownIpMatch: "Brand / IP evidence",
  troCases: "TRO cases",
  tro: "TRO evidence",
  productName: "Product name",
  brand: "Brand",
  title: "Title",
  bullets: "Bullet points",
  sites: "Markets",
  locs: "Locarno classes",
  classCodes: "Nice classes",
  removeBg: "Remove background",
  rerank: "AI comparison",
  includeImageText: "Image OCR",
  checked: "Checked",
  failed: "Failed",
  partial: "Partial",
  not_covered: "Not covered",
  not_selected: "Not selected",
  high: "High risk",
  mid: "Review",
  low: "Lower risk",
  expired: "Expired",
  UNKNOWN: "Unrated",
  design: "Design patents",
  copy: "Copyright",
  tm: "Word marks",
  gtm: "Figurative marks",
  hidden: "Folded",
  unknown: "Unrated",
  targets: "Associated results",
  kind: "Check",
  total: "Total",
  designCountries: "Search countries",
  skipped: "Skipped checks",
  countryCode: "Country",
  bucket: "Source field",
  drawingCode: "Drawing code",
  targetId: "Target",
  done: "Done",
  error: "Error",
  message: "Note",
}
const label = (key: string) =>
  Object.hasOwn(labels, key) ? labels[key] : key.replace(/([a-z])([A-Z])/g, "$1 $2")
const css = `
@page{size:A4;margin:15mm 15mm 17mm;@bottom-right{content:counter(page) " / " counter(pages);font:8pt Arial,sans-serif;color:#627782}}*{box-sizing:border-box}body{font:10pt/1.45 Arial,"Microsoft YaHei",sans-serif;color:#172c35;margin:0;overflow-wrap:anywhere}
header{border-top:5px solid #176880;padding-top:9pt}h1{font-size:23pt;line-height:1.17;margin:5pt 0}h2{font-size:16pt;border-bottom:1px solid #acc3c9;color:#174f61;padding-bottom:3pt;margin:16pt 0 6pt}
h3{font-size:12pt;margin:9pt 0 3pt}h4{font-size:10.5pt;margin:5pt 0 1pt}h1,h2,h3,h4{break-after:avoid}p{margin:2pt 0}
.meta,small{color:#4a626b}.stat{display:inline-block;background:#ecf3f5;padding:4pt 8pt;margin:2pt 4pt 2pt 0}
.item{margin:4pt 0;padding:3pt 0;border-top:1px solid #dce5e7}.field{margin-right:8pt;white-space:pre-wrap}.field b{color:#45616b}img{max-width:105mm;max-height:48mm;vertical-align:middle}figure{display:inline-block;margin:5pt;break-inside:avoid}figure img{display:block;max-width:72mm}figcaption{font-size:9pt}.source{margin:3pt 0 5pt 9pt;border-left:2px solid #ccdce0;padding-left:6pt}.empty,em{color:#5b6b72}a{color:#18667d}
`
export function patentReportHtml(
  task: Task,
  uploadRef: (imageId: string) => string,
  image: (url: string) => string
) {
  const i = input(task.input)
  // Localize only errors written by the runner. The raw evidence can contain its own error fields.
  const checks = task.checks.map(check => {
    const data = output(check.output)
    const units = Object.fromEntries(
      Object.entries(data.units).map(([id, unit]) => [
        id,
        unit.error ? { ...unit, error: englishScreeningMessage(unit.error) } : unit,
      ])
    )
    return {
      ...check,
      error: check.error && englishScreeningMessage(check.error),
      output: { ...obj(check.output), units } as unknown as typeof check.output,
    }
  })
  const localized = { ...task, checks }
  const { report, title } = withUiLanguage("en-US", () => ({
    report: buildReport(localized),
    title: reportTitle(i),
  }))
  const saved = annotations(task.annotations)
  const todoIds = new Set(report.todos.map(todo => todo.id))
  if (Object.keys(saved.todoDone).some(id => !todoIds.has(id)))
    throw new ExportConflict("REPORT_DATA_INCOMPLETE")
  const decisions = Object.entries(saved.decisions).filter(
    ([, decision]) => decision.value !== "none"
  )
  if (decisions.length) {
    const groups = [
      ...rows(report.tm.words).map(word => rows(word.marks)),
      ...[report.copy, report.gtm, report.design].flatMap(group =>
        Object.values(group).map(unit => rows(unit.matches))
      ),
    ]
    const keys = new Set(groups.flat().map(match => match.decisionKey))
    if (decisions.some(([key]) => !keys.has(key)))
      throw new ExportConflict("REPORT_DATA_INCOMPLETE")
  }
  function value(v: unknown, key = ""): string {
    if (Array.isArray(v)) return v.map(x => value(x, key)).join(" · ")
    if (v && typeof v === "object") return fields(obj(v))
    if (typeof v === "boolean") return v ? "Yes" : "No"
    if (typeof v === "string" && /^https?:\/\//i.test(v)) {
      if (imageFields.has(key)) return image(v)
      return `<a href="${escape(v)}">${escape(v)}</a>`
    }
    if (typeof v === "string" && ["level", "riskLevel", "state", "kind"].includes(key))
      return escape(label(v))
    return escape(v)
  }
  function fields(data: Bag): string {
    return Object.entries(data)
      .filter(
        ([k, v]) => !internal.has(k) && v != null && v !== "" && !(Array.isArray(v) && !v.length)
      )
      .map(([k, v]) => `<span class="field"><b>${escape(label(k))}</b> ${value(v, k)}</span>`)
      .join(" ")
  }
  const section = (title: string, body: string) =>
    `<section><h2>${escape(title)}</h2>${body || "No saved records"}</section>`
  const block = (data: Bag) => `<div class="item">${fields(data)}</div>`
  const marks = (items: Bag[]) =>
    items
      .map(m => {
        const { sources, ...detail } = m
        const decision = m.flagged ? "Flagged" : m.dismissed ? "Dismissed" : "Default"
        return `<article class="item"><h4>${escape(m.markText || m.title || m.displayPn || m.targetId || "Match")} · ${escape(label(String(m.level)))}</h4><small>Review flag · ${decision}</small><div>${fields(detail)}</div>${rows(
          sources
        )
          .map((s, n) => `<div class="source"><b>Original source ${n + 1}</b> ${fields(s)}</div>`)
          .join("")}</article>`
      })
      .join("")
  const selected = KINDS.filter(k => i[k])
  const modules = selected.filter(k => !i.resolved.skipped.includes(k))
  const evidence: string[] = []
  function facets(items: Bag[]) {
    const counts: Record<string, number> = { high: 0, mid: 0, low: 0, UNKNOWN: 0, expired: 0 }
    for (const item of items) counts[String(item.level)]++
    return `<p class="meta">${fields({ total: items.length, ...counts })}</p>`
  }
  function moduleBody(kind: Kind) {
    if (kind === "tm") {
      const words = rows(report.tm.words)
      return (
        facets(words) +
        words
          .map(w => {
            const { marks: hits, tro, ...word } = w
            if (Object.keys(obj(tro)).length) evidence.push(block({ term: w.term, tro }))
            return `<h3>${escape(w.term)} · ${rows(hits).length} marks</h3>${fields(word)}${marks(rows(hits))}`
          })
          .join("")
      )
    }
    return (
      facets(i.images.flatMap(img => rows(report[kind][img.id]?.matches))) +
      i.images
        .map(img => {
          const {
            matches,
            image: originalImage,
            knownIpMatch,
            troCases,
            ...unit
          } = obj(report[kind][img.id])
          void originalImage // The input section already includes the original image.
          if (knownIpMatch || rows(troCases).length)
            evidence.push(block({ kind, imageId: img.id, knownIpMatch, troCases }))
          return `<h3>${escape(img.name)} · ${rows(matches).length} matches</h3>${fields(unit)}${marks(rows(matches))}`
        })
        .join("")
    )
  }
  const { images: listingImages, ...listing } = i.tm ?? {}
  const photos = [
    ...i.images.map(p => ({ ...p, url: uploadRef(p.id) })),
    ...(listingImages ?? []).map(p => ({
      ...p,
      name: /^listing-[0-9a-f]{32}$/.test(p.id)
        ? p.name
            .replace(/^商品主图$/, "Main product image")
            .replace(/^商品附图(\d+)$/, "Additional product image $1")
        : p.name,
    })),
  ]
  const s = report.summary
  const stats = ["high", "mid", "low", "unknown", "expired", "troCases"] as const
  const dates = [task.createdAt, task.finishedAt].map(d =>
    d ? d.toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—"
  )
  return `<!doctype html><html lang="en-US"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escape(title)}</title><style>${css}</style></head><body>
  <header><small>Product patent screening report · Task ${task.id} · ${escape(i.sites.join(", "))}</small><h1>${escape(title)}</h1><p class="meta">Created ${dates[0]} · Finished ${dates[1]} · ${task.quotedCredits} credits</p></header>
  ${section(report.summary.conclusion, stats.map(k => `<span class="stat">${label(k)} <b>${s[k]}</b></span>`).join(""))}
  ${section("Coverage and gaps", report.coverage.map(c => `<p>${escape(c.site)} · ${label(c.kind)} · <b>${label(c.state)}</b> · ${escape(c.note)}</p>`).join("") + progress(localized).units.map(block).join("") + report.gaps.map(block).join(""))}
  ${section("Product input and images", fields({ sites: i.sites, designCountries: i.resolved.designCountries, classCodes: i.resolved.classCodes, skipped: i.resolved.skipped }) + selected.map(k => `<p><b>${label(k)}</b> ${fields(k === "tm" ? listing : obj(i[k]))}</p>`).join("") + photos.map(p => `<figure>${image(p.url)}<figcaption>${escape(p.name)} · ${escape(p.id)}</figcaption></figure>`).join(""))}
  ${section("Pre-listing actions", report.todos.map(todo => `<h3>${escape(todo.title)}</h3>${fields({ done: todo.done, description: todo.description, targets: todo.targets })}`).join(""))}
  ${modules.map(k => section(label(k), moduleBody(k))).join("")}
  ${section("Image OCR evidence", rows(report.tm.imageOCR).map(block).join(""))}
  ${section("Brand/IP and TRO case evidence", evidence.join(""))}
  <p class="meta">${escape(report.disclaimer)}</p></body></html>`
}
