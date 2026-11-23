import { ImageTemplateService } from "./image-template.service"

describe("ImageTemplateService 关键词标签搜索", () => {
  const prisma = {
    $queryRaw: jest.fn(),
    imageTemplate: { count: jest.fn(), findMany: jest.fn() },
  }
  const service = new ImageTemplateService(prisma as never)

  beforeEach(() => {
    jest.resetAllMocks()
    prisma.$queryRaw.mockResolvedValue([{ id: 8 }])
    prisma.imageTemplate.count.mockResolvedValue(1)
    prisma.imageTemplate.findMany.mockResolvedValue([{ id: 8 }])
  })

  it.each([
    ["服装", "%服装%"],
    ["50%_!", "%50!%!_!!%"],
    ["' OR 1=1 --", "%' OR 1=1 --%"],
  ])("将关键词 %s 作为参数绑定，并转义标签搜索通配符", async (keyword, pattern) => {
    await service.findAll({ keyword }, 55)

    const [strings, ...values] = prisma.$queryRaw.mock.calls[0]
    expect(values).toEqual([55, pattern])
    expect(strings.join("?")).toContain("deletedAt IS NULL")
    expect(strings.join("?")).toContain("isSystem = true OR userId = ?")
    expect(strings.join("?")).toContain("JSON_SEARCH(tags, 'one', ?, '!', '$[*]')")
  })

  it("标签命中与名称、分组取并集，并保留本人范围、独立标签筛选和分页", async () => {
    const result = await service.findAll(
      { keyword: "服装", tab: "mine", groupId: 3, tag: "Amazon", page: 2, pageSize: 5 },
      55
    )

    const { where } = prisma.imageTemplate.count.mock.calls[0][0]
    expect(where.AND).toEqual([
      { isSystem: false, userId: 55 },
      { groupId: 3 },
      { tags: { array_contains: "Amazon" } },
      {
        OR: [
          { name: { contains: "服装" } },
          { note: { contains: "服装" } },
          { items: { some: { prompt: { contains: "服装" } } } },
          { group: { name: { contains: "服装" } } },
          { id: { in: [8] } },
        ],
      },
    ])
    expect(prisma.imageTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where, skip: 5, take: 5, orderBy: { updatedAt: "desc" } })
    )
    expect(result).toMatchObject({ total: 1, page: 2, pageSize: 5, items: [{ id: 8 }] })
  })

  it("未输入关键词时不执行额外的标签查询", async () => {
    await service.findAll({}, 55)
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
  })
})
