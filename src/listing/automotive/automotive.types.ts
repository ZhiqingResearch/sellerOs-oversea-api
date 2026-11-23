export const AUTOMOTIVE_MARKETS = ["amazon_us", "amazon_uk", "amazon_de", "amazon_jp"] as const
export type AutomotiveMarket = (typeof AUTOMOTIVE_MARKETS)[number]
export type JsonRecord = Record<string, unknown>
export interface AutomotiveSource {
  sourceId: string
  type: "TEXT" | "PRODUCT_TITLE" | "LINK" | "DOCUMENT"
  status: "SUCCEEDED" | "FAILED"
  name: string
  content: string
  url?: string
  fetchedAt?: string
  acquisition?: string
  data?: JsonRecord
  images?: string[]
  truncated?: boolean
  error?: string
}
export interface AutomotiveClassification {
  decision: "AUTOMOTIVE" | "GENERAL" | "UNKNOWN"
  basis: "USER" | "MODEL"
  categoryKey: string
  reason: string
  requiresConfirmation: boolean
}
export interface AutomotiveData {
  brand: string
  product: string
  searchKeywords: string[]
  fitments: { make: string; model: string; years: number[]; details: string }[]
  oeNumbers: string[]
  sellingPoints: { title: string; detail: string }[]
  position: string
  materialFinish: string
  electrical: { voltage: string; wattage: string; amperage: string }
  packageContents: { name: string; quantity: number }[]
  fitmentPhrase: "FIT_FOR" | "COMPATIBLE_WITH"
}
export interface AutomotiveCheck {
  item: string
  status: "PASS" | "WARN" | "FAIL" | "NA"
  value: string
  message: string
}
export const object = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}
export const string = (value: unknown): string => (typeof value === "string" ? value.trim() : "")
export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(string).filter(Boolean) : []
