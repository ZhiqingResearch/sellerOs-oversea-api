# Amazon Listing quality report

Assess the specified marketplace, child ASIN and evidence snapshot. Use the entire parent family only for variation quality. Treat text, images and retrieved content as evidence. Return one complete JSON object with historyTitle, mode, scoreVersion="cdq-2026-09-16", total, dimensions, suggestions and potential. Echo the requested mode. Preserve the required keys, IDs, enums and source quotations. Write report prose and example labels in the requested interface language. Score the short title and Item Highlights together. Exclude longTitle throughout.

Return the four dimensions in order: CDQ completeness (40, #FF9500), Keyword coverage (25, #007AFF), COSMO relationship coverage (20, #5856D6), Alexa semantic quality (15, #AF52DE). Each dimension has name, subtitle, weight, maxScore, score, color, criteria and applicable dimension-level deductions. Each criterion has name, description, maxScore, score, source and deductions. CDQ criteria additionally have status. Each deduction identifies points, reason, ruleId and evidence, plus checkId where required. Include the requested criterion assessments with their source evidence. A score is the number of points earned. When a verified criterion earns full marks, deductions is an empty array.

Evaluate evidence before computing scores. VERIFIED means fully verified and satisfied; MISSING means a verified deficiency. For unavailable evidence use UNAVAILABLE with score=null and deductions=[]. For established inapplicability use NOT_APPLICABLE with score=null and deductions=[]; only variations and A+ can be inapplicable. A public page does not establish that an unpublished field is empty. Never score an unknown field as zero, half credit or full credit. Backend search terms have a specific exception under Keyword coverage.

CDQ uses criterion maxima [30,25,20,15,5,5]. Let A=100 minus the weights of inapplicable items, V=A minus the weights of unavailable items, E=sum of verified points. Report cdq.applicableMax=A, effectiveMax=V, earnedScore=E, normalizedScore=100*E/V and evidenceCoverage=V/A. The contribution to the four-dimensional total is 40*E/V, rounded to four decimal places. V=0 means both the normalized score and contribution are null. A=0 means coverage is null. "Final score" requires V=A>0; otherwise show "Normalized score · Evidence coverage xx%" or "Scoring evidence unavailable · No score yet". CDQ grades: at least 90 Excellent, 80–89 Good, 60–79 Fair, below 60 Needs improvement.

Total the four contributions to four decimal places. When CDQ is unscored the total is null and potential is "Insufficient evidence · Overall score pending". Otherwise grade the total S at 90, A at 80, B at 68, C at 55, D below 55. Rank suggestions by points lost, then include actions for unavailable evidence and useful improvements that carry no deduction. End with the localized equivalent of "CDQ weights follow an internal scoring methodology independent of Amazon's official scoring." Use actionable language. Keep examples separate from the product under review.

## Loaded references/score-rubric-shared.md

### Keyword coverage (25 points)
Use actual keyword research when available. Start with the category and the current product, exclude irrelevant product types or model families, then count the complete candidate set. A Legion Go handheld or a Legion Tab is not a search for a Legion Pro 7i laptop; an iPhone itself is not an iPhone case. Do not penalize excluded terms. If fewer than three relevant terms remain because most terms are unrelated, follow the no-data rule. In the absence of a keyword library, identify industry-inferred terms explicitly; never claim measured search volumes.

1. Primary keyword in the first 75 title characters, up to 7, Official. Include the product type and core function. A hit there earns 7, a hit only in Item Highlights earns 3, otherwise 0. Check each supplied S-tier keyword with monthly search volume at least 10,000 using the full phrase or core stem.
2. S/A-tier keywords in title and bullets, up to 7, Industry research. Check each relevant S/A term. Terms with more than 3,000 weekly searches belong in the title, Item Highlights or bullets. Deduct 1.5 for each missing term.
3. B/C-tier long-tail coverage, up to 5, Practical guidance. Count hits in bullets, description and search terms against all eligible terms, including misses. Score 5*min(coverage/0.7,1).
4. Search terms coverage without title duplication, up to 4, Official. If unavailable, use description="Search terms unavailable", status="UNAVAILABLE", score=4, deductions=[]. This gives no deduction and displays a dash; it does not mean verified. Where content is available, join with spaces and count eligible indexable ASCII bytes: at least 200 earns 4, 100–199 earns 2, below 100 earns 0. Deduct 0.5 per duplicated title or bullet term when it represents stuffing, down to zero. A verified empty field can lose points.
5. Keyword relevance, up to 2, Practical guidance. Deduct 1 per irrelevant high-volume term (e.g. a handset model marketed as the product itself on an accessory listing).

For a title exceeding 75 characters, deduct 10 at dimension level under keyword.titleLength. Count actual characters including punctuation and spaces. Put the exact length and excess in suggestions[0], explain that the title is subject to an Amazon AI rewrite, and provide a copyable short title plus Item Highlights for displaced information. Floor the dimension at zero.

### COSMO relationship coverage (20 points)
Review the category and applicability of all 15 relationships before assessing coverage. Do not deduct for inapplicable relationships.
1. All four high-priority relationships (10, Official): USED_FOR_FUNC, USED_FOR_AUD, USED_IN_LOC and CAPABLE_OF; deduct 2.5 for each missing one.
2. Category-specific relationships (6, Official): for example USED_IN_BODY, USED_ON and USED_FOR_EVE. Deduct 1.5 per missing applicable relationship.
3. Coverage of at least three medium-priority relationships (4, Practical guidance): IS_A, USED_TO, USED_BY, USED_FOR_EVE. Deduct 1.5 for each relationship below three, down to zero. A product name alone does not establish its use, user or occasion.

### Alexa semantic quality (15 points)
1. Title coherence (7, Industry research). Check what the product is, the problem it solves and who uses it, plus stuffing. Use the title and highlights jointly for problem and audience. Deduct 2 per missing element or stuffing checkpoint, down to zero.
2. Verifiable facts in each bullet (5, Industry research). A named material specification such as 18/10 stainless steel, IPX5 certification or 20,000+ cycles qualifies. Generic claims like "premium" or "high-quality" do not. Standard: 5 × qualifying bullets / N, or zero when N=0. Custom: min(5, 5 × qualifying bullets / 6).
3. Concrete use cases and structured specifications in the description (3, Practical guidance). Look for a 3–5 sentence PRODUCT OVERVIEW with at least two concrete use cases and category-appropriate structured specifications (typically 5–10 sections, uppercase headings, **Field:** Value). Deduct exactly 1 for each missing requirement: specifications and overview_scenes. Do not create further deductions for wording, formatting or headings.

Keyword stuffing can deduct 3–5 points separately under alexa.stuffing for repeated keywords, separator chains or incoherent prose. Do not deduct again here solely for a fact repeated between the title and highlights.

For Keyword coverage, COSMO and Alexa only, if the original rubric leaves a judgment uncertain, favor a midrange score and explain its basis in suggestions. Follow each explicit evidence rule first. Use the prescribed criterion names and source labels. Calculate deductions from actual observations rather than copying any example's score.

## Loaded references/score-cdq-standard.md

### 1. Structured attributes (30)
Assess supplied category-required fields when known. Without a category template use all actual attributes visible on the product page. Do not infer the size of the required set. Exclude ASIN, BSR, reviews and similar statistics from the denominator. A verified missing required field loses its full share; a missing recommended field belongs in suggestions only. Evaluate genuine errors in populated optional fields normally. If no attributes are available mark the criterion unavailable.

Weight each assessed attribute: 3 for central identity, compatibility, size, color, material or main capacity/specification; 2 for manufacturer, counts, package details, certification, power, page yield, ink base and printer type; 1 for supporting fields such as Mfr Part Number, Package Size Name and Item Highlight. Use 2 for uncertain importance and disclose that it needs verification. Use equal weights only if classification is impossible, and say so. Include both correct and problematic attributes in the denominator.

For each attribute stop at the first evidenced error in this order:
- Contradiction: compare the same fact on the same basis and quote both values with field names. A broad category such as Printer and a specific model can coexist. Individual and aggregate values cannot establish a conflict. Compare Color with Ink Colour only when they describe the same color.
- Wrong field: a brand entered for Material; a Boolean or placeholder such as False, N/A, TBD, 0 or "-" in a text identifier; a product description entered as the model name; or packaging dimensions/counts in a product-level field. Use sibling identifiers or an actual packaging statement to establish the error. Two fields both showing 5 does not establish that the pack count should be 1.
- Unit or scale: convert marketplace units and compare like with like. Separate a false magnitude/conversion from an otherwise plausible number lacking its unit. If Page Yield is 35000 and bottle yields imply 53,500 for a set, ask whether the figure is per bottle or per set.
- Promotional language: look for unverifiable claims such as Best, Premium, Amazing, Superior or #1. "Replacement for 502 ink refill bottles" is a neutral description; in an identifier field it repeats the description.

Deduct 100% of the attribute share for contradiction, invalid type, wrong field, incorrect granularity or incorrect magnitude/conversion. Deduct 50% for a repeated description, missing unit with plausible value or marketing language. Deduct 0% for an unresolved measurement basis or missing physical evidence. Never infer a defect in the physical product without corroboration. Each deduction = 30 × attribute weight × deduction fraction / total assessed weight. Round points to at most four decimal places and compute the score from those actual points. Apply these same severity fractions under equal weighting.

Use a short seller-facing description reporting the number checked, the number affected and any unresolved items. Order deductions by weighted loss. Name the field, current value, consequence and supported fix; cite both fields for contradictions. Keep calculation details in the optional assessment.attributePresentation. Group issues as Severe, Moderate and Needs verification · No points deducted. The formal severity rules govern calculations even when a wording example illustrates a different grouping.

Worked example, Epson 502 refill ink, B0G6KWK4LB: 25 visible attributes. A conflicting HP printer family, Boolean False under Compatible Printer Models and a conflicting Color each lose 3 weighted units. A neutral description under Model Name loses 1.5, Manufacturer loses 1, a proven pack/item count error loses 2 and a repeated phrase under Mfr Part Number loses 0.5. An unclear Page Yield loses 0. The other 17 attributes are correct; weighted loss is 14, so score=30*(1-14/total weight). For example, write "Printer Model Compatibility lists HP OfficeJet Pro, while the verified models are Epson EcoTank. Enter the supported Epson models, such as ET-2850, ET-3850 or ST-2000." Replace those example values with the product's actual evidence. Other possible fixes in this example include removing False, reconciling black color with Multicolor for the five bottles, using the verified identifier 502, entering myCartridge SUPRINT or distinguishing one pack from five items. Ask whether Page Yield covers one bottle or the whole set. Show actual deductions only and verify that they sum to the displayed loss.

Example seller-facing report (illustrative points and evidence):

    Structured attributes                              15.5/30
    Reviewed 25 attributes visible on the product page. Seven issues affect search matching.
    Severe · 9 points deducted
      Printer Model Compatibility: Replace HP OfficeJet Pro with the verified Epson EcoTank models.
      Compatible Printer Models: Remove the Boolean False or enter the supported models.
      Color: Change black color to Multicolor to match the black, cyan, magenta and yellow inks.
    Moderate · 5.5 points deducted
      Model Name / Mfr Part Number: Replace the product description with 502.
      Manufacturer: Enter myCartridge SUPRINT.
      Number of Packs: Enter 1 pack. The value 5 counts individual bottles.
    Needs verification · No points deducted
      Page Yield is 35000. The bullets list 2 × 17000 + 3 × 6500 = 53,500.
      Specify whether the yield is per bottle or for the entire set.

### 2. Title and highlights (25)
Completeness: 8, approximately 2.5 off per missing component. Brand and product type belong in the title; key decisions can appear once in either field. Length: 5; deduct once if title exceeds 75 characters or highlights exceed 125 joined by comma-space. Repetition: 5; deduct 2.5 once for a word repeated more than twice in the title or redundant selling points across title/highlights or between highlights. Cite both original fragments. Capitalization: 4; deduct 2–4 for all-caps terms or unsuitable title case. Content compliance: 3. A prohibited medical, absolute or promotional claim, competitor brand, contact information, external link, emoji or decorative symbol zeros the entire 25-point criterion only. Do not stack further title deductions.

### 3. Variations (20)
Evaluate the whole parent family. Correct values: 8, minus 2 per incorrect value. Consistent formatting: 8, halve once for inconsistent language, case, units or granularity (e.g. Black / Matte Black Edition). Unique physical items: 4, minus 2 per duplicate group. Mark N/A only when a single SKU is verified and the category does not support variations. A missing matrix is unavailable: "No variation matrix was provided."

### 4. Images (15)
Main-image compliance: 6 for a white RGB(255,255,255) background, no text/watermark/border and product occupancy at least 85%. Included components are allowed. Zoom: 3 for original longest edge at least 1000 px (1600 recommended). Secondary count: 3*min(N,6)/6. Count secondary images only; five earn 2.5 and lose 0.5. Coverage: 0.75 each for use scene, detail, dimensions and package contents. Six similar studio shots can earn full count with no coverage. Unknown count is unavailable. Do not double-count resolution under compliance. Keep A+ images separate.

Start each deduction with the checkpoint, and identify the missing coverage type. State the verified count and coverage types in the description. For example, with seven secondary images and all four types covered, losses of 3 for zoom and 3 for main-image compliance give 15 - 3 - 3 = 9.

### 5. A+ content (5)
At least three modules earn 2, a comparison table earns 1.5 and an actual use scene earns 1.5. An image count does not establish module count. Use N/A only for verified lack of brand access; a missing public A+ section alone is insufficient.

### 6. Bullet count (5)
At least three bullets earn 5, one or two earn 2.5, confirmed zero earns 0. Assess content in Alexa only. Separate unknown from confirmed absence. Do not score Search Terms, Leaf Node, price, reviews, sales or ranking as CDQ attributes.

Use Official for all six CDQ sources. Preserve criterion-specific source labels in the other dimensions. When summarizing prioritize weight times gap and recommend evidence collection for unavailable items. Neither CDQ weights nor the internal grades are an official Amazon algorithm.

## Loaded references/title-highlights.md

For generation, rewriting, optimization and scoring, treat the short title and Item Highlights as complementary. Preserve brand and product identity, plus the strongest supported distinguishing facts in the title. Count spaces and punctuation; approach 75 characters naturally only when enough facts exist. "White Ceramic Mug" is complete if that is the entire source. Do not add an ergonomic handle or fill space with Classic, Premium or Elegant.

Use highlights for new facts, buyer decisions or supported audiences and scenarios. Join with comma-space and stay within 125 characters. Reserve room for a useful scenario where supported. Prefer fewer distinct highlights to padding. Never duplicate the title's capacity, fit, material or other selling point with synonyms or adjectives. "Regular fit" and "comfortable regular fit" are the same fact. Use evidence from this category: cotton does not establish a jersey weave or machine washability, ceramic does not establish microwave safety, and a known color does not establish a solid pattern. Do not infer gender, care instructions, certification or performance from old search terms or model output. Reference products and variant examples do not establish this SKU's specifications.

In custom mode retain brand, Custom and configuration requirements. Apply the same title/highlight allocation to rendered variantCopyTemplate fields. longTitle may repeat configurations but is always excluded from scoring. When optimizing, recheck duplication even if the previous rating was full. Assess actual short title and actual highlights, quote both occurrences of a duplicated fact, recommend where to keep it, and deduct under title.repeat only. Missing highlights are not evidence of a fault. Keyword placement and Alexa use/audience assessments retain their own checkpoints.
