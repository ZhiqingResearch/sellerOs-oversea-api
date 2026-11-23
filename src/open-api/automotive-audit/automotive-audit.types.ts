import type { Prisma } from "@prisma/client"

// Heterogeneous evidence stays opaque; executable service fields are typed below.
export type AuditData = Record<string, unknown>
export type AuditPhase = "semantic" | "rules" | "visual" | "snapshot"
export type PhaseMap = Record<string, AuditPhaseState>

export interface AuditInput extends AuditData {
  product: AuditData & { imageUrl?: string }
  productPointer: string
}

export interface AuditReview extends AuditData {
  status: string
  originalMainImage?: AuditData
}

export interface AuditPhaseState extends AuditData {
  state: string
  inputHash?: string
  content?: string
  usage?: unknown
  result?: AuditReview
}

export interface ImageFailure extends AuditData {
  imageId: string
  url: string
  reason: string
}

export interface AuditImageState extends AuditPhaseState {
  images: AuditImage[]
  failures: ImageFailure[]
  originalMainImage?: AuditData
}

export interface AuditPublicResult extends AuditData {
  summary: { score: number; grade: string; coverageRate: number }
}

export interface AuditConfig {
  model: string
  gatewayBaseUrl: string
  crawlerBaseUrl: string
  registeredBrand: string
  ruleVersion: string
}

export interface AuditImage extends AuditData {
  imageId: string
  url: string
  mime: string
  sha256: string
  base64: string
}

export function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}
