export type AuditObject = Record<string, unknown>

export interface AuditEvidenceSnapshot {
  snapshotId: string
  provider: string
  state: string
  httpStatus: number | null
  request: unknown
  rawResponse: string | null
  fetchedAt: Date | string | null
  productPointer?: string | null
}

export function auditObject(value: unknown): AuditObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AuditObject) : {}
}

export function auditRows(value: unknown): AuditObject[] {
  return Array.isArray(value) ? value.map(auditObject) : []
}

export function auditText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function auditNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** Crawler numeric fields are sometimes decimal strings; never coerce empty strings, booleans or prose. */
export function auditNumeric(value: unknown): number | null {
  const number = auditNumber(value)
  if (number !== null) return number
  const text = auditText(value)
  return text && /^-?\d+(?:\.\d+)?$/.test(text) ? auditNumber(Number(text)) : null
}

export function auditTexts(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap(item => auditText(item) ?? []) : []
}

export function auditDate(value: unknown): string | null {
  const text = auditText(value)
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const parsed = new Date(text)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
    ? text
    : null
}

export function auditIso(value: Date | string | null): string | null {
  if (value === null) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

export function shiftAuditDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
}

/** Decode only completed provider responses. Never expose raw requests, headers or envelopes. */
export function readAuditSnapshot(snapshot: AuditEvidenceSnapshot): AuditObject | null {
  if (snapshot.state !== "RECEIVED" || snapshot.httpStatus !== 200 || !snapshot.rawResponse)
    return null
  try {
    const result = auditObject(JSON.parse(snapshot.rawResponse))
    if (snapshot.provider === "SIF" && result.code !== 1) return null
    if (snapshot.provider === "CRAWLER" && result.code !== 200) return null
    return result
  } catch {
    return null
  }
}

export function auditSource(snapshot: AuditEvidenceSnapshot, field: string) {
  return {
    provider: snapshot.provider,
    snapshotId: snapshot.snapshotId,
    fetchedAt: auditIso(snapshot.fetchedAt),
    field,
  }
}

export function auditUrl(value: unknown): string | null {
  const text = auditText(value)
  if (!text) return null
  try {
    const url = new URL(text)
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null
    // Public image/listing URLs only; drop query/fragment rather than leaking signed access tokens.
    if (!/(^|\.)(amazon\.[a-z.]+|media-amazon\.com|ssl-images-amazon\.com)$/i.test(url.hostname))
      return null
    return `${url.origin}${url.pathname}`
  } catch {
    return null
  }
}
