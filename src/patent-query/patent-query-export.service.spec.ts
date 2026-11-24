import { PatentQueryExportService } from "./patent-query-export.service"
import { hydrateOutput, hydrateResults } from "./patent-query.storage"

const queued = {
  id: "test-job",
  taskId: 3,
  attempt: 0,
  status: "QUEUED",
  errorCode: null,
  reportVersion: "pdf1-r1",
  filename: "保温杯.pdf",
  task: { userId: 7, status: "PARTIAL", reportRevision: 1, deletedAt: null },
}
function setup() {
  const jobs = {
    findFirst: jest.fn().mockResolvedValue(queued),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  }
  const oss = {
    hasPrivatePdf: jest.fn().mockResolvedValue(false),
    putPrivatePdf: jest.fn(),
    signPrivatePdf: jest.fn(),
  }
  const pdf = { export: jest.fn().mockResolvedValue(Buffer.from("PDF")) }
  const service = new PatentQueryExportService(
    { patentQueryExport: jobs } as never,
    pdf as never,
    oss as never
  )
  return { jobs, service, oss, pdf }
}
describe("异步专利 PDF 导出", () => {
  it("CAS 未认领成功时不执行渲染或上传", async () => {
    const s = setup()
    s.jobs.updateMany.mockResolvedValueOnce({ count: 0 })
    await s.service.tick()
    expect(s.pdf.export).not.toHaveBeenCalled()
    expect(s.oss.putPrivatePdf).not.toHaveBeenCalled()
  })
  it("恢复已上传但未发布的同版本文件，不再渲染", async () => {
    const s = setup()
    s.oss.hasPrivatePdf.mockResolvedValue(true)
    await s.service.tick()
    expect(s.pdf.export).not.toHaveBeenCalled()
    expect(s.jobs.updateMany).toHaveBeenLastCalledWith({
      where: { id: queued.id, attempt: 1, status: "PROCESSING" },
      data: { status: "READY" },
    })
  })
  it("OSS 写入失败不发布 READY", async () => {
    const s = setup()
    s.oss.putPrivatePdf.mockRejectedValue(new Error("failed"))
    await s.service.tick()
    expect(s.jobs.updateMany).toHaveBeenLastCalledWith({
      where: { id: queued.id, attempt: 1, status: "PROCESSING" },
      data: { status: "FAILED", errorCode: "EXPORT_STORAGE_UNAVAILABLE" },
    })
  })
  it("过期版本返回 409 且不签名；任务和用户均参与可见性检查", async () => {
    const s = setup()
    s.jobs.findFirst.mockResolvedValue({
      ...queued,
      status: "READY",
      task: { ...queued.task, reportRevision: 2 },
    })
    await expect(s.service.download(7, 3, queued.id)).rejects.toMatchObject({
      status: 409,
      code: "EXPORT_OUTDATED",
    })
    expect(s.jobs.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: queued.id, taskId: 3, task: { userId: 7, deletedAt: null } },
      })
    )
    expect(s.oss.signPrivatePdf).not.toHaveBeenCalled()
  })
  it("分项顺序断档、少词或少来源判为数据不完整，真实零命中可导出", async () => {
    const data = { text: {}, savedWordMarkCounts: [1] }
    const row = { id: 1, position: 0, imageId: null, data: { term: "cup" }, marks: [] }
    expect(() => hydrateOutput(data, [row], true)).toThrow("incomplete")
    expect(() => hydrateOutput({ text: {} }, [{ ...row, position: 1 }], true)).toThrow("incomplete")
    expect(() => hydrateOutput(data, [], true)).toThrow("incomplete")
    expect(() => hydrateOutput({ text: {}, savedWordMarkCounts: [] }, [], true)).not.toThrow()
    const db = {
      patentQueryTextMark: {
        findMany: jest.fn().mockResolvedValue([{ resultId: 1, position: 1, data: {} }]),
      },
    }
    await expect(hydrateResults(db as never, [row], true)).rejects.toMatchObject({
      code: "REPORT_DATA_INCOMPLETE",
    })
  })
})
