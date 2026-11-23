import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from "class-validator"
import { LISTING_AI_MODELS } from "../listing-ai.models"
import { MAX_LISTING_DOCUMENT_BYTES } from "../listing-document.constants"
import { AUTOMOTIVE_MARKETS } from "./automotive.types"

export class MatchCategoryDto {
  @ApiPropertyOptional({ description: "请求UUID；网络重试复用" })
  @IsOptional()
  @IsUUID()
  runId?: string
  @ApiProperty({ enum: AUTOMOTIVE_MARKETS }) @IsIn(AUTOMOTIVE_MARKETS) market!: string
  @ApiPropertyOptional({ description: "用户完整文字描述", example: "A-Premium 前陶瓷刹车片" })
  @IsOptional()
  @IsString()
  keyword?: string
  @ApiPropertyOptional({ description: "已提取商品的标题，不包含描述和参数" })
  @IsOptional()
  @IsString()
  productTitle?: string
  @ApiPropertyOptional({ description: "文档URL，由后端下载解析" })
  @IsOptional()
  @IsUrl({ protocols: ["https", "http"], require_protocol: true })
  documentUrl?: string
  @ApiPropertyOptional({ enum: LISTING_AI_MODELS })
  @IsOptional()
  @IsIn(LISTING_AI_MODELS)
  model?: string
}
export class AutomotiveProductDto {
  @ApiProperty({ description: "原商品URL，仅溯源" })
  @IsUrl({ protocols: ["http", "https"], require_protocol: true })
  url!: string
  @ApiPropertyOptional() @IsOptional() @IsString() platform?: string
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string
  @ApiProperty({ description: "提取商品接口的完整data，保留嵌套参数" }) @IsObject() data!: Record<
    string,
    unknown
  >
  @ApiPropertyOptional() @IsOptional() @IsString() fetchedAt?: string
}
export class AutomotiveCategoryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string
  @ApiProperty({ enum: ["MODEL", "USER", "NONE"] }) @IsIn(["MODEL", "USER", "NONE"]) source!: string
  @ApiPropertyOptional() @IsOptional() @IsBoolean() userSelectedAutomotive?: boolean
}
export class AutomotiveDocumentDto {
  @ApiPropertyOptional() @IsOptional() @IsString() content?: string
  @ApiPropertyOptional() @IsOptional() @IsString() fileName?: string
  @ApiPropertyOptional() @IsOptional() @IsString() objectKey?: string
  @ApiPropertyOptional() @IsOptional() @IsString() mimeType?: string
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_LISTING_DOCUMENT_BYTES)
  fileSize?: number
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ protocols: ["http", "https"], require_protocol: true })
  url?: string
}
export class PrepareAutomotiveDto {
  @ApiProperty() @IsUUID() runId!: string
  @ApiPropertyOptional({ enum: AUTOMOTIVE_MARKETS })
  @IsOptional()
  @IsIn(AUTOMOTIVE_MARKETS)
  market?: string
  @ApiPropertyOptional({ enum: LISTING_AI_MODELS })
  @IsOptional()
  @IsIn(LISTING_AI_MODELS)
  model?: string
  @ApiPropertyOptional() @IsOptional() @IsString() text?: string
  @ApiPropertyOptional({ type: AutomotiveCategoryDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AutomotiveCategoryDto)
  category?: AutomotiveCategoryDto
  @ApiPropertyOptional({ type: AutomotiveProductDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AutomotiveProductDto)
  productDetail?: AutomotiveProductDto
  @ApiPropertyOptional({ type: AutomotiveDocumentDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AutomotiveDocumentDto)
  document?: AutomotiveDocumentDto
  @ApiPropertyOptional() @IsOptional() @IsBoolean() discardProductSource?: boolean
}
class FitmentDto {
  @ApiProperty() @IsString() @IsNotEmpty() make!: string
  @ApiProperty() @IsString() @IsNotEmpty() model!: string
  @ApiProperty({ type: [Number] })
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1000, { each: true })
  @Max(9999, { each: true })
  years!: number[]
  @ApiPropertyOptional() @IsOptional() @IsString() details?: string
}
class SellingPointDto {
  @ApiProperty() @IsString() title!: string
  @ApiProperty() @IsString() detail!: string
}
class ElectricalDto {
  @ApiPropertyOptional() @IsOptional() @IsString() voltage?: string
  @ApiPropertyOptional() @IsOptional() @IsString() wattage?: string
  @ApiPropertyOptional() @IsOptional() @IsString() amperage?: string
}
class PackageItemDto {
  @ApiProperty() @IsString() @IsNotEmpty() name!: string
  @ApiProperty() @IsInt() @Min(1) quantity!: number
}
export class AutomotiveDataDto {
  @ApiProperty() @IsString() @IsNotEmpty() brand!: string
  @ApiProperty() @IsString() @IsNotEmpty() product!: string
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  searchKeywords?: string[]
  @ApiProperty({ type: [FitmentDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => FitmentDto)
  fitments!: FitmentDto[]
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  oeNumbers!: string[]
  @ApiPropertyOptional({ type: [SellingPointDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SellingPointDto)
  sellingPoints?: SellingPointDto[]
  @ApiPropertyOptional() @IsOptional() @IsString() position?: string
  @ApiPropertyOptional() @IsOptional() @IsString() materialFinish?: string
  @ApiPropertyOptional({ type: ElectricalDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ElectricalDto)
  electrical?: ElectricalDto
  @ApiProperty({ type: [PackageItemDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => PackageItemDto)
  packageContents!: PackageItemDto[]
  @ApiPropertyOptional({ enum: ["FIT_FOR", "COMPATIBLE_WITH"] })
  @IsOptional()
  @IsIn(["FIT_FOR", "COMPATIBLE_WITH"])
  fitmentPhrase?: "FIT_FOR" | "COMPATIBLE_WITH"
}
export class GenerateAutomotiveDto {
  @ApiProperty() @IsUUID() runId!: string
  @ApiProperty() @IsUUID() attemptId!: string
  @ApiProperty({ enum: ["AUTOMOTIVE"] }) @IsIn(["AUTOMOTIVE"]) workflowChoice!: string
  @ApiProperty({ type: AutomotiveDataDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => AutomotiveDataDto)
  automotiveData!: AutomotiveDataDto
  @ApiPropertyOptional({
    type: [String],
    description: "本次临时敏感词，仅用于生成避用及规则提示，不写入词库",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sensitiveWords?: string[]
}
