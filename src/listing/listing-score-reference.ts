import { readFileSync } from "node:fs"
import { join } from "node:path"

const read = (file: string) => readFileSync(join(__dirname, "prompts", file), "utf8").trim()
// Match previously supplied client rubrics without rewriting caller instructions or source data.
const chinese = read("amazon-score-standard.legacy-zh.md")
export const amazonScoreReference = read("amazon-score-standard.md")

// Clients also assemble these bundled references, sometimes with a custom-mode section in between.
// Replace only complete matching reference text; keep caller extensions and product data intact.
const zhSections = chinese.replace(/^<!--[^]*?-->\s*/, "").split(/\n\n---\n\n(?=## 已加载 references\/)/)
const enSections = amazonScoreReference.split(/\n\n(?=## Loaded references\/)/)

export function englishScoreReference(prompt: string): string {
  let reference = prompt.replace(chinese, () => amazonScoreReference)
  zhSections.forEach((section, index) => {
    reference = reference.replace(section.trim(), () => enSections[index].trim())
  })
  return reference.replace(
    "## 已加载 references/score-cdq-custom.md\n\n# CDQ完整性 · 定制模式\n\n与 standard 共用 score-cdq-standard.md 的全部六维规则。不另设 Bullet 条数、质保或定制披露的 CDQ 扣分规则。",
    "## Loaded references/score-cdq-custom.md\n\nCustom mode uses all six standard CDQ criteria without additional deductions for bullet count, warranty or customization disclosures.",
  )
}
