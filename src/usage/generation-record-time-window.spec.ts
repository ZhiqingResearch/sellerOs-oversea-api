import { recentGenerationQuery } from "./generation-record-time-window"

const now = new Date("2026-11-03T12:00:00.000Z")

describe("用户生成记录历史范围", () => {
  it("默认覆盖全部历史，保留其他筛选且不修改入参", () => {
    const query = { function: "IMAGE", dateFrom: undefined }
    expect(recentGenerationQuery(query, now)).toEqual({
      function: "IMAGE",
      dateFrom: "1970-01-01T00:00:00.000Z",
      dateTo: now.toISOString(),
    })
    expect(query).toEqual({ function: "IMAGE", dateFrom: undefined })
  })

  it("保留显式历史起点，未来结束时间裁到当前时刻", () => {
    expect(recentGenerationQuery({ dateFrom: "2020-01-01", dateTo: "2030-01-01" }, now)).toEqual({
      dateFrom: "2020-01-01T00:00:00.000Z",
      dateTo: now.toISOString(),
    })
  })

  it("保留窗口内更窄的筛选，纯日期结束仍包含当日", () => {
    expect(
      recentGenerationQuery({ dateFrom: "2026-11-01T08:00:00+08:00", dateTo: "2026-11-02" }, now)
    ).toEqual({ dateFrom: "2026-11-01T00:00:00.000Z", dateTo: "2026-11-02T23:59:59.999Z" })
  })

  it("14 天以前的区间按原范围查询", () => {
    const range = recentGenerationQuery({ dateFrom: "2026-09-01", dateTo: "2026-09-02" }, now)
    expect(range).toEqual({
      dateFrom: "2026-09-01T00:00:00.000Z",
      dateTo: "2026-09-02T23:59:59.999Z",
    })
  })
})
