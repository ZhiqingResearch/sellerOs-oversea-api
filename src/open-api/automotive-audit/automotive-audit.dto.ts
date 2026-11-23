import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Transform, Type } from "class-transformer"
import {
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator"

export class AuditDimensionsDto {
  @ApiProperty({ example: 20 })
  @IsNumber({ allowInfinity: false, allowNaN: false }, { message: "$property 必须为有限数字" })
  @Min(0.000001, { message: "$property 必须大于等于0.000001" })
  length: number

  @ApiProperty({ example: 12 })
  @IsNumber({ allowInfinity: false, allowNaN: false }, { message: "$property 必须为有限数字" })
  @Min(0.000001, { message: "$property 必须大于等于0.000001" })
  width: number

  @ApiProperty({ example: 10 })
  @IsNumber({ allowInfinity: false, allowNaN: false }, { message: "$property 必须为有限数字" })
  @Min(0.000001, { message: "$property 必须大于等于0.000001" })
  height: number

  @ApiProperty({ enum: ["CM", "INCH"] })
  @IsIn(["CM", "INCH"], { message: "尺寸单位必须为CM或INCH" })
  unit: "CM" | "INCH"
}

export class AuditWeightDto {
  @ApiProperty({ example: 0.8 })
  @IsNumber({ allowInfinity: false, allowNaN: false }, { message: "$property 必须为有限数字" })
  @Min(0.00000001, { message: "$property 必须大于等于0.00000001" })
  value: number

  @ApiProperty({ enum: ["KG", "LB"] })
  @IsIn(["KG", "LB"], { message: "重量单位必须为KG或LB" })
  unit: "KG" | "LB"
}

export class AutomotiveReferenceDto {
  @ApiPropertyOptional({ description: "产品名称、OE、适配与卖点的综合原文" })
  @IsOptional()
  @IsString({ message: "$property 必须为字符串" })
  productInfo?: string | null

  @ApiPropertyOptional({ type: [String], example: ["25600-2M052"] })
  @IsOptional()
  @IsArray({ message: "$property 必须为数组" })
  @IsString({ each: true, message: "$property 每一项必须为字符串" })
  @IsNotEmpty({ each: true, message: "$property 每一项不能为空" })
  mainOeNumbers?: string[] | null

  @ApiPropertyOptional({ type: [String], description: "全部OE及原始写法" })
  @IsOptional()
  @IsArray({ message: "$property 必须为数组" })
  @IsString({ each: true, message: "$property 每一项必须为字符串" })
  @IsNotEmpty({ each: true, message: "$property 每一项不能为空" })
  oeNumbers?: string[] | null

  @ApiPropertyOptional({ example: "2020-2022 Hyundai Accent 1.6L" })
  @IsOptional()
  @IsString({ message: "$property 必须为字符串" })
  fitmentText?: string | null

  @ApiPropertyOptional({ example: "Plastic" })
  @IsOptional()
  @IsString({ message: "$property 必须为字符串" })
  material?: string | null

  @ApiPropertyOptional({ example: "Front" })
  @IsOptional()
  @IsString({ message: "$property 必须为字符串" })
  installationPosition?: string | null

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt({ message: "$property 必须为整数" })
  @Min(1, { message: "$property 必须大于等于1" })
  packageQuantity?: number | null

  @ApiPropertyOptional({ type: AuditDimensionsDto })
  @IsOptional()
  @IsObject({ message: "$property 必须为对象" })
  @ValidateNested({ message: "$property 嵌套字段不符合要求" })
  @Type(() => AuditDimensionsDto)
  dimensions?: AuditDimensionsDto | null

  @ApiPropertyOptional({ type: AuditWeightDto })
  @IsOptional()
  @IsObject({ message: "$property 必须为对象" })
  @ValidateNested({ message: "$property 嵌套字段不符合要求" })
  @Type(() => AuditWeightDto)
  weight?: AuditWeightDto | null

  @ApiPropertyOptional({ type: [String], description: "可选模型上下文，无独立计分项" })
  @IsOptional()
  @IsArray({ message: "$property 必须为数组" })
  @IsString({ each: true, message: "$property 每一项必须为字符串" })
  coreKeywords?: string[] | null
}

export class AuditListingSupplementDto {
  @ApiPropertyOptional({ description: "真实后台ST；null/省略=未知，空字符串=确认为空" })
  @IsOptional()
  @IsString({ message: "$property 必须为字符串" })
  searchTerms?: string | null
}

export class CreateAutomotiveAuditDto {
  @ApiProperty({ example: "B0H6K3K54T" })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value
  )
  @Matches(/^[A-Z0-9]{10}$/, { message: "ASIN必须为10位字母或数字" })
  asin: string

  @ApiProperty({ example: "JWQ-01-1" })
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString({ message: "$property 必须为字符串" })
  @IsNotEmpty({ message: "$property 不能为空" })
  @MaxLength(191, { message: "SKU不能超过191个字符" })
  sku: string

  @ApiProperty({ type: AutomotiveReferenceDto })
  @IsDefined({ message: "$property 必须提供" })
  @IsObject({ message: "$property 必须为对象" })
  @ValidateNested({ message: "$property 嵌套字段不符合要求" })
  @Type(() => AutomotiveReferenceDto)
  referenceData: AutomotiveReferenceDto

  @ApiPropertyOptional({ type: AuditListingSupplementDto })
  @IsOptional()
  @IsObject({ message: "$property 必须为对象" })
  @ValidateNested({ message: "$property 嵌套字段不符合要求" })
  @Type(() => AuditListingSupplementDto)
  listingSupplement?: AuditListingSupplementDto | null
}
