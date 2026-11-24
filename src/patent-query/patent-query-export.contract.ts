import { ConflictException } from "@nestjs/common"

const failures = {
  REPORT_NOT_SETTLED: ["The report must be settled before it can be exported.", false],
  EXPORT_OUTDATED: ["The report has changed. Request a new export.", false],
  EXPORT_NOT_READY: ["The PDF is not ready for download.", true],
  LEGACY_REPORT_UNSUPPORTED: ["This report uses an unsupported storage format.", false],
  REPORT_DATA_INCOMPLETE: ["Saved report data is incomplete. Contact support.", false],
  PDF_RENDER_FAILED: ["The PDF could not be generated. Please retry.", true],
  EXPORT_STORAGE_UNAVAILABLE: ["The export file could not be accessed. Please retry.", true],
} as const
export type ExportErrorCode = keyof typeof failures
export function exportFailure(code: ExportErrorCode) {
  const [message, retryable] = failures[code]
  return { code, message, retryable }
}
export class ExportConflict extends ConflictException {
  constructor(readonly code: ExportErrorCode) {
    super(exportFailure(code))
  }
}
// Settled results and inputs are immutable. Annotation edits increment the revision in their transaction.
// Bump the template component when changing the rendered document.
export const exportVersion = (revision: number) => `pdf1-r${revision}`
