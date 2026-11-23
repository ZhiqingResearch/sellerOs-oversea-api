import {
  auditDate,
  auditIso,
  auditNumber,
  auditNumeric,
  auditObject,
  auditRows,
  auditSource,
  auditText,
  auditTexts,
  auditUrl,
  readAuditSnapshot,
  shiftAuditDate,
  type AuditEvidenceSnapshot,
  type AuditObject,
} from "./asin-audit-detail.utils"

function matchesProduct(product: AuditObject, asin: string): boolean {
  const ids = [
    auditText(product.productId),
    auditText(product.asin),
    auditText(product.url)?.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/i)?.[1],
  ].filter(Boolean)
  return ids.length > 0 && ids.every(id => id!.toUpperCase() === asin.toUpperCase())
}

function findProducts(
  value: unknown,
  asin: string,
  path = "",
  depth = 0
): { product: AuditObject; path: string }[] {
  if (depth > 8 || !value || typeof value !== "object") return []
  const object = auditObject(value)
  if (matchesProduct(object, asin)) return [{ product: object, path }]
  return Object.entries(value).flatMap(([key, child]) =>
    findProducts(child, asin, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, depth + 1)
  )
}

function productAttributes(product: AuditObject) {
  const attributes: { name: string; value: string; path: string }[] = []
  const add = (value: unknown, prefix: string) => {
    if (!Array.isArray(value)) return
    value.forEach((pair, index) => {
      if (!Array.isArray(pair) || pair.length !== 2) return
      const name = auditText(pair[0])
      const text = auditText(pair[1]) ?? (auditNumber(pair[1]) !== null ? String(pair[1]) : null)
      if (name && text !== null)
        attributes.push({ name, value: text, path: `${prefix}/${index}/1` })
    })
  }
  add(product.product_information, "/product_information")
  Object.entries(auditObject(product.product_information_hhl)).forEach(([group, pairs]) =>
    add(pairs, `/product_information_hhl/${group.replace(/~/g, "~0").replace(/\//g, "~1")}`)
  )
  return attributes
}

export function buildListingFacts(asin: string, snapshots: AuditEvidenceSnapshot[]) {
  const candidates = snapshots
    .filter(s => s.provider === "CRAWLER")
    .flatMap(snapshot => {
      const envelope = readAuditSnapshot(snapshot)
      return envelope
        ? findProducts(envelope.data, asin, "/data").map(item => ({ ...item, snapshot }))
        : []
    })
    .filter(item => auditText(item.product.title))
  // Audit/variant is the original scoring snapshot; highlights supplements cannot replace it.
  const selected = candidates.find(item => {
    if (!/\/(audit|variant)(?:\?|$)/.test(auditText(auditObject(item.snapshot.request).url) ?? ""))
      return false
    const siblings = candidates.filter(candidate => candidate.snapshot === item.snapshot)
    return item.snapshot.productPointer
      ? item.path === item.snapshot.productPointer
      : siblings.length === 1
  })
  if (!selected)
    return {
      status: "INSUFFICIENT_EVIDENCE",
      reason: "缺少身份匹配的原始商品快照",
      source: null,
      data: null,
    }
  const { product, path, snapshot } = selected
  const attributes = productAttributes(product)
  const field = <T>(value: T | null, pointer: string) => ({
    status: value === null ? "UNKNOWN" : "OBSERVED",
    value,
    source: auditSource(snapshot, `${path}${pointer}`),
  })
  const bsrEntries = attributes
    .filter(a => a.name.toLowerCase() === "best sellers rank")
    .map(attribute => ({
      text: attribute.value,
      source: auditSource(snapshot, `${path}${attribute.path}`),
      categories: [...attribute.value.matchAll(/#([\d,]+)\s+in\s+([^#\n]+)/g)].map(match => ({
        rank: Number(match[1].replace(/,/g, "")),
        name: match[2].replace(/\s*\(See Top 100.*$/i, "").trim(),
      })),
    }))
  const hasBulletArray =
    Array.isArray(product.bullets) && product.bullets.every(x => typeof x === "string")
  const hasImageArray =
    Array.isArray(product.otherImagesUrl) &&
    product.otherImagesUrl.every(x => typeof x === "string")
  const images = hasImageArray
    ? auditTexts(product.otherImagesUrl).flatMap(url => auditUrl(url) ?? [])
    : null
  const urls = (value: unknown) =>
    Array.isArray(value) && value.every(item => typeof item === "string")
      ? value.flatMap(item => auditUrl(item) ?? [])
      : null
  const priceSnapshot = selectSif(snapshots, asin, "batchAsinPrice")
  const priceRow = auditRows(priceSnapshot?.data.list).find(row => row.asin === asin)
  const dateAttribute = attributes.find(attribute =>
    /^(date first available|first available date)$/i.test(attribute.name)
  )
  const listedDate = dateAttribute
    ? field(dateAttribute.value, dateAttribute.path)
    : priceSnapshot && auditText(priceRow?.listedDate)
      ? {
          status: "OBSERVED",
          value: auditText(priceRow?.listedDate),
          source: auditSource(
            priceSnapshot.snapshot,
            "/data/list/" +
              auditRows(priceSnapshot.data.list).findIndex(row => row.asin === asin) +
              "/listedDate"
          ),
        }
      : field(null, "/product_information")
  return {
    status: "AVAILABLE",
    reason: null,
    source: auditSource(snapshot, path),
    data: {
      asin,
      title: field(auditText(product.title), "/title"),
      secondTitle: field(auditText(product.second_title), "/second_title"),
      brand: field(auditText(product.brand), "/brand"),
      bullets: field(hasBulletArray ? auditTexts(product.bullets) : null, "/bullets"),
      bulletCount: field(hasBulletArray ? auditTexts(product.bullets).length : null, "/bullets"),
      description: field(
        typeof product.description === "string" ? product.description : null,
        "/description"
      ),
      mainImage: field(auditUrl(product.imageUrl), "/imageUrl"),
      otherImages: field(images, "/otherImagesUrl"),
      aplusImages: field(urls(product.aplus), "/aplus"),
      videos: field(urls(product.videoUrl), "/videoUrl"),
      listedDate,
      variationCount: field(
        auditNumeric(auditObject(product.extra).variations),
        "/extra/variations"
      ),
      categoryPath: field(auditText(product.nodeLabelPath), "/nodeLabelPath"),
      price: field(auditNumeric(product.priceValue), "/priceValue"),
      currency: field(auditText(product.currency), "/currency"),
      rating: field(auditNumeric(product.rating), "/rating"),
      reviewCount: field(auditNumeric(product.reviewCount), "/reviewCount"),
      isSoldOut: field(
        typeof product.sold_out === "boolean" ? product.sold_out : null,
        "/sold_out"
      ),
      attributes: attributes.map(a => ({
        name: a.name,
        value: a.value,
        source: auditSource(snapshot, `${path}${a.path}`),
      })),
      bsrEntries,
      variantScope: "TARGET_ONLY_FAMILY_COMPLETENESS_UNKNOWN",
    },
  }
}

function requestUrl(snapshot: AuditEvidenceSnapshot): URL | null {
  try {
    return new URL(String(auditObject(snapshot.request).url))
  } catch {
    return null
  }
}

function selectSif(snapshots: AuditEvidenceSnapshot[], asin: string, endpoint: string) {
  return (
    snapshots.flatMap(snapshot => {
      if (snapshot.provider !== "SIF" || !requestUrl(snapshot)?.pathname.endsWith(`/${endpoint}`))
        return []
      const url = requestUrl(snapshot)!
      const body = auditObject(auditObject(snapshot.request).body)
      const requestedAsins = auditTexts(body.asinList)
      if (url.searchParams.get("asin") !== asin && !requestedAsins.includes(asin)) return []
      const envelope = readAuditSnapshot(snapshot)
      if (!envelope) return []
      const data = auditObject(envelope.data)
      if (auditText(data.asin) && data.asin !== asin) return []
      return [{ snapshot, data, url }]
    })[0] ?? null
  )
}

const TREND_METRICS = [
  ["bsr", "大类排名", "RANK"],
  ["buyboxPrice", "Buy Box价格", "CURRENCY"],
  ["review", "评论数量", "COUNT"],
  ["star", "评分", "RATING"],
  ["nfScore", "自然流量得分", "ESTIMATED_TRAFFIC_SCORE"],
  ["spScore", "SP常规流量得分", "ESTIMATED_TRAFFIC_SCORE"],
  ["recSpScore", "SP推荐流量得分", "ESTIMATED_TRAFFIC_SCORE"],
  ["sbScore", "SB流量得分", "ESTIMATED_TRAFFIC_SCORE"],
  ["sbvScore", "SBV流量得分", "ESTIMATED_TRAFFIC_SCORE"],
  ["totalScore", "总流量得分", "ESTIMATED_TRAFFIC_SCORE"],
  ["nfScoreRatios", "自然流量占比", "RATIO"],
  ["spScoreRatios", "SP常规流量占比", "RATIO"],
  ["recSpScoreRatios", "SP推荐流量占比", "RATIO"],
  ["sbScoreRatios", "SB流量占比", "RATIO"],
  ["sbvScoreRatios", "SBV流量占比", "RATIO"],
] as const

export function buildAuditTrends(
  asin: string,
  snapshots: AuditEvidenceSnapshot[],
  windowDays: number
) {
  const selected = selectSif(snapshots, asin, "asinOpTrafficTrend")
  const dates =
    selected && Array.isArray(selected.data.dates) ? selected.data.dates.map(auditDate) : []
  const validDates = dates.filter((date): date is string => date !== null).sort()
  const endDate = selected
    ? (auditDate(selected.url.searchParams.get("endDate")) ?? validDates.at(-1) ?? null)
    : null
  if (!selected || !endDate)
    return {
      status: "INSUFFICIENT_EVIDENCE",
      reason: "未保存可用的目标ASIN趋势快照",
      windowDays,
      period: null,
      series: [],
      composition: null,
    }
  const startDate = shiftAuditDate(endDate, 1 - windowDays)
  const baselineEndDate = shiftAuditDate(startDate, -1)
  const baselineStartDate = shiftAuditDate(startDate, -windowDays)
  const { data, snapshot } = selected
  const period = {
    startDate,
    endDate,
    baselineStartDate,
    baselineEndDate,
    actualStartDate: validDates[0] ?? null,
    actualEndDate: validDates.at(-1) ?? null,
    requestedStartDate: auditDate(selected.url.searchParams.get("startDate")),
    requestedEndDate: auditDate(selected.url.searchParams.get("endDate")),
    granularity: "DAY",
    timezone: null,
    timezoneStatus: "NOT_PROVIDED_BY_SOURCE",
    fetchedAt: auditIso(snapshot.fetchedAt),
  }
  const makeSeries = (
    key: string,
    name: string,
    unit: string,
    values: unknown,
    field: string,
    categoryId: string | null = null
  ) => {
    const counts = new Map<string, number>()
    dates.forEach(date => {
      if (date) counts.set(date, (counts.get(date) ?? 0) + 1)
    })
    const map = new Map<string, number | null>()
    const hasAlignedValues = Array.isArray(values) && values.length === dates.length
    dates.forEach((date, index) => {
      if (!date) return
      const number = hasAlignedValues ? auditNumber(values[index]) : null
      const isValid =
        number !== null &&
        number >= 0 &&
        (unit !== "RANK" || number > 0) &&
        (unit !== "RATIO" || number <= 1)
      map.set(date, counts.get(date) === 1 && isValid ? number : null)
    })
    const pointsFor = (start: string) =>
      Array.from({ length: windowDays }, (_, index) => {
        const date = shiftAuditDate(start, index)
        return { date, value: map.get(date) ?? null }
      })
    const points = pointsFor(startDate)
    const baselinePoints = pointsFor(baselineStartDate)
    const current = points.flatMap(point => (point.value === null ? [] : [point.value]))
    const baseline = baselinePoints.flatMap(point => (point.value === null ? [] : [point.value]))
    const isComparable = current.length === windowDays && baseline.length === windowDays
    const average = (numbers: number[]) =>
      numbers.reduce((sum, value) => sum + value, 0) / numbers.length
    const currentAverage = current.length ? average(current) : null
    const baselineAverage = baseline.length ? average(baseline) : null
    const latest = [...points].reverse().find(point => point.value !== null) ?? null
    return {
      key,
      name,
      unit,
      categoryId,
      status:
        current.length === windowDays
          ? "AVAILABLE"
          : current.length
            ? "PARTIAL"
            : "INSUFFICIENT_EVIDENCE",
      reason: !hasAlignedValues
        ? "序列缺失或长度与日期不一致"
        : current.length < windowDays
          ? "当前窗口存在缺失、非法或重复日期数据"
          : null,
      source: auditSource(snapshot, field),
      validDays: current.length,
      expectedDays: windowDays,
      coverageRate: current.length / windowDays,
      points,
      baselinePoints,
      latest,
      best: unit === "RANK" && current.length ? Math.min(...current) : null,
      average: currentAverage,
      isComparable,
      comparison: {
        method: "EQUAL_WINDOW_DAILY_MEAN",
        baselineValidDays: baseline.length,
        baselineAverage,
        changeRate:
          isComparable && baselineAverage !== null && baselineAverage !== 0
            ? (currentAverage! - baselineAverage) / baselineAverage
            : null,
        reason: !isComparable
          ? "当前期或基期有效天数不足，不计算环比"
          : baselineAverage === 0
            ? "基期均值为0，无法计算相对变化率"
            : null,
      },
    }
  }
  const catId = typeof data.catId === "number" ? String(data.catId) : auditText(data.catId)
  const names = auditObject(data.catIdName)
  const series = TREND_METRICS.map(([key, name, unit]) =>
    makeSeries(
      key,
      key === "bsr" ? (auditText(names[catId ?? ""]) ?? name) : name,
      unit,
      data[key],
      `/data/${key}`,
      key === "bsr" ? catId : null
    )
  )
  for (const [id, values] of Object.entries(auditObject(data.subBsr))) {
    series.push(
      makeSeries(
        `subBsr:${id}`,
        auditText(names[id]) ?? "细分类排名",
        "RANK",
        values,
        `/data/subBsr/${id}`,
        id
      )
    )
  }
  const channelKeys = ["nfScore", "spScore", "recSpScore", "sbScore", "sbvScore"]
  const channels = channelKeys.map(key => series.find(item => item.key === key)!)
  const total = series.find(item => item.key === "totalScore")!
  const commonIndices = total.points.flatMap((point, index) =>
    point.value !== null && channels.every(channel => channel.points[index].value !== null)
      ? [index]
      : []
  )
  const totalScore = commonIndices.length
    ? commonIndices.reduce((sum, index) => sum + total.points[index].value!, 0)
    : null
  const hasInconsistentTotals = commonIndices.some(
    index =>
      channels.reduce((sum, channel) => sum + channel.points[index].value!, 0) >
      total.points[index].value! + 0.000001
  )
  const composition = {
    status: hasInconsistentTotals
      ? "INSUFFICIENT_EVIDENCE"
      : commonIndices.length === windowDays
        ? "AVAILABLE"
        : commonIndices.length
          ? "PARTIAL"
          : "INSUFFICIENT_EVIDENCE",
    method: "SUM_CHANNEL_SCORE_DIVIDED_BY_SUM_TOTAL_SCORE_ON_COMMON_DAYS",
    unit: "ESTIMATED_TRAFFIC_SCORE_SHARE",
    validDays: commonIndices.length,
    expectedDays: windowDays,
    dates: commonIndices.map(index => total.points[index].date),
    totalScore,
    reason: hasInconsistentTotals
      ? "渠道得分之和超过源总得分，保留原值但不生成占比"
      : !commonIndices.length
        ? "各渠道与总流量没有共同有效日期，不生成占比"
        : totalScore === 0
          ? "有效日期总流量得分为0，得分为真实0，占比不可计算"
          : commonIndices.length < windowDays
            ? "仅覆盖共同有效日期，不代表完整窗口"
            : null,
    channels: channels.map(channel => {
      const score = commonIndices.length
        ? commonIndices.reduce((sum, index) => sum + channel.points[index].value!, 0)
        : null
      return {
        key: channel.key,
        name: channel.name,
        score,
        share:
          !hasInconsistentTotals && totalScore !== null && totalScore > 0
            ? score! / totalScore
            : null,
      }
    }),
  }
  return {
    status: series.every(s => s.status === "AVAILABLE")
      ? "AVAILABLE"
      : series.some(s => s.validDays > 0)
        ? "PARTIAL"
        : "INSUFFICIENT_EVIDENCE",
    reason: "流量为SIF第三方流量得分及占比，不是店铺实际访客、广告花费或订单",
    windowDays,
    period,
    series,
    composition,
  }
}

export function buildAuditKeywords(
  asin: string,
  snapshots: AuditEvidenceSnapshot[],
  optimization: unknown
) {
  const selected = selectSif(snapshots, asin, "asinKeywordsSimpleGroupByMonthly")
  const rows = auditRows(selected?.data.list)
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.asin === asin && auditText(row.keyword))
  // No word-family inference: preserve source rows and explicit evidence instead of guessing order counts.
  const positions = (value: unknown) =>
    auditRows(value)
      .map(row => ({
        date: auditDate(row.date),
        rank: auditNumber(row.allPageRank),
        page: auditNumber(row.page),
      }))
      .filter(row => row.date)
  const observed = rows.map(({ row, index }) => ({
    keyword: auditText(row.keyword),
    sourceType: "THIRD_PARTY_OBSERVATION",
    source: auditSource(selected.snapshot, `/data/list/${index}`),
    startDate: auditDate(selected.data.startDate),
    endDate: auditDate(selected.data.endDate),
    totalScore: auditNumber(row.totalScore),
    naturalScore: auditNumber(row.naturalScore),
    adScore: auditNumber(row.adScore),
    searchRank: auditNumber(row.searchRank),
    searchVolume: auditNumber(row.searchVolume),
    naturalPositions: positions(row.naturalPositionSeq),
    sponsoredPositions: positions(row.spPositionSeq),
    clickShare: auditNumber(row.clickShared),
    conversionShare: auditNumber(row.conversionShared),
    shareUnit: "SOURCE_PERCENT",
    shareScope: "第三方ABA共享份额，仅适用于源数据覆盖的ASIN，不是店铺点击或订单数",
    tags: auditTexts(row.keywordTags),
    orders: null,
    clicks: null,
    sales: null,
    businessEvidenceStatus: "NOT_CONNECTED",
  }))
  const recommendations = auditRows(auditObject(optimization).keywordTiers).flatMap(tier =>
    auditTexts(tier.keywords).map(keyword => ({
      keyword,
      sourceType: "AUDIT_RECOMMENDATION",
      category: auditText(tier.label) ?? auditText(tier.tier),
      classificationBasis: "已保存审计建议的分层，不等同于真实出单词分类",
      orders: null,
      clicks: null,
      sales: null,
    }))
  )
  return {
    status: observed.length ? "AVAILABLE" : "INSUFFICIENT_EVIDENCE",
    reason: observed.length ? null : "未取得目标ASIN的真实观察词列表，建议词不补足取证缺口",
    startDate: auditDate(selected?.data.startDate),
    endDate: auditDate(selected?.data.endDate),
    source: selected ? auditSource(selected.snapshot, "/data/list") : null,
    deduplication: "SOURCE_ROWS_PRESERVED_NO_WORD_FAMILY_MERGE",
    observed,
    recommendations,
    historicalConversions: {
      status: "NOT_CONNECTED",
      reason: "未接入店铺搜索词点击、订单、销售额报表",
    },
  }
}
