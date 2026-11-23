import { ApiProperty } from "@nestjs/swagger"
import { Transform, Type } from "class-transformer"
import {
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsNumber,
  IsObject,
  Matches,
  Min,
  ValidateNested,
} from "class-validator"

export class ComputerConfigurationDto {
  @ApiProperty({ example: 32, description: "当前实配内存容量，GB" })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.000001)
  ramGb: number

  @ApiProperty({ example: 1024, description: "当前内置存储容量，GB；1TB=1024GB" })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.000001)
  storageGb: number
}

export class ComputerReferenceDto {
  @ApiProperty({
    type: [ComputerConfigurationDto],
    description: "合法配置组合；内存与硬盘不得跨组合拼接",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ComputerConfigurationDto)
  configurations: ComputerConfigurationDto[]
}

export class CreateComputerAuditDto {
  @ApiProperty({ example: "B0BZJWSLDW" })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value
  )
  @Matches(/^[A-Z0-9]{10}$/, { message: "ASIN必须为10位字母或数字" })
  asin: string

  @ApiProperty({ type: ComputerReferenceDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ComputerReferenceDto)
  referenceData: ComputerReferenceDto
}
