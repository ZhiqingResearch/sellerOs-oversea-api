export type RecordedHttp = (
  provider: "CRAWLER" | "SIF",
  url: string,
  method: string,
  body: unknown,
  headers: Record<string, string>
) => Promise<{ status: number; raw: string; snapshotId: string }>

export type JsonRecord = Record<string, unknown>

export interface ComputerPhase {
  state: "SUBMITTING" | "RECEIVED" | "COMPLETED" | "FAILED" | "UNKNOWN"
  inputHash: string
  request: JsonRecord
  content?: string
  result?: unknown
  usage?: unknown
  finishReason?: string | null
  streamInterrupted?: boolean
  outputGaps?: string[]
  billing?: unknown
}

export interface ConsistencyCheck {
  hasContradiction: boolean | null
  summary: string
  contradictions: {
    field: "bullets" | "description"
    titleQuote: string
    contentQuote: string
    explanation: string
  }[]
  checkedSources: string[]
  missingSources: string[]
}

export class ComputerAuditError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}
