import { BadRequestException } from "@nestjs/common"
import { COUNTRY_LANGUAGES, resolveMarketplaceLanguage } from "../utils/marketplace-language"

export function contentLanguagePrompt(
  prompt: string,
  input: { market?: string; contentLanguage?: string }
): string {
  if (input.market !== undefined && (typeof input.market !== "string" || input.market.length > 30))
    throw new BadRequestException("Invalid marketplace")
  if (
    input.contentLanguage !== undefined &&
    (typeof input.contentLanguage !== "string" || input.contentLanguage.length > 20)
  )
    throw new BadRequestException("Invalid content language")
  if (!input.market && !input.contentLanguage) return prompt
  const explicit = input.contentLanguage?.trim().toLowerCase()
  const language = explicit
    ? Object.values(COUNTRY_LANGUAGES).find(
        item => item.locale.toLowerCase() === explicit || item.locale.split("-")[0] === explicit
      )
    : resolveMarketplaceLanguage(input.market)
  if (!language) throw new BadRequestException("Unsupported content language or marketplace")
  return `${prompt}\n\nCONTENT LANGUAGE: ${language.languageEn} (${language.locale}). All newly generated visible text, subtitles, dialogue and narration must use this language. Translate requested copy before rendering. Preserve reference media, original audio and product identity unless the user explicitly requests an edit.`
}
