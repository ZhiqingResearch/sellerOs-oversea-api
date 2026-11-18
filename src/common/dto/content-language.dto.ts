import { ApiPropertyOptional } from "@nestjs/swagger"
import { IsOptional, IsString, MaxLength } from "class-validator"

export class ContentLanguageDto {
  @ApiPropertyOptional({
    example: "amazon_de",
    description: "商品目标商城，控制新生成的画面文字/字幕/旁白语言",
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  market?: string

  @ApiPropertyOptional({
    example: "de-DE",
    description: "显式内容语言（BCP-47），优先于 market；不改变界面语言",
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  contentLanguage?: string
}
