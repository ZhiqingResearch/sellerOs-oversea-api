import {
  BadRequestException,
  Body,
  Controller,
  INestApplication,
  Post,
  ValidationPipe,
} from "@nestjs/common"
import { NestExpressApplication } from "@nestjs/platform-express"
import { Test } from "@nestjs/testing"
import { IsIn, IsOptional, IsString } from "class-validator"
import type { Request } from "express"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Logger } from "winston"
import { AllExceptionsFilter } from "../filters/http-exception.filter"
import {
  localizeErrorMessage,
  negotiateUiLanguage,
  requestLanguageMiddleware,
  requestUiLanguage,
  uiLanguage,
  uiText,
  withUiLanguage,
} from "./request-language"

class LanguageDto {
  @IsOptional()
  @IsIn(["zh-CN", "en-US"])
  responseLanguage?: string

  @IsString({ message: "不能为空" })
  value!: string
}

@Controller("asin-audit")
class LanguageController {
  @Post("probe")
  async probe(@Body() dto: LanguageDto) {
    await new Promise(resolve => setImmediate(resolve))
    if (dto.value === "fail") throw new BadRequestException("积分余额不足，本次需 5 积分")
    return { language: uiLanguage(), message: uiText("完成", "Done") }
  }
}

describe("request language", () => {
  it.each([
    [undefined, "zh-CN"],
    ["", "zh-CN"],
    ["en", "en-US"],
    ["en-GB", "en-US"],
    ["zh-TW", "zh-CN"],
    ["de-DE", "en-US"],
    ["en;q=0.2,zh-CN;q=0.9", "zh-CN"],
    ["zh;q=0,en;q=0.5", "en-US"],
    ["en;q=bad,zh;q=0.4", "zh-CN"],
  ])("negotiates %s as %s", (header, expected) => {
    expect(negotiateUiLanguage(header)).toBe(expected)
  })

  it("accepts explicit ASIN language only, without treating market or arbitrary DTO fields as UI language", () => {
    const request = {
      url: "/api/asin-audit/score",
      headers: { "accept-language": "en-US" },
      body: { responseLanguage: "zh-CN", market: "amazon_de" },
    } as Request
    expect(requestUiLanguage(request)).toBe("zh-CN")
    expect(requestUiLanguage({ ...request, url: "/api/video-analysis" })).toBe("en-US")
    expect(requestUiLanguage({ ...request, body: { responseLanguage: "invalid" } })).toBe("en-US")
  })

  it("keeps concurrent asynchronous contexts isolated", async () => {
    const languages = await Promise.all(
      ["en-US", "zh-CN"].map(language =>
        withUiLanguage(language as "en-US" | "zh-CN", async () => {
          await new Promise(resolve => setImmediate(resolve))
          return uiText("完成", "Done")
        })
      )
    )
    expect(languages).toEqual(["Done", "完成"])
    expect(uiLanguage()).toBe("zh-CN")
  })

  it("localizes known errors and safely handles untranslated upstream errors", () => {
    expect(localizeErrorMessage("积分余额不足", 400, "en-US")).toBe("Insufficient credits")
    expect(localizeErrorMessage("上游返回了中文", 502, "en-US")).not.toMatch(/\p{Script=Han}/u)
    expect(localizeErrorMessage("请重试", 400, "zh-CN")).toBe("请重试")
    expect(localizeErrorMessage("Invalid request", 400, "en-US")).toBe("Invalid request")
  })
})

describe("language middleware with Nest validation and exception filters", () => {
  let app: INestApplication
  let base: string

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [LanguageController] }).compile()
    const nestApp = module.createNestApplication<NestExpressApplication>({ logger: false })
    nestApp.useBodyParser("json")
    nestApp.use(requestLanguageMiddleware)
    nestApp.setGlobalPrefix("api")
    nestApp.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    nestApp.useGlobalFilters(
      new AllExceptionsFilter({ warn: jest.fn(), error: jest.fn() } as unknown as Logger)
    )
    await nestApp.listen(0, "127.0.0.1")
    app = nestApp
    const server: Server = nestApp.getHttpServer()
    const address = server.address() as AddressInfo
    base = `http://127.0.0.1:${address.port}/api/asin-audit/probe`
  })

  afterAll(async () => {
    await app?.close()
  })

  const post = (body: object, language = "en-US") =>
    fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": language },
      body: JSON.stringify(body),
    })

  it("uses the ASIN body override for async handlers and errors", async () => {
    const results = await Promise.all([
      post({ value: "ok" }),
      post({ value: "ok", responseLanguage: "zh-CN" }),
    ])
    expect(await results[0].json()).toEqual({ language: "en-US", message: "Done" })
    expect(await results[1].json()).toEqual({ language: "zh-CN", message: "完成" })
    const error = await post({ value: "fail", responseLanguage: "en-US" }, "zh-CN")
    expect(error.status).toBe(400)
    expect(await error.json()).toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("Insufficient credits") as unknown,
    })
  })

  it("localizes validation arrays and malformed JSON before middleware runs", async () => {
    const invalid = await post({ responseLanguage: "en-US" })
    expect(await invalid.json()).toMatchObject({ message: ["This field is required"] })
    const malformed = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": "en-US" },
      body: '{"value":"中文"',
    })
    expect(malformed.status).toBe(400)
    expect(JSON.stringify(await malformed.json())).not.toMatch(/\p{Script=Han}/u)
  })
})
