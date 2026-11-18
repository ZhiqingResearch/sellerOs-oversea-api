import test from "node:test"
import assert from "node:assert/strict"
import { config, rollout, validateConfig } from "./rollout-session-models-20261117.mjs"

const log = { log() {}, table() {} }
const matches = (row, key) => Object.entries(key).every(([field, value]) => row[field] === value)

function setup({ failCostWrite = false, writeLatencyMs = 0 } = {}) {
  let tables = { models: [], costs: [] }
  let transactionElapsedMs = 0
  let transactionTimeoutMs = Infinity
  const calls = { writes: 0, transactions: 0, returnSelections: [] }
  const table = (name, compoundKey) => ({
    findMany: async ({ where }) => structuredClone(tables[name].filter(row => where.OR.some(key => matches(row, key)))),
    upsert: async ({ where, create, update, select }) => {
      calls.writes++
      calls.returnSelections.push(select)
      transactionElapsedMs += writeLatencyMs
      if (transactionElapsedMs > transactionTimeoutMs) throw new Error("模拟事务超时")
      if (name === "costs" && failCostWrite) throw new Error("模拟成本写入失败")
      const row = tables[name].find(row => matches(row, where[compoundKey]))
      if (row) Object.assign(row, structuredClone(update))
      else tables[name].push(structuredClone(create))
    },
  })
  const db = {
    aiGatewayModel: table("models", "publicId_category"),
    aiGatewayVideoFixedPrice: table("costs", "publicId_category_mode_resolution"),
    $transaction: async (fn, options) => {
      calls.transactions++
      transactionElapsedMs = 0
      transactionTimeoutMs = options.timeout
      const before = structuredClone(tables)
      try { return await fn(db) } catch (error) { tables = before; throw error }
    },
  }
  const gateway = { models: {
    get: async publicId => ({ id: publicId, display_name: publicId, modality: config.models.find(r => r.publicId === publicId).modality.toLowerCase(), exec_mode: "async", facts: { modes: ["generate", "edit", "reference_to_video"] } }),
    requestSchema: async () => ({ version: 2, request_schema: { type: "object", allOf: [{ properties: { watermark: false } }] } }),
    pricing: async (publicId, { operation }) => ({ model: publicId, currency: "CNY", operations: [{ operation }] }),
  } }
  return { db, gateway, calls, get tables() { return tables } }
}

test("配置范围与最终价格：不含Gemini1.1，5个视频模型均为1.5倍", () => {
  validateConfig()
  assert.equal(new Set(config.models.map(r => r.publicId)).size, 10)
  assert.equal(config.models.length, 25)
  assert.equal(config.videoCosts.length, 28)
  assert.equal(config.models.filter(r => r.modality === "IMAGE").length, 15)
  assert.equal(config.models.filter(r => r.modality === "VIDEO").length, 10)
  assert.ok(config.models.filter(r => r.modality === "VIDEO").every(r => r.priceMultiplier === "1.5"))
  assert.ok(!JSON.stringify(config).includes("gemini-omni-1.1-flash"))
  assert.ok(!config.models.some(r => ["LOCAL_REDRAW", "CHETAIDOU_IMAGE", "AI_SPLIT_MULTIMODAL"].includes(r.category)))
  assert.equal(config.models.find(r => r.publicId === "byteplus-seedream-5-0-pro" && r.category === "AI_SPLIT").fixedCredits, "20")
  assert.equal(config.models.find(r => r.publicId === "gpt-image-2.6-flare" && r.category === "AI_SPLIT").fixedCredits, "30")
  assert.equal(config.models.find(r => r.publicId === "byteplus-seedream-5-0-lite" && r.category === "PORTRAIT").fixedCredits, "5")
  assert.equal(config.videoCosts.find(r => r.publicId === "gemini-omni-1.2-flash" && r.mode === "video_to_video" && r.resolution === "4k").costCnyPerSecond, "1.5243")
  assert.equal(config.videoCosts.find(r => r.publicId === "byteplus-seedance-2-0-fast" && r.category === "REFERENCE" && r.resolution === "720p").costCnyPerSecond, "0.864")
  assert.equal(config.videoCosts.find(r => r.publicId === "byteplus-seedance-2-0" && r.category === "NORMAL" && r.resolution === "720p").costCnyPerSecond, "1.08")
})

test("默认预览只读取网关与目标库，不写库或开启事务", async () => {
  const fixture = setup()
  await rollout({ ...fixture, log })
  assert.equal(fixture.calls.writes, 0)
  assert.equal(fixture.calls.transactions, 0)
  assert.deepEqual(fixture.tables, { models: [], costs: [] })
})

test("重复执行不新增重复行，保留既有排序及清单外配置，刷新最新Schema", async () => {
  const fixture = setup()
  const old = { ...config.models[0], fixedCredits: "99", priceMultiplier: "9", sortOrder: 777, enabled: false }
  const unrelated = { publicId: "gemini-omni-1.1-flash", category: "NORMAL", enabled: false, priceMultiplier: "2", sortOrder: 8 }
  const extraCost = { publicId: "gemini-omni-1.1-flash", category: "NORMAL", mode: "", resolution: "480p", costMinCny: "123" }
  fixture.tables.models.push(old, structuredClone(unrelated))
  fixture.tables.costs.push(structuredClone(extraCost))
  await rollout({ ...fixture, apply: true, log })
  const first = structuredClone(fixture.tables)
  await rollout({ ...fixture, apply: true, log })
  assert.equal(fixture.tables.models.length, 26)
  assert.equal(fixture.tables.costs.length, 29)
  const updated = fixture.tables.models.find(r => r.publicId === old.publicId && r.category === old.category)
  assert.equal(updated.sortOrder, 777)
  assert.equal(updated.fixedCredits, config.models[0].fixedCredits)
  assert.equal(updated.enabled, true)
  assert.equal(updated.gatewayConfig.requestSchema.version, 2)
  assert.deepEqual(fixture.tables.models.find(r => r.publicId === unrelated.publicId), unrelated)
  assert.deepEqual(fixture.tables.costs.find(r => r.publicId === extraCost.publicId), extraCost)
  assert.deepEqual(fixture.tables.models.map(({ syncedAt, ...r }) => r), first.models.map(({ syncedAt, ...r }) => r))
  assert.deepEqual(fixture.tables.costs, first.costs)
})

test("网关缺失或模态错误时，在任何数据库写入前失败", async () => {
  for (const reason of ["missing", "wrong-modality"]) {
    const fixture = setup()
    const get = fixture.gateway.models.get
    fixture.gateway.models.get = async publicId => {
      if (publicId === "gemini-omni-1.2-flash") {
        if (reason === "missing") throw new Error("网关模型不存在")
        return { ...(await get(publicId)), modality: "image" }
      }
      return get(publicId)
    }
    await assert.rejects(rollout({ ...fixture, apply: true, log }))
    assert.equal(fixture.calls.writes, 0)
    assert.equal(fixture.calls.transactions, 0)
  }
})

test("成本写入失败时，已写入的模型配置随事务回滚", async () => {
  const fixture = setup({ failCostWrite: true })
  const initial = { ...config.models[0], fixedCredits: "99", sortOrder: 777 }
  fixture.tables.models.push(initial)
  const before = structuredClone(fixture.tables)
  await assert.rejects(rollout({ ...fixture, apply: true, log }), /模拟成本写入失败/)
  assert.equal(fixture.calls.transactions, 1)
  assert.deepEqual(fixture.tables, before)
})

test("慢连接写入总耗时超过60秒仍可完成，upsert只取回ID", async () => {
  const fixture = setup({ writeLatencyMs: 1500 })
  await rollout({ ...fixture, apply: true, log })
  assert.ok(fixture.calls.writes * 1500 > 60_000)
  assert.equal(fixture.tables.models.length, 25)
  assert.equal(fixture.tables.costs.length, 28)
  for (const select of fixture.calls.returnSelections) assert.deepEqual(select, { id: true })
})
