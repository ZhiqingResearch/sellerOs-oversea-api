import { uiLanguage, type UiLanguage } from "./request-language"

const ENGLISH_DIRECTIVE =
  "[APPLICATION_OUTPUT_LANGUAGE=en-US] Write all user-facing analysis, explanations, report headings, recommendations, labels and generation-prompt prose in English, regardless of the input language or Chinese examples. This overrides conflicting prose-language instructions. Preserve JSON keys, required enum values, numeric facts, source quotations, actual speech and machine reference tokens. Customer-facing product copy, on-image advertising text, subtitles and voiceover must use the explicitly selected target marketplace/content language, not the interface language. An explicit translation target takes precedence. Do not invent missing facts or change prices/currencies."

export function withOutputLanguage(prompt: string, language: UiLanguage = uiLanguage()): string {
  if (language !== "en-US" || prompt.includes(ENGLISH_DIRECTIVE)) return prompt
  return `${prompt}\n\n${ENGLISH_DIRECTIVE}`
}

export function savedUiLanguage(value: unknown): UiLanguage {
  return value === "en-US" ? "en-US" : "zh-CN"
}
