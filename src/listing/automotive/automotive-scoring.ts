import { readFileSync } from "node:fs"
import { join } from "node:path"
import { withOutputLanguage } from "../../common/i18n/ai-language"
import type { ListingAiInvocationDto } from "../dto/listing-ai.dto"
import { DEFAULT_LISTING_AI_MODEL } from "../listing-ai.models"
import type { finalizeAutomotive } from "./automotive.rules"
import type { AutomotiveData, AutomotiveMarket } from "./automotive.types"

// 与原前端Amazon standard评分使用同一套内容，随后端构建打包，不依赖前端目录。
const SCORE_PROMPT = readFileSync(join(__dirname, "../prompts/amazon-score-standard.md"), "utf8")

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
    systemPrompt: withOutputLanguage(
      `${SCORE_PROMPT}\n评分报告、原因和建议使用中文，引用商品原文保持原站点语言。按既有四维和分值评分，不新增汽配评分项。`
    ),
    userPrompt: `mode: standard\n目标市场：${market}\n本次评分对象为已生成的汽配Listing，按原Amazon标准评分规则评估。下面的确认资料仅用于核对事实，不是待评正文，不得替代正文缺失内容。不访问URL，不重新抓取商品或查询关键词。\n<confirmed-automotive-facts>${factsJson}</confirmed-automotive-facts>\n标题实测字符数（含空格）：${Array.from(result.title).length}；Item Highlights以逗号空格拼接实测字符数：${Array.from(source.itemHighlights).length}。\n临时敏感词：${JSON.stringify(sensitiveWords)}\n未提供本次图片、A+、父体变体矩阵及关键词取证数据，按原规则标明未获取，不编造、不将未知当作确认缺失或不适用。已有结构化属性仍按原规则核验，不能虚构完整后台必填清单。\n以下为独立字段的原文事实，字段之间不得相互替代。\n<listing-scoring-source>${sourceJson}</listing-scoring-source>`,
  }
}
