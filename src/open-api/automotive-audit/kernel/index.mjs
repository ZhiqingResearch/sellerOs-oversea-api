import { readFileSync } from 'node:fs';
import { hashValue, parseAsin, getAttributes, parseLastBsr } from './audit-data.mjs';
import { auditTask } from './audit-engine.mjs';
import { finalizeDiagnostics } from './audit-diagnostics.mjs';
import { applyScoringPolicy } from './scoring-policy.mjs';
import { applyAvailableEvidence } from './available-evidence.mjs';
import { applyAutomotiveBodyPolicy } from './automotive-body-policy.mjs';
import { applyCachedEvidence } from './cached-evidence.mjs';
import { finalizeAudit } from './finalize-audit.mjs';
import { buildEvidence, validateReview, applyReview, SYSTEM_PROMPT as TEXT_PROMPT } from './semantic-review.mjs';
import { buildRuleEvidence, validateRuleReview, applyRuleReview, SYSTEM_PROMPT as RULE_PROMPT } from './rule-review.mjs';
import { validateImageReview, parseImageReviewContent, applyImageReview, IMAGE_PROMPT } from './image-review.mjs';
import { buildSnapshotEvidence, validateSnapshotReview, normalizeSnapshotReview, applySnapshotReview, SYSTEM_PROMPT as SNAPSHOT_PROMPT } from './snapshot-review.mjs';
import { getCachedAttribute } from './cached-attributes.mjs';
export { inspectImage, getOriginalImageUrl } from './snapshot-review.mjs';
export { measureImage } from './image-metrics.mjs';
export { hashValue } from './audit-data.mjs';

const catalog = JSON.parse(readFileSync(new URL('./rule-catalog.json', import.meta.url), 'utf8'));
export const RULE_VERSION = 'automotive-partial-evidence-v2';

export function normalizeReference(reference) {
  const dimensions = reference.dimensions;
  const weight = reference.weight;
  return {
    '产品信息（产品名称+OE+适配信息+产品卖点）': reference.productInfo ?? '',
    '主OE': (reference.mainOeNumbers ?? []).join('\n'),
    'OE信息分行': (reference.oeNumbers ?? []).join('\n'),
    '适配车型分行': reference.fitmentText ?? '',
    '材质': reference.material ?? '',
    '安装位置': reference.installationPosition ?? '',
    '包装数量': reference.packageQuantity ?? '',
    '核心大词': (reference.coreKeywords ?? []).join('\n'),
    '产品尺寸（CM）': dimensions ? [dimensions.length, dimensions.width, dimensions.height].map(value => Number((value * (dimensions.unit === 'INCH' ? 2.54 : 1)).toFixed(6))).join(' x ') + ' cm' : '',
    '产品重量（KG）': weight ? Number((weight.value * (weight.unit === 'LB' ? 0.45359237 : 1)).toFixed(8)) + ' kg' : '',
  };
}

export function createAuditInput(input, body, snapshot) {
  if (body?.code !== 200 || !body.data || typeof body.data !== 'object') throw new Error('CRAWLER_INVALID_RESPONSE');
  const hasGroup = Array.isArray(body.data.variant_product_info);
  const products = hasGroup ? body.data.variant_product_info : [body.data];
  function identities(product) {
    return [product?.productId, product?.url, ...getAttributes(product ?? {}).filter(item => item.name.toUpperCase() === 'ASIN').map(item => item.value)]
      .filter(value => value !== undefined && value !== null && value !== '').map(parseAsin);
  }
  const matches = products.map((product, index) => ({ product, index, ids: identities(product) })).filter(item => item.ids.includes(input.asin));
  if (matches.length !== 1 || matches[0].ids.some(asin => asin !== input.asin)) throw new Error('CRAWLER_ASIN_MISMATCH');
  const { product, index } = matches[0];
  if (typeof product.title !== 'string' || !product.title.trim()) throw new Error('CRAWLER_PRODUCT_INCOMPLETE');
  if (product.imageUrl != null && typeof product.imageUrl !== 'string') throw new Error('CRAWLER_PRODUCT_INCOMPLETE');
  for (const field of ['bullets', 'otherImagesUrl', 'aplus']) {
    if (product[field] != null && (!Array.isArray(product[field]) || product[field].some(value => typeof value !== 'string'))) throw new Error('CRAWLER_PRODUCT_INCOMPLETE');
  }
  const normalizedProduct = { ...product, bullets: product.bullets ?? [], otherImagesUrl: product.otherImagesUrl ?? [], aplus: product.aplus ?? [] };
  const searchTerms = input.listingSupplement?.searchTerms;
  const hasConsistentFamilyIds = products.every(member => {
    const ids = identities(member);
    return ids.length > 0 && ids.every(id => id && id === ids[0]);
  });
  return {
    asin: input.asin, sku: input.sku, recordIds: [], product: normalizedProduct,
    source: { row: 'referenceData', sheet: 'API', fields: normalizeReference(input.referenceData) },
    submissions: typeof searchTerms === 'string' ? [{ fields: { '后台搜索词（rpa）': searchTerms } }] : [],
    searchTerms, hasCrawlerVariantGroup: hasGroup && hasConsistentFamilyIds, hasVerifiedParentRelation: false,
    family: products.map(member => ({ asin: parseAsin(member.productId) ?? parseAsin(member.url), title: member.title, bsr: parseLastBsr(member) })),
    productPointer: hasGroup ? `/data/variant_product_info/${index}` : '/data',
    responseSha256: snapshot.responseHash, rawResponsePath: `snapshot:${snapshot.snapshotId}`, fetchedAt: snapshot.fetchedAt,
  };
}

export function getImageEntries(task) {
  return [
    ...(task.product.imageUrl ? [{ imageId: 'main:0', url: task.product.imageUrl }] : []),
    ...[...new Set(task.product.otherImagesUrl ?? [])].filter(url => url && url !== task.product.imageUrl).map((url, index) => ({ imageId: `aux:${index}`, url })),
    ...[...new Set(task.product.aplus ?? [])].map((url, index) => ({ imageId: `aplus:${index}`, url })),
  ];
}

export function buildModelRequest(task, phase, images = []) {
  let prompt, content, maxOutputTokens;
  if (phase === 'semantic' || phase === 'rules') {
    prompt = phase === 'semantic' ? TEXT_PROMPT : RULE_PROMPT;
    const evidence = phase === 'semantic' ? buildEvidence(task) : buildRuleEvidence(task);
    if (phase === 'semantic' && typeof task.searchTerms === 'string' && task.searchTerms.trim()) {
      evidence.push({ id: 'submitted:ST', text: task.searchTerms });
      prompt += '\n本次提供真实后台ST，额外输出searchTermsStructure:{outcome:"complete|incomplete|unknown",reason:"中文理由",evidence:[{ref,quote}]}。按既定M2-2.3.3检查OE号、车型词、功能词、商品品牌词四类结构，完整=complete，确认缺任一类=incomplete，缺少比对基准=unknown。只核查结构，不重复扣号码准确性或格式。非unknown必须引用完整submitted:ST及相应基准的连续原文；没有品牌/OE/适配基准时不能判断complete。';
    }
    content = JSON.stringify({ asin: task.asin, evidence });
    maxOutputTokens = phase === 'semantic' ? 5000 : 4000;
  } else {
    const selected = phase === 'visual' ? images.filter(image => image.imageId.startsWith('aplus:')) : images;
    prompt = phase === 'visual' ? IMAGE_PROMPT : SNAPSHOT_PROMPT;
    const evidence = phase === 'visual' ? { asin: task.asin, title: task.product.title, imageCount: selected.length } : {
      asin: task.asin, evidence: buildSnapshotEvidence(task), family: task.family.map(({ asin, title }) => ({ asin, title })), images: selected,
    };
    content = [{ type: 'text', text: JSON.stringify(evidence) }];
    for (const image of selected) content.push({ type: 'text', text: image.imageId }, { type: 'image_url', image_url: { url: image.url } });
    maxOutputTokens = phase === 'visual' ? 5000 : 8000;
  }
  return { prompt, content, maxOutputTokens };
}

export function validateModelResponse(task, phase, content, images = []) {
  const raw = phase === 'visual' ? parseImageReviewContent(content).review : JSON.parse(content.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim());
  if (phase === 'semantic') {
    const result = validateReview(raw, buildEvidence(task));
    if (typeof task.searchTerms === 'string' && task.searchTerms.trim()) {
      const decision = raw.searchTermsStructure;
      const evidence = [...buildEvidence(task), { id: 'submitted:ST', text: task.searchTerms }];
      if (!decision || !['complete','incomplete','unknown'].includes(decision.outcome) || typeof decision.reason !== 'string' || !decision.reason.trim() || !Array.isArray(decision.evidence)) throw new Error('ST结构判断缺失');
      if (!decision.evidence.every(ref => typeof ref.quote === 'string' && ref.quote.trim() && evidence.some(item => item.id === ref.ref && item.text.includes(ref.quote)))) throw new Error('ST引用无效');
      if (decision.outcome !== 'unknown' && !decision.evidence.some(ref => ref.ref === 'submitted:ST' && ref.quote === task.searchTerms)) throw new Error('ST判断未覆盖完整原文');
      if (decision.outcome !== 'unknown' && !decision.evidence.some(ref => ref.ref !== 'submitted:ST')) throw new Error('ST判断缺少比对基准引用');
      if (decision.outcome === 'complete' && (!getCachedAttribute(task.product, ['Brand', 'Brand Name']).value || !task.source.fields['主OE'] || !task.source.fields['适配车型分行'])) throw new Error('ST基准不足');
      result.searchTermsStructure = decision;
    }
    return result;
  }
  if (phase === 'rules') return validateRuleReview(raw, buildRuleEvidence(task));
  if (phase === 'visual') return validateImageReview(raw, images.filter(image => image.imageId.startsWith('aplus:')));
  return validateSnapshotReview(normalizeSnapshotReview(raw), images, buildSnapshotEvidence(task), task.family);
}

// Explicit caller-provided ST is different from a crawler's empty/missing keyword array.
function applySearchTerms(result, task) {
  if (typeof task.searchTerms !== 'string') return;
  const text = task.searchTerms;
  const evidence = [{ source: 'REQUEST', path: 'listingSupplement.searchTerms', value: text }];
  const penalty = result.rules.find(rule => rule.ruleId === 'M1-8.1');
  const points = (/[,A-Z]/.test(text) ? 1.5 : 0) + (/\b(best|sale|discount|free shipping)\b/i.test(text) ? 1 : 0) + (Buffer.byteLength(text, 'utf8') > 249 ? 3 : 0);
  Object.assign(penalty, { status: points ? 'fail' : 'pass', deductionPoints: points, reason: `已核查调用方提供的后台ST：${Buffer.byteLength(text, 'utf8')}字节，按原规则外扣${points}分。`, evidence, checks: [], blockers: [] });
  const structure = result.rules.find(rule => rule.ruleId === 'M2-2.3.3');
  if (!text.trim()) Object.assign(structure, { status: 'fail', earnedPoints: 0, reason: '调用方明确提供空ST，缺少规则要求的结构。', evidence, checks: [], blockers: [] });
  const decision = result.semantic?.searchTermsStructure;
  if (text.trim() && decision && decision.outcome !== 'unknown') Object.assign(structure, { status: decision.outcome === 'complete' ? 'pass' : 'fail', earnedPoints: decision.outcome === 'complete' ? 1 : 0, reason: decision.reason, evidence: decision.evidence, checks: [], blockers: [] });
}

export function calculateAudit(task, reviews, options = {}) {
  task = { ...task, unavailableImageIds: options.unavailableImageIds ?? [] };
  let result = auditTask(task, catalog);
  if (reviews.semantic?.status === 'success') result = applyReview(result, reviews.semantic);
  if (reviews.semantic?.review?.searchTermsStructure) result.semantic.searchTermsStructure = reviews.semantic.review.searchTermsStructure;
  if (reviews.rules?.status === 'success') result = applyRuleReview(result, reviews.rules, task);
  if (reviews.visual?.status === 'success') result = applyImageReview(result, reviews.visual);
  if (reviews.snapshot?.status === 'success') result = applySnapshotReview(result, reviews.snapshot, task);
  result = finalizeDiagnostics(result, task);
  result = applyScoringPolicy(result, task, catalog);
  result = applyAvailableEvidence(result, task);
  result = applyAutomotiveBodyPolicy(result, task);
  result = applyCachedEvidence(result, task);
  applySearchTerms(result, task);
  // The accepted document's brand baseline is server-owned, never inferred from a seller's listing.
  if (options.registeredBrand !== undefined) {
    const rule = result.rules.find(item => item.ruleId === 'M1-2.3');
    const brand = getCachedAttribute(task.product, ['Brand', 'Brand Name']);
    if (options.registeredBrand && brand.value) Object.assign(rule, { status: brand.value === options.registeredBrand ? 'pass' : 'fail', earnedPoints: brand.value === options.registeredBrand ? 2 : 0, reason: `按本次规则快照的注册品牌${options.registeredBrand}与实际品牌${brand.value}完全匹配核查。`, evidence: [...brand.evidence, { source: 'RULE_CONFIG', field: 'registeredBrand', value: options.registeredBrand }] });
    else Object.assign(rule, { status: 'unknown', earnedPoints: null, reason: '注册品牌基准或商品品牌属性缺失，不能从Listing倒填注册品牌。' });
  }
  const unavailable = options.unavailableImageIds ?? [];
  const limited = new Set([
    ...(unavailable.includes('main:0') ? ['M1-5.1', 'M1-7.4'] : []),
    ...(unavailable.some(id => id.startsWith('aux:')) ? ['M1-5.2', 'M1-7.4'] : []),
    ...(unavailable.some(id => id.startsWith('aplus:')) ? ['M1-7.2', 'M1-7.3', 'M1-7.4', 'M1-7.5'] : []),
  ]);
  for (const rule of result.rules.filter(item => limited.has(item.ruleId))) {
    Object.assign(rule, { status: 'unknown', earnedPoints: null, reason: `部分关联图片未能读取，不能凭已读取子集确认该项。未读取：${unavailable.join('、')}。`, confirmedIssues: [], evidenceDetails: { missingData: [{ data: '未读取图片的有效内容', location: unavailable.join('、'), remedy: '提供可读取的图片资源' }], interpretationLimits: [] } });
  }
  result = finalizeAudit(result);
  return result;
}

export function toPublicResult(result, snapshotId) {
  const modules = result.totals.modules.map(module => ({ code: module.moduleId === 'M1' ? 'CDQ' : 'OE', weight: module.weightPoints / 100, maxPoints: module.maxPoints, evaluatedPoints: module.evaluatedPoints, earnedPoints: module.earnedPoints, excludedPoints: module.excludedPoints, weightedScore: module.score }));
  const rules = result.rules.map(rule => {
    const isEvaluated = ['pass', 'fail'].includes(rule.status);
    return {
      ruleId: rule.ruleId, dimensionCode: rule.dimension || '前置筛查', name: rule.name, kind: rule.kind.toUpperCase(), status: rule.status.toUpperCase(),
      maxPoints: rule.maxPoints, evaluatedPoints: rule.evaluatedPoints, excludedPoints: rule.excludedPoints,
      hasEvidenceLimits: rule.hasEvidenceLimits, scoreTreatment: rule.scoreTreatment, scoringNote: rule.scoringNote ?? null,
      earnedPoints: isEvaluated && rule.kind === 'scored' ? rule.earnedPoints : null,
      deductedPoints: isEvaluated && rule.kind !== 'veto' ? rule.deductionPoints : null,
      isIncludedInScore: isEvaluated && rule.kind !== 'veto', reason: rule.reason,
      evidence: rule.evidence, checks: rule.checks, sourceRefs: rule.sourceRefs,
      confirmedIssues: rule.confirmedIssues ?? [],
    };
  });
  const deductions = rules.filter(rule => rule.isIncludedInScore && rule.deductedPoints > 0).map(rule => {
    const module = modules.find(item => item.code === (rule.ruleId.startsWith('M1') ? 'CDQ' : 'OE'));
    const reason = rule.scoreTreatment === 'partial_confirmed_deduction'
      ? `${[...new Set(rule.confirmedIssues.filter(issue => issue.deductionPoints > 0).map(issue => issue.message))].join('；')}。${rule.scoringNote}`
      : rule.reason;
    return { ruleId: rule.ruleId, name: rule.name, points: rule.deductedPoints, weightedPoints: rule.kind === 'EXTERNAL_PENALTY' ? rule.deductedPoints : Number((rule.deductedPoints / module.evaluatedPoints * module.weight * 100).toFixed(4)), reason, affectsFinalScore: !result.totals.hasConfirmedVeto };
  });
  const vetoItems = rules.filter(rule => rule.kind === 'VETO' && rule.status === 'FAIL');
  const dataGaps = result.rules.filter(rule => rule.hasEvidenceLimits).map(rule => ({
    ruleId: rule.ruleId, name: rule.name, reason: rule.reason, excludedPoints: rule.excludedPoints,
    evaluatedPoints: rule.evaluatedPoints, scoringNote: rule.scoringNote ?? null,
    confirmedDeductedPoints: rule.deductionPoints,
    missingData: rule.evidenceDetails?.missingData ?? [], interpretationLimits: rule.evidenceDetails?.interpretationLimits ?? [],
    checks: rule.checks, confirmedIssues: rule.confirmedIssues ?? [],
  }));
  const dimensions = [...new Set(rules.filter(rule => rule.kind === 'SCORED').map(rule => `${rule.ruleId.slice(0, 2)}:${rule.dimensionCode}`))].map(key => {
    const items = rules.filter(rule => rule.kind === 'SCORED' && `${rule.ruleId.slice(0, 2)}:${rule.dimensionCode}` === key);
    return { code: key, name: items[0].dimensionCode, maxPoints: items.reduce((sum, item) => sum + item.maxPoints, 0), evaluatedPoints: items.reduce((sum, item) => sum + item.evaluatedPoints, 0), earnedPoints: items.reduce((sum, item) => sum + (item.earnedPoints ?? 0), 0), ruleIds: items.map(item => item.ruleId) };
  });
  return {
    schemaVersion: '1', ruleVersion: RULE_VERSION, scoreBasis: result.totals.scoreBasis,
    validation: { asin: { status: 'VALID', reason: '爬虫商品身份已与请求ASIN交叉核对' }, sku: { status: 'UNVERIFIED', reason: 'SKU为调用方提供的关联标识，未接入独立商品主数据核验' } },
    summary: { score: result.totals.finalScore, grade: result.totals.grade, coverageRate: result.totals.summary.coverage, evaluatedPoints: result.totals.summary.evaluatedPoints, excludedPoints: result.totals.summary.pendingPoints, hasEvidenceLimits: result.totals.hasEvidenceLimits, hasConfirmedVeto: result.totals.hasConfirmedVeto, externalPenalty: result.totals.externalPenalty },
    modules, dimensions, rules, vetoItems, deductions, dataGaps,
    optimizationSummary: [...vetoItems.map(rule => `${rule.ruleId} ${rule.name}：${rule.reason}（一票否决0分/D）`), ...deductions.map(item => `${item.ruleId} ${item.name}：${item.reason}（原项扣${item.points}分）`)].join('\n'),
    remarks: dataGaps.map(gap => `${gap.ruleId} ${gap.name}：${gap.reason}${gap.scoringNote ? ` ${gap.scoringNote}` : ''}`).join('\n'), crawlerSnapshotId: snapshotId,
  };
}
