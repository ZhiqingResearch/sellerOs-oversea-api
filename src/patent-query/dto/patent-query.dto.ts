import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

export class PatentImageDto {
  @ApiProperty({ example: "img-1" }) @Matches(/^[A-Za-z0-9_-]{1,64}$/) id: string
  @ApiProperty({ example: "patent-query/123/product.jpg" }) @IsString() @MaxLength(1024) key: string
  @ApiProperty({ example: "保温杯.jpg" }) @IsString() @MaxLength(255) name: string
}
export class ListingImageDto {
  @ApiProperty({ example: "listing-abc123" }) @Matches(/^[A-Za-z0-9_-]{1,64}$/) id: string
  @ApiProperty({ example: "https://m.media-amazon.com/images/I/example.jpg" })
  @IsString()
  @MaxLength(2048)
  url: string
  @ApiProperty({ example: "商品主图" }) @IsString() @MaxLength(255) name: string
}
export class DesignOptionsDto {
  @ApiPropertyOptional({ example: "保温杯" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  productName?: string
  @ApiPropertyOptional({ example: ["07-01"] })
  @IsOptional()
  @IsArray()
  @Matches(/^\d{2}-\d{2}$/, { each: true })
  locs?: string[]
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() removeBg?: boolean
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() rerank?: boolean
}
export class GraphicOptionsDto {
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() removeBg?: boolean
}
export class ListingTextDto {
  @ApiPropertyOptional({ example: "FrostCup" }) @IsOptional() @IsString() brand?: string
  @ApiPropertyOptional({ example: "Insulated Tumbler" }) @IsOptional() @IsString() title?: string
  @ApiPropertyOptional({ description: "五点描述，整段文本" })
  @IsOptional()
  @IsString()
  bullets?: string
  @ApiPropertyOptional({ description: "商品描述" }) @IsOptional() @IsString() description?: string
}
export class TextOptionsDto extends ListingTextDto {
  @ApiPropertyOptional({ type: [ListingImageDto], description: "仅参与文字商标 OCR 的商品图" })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ListingImageDto)
  images?: ListingImageDto[]
  @ApiPropertyOptional({
    type: [String],
    example: ["021", "032"],
    description: "用户选定的尼斯类别，1–45，可多选",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(45)
  @IsString({ each: true })
  classCodes?: string[]
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() includeImageText?: boolean
}
export class QuotePatentQueryDto {
  @ApiPropertyOptional({ type: [PatentImageDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => PatentImageDto)
  images?: PatentImageDto[]
  @ApiProperty({ example: ["US"], enum: ["US", "DE", "FR", "IT", "ES", "GB", "JP"], isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(["US", "DE", "FR", "IT", "ES", "GB", "JP"], { each: true })
  sites: string[]
  @ApiPropertyOptional({ type: DesignOptionsDto })
  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => DesignOptionsDto)
  design?: DesignOptionsDto
  @ApiPropertyOptional({ type: Object, example: {} })
  @IsOptional()
  @IsObject()
  copy?: Record<string, never>
  @ApiPropertyOptional({ type: GraphicOptionsDto })
  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => GraphicOptionsDto)
  gtm?: GraphicOptionsDto
  @ApiPropertyOptional({ type: TextOptionsDto })
  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => TextOptionsDto)
  tm?: TextOptionsDto
}
export class CreatePatentQueryDto extends QuotePatentQueryDto {
  @ApiProperty({ description: "每次新检测生成 UUID；重试原请求保持一致" })
  @IsUUID()
  requestId: string
}
export class QueryPatentQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ["summary"], default: "summary" })
  @IsOptional()
  @IsIn(["summary"])
  view = "summary" as const
  @ApiPropertyOptional({ enum: ["history", "active"], default: "history" })
  @IsOptional()
  @IsIn(["history", "active"])
  scope: "history" | "active" = "history"
  @ApiPropertyOptional() @IsOptional() @IsString() keyword?: string
  @ApiPropertyOptional({ example: "2026-10-23" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate?: string
  @ApiPropertyOptional({ example: "2026-10-23" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endDate?: string
}
export class DecisionDto {
  @ApiProperty({ enum: ["design", "copy", "gtm", "tm"] })
  @IsIn(["design", "copy", "gtm", "tm"])
  kind: "design" | "copy" | "gtm" | "tm"
  @ApiPropertyOptional() @IsOptional() @IsString() imageId?: string
  @ApiProperty() @IsString() targetId: string
  @ApiProperty({ enum: ["flag", "dismiss", "none"] }) @IsIn(["flag", "dismiss", "none"]) value:
    | "flag"
    | "dismiss"
    | "none"
}
export class TodoDto {
  @ApiProperty() @IsString() todoId: string
  @ApiProperty() @IsBoolean() done: boolean
}
export class RefreshImagesDto {
  @ApiProperty({ enum: ["design", "copy", "gtm", "tm"] })
  @IsIn(["design", "copy", "gtm", "tm"])
  kind: DecisionDto["kind"]
  @ApiPropertyOptional() @IsOptional() @IsString() imageId?: string
}
export class CitationDto {
  @ApiProperty({ enum: ["cited", "citedBy"] }) @IsIn(["cited", "citedBy"]) direction:
    | "cited"
    | "citedBy"
}
export class ImportListingDto {
  @ApiProperty({ example: "B012345678" }) @IsString() input: string
  @ApiPropertyOptional({ enum: ["US", "GB", "DE", "FR", "IT", "ES", "JP"], default: "US" })
  @IsOptional()
  @IsIn(["US", "GB", "DE", "FR", "IT", "ES", "JP"])
  marketplace?: string
}

export class TaskViewDto {
  @ApiPropertyOptional({ enum: ["overview"], default: "overview" })
  @IsOptional()
  @IsIn(["overview"])
  view = "overview" as const
}
export class ResponseModeDto {
  @ApiPropertyOptional({ enum: ["compact"], default: "compact" })
  @IsOptional()
  @IsIn(["compact"])
  response = "compact" as const
}
export class ResultPageDto extends PaginationDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  pageSize = 20
}
export class RiskPageDto extends ResultPageDto {
  @ApiPropertyOptional({
    enum: ["all", "high", "mid", "low", "UNKNOWN", "expired"],
    default: "all",
  })
  @IsOptional()
  @IsIn(["all", "high", "mid", "low", "UNKNOWN", "expired"])
  risk: "all" | "high" | "mid" | "low" | "UNKNOWN" | "expired" = "all"
}
export class ResultsQueryDto extends RiskPageDto {
  @ApiProperty({ enum: ["design", "copy", "gtm", "tm"] })
  @IsIn(["design", "copy", "gtm", "tm"])
  kind: DecisionDto["kind"]
  @ApiPropertyOptional() @IsOptional() @IsString() imageId?: string
  @ApiPropertyOptional({ enum: ["hide", "show"], default: "hide" })
  @IsOptional()
  @IsIn(["hide", "show"])
  fold: "hide" | "show" = "hide"
}
export class ContextQueryDto extends ResultPageDto {
  @ApiProperty({ enum: ["gaps", "ocr", "tro", "knownIp"] })
  @IsIn(["gaps", "ocr", "tro", "knownIp"])
  section: "gaps" | "ocr" | "tro" | "knownIp"
  @ApiPropertyOptional({ enum: ["design", "copy", "gtm", "tm"] })
  @IsOptional()
  @IsIn(["design", "copy", "gtm", "tm"])
  kind?: DecisionDto["kind"]
  @ApiPropertyOptional() @IsOptional() @IsString() imageId?: string
}
