import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

export const config = JSON.parse(readFileSync(new URL("./rollout-session-models-20261117.config.json", import.meta.url), "utf8"))
const modelKey = row => `${row.publicId}|${row.category}`
const costKey = row => `${modelKey(row)}|${row.mode}|${row.resolution}`
const decimal = value => typeof value === "string" && /^\d+(\.\d{1,6})?$/.test(value) && Number(value) > 0

export function validateConfig() {
  assert.equal(new Set(config.models.map(modelKey)).size, config.models.length, "模型类别重复")
  assert.equal(new Set(config.videoCosts.map(costKey)).size, config.videoCosts.length, "视频成本档重复")
  const modalities = new Map()
  for (const row of config.models) {
    assert.ok(row.publicId && typeof row.enabled === "boolean", "模型 ID 或启停配置无效")
    assert.ok(Number.isInteger(row.sortOrder), `${modelKey(row)} 排序无效`)
    assert.ok(decimal(row.priceMultiplier), `${modelKey(row)} 倍率无效`)
    assert.ok((row.modality === "IMAGE" ? ["IMAGE_GENERATION", "PORTRAIT", "AI_SPLIT"] : row.modality === "VIDEO" ? ["NORMAL", "REFERENCE"] : []).includes(row.category), `${modelKey(row)} 模态/类别无效`)
    assert.ok(row.modality === "IMAGE" ? decimal(row.fixedCredits) : row.fixedCredits === null, `${modelKey(row)} 一口价无效`)
    if (modalities.has(row.publicId)) assert.equal(modalities.get(row.publicId), row.modality, "同一模型模态不一致")
    modalities.set(row.publicId, row.modality)
  }
  for (const row of config.videoCosts) {
    assert.ok(config.models.some(model => modelKey(model) === modelKey(row) && model.modality === "VIDEO"), `${costKey(row)} 没有对应视频模型`)
    assert.ok(typeof row.mode === "string" && row.resolution === row.resolution.toLowerCase(), "模式或分辨率无效")
    assert.ok(decimal(row.costCnyPerSecond), `${costKey(row)} 成本无效`)
  }
}

async function readState(db) {
  const [models, costs] = await Promise.all([
    db.aiGatewayModel.findMany({
      where: { OR: config.models.map(({ publicId, category }) => ({ publicId, category })) },
      select: { publicId: true, category: true, modality: true, execMode: true, priceMultiplier: true, fixedCredits: true, enabled: true, gatewayActive: true, sortOrder: true },
    }),
    db.aiGatewayVideoFixedPrice.findMany({
      where: { OR: config.videoCosts.map(({ publicId, category, mode, resolution }) => ({ publicId, category, mode, resolution })) },
    }),
  ])
  return { models, costs }
}

function verifyState(state) {
  for (const expected of config.models) {
    const row = state.models.find(row => modelKey(row) === modelKey(expected))
    assert.ok(row, `缺少模型：${modelKey(expected)}`)
    assert.equal(row.modality, expected.modality)
    assert.equal(row.execMode, "ASYNC")
    assert.equal(Number(row.priceMultiplier), Number(expected.priceMultiplier), `${modelKey(row)} 倍率不符`)
    assert.equal(row.fixedCredits == null ? null : Number(row.fixedCredits), expected.fixedCredits == null ? null : Number(expected.fixedCredits), `${modelKey(row)} 一口价不符`)
    assert.equal(row.enabled, expected.enabled)
    assert.equal(row.gatewayActive, true)
  }
  for (const expected of config.videoCosts) {
    const row = state.costs.find(row => costKey(row) === costKey(expected))
    assert.ok(row, `缺少成本：${costKey(expected)}`)
    assert.equal(row.creditsPerSec, null, `${costKey(row)} 不应启用固定积分价`)
    assert.equal(row.costPerRequest, false, `${costKey(row)} 成本单位应为元/秒`)
    assert.equal(Number(row.costMinCny), Number(expected.costCnyPerSecond))
    assert.equal(Number(row.costMaxCny), Number(expected.costCnyPerSecond))
  }
}

export async function rollout({ db, gateway, apply = false, log = console }) {
  validateConfig()
  // 全部网关元数据就绪后才允许写库，避免导入半套模型。
  const snapshots = new Map(await Promise.all([...new Set(config.models.map(row => row.publicId))].map(async publicId => {
    const model = config.models.find(row => row.publicId === publicId)
    const operation = model.modality === "IMAGE" ? "images.generations" : "videos.generations"
    const [detail, requestSchema, pricing] = await Promise.all([
      gateway.models.get(publicId),
      gateway.models.requestSchema(publicId, { operation }),
      gateway.models.pricing(publicId, { operation }),
    ])
    assert.equal(detail.id, publicId, "网关模型 ID 不符")
    assert.equal(detail.modality, model.modality.toLowerCase(), `${publicId} 模态不符`)
    assert.equal(detail.exec_mode, "async", `${publicId} 不是异步模型`)
    assert.ok(detail.display_name && requestSchema.request_schema?.type === "object", `${publicId} 缺少展示名或请求 Schema`)
    assert.ok(detail.facts?.modes?.includes(model.modality === "IMAGE" ? "edit" : "reference_to_video"), `${publicId} 不支持所需参考素材模式`)
    assert.equal(pricing.model, publicId, "网关定价模型不符")
    assert.equal(pricing.currency, "CNY", `${publicId} 定价币种不符`)
    assert.ok(pricing.operations?.some(row => row.operation === operation), `${publicId} 缺少操作定价`)
    log.log(`网关能力就绪：${publicId}`)
    return [publicId, { detail, requestSchema, pricing }]
  })))
  const before = await readState(db)
  log.table(config.models.map(row => {
    const old = before.models.find(old => modelKey(old) === modelKey(row))
    return { 模型: row.publicId, 类别: row.category, 操作: old ? "同步" : "新增", 当前一口价: old?.fixedCredits?.toString() ?? "按量", 目标一口价: row.fixedCredits ?? "按量", 当前倍率: old?.priceMultiplier?.toString() ?? "无", 目标倍率: row.priceMultiplier, 启用: row.enabled, 排序: old?.sortOrder ?? row.sortOrder }
  }))
  log.table(config.videoCosts.map(row => {
    const old = before.costs.find(old => costKey(old) === costKey(row))
    return { 模型: row.publicId, 类别: row.category, 模式: row.mode || "通配", 分辨率: row.resolution, 当前成本下限: old?.costMinCny?.toString() ?? "无", 当前成本上限: old?.costMaxCny?.toString() ?? "无", 当前固定积分: old?.creditsPerSec?.toString() ?? "无", 当前单位: old ? (old.costPerRequest ? "元/次" : "元/秒") : "无", 目标成本元每秒: row.costCnyPerSecond }
  }))
  if (!apply) {
    log.log(`预览完成：${snapshots.size} 个模型、${config.models.length} 条类别配置、${config.videoCosts.length} 条视频成本；未写库。`)
    return before
  }
  log.log("开始写入：单事务最长 5 分钟；验证通过后统一提交。")
  await db.$transaction(async tx => {
    for (const row of config.models) {
      const { detail, requestSchema, pricing } = snapshots.get(row.publicId)
      const { sortOrder, ...model } = row
      const data = { ...model, displayName: detail.display_name, execMode: "ASYNC", gatewayConfig: { detail, requestSchema }, quoteConfig: pricing, gatewayActive: true, syncedAt: new Date() }
      await tx.aiGatewayModel.upsert({
        where: { publicId_category: { publicId: row.publicId, category: row.category } },
        create: { ...data, sortOrder },
        update: data,
        select: { id: true },
      })
    }
    log.log(`已写入 ${config.models.length} 条模型类别，尚未提交；继续写入视频成本。`)
    for (const row of config.videoCosts) {
      const { costCnyPerSecond, ...key } = row
      const data = { creditsPerSec: null, costMinCny: costCnyPerSecond, costMaxCny: costCnyPerSecond, costPerRequest: false }
      await tx.aiGatewayVideoFixedPrice.upsert({
        where: { publicId_category_mode_resolution: key },
        create: { ...key, ...data },
        update: data,
        select: { id: true },
      })
    }
    log.log(`已写入 ${config.videoCosts.length} 条视频成本，尚未提交；开始回读验证。`)
    verifyState(await readState(tx))
  }, { timeout: 300_000 })
  const after = await readState(db)
  verifyState(after)
  log.log(`提交并回读验证通过：${config.models.length} 条模型类别、${config.videoCosts.length} 条视频成本。`)
  return after
}

async function main() {
  const { values: args } = parseArgs({ options: { apply: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean" } } })
  if (args.help) {
    console.log("本会话新增模型上线配置（不含 Gemini 1.1）。默认只预览；--apply 才写库。\n预览：node --env-file=/path/to/production.env scripts/rollout-session-models-20261117.mjs --dry-run\n执行：node --env-file=/path/to/production.env scripts/rollout-session-models-20261117.mjs --apply\n依赖：DATABASE_URL、AI_GATEWAY_BASE_URL、AI_GATEWAY_API_KEY。能力/定价从所选环境网关实时读取，不调用生成接口。")
    return
  }
  assert.ok(!(args.apply && args["dry-run"]), "--apply 和 --dry-run 不能同时使用")
  const required = key => {
    const value = process.env[key]?.trim()
    if (!value) throw new Error(`缺少环境变量 ${key}`)
    return value
  }
  const database = new URL(required("DATABASE_URL"))
  const baseURL = required("AI_GATEWAY_BASE_URL")
  const apiKey = required("AI_GATEWAY_API_KEY")
  console.log(`目标数据库：${database.hostname}${database.port ? `:${database.port}` : ""}${database.pathname}`)
  console.log(`目标网关：${new URL(baseURL).origin}；模式：${args.apply ? "正式写入" : "只读预览"}`)
  const [{ PrismaClient }, { AiGatewayClient }] = await Promise.all([import("@prisma/client"), import("@zhiqingresearch/ai-ts-sdk")])
  const db = new PrismaClient()
  try {
    const gateway = new AiGatewayClient({ baseURL, apiKey, timeoutMs: 30_000, getRetry: { maxRetries: 0 } })
    await rollout({ db, gateway, apply: !!args.apply })
  } finally {
    await db.$disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`模型配置失败：${error.message}`)
    process.exitCode = 1
  })
}
