import { plainToInstance } from "class-transformer"
import { validateSync } from "class-validator"
import { UpsertProductProfileDto } from "./image-project.dto"
import { ImageProjectService } from "./image-project.service"

describe("产品资料禁用清单", () => {
  function setup() {
    const profile = { id: 1, projectId: 5, defaultLocale: "zh-CN", forbiddenContent: "原清单",
      localizations: [{ locale: "zh-CN", content: { productName: "咖啡机" } }] }
    const tx = {
      productProfile: {
        findUnique: jest.fn().mockResolvedValue(profile),
        upsert: jest.fn(({ update }) => {
          Object.assign(profile, Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined)))
          return Promise.resolve(profile)
        }),
        update: jest.fn().mockResolvedValue(profile),
        findUniqueOrThrow: jest.fn().mockResolvedValue(profile),
      },
      productProfileLocalization: {
        findUnique: jest.fn().mockResolvedValue(profile.localizations[0]),
        upsert: jest.fn(),
      },
    }
    const prisma = { ...tx, imageProject: { findUnique: jest.fn().mockResolvedValue({ userId: 7, productProfile: profile }) },
      $transaction: jest.fn(callback => callback(tx)) }
    return { profile, tx, service: new ImageProjectService(prisma as never, {} as never) }
  }

  it("只写清单即可保存，两个读取入口回显原文，不写本地化", async () => {
    const { service, tx } = setup()
    const forbiddenContent = "  # 禁止\n- best seller\n"
    expect(await service.upsertProductProfile(5, { forbiddenContent }, 7)).toMatchObject({ forbiddenContent })
    expect(await service.getProductProfile(5, 7)).toMatchObject({ forbiddenContent })
    expect(await service.findOneProject(5, 7)).toMatchObject({ productProfile: { forbiddenContent } })
    expect(tx.productProfileLocalization.upsert).not.toHaveBeenCalled()
  })

  it("未传保留、切换资料语言保留、显式空白清空", async () => {
    const { service, tx } = setup()
    expect(await service.upsertProductProfile(5, { sku: "SKU" }, 7)).toMatchObject({ forbiddenContent: "原清单" })
    expect(await service.upsertProductProfile(5, { defaultLocale: "zh-CN" }, 7)).toMatchObject({ forbiddenContent: "原清单" })
    expect(tx.productProfile.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ forbiddenContent: expect.anything() }),
    }))
    expect(await service.upsertProductProfile(5, { forbiddenContent: " \n" }, 7)).toMatchObject({ forbiddenContent: "" })
  })

  it("DTO 白名单保留字段并拒绝 null，服务拒绝超长文本", async () => {
    const dto = plainToInstance(UpsertProductProfileDto, { forbiddenContent: "- 禁止" })
    expect(validateSync(dto, { whitelist: true })).toEqual([])
    expect(dto.forbiddenContent).toBe("- 禁止")
    expect(validateSync(plainToInstance(UpsertProductProfileDto, { forbiddenContent: null }))).not.toEqual([])
    const { service, tx } = setup()
    await expect(service.upsertProductProfile(5, { forbiddenContent: "x".repeat(20001) }, 7)).rejects.toThrow("不能超过 20000")
    expect(tx.productProfile.upsert).not.toHaveBeenCalled()
  })
})
