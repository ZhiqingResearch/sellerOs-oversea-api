import { ApiProperty, OmitType } from "@nestjs/swagger"
import { IsInt, IsUUID, Min } from "class-validator"
import { CreateListingGenerationDto } from "./listing-generation.dto"

export class CreateListingOptimizationDto extends OmitType(CreateListingGenerationDto, [
  "runId",
  "generationBillingId",
  "longTitle",
] as const) {
  @ApiProperty({ description: "读取原记录时的版本，防止使用过期建议" })
  @IsInt()
  @Min(1)
  expectedVersion!: number
}

export class RetryListingOptimizationScoreDto {
  @ApiProperty({ description: "本次评分重试幂等 UUID" })
  @IsUUID()
  retryRequestId!: string
}
