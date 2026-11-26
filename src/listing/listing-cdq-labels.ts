export const CDQ_DIMENSION_NAMES_EN = [
  "CDQ completeness", "Keyword coverage", "COSMO relationship coverage", "Alexa semantic quality",
] as const

export const CDQ_DIMENSION_NAME_PATTERNS = [
  /^(?:CDQ\s*完整性|CDQ\s+completeness)$/i, /关键词|\bkeywords?\b/i, /COSMO/i, /Alexa/i,
]

export const CDQ_CRITERION_NAMES_EN: readonly (readonly string[])[] = [
  ["Structured attributes", "Title quality", "Variation quality", "Image quality", "A+ content", "Bullet points"],
  ["Primary keyword in the first 75 title characters", "S/A-tier keywords in title and bullets", "B/C-tier long-tail coverage",
    "Search terms coverage without title duplication", "Keyword relevance"],
  ["Coverage of all four high-priority relationships", "Category-specific relationships", "Coverage of at least three medium-priority relationships"],
  ["Title coherence", "Verifiable facts in each bullet", "Concrete use cases and structured specifications in the description"],
]

export const CDQ_WEIGHT_NOTE_EN =
  "CDQ weights follow an internal scoring methodology independent of Amazon's official scoring."
