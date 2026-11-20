import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator"
import {
  COMPETITOR_ANALYSIS_MODELS,
  type CompetitorAnalysisModel,
} from "../competitor-analysis.models"

const SUPPORTED_COUNTRIES = [
  "US",
  "UK",
  "DE",
  "CA",
  "JP",
  "FR",
  "ES",
  "IT",
  "MX",
  "AU",
  "AE",
  "BR",
  "SA",
] as const

export class AnalyzeCompetitorsDto {
  @ApiPropertyOptional({ description: "本次竞品分析业务操作 ID，用于聚合积分明细" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  runId?: string

  @ApiProperty({ example: ["B0D1234567", "B0D7654321"], maxItems: 3 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique()
  @Matches(/^[A-Z0-9]{10}$/, { each: true, message: "每个 ASIN 必须是 10 位大写字母或数字" })
  asins!: string[]

  @ApiProperty({ example: "US", enum: SUPPORTED_COUNTRIES })
  @IsIn(SUPPORTED_COUNTRIES)
  country!: string

  @ApiPropertyOptional({
    description: "新任务统一使用 Gemini 3.8 Flash，保留旧模型参数兼容已有客户端",
    enum: COMPETITOR_ANALYSIS_MODELS,
    example: "ZQ-Multimodal-Gemini-3.8-Flash",
  })
  @IsOptional()
  @IsIn(COMPETITOR_ANALYSIS_MODELS)
  model?: CompetitorAnalysisModel
}
