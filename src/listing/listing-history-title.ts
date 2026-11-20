export const LISTING_HISTORY_TITLE_PREFIX = "Listing 生成 · "
export const ENGLISH_LISTING_HISTORY_TITLE_PREFIX = "Listing Generator · "
export const LISTING_DOCUMENT_TITLE: [zh: string, en: string] = ["产品文档", "Product document"]

export const LISTING_STEP_LABELS: Record<string, [zh: string, en: string]> = {
  category_match: ["类目匹配", "Category matching"],
  attribute_analysis: ["属性分析", "Attribute analysis"],
  long_title: ["长标题生成", "Long title generation"],
  generation: ["Listing 主生成", "Listing generation"],
  optimization: ["Listing 优化", "Listing optimization"],
  qa_rewrite: ["问答改写", "Q&A rewrite"],
  score: ["Listing 评分", "Listing scoring"],
}

export function englishListingHistoryTitle(title: string, firstOperation?: string): string {
  if (!title.startsWith(LISTING_HISTORY_TITLE_PREFIX)) return title
  const suffix = title.slice(LISTING_HISTORY_TITLE_PREFIX.length)
  const step = firstOperation ? LISTING_STEP_LABELS[firstOperation] : undefined
  const englishSuffix = suffix === LISTING_DOCUMENT_TITLE[0]
    ? LISTING_DOCUMENT_TITLE[1]
    : step?.[0] === suffix ? step[1] : suffix
  return `${ENGLISH_LISTING_HISTORY_TITLE_PREFIX}${englishSuffix}`.slice(0, 500)
}
