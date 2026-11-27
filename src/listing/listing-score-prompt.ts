import { buildListingAlexaPrompt } from "./listing-alexa-score"
import { CDQ_DIMENSION_NAMES_EN, CDQ_WEIGHT_NOTE_EN } from "./listing-cdq-labels"
import { withListingOutputLanguage } from "./listing.prompts"
import { buildListingEvidencePrompt } from "./listing-score-evidence-flow"
import { parseListingScoreSource } from "./listing-score-evidence"
import { LISTING_RULE_CHECK_PROMPT } from "./listing-score-rules"
import { englishScoreReference } from "./listing-score-reference"

/** 自动评分与独立打分共用首次评分约束，规则和证据要求不随入口改变。 */
export function buildListingScoreSystemPrompt(systemPrompt: string | undefined, userPrompt: string): string {
  const source = parseListingScoreSource(userPrompt)
  return withListingOutputLanguage([
    englishScoreReference(systemPrompt ?? ""),
    LISTING_RULE_CHECK_PROMPT,
    buildListingEvidencePrompt(source),
    buildListingAlexaPrompt(source),
    `Return the complete report JSON on this first pass according to the requested marketplace rubric, including suggestions and potential. Preserve actual source quotations and machine identifiers. Apply the CDQ-specific fields, examples and rules only when the requested rubric uses CDQ.
For CDQ use the localized equivalents of these dimension names in order: ${CDQ_DIMENSION_NAMES_EN.join(", ")}. Use the criterion-specific source labels "Official", "Industry research" and "Practical guidance". End with the localized equivalent of "${CDQ_WEIGHT_NOTE_EN}".
Each dimension includes name, weight, maxScore, score and criteria. Each criterion includes name, maxScore, score, description, source and deductions, plus the required CDQ status. Compute each criterion from verified evidence and itemized deductions. Scores must be between zero and maxScore and the total between zero and 100. Use null only for unavailable/inapplicable items as specified. For verified items score=maxScore when deductions is empty. Keep dimension penalties separate. V=0 means no CDQ score and no total. Include the original summary fields.
For example, "No variation matrix was provided." A deduction might read "Bullet 2 gives no measurable specification" and a suggestion "Add a verified dimension or capacity to bullet 2." Use the actual evidence and bullet number. If only the specification section is absent, the description earns 2/3. Include specifications and overview_scenes in assessment.checks with exact quotes. Complete each required evidence row, and use the same findings for the score and its explanation. Return the report, without partial corrections or internal diagnostics.`,
  ].filter(Boolean).join("\n\n"))
}
