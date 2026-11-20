export const COMPETITOR_RECORD_PREFIX: [zh: string, en: string] = ["竞品复刻 · ", "Competitor recreation · "]
export const OWN_PRODUCT_RECORD_PREFIX: [zh: string, en: string] = ["自有商品 · ", "Own product · "]
export const UNTITLED_OWN_PRODUCT: [zh: string, en: string] = ["未命名", "Untitled"]

export function englishProductFactoryRecordName(name: string, sourceType: string): string {
  const [prefix, englishPrefix] = sourceType === "competitor"
    ? COMPETITOR_RECORD_PREFIX
    : OWN_PRODUCT_RECORD_PREFIX
  if (!name.startsWith(prefix)) return name
  const suffix = name.slice(prefix.length)
  return `${englishPrefix}${sourceType !== "competitor" && suffix === UNTITLED_OWN_PRODUCT[0]
    ? UNTITLED_OWN_PRODUCT[1] : suffix}`
}
