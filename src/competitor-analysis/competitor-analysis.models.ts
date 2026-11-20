export const DEFAULT_COMPETITOR_ANALYSIS_MODEL = "ZQ-Multimodal-Gemini-3.8-Flash"

export const COMPETITOR_ANALYSIS_MODELS = [
  DEFAULT_COMPETITOR_ANALYSIS_MODEL,
  // Accept model values sent by older clients. New calls use the default above.
  "ZQ-Think-Flash",
  "ZQ-Think-Lite",
  "ZQ-Think-Pro",
] as const

export type CompetitorAnalysisModel = (typeof COMPETITOR_ANALYSIS_MODELS)[number]
