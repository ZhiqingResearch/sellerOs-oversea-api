import { ValidationPipe } from "@nestjs/common"
import { QueryMembersDto } from "./console.dto"

describe("QueryMembersDto", () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true })
  const metadata = { type: "query" as const, metatype: QueryMembersDto }

  it("接受合法筛选参数，沿用全局配置剥离额外字段", async () => {
    const query = {
      keyword: "张明",
      role: "ADMIN",
      status: "DISABLED",
      quotaStatus: "NEAR_LIMIT",
      usageStatus: "USED",
    }
    expect(await pipe.transform({ ...query, extra: "ignored" }, metadata)).toEqual(query)
    expect(await pipe.transform({}, metadata)).toEqual({})
  })

  it.each([
    { role: "OWNER" },
    { status: "ARCHIVED" },
    { quotaStatus: "INVALID" },
    { usageStatus: "INVALID" },
    { role: "" },
    { keyword: ["张", "李"] },
    { status: ["ACTIVE", "DISABLED"] },
  ])("拒绝非法参数 %j", async query => {
    await expect(pipe.transform(query, metadata)).rejects.toThrow("Bad Request Exception")
  })
})
