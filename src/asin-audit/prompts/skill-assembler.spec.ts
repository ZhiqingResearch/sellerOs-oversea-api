import { buildAsinAuditOptimizeSkill, buildAsinAuditScoreSkill } from "./skill-assembler"

describe("buildAsinAuditScoreSkill（类目覆盖层装配）", () => {
  it("无类目：不追加类目覆盖层", () => {
    const skill = buildAsinAuditScoreSkill()
    expect(skill).not.toContain("已加载 references/category-computer.md")
    expect(skill).toContain("已加载 references/score-dimensions.md")
  })

  it("null 同样走通用细则", () => {
    expect(buildAsinAuditScoreSkill(null)).not.toContain("已加载 references/category-computer.md")
  })

  it("computer：追加电脑类目冻结清单，且位于通用细则之后", () => {
    const skill = buildAsinAuditScoreSkill("computer")
    expect(skill).toContain("已加载 references/category-computer.md")
    // 生效声明与关键冻结清单内容在位
    expect(skill).toContain("以本文为准")
    expect(skill).toContain("电脑类目冻结清单")
    expect(skill).toContain("配置—用途—价位")
    // 通用 references 仍在
    expect(skill).toContain("已加载 references/traffic-optimization.md")
    // 覆盖层排在通用细则之后
    expect(skill.indexOf("已加载 references/category-computer.md")).toBeGreaterThan(
      skill.indexOf("已加载 references/score-dimensions.md")
    )
  })
})

describe("buildAsinAuditOptimizeSkill（输出前长度自检）", () => {
  it("A+ 主标题按说明语言生成，展示名称不作为固定中文枚举", () => {
    const skill = buildAsinAuditOptimizeSkill()
    expect(skill).not.toContain("`name` 中文模块名")
    expect(skill).toContain("`aplusModules.name` 与 `nameEn` 均为英文")
    expect(skill).toContain("不得输出中文主标题加英文副标签")
    expect(skill).toContain("不是固定中文枚举")
  })

  it("实际装配的优化提示词包含三项长度复核及同次回答内精简要求", () => {
    const skill = buildAsinAuditOptimizeSkill()
    expect(skill).toContain("listing.title.length <= 75")
    expect(skill).toContain("listing.longTitle.length <= 200")
    expect(skill).toContain('listing.itemHighlights.join(", ").length <= 125')
    expect(skill).toContain("英文逗号和空格共计 2 字符")
    expect(skill).toContain("先在本次回答内精简对应字段")
    expect(skill).toContain("精简后对最终三个字段重新计数")
    expect(skill).toContain("不得在单词或型号中间截断")
    expect(skill).toContain("不要输出草稿、自检过程、计数说明或额外的长度字段")
  })
})
