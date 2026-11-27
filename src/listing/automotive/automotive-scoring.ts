import { amazonScoreReference } from "../listing-score-reference"
import { withListingOutputLanguage } from "../listing.prompts"
import type { ListingAiInvocationDto } from "../dto/listing-ai.dto"
import { DEFAULT_LISTING_AI_MODEL } from "../listing-ai.models"
import type { finalizeAutomotive } from "./automotive.rules"
import type { AutomotiveData, AutomotiveMarket } from "./automotive.types"

export function buildAutomotiveScoreRequest(
  result: ReturnType<typeof finalizeAutomotive>,
  data: AutomotiveData,
  market: AutomotiveMarket,
  model: ListingAiInvocationDto["model"] = DEFAULT_LISTING_AI_MODEL,
  sensitiveWords: string[] = []
): ListingAiInvocationDto {
  const source = {
    title: result.title,
    itemHighlights: result.itemHighlights.join(", "),
    bullets: result.bullets,
    description: result.description,
    searchTerms: result.searchTerms.join(" "),
    structuredAttributes: result.structuredAttributes,
  }
  const sourceJson = JSON.stringify(source).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
  const factsJson = JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
  return {
    operation: "score",
    model,
    temperature: 0,
    systemPrompt: withListingOutputLanguage(
      amazonScoreReference + "\nPreserve source quotes in their marketplace language. Apply the existing four dimensions and weights without additional automotive criteria."
    ),
    userPrompt: `mode: standard
Marketplace: ${market}. Score the generated automotive listing against the standard Amazon rubric. The confirmed facts below are for verification only; they cannot substitute for missing listing content. Do not visit URLs, fetch products or look up keywords.
<confirmed-automotive-facts>${factsJson}</confirmed-automotive-facts>
Measured title length including spaces: ${Array.from(result.title).length}. Measured comma-space joined Item Highlights length: ${Array.from(source.itemHighlights).length}.
Temporary sensitive terms: ${JSON.stringify(sensitiveWords)}
Images, A+ content, the parent variation matrix and keyword research were not supplied. Mark unavailable evidence according to the rubric. Do not infer confirmed absence or inapplicability. Assess the actual structured attributes without inventing a category-required field list. Use the original fields independently.
<listing-scoring-source>${sourceJson}</listing-scoring-source>`,
  }
}
