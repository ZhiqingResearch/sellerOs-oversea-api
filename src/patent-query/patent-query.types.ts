import type { PatentQueryCheck, PatentQueryTask, Prisma } from "@prisma/client"
import type { QuotePatentQueryDto } from "./dto/patent-query.dto"
export const KINDS = ["design", "copy", "gtm", "tm"] as const
export type Kind = (typeof KINDS)[number]
export type Bag = Record<string, unknown>
export const obj = (v: unknown): Bag =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Bag) : {}
export const rows = (v: unknown): Bag[] => (Array.isArray(v) ? v.map(obj) : [])
export const str = (v: unknown): string => (typeof v === "string" ? v : "")
export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []
export const json = (v: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue
export type Input = QuotePatentQueryDto & {
  images: NonNullable<QuotePatentQueryDto["images"]>
  resolved: { responseLanguage?: "zh-CN" | "en-US"; designCountries: string[]; classCodes: string[]; skipped: string[] }
}
export interface Unit {
  savedMatchCount?: number
  resultReady?: boolean
  status: string
  error: string | null
  result: Bag
  matches: Bag[]
  offset: number
  pageFingerprints?: string[]
  complete: boolean
}
export interface Output {
  savedWordMarkCounts?: number[]
  clientRequestId?: string
  upstreamCompleted?: boolean
  units: Record<string, Unit>
  text?: Bag
  cache?: Record<string, Bag>
}
export const output = (v: unknown): Output => ({ units: {}, ...obj(v) }) as Output
export const input = (v: unknown): Input => v as Input
export type Task = PatentQueryTask & { checks: PatentQueryCheck[] }
export const TERMINAL = ["COMPLETED", "PARTIAL", "FAILED"]
export const PAID = ["COMPLETED", "PARTIAL"]
