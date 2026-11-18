import { BadRequestException } from "@nestjs/common"
import type { Response } from "express"
import { AnnouncementService } from "../../announcement/announcement.service"
import { classifyKeyword } from "../../category-analysis/category-analysis.math"
import { validateReportMarkdown } from "../../category-analysis/category-analysis.service"
import { taskErrorMessage } from "../../chetaidou/chetaidou-errors"
import { PromptTemplateService } from "../../image-project/prompt-template.service"
import { recalculateCdqScoreSummary } from "../../listing/listing-cdq-summary"
import { streamBusinessAi } from "../business-ai/business-ai-stream"
import { BusinessAiService } from "../business-ai/business-ai.service"
import { withOutputLanguage } from "./ai-language"
import { contentLanguagePrompt } from "./content-language"
import { localizedTaskErrors, withUiLanguage } from "./request-language"

describe("overseas backend language boundaries", () => {
  it("returns stored announcements and templates unchanged even for English requests", async () => {
    const announcements = [{ id: 1, content: "原始公告" }]
    const templates = [{ id: 2, dimension: "场景", name: "原始模板", prompt: "原始提示词" }]
    const db = {
      announcement: { findMany: jest.fn().mockResolvedValue(announcements) },
      imagePromptTemplate: {
        findMany: jest.fn().mockResolvedValue(templates),
        count: jest.fn().mockResolvedValue(1),
      },
    }
    const announcementService = new AnnouncementService(db as never)
    const templateService = new PromptTemplateService(db as never)
    const result = await withUiLanguage("en-US", async () => ({
      announcements: await announcementService.findActive(),
      templates: await templateService.findAll({ page: 1, pageSize: 10 }),
    }))
    expect(result.announcements).toBe(announcements)
    expect(result.templates.items).toBe(templates)
    expect(result.templates.items[0]).not.toHaveProperty("localized")
  })
  it("keeps the default prompt and appends one English directive without overriding marketplace copy", () => {
    expect(withOutputLanguage("original")).toBe("original")
    withUiLanguage("en-US", () => {
      const prompt = withOutputLanguage("商品资料")
      expect(prompt).toContain("APPLICATION_OUTPUT_LANGUAGE=en-US")
      expect(prompt).toContain("explicit translation target takes precedence")
      expect(withOutputLanguage(prompt)).toBe(prompt)
    })
  })

  it("uses the target marketplace independently of UI language, with explicit content language winning", () => {
    withUiLanguage("en-US", () => {
      expect(contentLanguagePrompt("brief", { market: "amazon_de" })).toContain("German (de-DE)")
      expect(
        contentLanguagePrompt("brief", { market: "amazon_de", contentLanguage: "ja-JP" })
      ).toContain("Japanese (ja-JP)")
      expect(contentLanguagePrompt("brief", {})).toBe("brief")
      expect(() => contentLanguagePrompt("brief", { contentLanguage: "not-a-language" })).toThrow(
        BadRequestException
      )
    })
  })

  it("localizes generated keyword explanations without changing numeric decisions", () => {
    const input = {
      search_volume: 2000,
      supply_demand: 2,
      yoy_pct: -2,
      top3_concentration: 65,
      acos: 0.7,
    } as Parameters<typeof classifyKeyword>[0]
    const zh = classifyKeyword(input)
    const en = withUiLanguage("en-US", () => classifyKeyword(input))
    expect(zh.verdict).toBe("可做长尾")
    expect(en.verdict).toBe("Consider long-tail keywords")
    expect(en.reason).toContain("65.0%")
    expect(en.reason).not.toMatch(/\p{Script=Han}/u)
  })

  it("requires English category-report headings for English jobs", () => {
    const markdown = [
      "Defer entry",
      ...[
        "Key Conclusions",
        "Entry Risks",
        "Market Capacity",
        "Competitive Landscape",
        "Leading Products",
        "Entry Opportunities",
      ].map(title => `## ${title}\nUnavailable`),
      "### Data Checks\nUnavailable",
    ].join("\n")
    expect(withUiLanguage("en-US", () => validateReportMarkdown(markdown, "Defer entry"))).toBe(
      true
    )
    expect(validateReportMarkdown(markdown, "Defer entry")).toBe(false)
  })

  it("changes scoring prose while preserving scores and original evidence", () => {
    const report = {
      scoreVersion: "cdq-2026-09-16",
      dimensions: [
        {
          maxScore: 40,
          criteria: [30, 25, 20, 15, 5, 5].map(maxScore => ({
            maxScore,
            score: maxScore,
            status: "VERIFIED",
            evidence: "原文引用",
          })),
        },
        { score: 25 },
        { score: 20 },
        { score: 15 },
      ],
    }
    const zh = recalculateCdqScoreSummary(report)
    const en = withUiLanguage("en-US", () => recalculateCdqScoreSummary(report))
    expect(en).toMatchObject({ total: 100, potential: "S · Ready to publish" })
    expect(en.dimensions).toEqual(zh.dimensions)
  })

  it("keeps task payloads and raw stored errors intact while exposing English error text", () => {
    const task = { errorMessage: "生成失败", input: "用户输入", result: { text: "历史内容" } }
    const publicTask = withUiLanguage("en-US", () => localizedTaskErrors(task))
    expect(publicTask.errorMessage).not.toMatch(/\p{Script=Han}/u)
    expect(publicTask.input).toBe(task.input)
    expect(publicTask.result).toBe(task.result)
    expect(task.errorMessage).toBe("生成失败")
    expect(
      withUiLanguage("en-US", () =>
        taskErrorMessage({ type: "COMPOSE", errorCode: "MODEL_OUTPUT_INVALID" })
      )
    ).toContain("Recompose")
  })

  it("localizes errors after SSE headers are sent", async () => {
    const frames: string[] = []
    const response = {
      status: jest.fn(),
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: (frame: string) => frames.push(frame),
      end: jest.fn(),
    }
    const service = {
      stream: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("积分余额不足")) }),
      }),
    }
    await withUiLanguage("en-US", () =>
      streamBusinessAi(
        response as unknown as Response,
        service as unknown as BusinessAiService,
        7,
        "launch.plan",
        { operation: "generate", userPrompt: "原始资料" }
      )
    )
    expect(frames.join("")).toContain("Insufficient credits")
    expect(frames.join("")).not.toContain("[DONE]")
    expect(response.end).toHaveBeenCalled()
  })

  it("localizes saved AI-run failures without modifying stored output", async () => {
    const run = { runId: "run", error: "生成失败", outputText: "历史原始产出" }
    const db = { businessAiRun: { findFirst: jest.fn().mockResolvedValue(run) } }
    const service = new BusinessAiService({} as never, {} as never, db as never)
    const result = await withUiLanguage("en-US", () => service.findRun(7, "run"))
    expect(result?.error).not.toMatch(/\p{Script=Han}/u)
    expect(result?.outputText).toBe(run.outputText)
    expect(run.error).toBe("生成失败")
  })
})
