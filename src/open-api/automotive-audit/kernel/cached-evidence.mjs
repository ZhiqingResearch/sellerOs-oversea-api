// Migrated from the accepted automotive audit script; runtime I/O is injected by the service.
import { cleanText } from './audit-data.mjs';
import { getCachedAttribute, getCachedAttributes } from './cached-attributes.mjs';
import { compareMaterials, hasPartNumber, parsePartNumbers } from './audit-engine.mjs';
import { compareFitmentClaims, findVehicleYears, parseFitmentRows } from './cached-fitment.mjs';

export const CACHED_EVIDENCE_VERSION = 'complete-cache-evidence-v2';
const normalize = value => cleanText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const numberPattern = /\d+(?:\.\d+)?/g;

function measurement(value, type, defaultUnit) {
  const text = cleanText(value);
  const numbers = text.match(numberPattern) ?? [];
  if (!numbers.length || type === 'weight' && numbers.length !== 1) return null;
  const factor = type === 'weight' ? /pounds?|\blbs?\b/i.test(text) ? 0.45359237 : /ounces?|\boz\b/i.test(text) ? 0.028349523125 : /\bkg\b/i.test(text) || defaultUnit === 'kg' ? 1 : null : /inches|inch|\bin\b/i.test(text) ? 2.54 : /\bcm\b/i.test(text) || defaultUnit === 'cm' ? 1 : null;
  if (factor === null || type === 'dimensions' && ![1, 3].includes(numbers.length)) return null;
  return numbers.map(number => ({ value: Number(number) * factor, uncertainty: 0.5 * 10 ** -(number.split('.')[1]?.length ?? 0) * factor })).sort((left, right) => left.value - right.value);
}

export function compareMeasurement(source, listing, type) {
  const expected = measurement(source, type, type === 'weight' ? 'kg' : 'cm');
  const actual = measurement(listing, type);
  if (!expected || !actual || expected.length !== actual.length) return { status: 'unknown', reason: '缺可对应单位或尺寸轴数量，未猜测换算', expected, actual };
  // Intersect the precision intervals of the ORIGINAL values, not an invented percentage tolerance.
  const isConsistent = expected.every((item, index) => Math.abs(item.value - actual[index].value) <= item.uncertainty + actual[index].uncertainty + 1e-9);
  return { status: isConsistent ? 'pass' : 'fail', expected, actual, reason: `开发${source}；公开${listing}；统一${type === 'weight' ? 'kg' : 'cm'}：${expected.map(item => Number(item.value.toFixed(6)))} ↔ ${actual.map(item => Number(item.value.toFixed(6)))}。按原数值有效精度区间比较${type === 'dimensions' ? '，三轴排序避免长宽高顺序误判' : ''}。` };
}

function setEvidence(rule, checks, missingData, interpretationLimits = []) {
  rule.evidenceDetails = { knownFacts: checks.filter(check => check.status !== 'unknown').map(check => `${check.name}：${check.detail}`), missingData, interpretationLimits };
}
function settle(rule, points, reason, evidence, checks = rule.checks ?? []) {
  Object.assign(rule, { earnedPoints: rule.kind === 'veto' ? null : points, status: rule.kind === 'veto' ? points === 0 ? 'fail' : 'pass' : points === rule.maxPoints ? 'pass' : 'fail', reason, evidence, checks, blockers: [], pendingType: null, confirmedIssues: [], decisionMethod: 'local_cached_evidence' });
  delete rule.evidenceDetails;
}
function sourceEvidence(task, field) { return { source: 'development', row: task.source.row, field, value: task.source.fields[field] }; }

export function normalizeMaterial(value) {
  // Remove only an explicit applicability annotation, never a compound material.
  return normalize(cleanText(value).replace(/\(\s*for\b[^)]*\)/gi, '').replace(/aluminium/gi, 'aluminum'));
}

export function classifyHighlight(value) {
  const text = cleanText(value);
  if (!text || [...text].length > 125) return 'unknown';
  const clauses = text.split(/[|;；,]/).map(item => item.trim()).filter(Boolean);
  const hasSentence = clauses.some(clause => /\b(?:this|it|these|they|we|our\s+\w+)\s+(?:\w+\s+){0,3}(?:is|are|has|have|provides?|features?|offers?|includes?|fits?|replaces?)\b/i.test(clause));
  if (hasSentence) return 'sentence';
  const isPhrase = clause => /^(?:OE\s*[:#]|Replace\s*#|Compatible with\b|(?:Plug-and-Play|[A-Za-z]+-(?:Resistant|Fit|Way|Proof))\b|Standard\s+\d+-Way\b)/i.test(clause) && !/\b(?:is|are|has|have|provides?|features?|offers?)\b/i.test(clause);
  return clauses.length && clauses.every(isPhrase) ? 'phrases' : 'unknown';
}

function reviewHighlights(result, task) {
  const rule = result.rules.find(item => item.ruleId === 'M1-3.5');
  const attribute = getCachedAttribute(task.product, ['Item Highlight', 'Item Highlights']);
  if (!attribute.value || ['pass', 'fail'].includes(rule.status)) return;
  const form = classifyHighlight(attribute.value);
  if (form !== 'unknown') settle(rule, form === 'phrases' ? 2 : 1, `明确返回的Item Highlight共${[...attribute.value].length}字符，${form === 'phrases' ? '由OE引用、适配短语或卖点短语组成；竖线/分号只是分隔符，不作为未知或扣分理由，得2分' : '含主谓完整句，按附件扣1分'}。`, attribute.evidence, [{ name: '字段原文及句式', status: form === 'phrases' ? 'pass' : 'fail', detail: attribute.value }]);
}

function reviewVisualConsistency(result, task) {
  const rule = result.rules.find(item => item.ruleId === 'M1-7.4');
  const snapshot = result.snapshotReview;
  const comparison = snapshot?.review?.aplusComparison;
  if (!comparison || !['consistent', 'different'].includes(comparison.outcome) || !comparison.reason || !comparison.imageIds?.some(id => id.startsWith('aplus:')) || !comparison.imageIds.some(id => /^(?:main|aux):/.test(id))) return;
  const returnedIds = ['main:0', ...(task.product.otherImagesUrl ?? []).map((_, index) => `aux:${index}`), ...(task.product.aplus ?? []).map((_, index) => `aplus:${index}`)];
  if (!comparison.imageIds.every(id => returnedIds.includes(id) && snapshot.images?.some(image => image.imageId === id && image.sha256))) return;
  const isConsistent = comparison.outcome === 'consistent';
  settle(rule, isConsistent ? 0.5 : 0, `${comparison.reason} 按方案“检查图片一致性”结算：${isConsistent ? '缓存已完成A+与商品主辅图可见结构对照，得0.5分' : '缓存确认可见结构不一致，得0分'}。不再要求方案未规定的独立实物报告作为本项前置。`, comparison.imageIds.map(id => snapshot.images.find(image => image.imageId === id)), [{ name: 'A+与商品图可见结构一致性', status: isConsistent ? 'pass' : 'fail', detail: comparison.reason }]);
  rule.scopeNotes = ['只证明本次返回图片的可见结构一致性，不构成实物认证，也不证明图片制作来源或真实性。'];
}

export function reviewParameterEvidence(task) {
  const fields = task.source.fields;
  const checks = [];
  const missingData = [];
  const specifications = [
    { name: '材质', field: '材质', aliases: ['Material', 'Material Type'], type: 'material' },
    { name: '产品尺寸', field: '产品尺寸（CM）', aliases: ['Product Dimensions', 'Item Dimensions'], type: 'dimensions' },
    { name: '重量', field: '产品重量（KG）', aliases: ['Item Weight'], type: 'weight' },
  ];
  // Position is relevant only if the listing actually publishes this attribute.
  if (getCachedAttribute(task.product, ['Position', 'Installation Position']).value) specifications.push({ name: '安装位置', field: '安装位置', aliases: ['Position', 'Installation Position'], type: 'text' });
  for (const spec of specifications) {
    const attribute = getCachedAttribute(task.product, spec.aliases);
    const source = cleanText(fields[spec.field]);
    let status = 'unknown'; let detail;
    if (!source || !attribute.value) {
      detail = `开发${source || '未提供'}；公开属性${attribute.value || (attribute.hasConflict ? '多个来源冲突' : '未返回')}。`;
      missingData.push({ data: `${spec.name}：${!source ? '开发基准' : ''}${!source && !attribute.value ? '及' : ''}${!attribute.value ? '唯一公开属性值' : ''}`, location: `上架资料第${task.source.row}行/${spec.field}及${spec.aliases.join('/')}`, remedy: '补充同一SKU对应字段或有效规格记录' });
    } else if (['weight', 'dimensions'].includes(spec.type)) {
      const comparison = compareMeasurement(source, attribute.value, spec.type); status = comparison.status; detail = comparison.reason;
    } else if (spec.type === 'material') {
      const comparison = compareMaterials(source, attribute.value);
      status = normalizeMaterial(source) === normalizeMaterial(attribute.value) ? 'pass' : comparison.isContradiction ? 'fail' : 'unknown';
      detail = `开发${source}；公开属性${attribute.value}。复合材质/泛称不机械判冲突。`;
    } else { status = normalize(source) === normalize(attribute.value) ? 'pass' : 'unknown'; detail = `开发${source}；公开属性${attribute.value}`; }
    checks.push({ name: spec.name, status, detail, evidence: [sourceEvidence(task, spec.field), ...attribute.evidence] });
  }
  return { checks, missingData };
}

function reviewFitment(result, task) {
  const rule = result.rules.find(item => item.ruleId === 'M2-2.2.1');
  const fields = task.source.fields;
  const source = cleanText(fields['适配车型分行']);
  const fullSource = cleanText(fields['产品信息（产品名称+OE+适配信息+产品卖点）']);
  if (!source) return;
  const attributes = getCachedAttributes(task.product);
  const locations = [{ path: '/title', value: task.product.title }, ...(task.product.bullets ?? []).map((value, index) => ({ path: `/bullets/${index}`, value })), ...attributes.filter(item => /Compatible Devices|Vehicle|Fitment|Interchange|Item Highlight/i.test(item.name))];
  const comparison = compareFitmentClaims(source, locations);
  const review = result.ruleReview?.rules?.find(item => item.ruleId === rule.ruleId);
  const revisionMarker = /参考多条(?:链接|连接)(?:之)?后[:：]?/;
  const sections = fullSource.split(revisionMarker);
  const getFitmentSection = text => text.split(/Compatible OE\s*:|OE Number\s*:|Product (?:Highlights|advant[a-z]+)\s*:/i)[0];
  const oldSection = getFitmentSection(sections[0]);
  const revisedSection = sections.length > 1 ? getFitmentSection(sections[1]) : '';
  const revisedGroups = parseFitmentRows(revisedSection);
  const signature = groups => groups.map(group => `${group.label}:${group.years.slice().sort().join(',')}`).sort().join('|');
  const hasVerifiedRevision = revisedGroups.length > 0 && signature(revisedGroups) === signature(comparison.groups);
  const sourceRevisionIssues = comparison.groups.flatMap(group => {
    const claims = findVehicleYears(oldSection, group.label, { allowOmittedBrand: true });
    const years = [...new Set(claims.flatMap(claim => claim.years))];
    return years.length && (years.some(year => !group.years.includes(year)) || group.years.some(year => !years.includes(year))) ? [`${group.label}综合资料与分行清单年份范围不同`] : [];
  });
  // An omitted brand or an engine suffix is not a removed model. Use the
  // canonical labels from the current development rows before comparing sets.
  const removedGroups = hasVerifiedRevision ? parseFitmentRows(oldSection).filter(group => !comparison.groups.some(current => current.label === group.label || current.label.endsWith(' ' + group.label))) : [];
  const revisionIssues = removedGroups.flatMap(group => {
    const declarations = locations.flatMap(location => findVehicleYears(location.value, group.label, { allowOmittedBrand: true }).map(item => ({ ...item, path: location.path })));
    if (!declarations.length) return [];
    sourceRevisionIssues.push(`${group.label}仅存在于旧段，已从修订分行移除`);
    return [{ key: `fitment:${group.label}:removed`, message: `${group.label}仍在Listing声明，但当前修订开发清单已移除该车型`, points: 1, evidence: [sourceEvidence(task, '适配车型分行'), sourceEvidence(task, '产品信息（产品名称+OE+适配信息+产品卖点）'), ...declarations] }];
  });
  const claimsText = locations.filter(location => location.name || location.path === '/title' || /compatible|fits?\b|fitment|\bfor\b/i.test(location.value)).map(location => location.value).join('\n');
  // Do not reuse an old engine detail for newly expanded years without supporting evidence.
  const engineBasis = source + revisedSection + (sourceRevisionIssues.length ? '' : oldSection);
  const extraEngines = [...new Set(claimsText.match(/\b(?:\d+(?:\.\d+)?\s*L|[LV][3468]|[23468]Cyl|[0-9][A-Z]{2}-[A-Z]{2}|[0-9]HP[0-9]+)\b/gi) ?? [])].filter(token => !normalize(engineBasis).includes(normalize(token)));
  const missingData = [...extraEngines.map(token => ({ data: `额外排量/发动机/变速箱声明${token}的开发依据`, location: '现有适配及综合资料均无对应值', remedy: '含该限制的SKU适配依据' }))];
  const limitations = hasVerifiedRevision ? [] : [...sourceRevisionIssues];
  if (sections.length > 1 && !hasVerifiedRevision) limitations.push('综合资料的修订段与当前适配分行未能对应，不能任选较宽版本');
  const hasCompleteComparison = comparison.groups.length > 0 && comparison.checks.every(check => check.status !== 'unknown');
  if (!hasCompleteComparison) limitations.push('逐行对照结果已列出；未覆盖声明保留具体范围，不把原文匹配失败当作不适配');
  // A cached contradictory observation alone is not a deduction: verify both year ranges locally.
  const issues = [...comparison.issues, ...revisionIssues];
  const hasResolvedPriorUnknown = review?.outcome === 'consistent' || issues.length > 0 || /排量|发动机/.test(review?.reason ?? '') && !extraEngines.length;
  if (hasCompleteComparison && !missingData.length && !limitations.length && hasResolvedPriorUnknown) {
    const points = Math.max(0, rule.maxPoints - issues.length);
    settle(rule, points, `按车型及年份区间对照。${hasVerifiedRevision ? '综合资料明确修订段与当前开发分行一致，以此为有效范围；旧段差异仅保留追溯，不并入当前范围。' : '开发分行与综合资料交叉核对。'}${issues.length ? issues.map(issue => issue.message).join('；') + '；按附件每处扣1分，同一车型/年份问题跨标题、五点、属性只扣一次。' : '当前具体声明均有开发依据。'}不以年份排列顺序或子区间拆分制造缺失。`, [sourceEvidence(task, '适配车型分行'), sourceEvidence(task, '产品信息（产品名称+OE+适配信息+产品卖点）'), ...locations], comparison.checks);
    rule.scoringIssues = issues.map(issue => ({ ...issue, appliedPoints: 1, suppressedBy: null }));
  } else if (rule.status !== 'pass' || sourceRevisionIssues.length || missingData.length) {
    Object.assign(rule, { status: 'unknown', earnedPoints: null });
    rule.reason = '已核查现有适配声明；' + [...missingData.map(item => item.data), ...limitations, ...(!hasResolvedPriorUnknown ? ['仍需对应扩展声明的有效开发范围，不能自行扩大适配'] : [])].join('；');
    rule.checks = comparison.checks;
    setEvidence(rule, comparison.checks, missingData, limitations);
    rule.confirmedIssues = issues.map(issue => ({ key: issue.key, message: issue.message, deductionPoints: 1, evidence: issue.evidence, recommendation: '按有效开发范围收敛适配声明' }));
  }
  result.localFitmentReview = { hasVerifiedRevision, sourceRevisionIssues, missingData, checks: comparison.checks, issues, sourceFieldsRead: ['适配车型分行', '产品信息（产品名称+OE+适配信息+产品卖点）'] };
}

function reviewTitleAttributes(result, task) {
  const rule = result.rules.find(item => item.ruleId === 'M1-1.1');
  if (rule.status === 'fail') return;
  const claims = structuredClone(result.snapshotReview?.review?.titleAttributes?.claims ?? []);
  const attrs = getCachedAttributes(task.product);
  for (const claim of claims.filter(item => item.status === 'unverified')) {
    const material = getCachedAttribute(task.product, ['Material']);
    let matches = [];
    if (/^(?:材质\s*)?(?:Alumin(?:um|ium)|Plastic|Steel|Rubber)$/i.test(claim.claim) && material.value && normalize(claim.claim.replace(/^材质\s*/, '')) === normalize(material.value)) matches = material.evidence;
    const codes = parsePartNumbers(claim.claim).filter(code => code.length >= 5 && !/^(19|20)\d{2}$/.test(code));
    if (/零件|OE|编号|reference/i.test(claim.claim) && codes.length) {
      const codeAttrs = attrs.filter(item => /OEM|Part Number|Interchange/i.test(item.name));
      if (codes.every(code => codeAttrs.some(item => hasPartNumber(item.value, code)))) matches = codeAttrs.filter(item => codes.some(code => hasPartNumber(item.value, code)));
    }
    const productName = claim.claim.match(/(?:产品类型(?:为)?\s*)([A-Za-z][A-Za-z -]+)/)?.[1]?.trim();
    if (productName) matches = attrs.filter(item => /Included Components|Product Type|Model(?: Name)?$/i.test(item.name) && normalize(item.value).includes(normalize(productName)));
    if (matches.length) Object.assign(claim, { status: 'match', evidence: [...claim.evidence, ...matches.map(item => ({ ref: `listing:${item.path}`, quote: item.value }))], validationNote: '使用原始缓存字段补齐同一声明的直接证据；未修改历史模型结果' });
  }
  result.localTitleClaims = claims;
  if (claims.length && claims.every(claim => claim.status === 'match')) settle(rule, 1, '标题各实际声明已与本次返回的对应属性逐项核实一致。', claims.flatMap(claim => claim.evidence));
  else if (claims.length) {
    const unresolved = claims.filter(claim => claim.status === 'unverified');
    rule.reason = `已核查${claims.length-unresolved.length}/${claims.length}个标题声明，未取得对应属性的声明：${unresolved.map(claim => claim.claim).join('；')}。不以开发资料或五点冒充后台属性。`;
    rule.checks = claims.map(claim => ({ name: claim.claim, status: claim.status === 'match' ? 'pass' : 'unknown', detail: claim.evidence.map(item => item.quote).join(' ↔ ') }));
    setEvidence(rule, rule.checks, unresolved.map(claim => ({ data: `标题声明对应属性：${claim.claim}`, location: '当前返回属性及overview未能完整验证', remedy: '对应属性原文/后台导出' })));
  }
}

export function applyCachedEvidence(result, task) {
  const get = id => result.rules.find(rule => rule.ruleId === id);
  const parameters = reviewParameterEvidence(task);
  const accuracy = get('M1-2.2');
  const mismatches = parameters.checks.filter(check => check.status === 'fail');
  const unknowns = parameters.checks.filter(check => check.status === 'unknown');
  accuracy.checks = parameters.checks;
  accuracy.evidence = parameters.checks.flatMap(check => check.evidence);
  if (!unknowns.length || mismatches.length >= 2) {
    settle(accuracy, Math.max(0, 4 - mismatches.length * 2), `对照已有开发材质、产品尺寸、重量及实际发布的安装位置。${mismatches.length ? mismatches.map(check => check.detail).join('；') + ' 单处不一致扣2分，多处不一致本项0分；未据此认定造假。' : '对应字段在原始有效精度内一致。'}未发布的安装位置不作为其它字段的前置条件。`, accuracy.evidence, parameters.checks);
  } else {
    accuracy.reason = `已完成${parameters.checks.length-unknowns.length}/${parameters.checks.length}项参数对照，发现${mismatches.length}处差异；剩余具体缺口单列。安装位置空值不再阻断重量、尺寸换算。`;
    accuracy.confirmedIssues = mismatches.map(check => ({ key: `attribute:${check.name}`, message: check.detail, deductionPoints: 2, evidence: check.evidence, recommendation: '核对同一SKU开发规格与公开属性，修正错误一方' }));
    setEvidence(accuracy, parameters.checks, parameters.missingData, unknowns.filter(check => !parameters.missingData.some(gap => gap.data.startsWith(check.name))).map(check => check.detail));
  }
  const core = get('M1-1.3');
  core.checks = [...core.checks.filter(check => !parameters.checks.some(item => item.name === check.name)), ...parameters.checks];
  const oeLocations = [...getCachedAttributes(task.product).filter(item => /OEM|Interchange/i.test(item.name)), ...(task.product.bullets ?? []).map((value,index) => ({path:`/bullets/${index}`,value})).filter(item => /(?:OEM? Reference|PART NUMBER REFERENCE|OEM? (?:Number|Replacement)|Replaces\s+[A-Z0-9])/i.test(item.value))];
  const publishedOes = [...new Set(oeLocations.flatMap(item => parsePartNumbers(item.value)).filter(code => !/^(19|20)\d{2}$/.test(code)))];
  const expectedOes = parsePartNumbers(`${task.source.fields['主OE'] ?? ''}\n${task.source.fields['OE信息分行'] ?? ''}`);
  const unsupportedOes = publishedOes.filter(code => !expectedOes.includes(code));
  const coreGaps = [...parameters.missingData, ...mismatches.map(check => ({ data: `${check.name}两侧差异的有效版本`, location: check.detail, remedy: '核实该SKU正确规格并修正错误一侧；不要求所有一致字段额外提交实物报告' })), ...unsupportedOes.map(code => ({ data: `额外OE ${code}的有效开发/官方对应依据`, location: '已发布但当前开发OE清单不含该号码', remedy: '对应替换记录；不能由同源Listing自证' }))];
  if (!publishedOes.length) coreGaps.push({data:'可对应核查的公开MPN/OE字段',location:'当前命名属性及OE引用段未取得可验证号码',remedy:'对应字段或有效产品编号映射，不据此认定实际未填写'});
  if (core.status !== 'fail') {
    if (!unknowns.length && !mismatches.length && !unsupportedOes.length && publishedOes.length && expectedOes.length) settle(core, 1, '已对照有效开发字段核查本次发布的材质、尺寸、重量及OE，未发现不一致。按方案允许的开发表核查路径完成，不额外要求独立实物报告。', [...accuracy.evidence, ...oeLocations], core.checks);
    else {
      core.reason = `已有开发字段已逐项对照，${mismatches.length}处参数差异、${unsupportedOes.length}个额外OE缺有效依据。其余已知一致项保留；不把资料差异直接认定为实物造假，也不再统一要求独立实物报告。`;
      setEvidence(core, core.checks, coreGaps, unknowns.filter(check => !parameters.missingData.some(gap => gap.data.startsWith(check.name))).map(check => check.detail));
    }
  }
  reviewFitment(result, task);
  reviewTitleAttributes(result, task);
  reviewHighlights(result, task);
  reviewVisualConsistency(result, task);
  for (const [id, name, aliases] of [['M1-2.5', 'Warranty', ['Manufacturer Warranty Description','Warranty Description','Warranty']], ['M1-3.5','Item Highlights',['Item Highlight','Item Highlights']]]) {
    const rule = get(id);
    if (rule.status !== 'unknown' && rule.status !== 'unverified') continue;
    const attribute = getCachedAttribute(task.product, aliases);
    const publicFacts = id === 'M1-2.5' ? (task.product.bullets ?? []).filter(text => /warranty/i.test(text)) : task.product.second_title ? [`second_title已返回，但缓存没有证明它等同${name}：${task.product.second_title}`] : [];
    if (attribute.value) {
      const detail = `${name}字段已明确返回：${attribute.value}`;
      setEvidence(rule, [{ name: '明确属性原文', status: 'pass', detail }], [], ['原文已取得，尚有句式或评分边界未解析；不是字段缺失。']);
    } else setEvidence(rule, publicFacts.map(detail => ({ name: '已有公开文案', status: 'pass', detail })), [{ data: attribute.hasConflict ? `${name}字段多个来源的有效值` : `${name}后台字段原文及填写状态`, location: '当前爬虫没有唯一、明确命名的字段证据', remedy: '字段导出或接口字段语义映射；不能用其它文案直接替代' }]);
  }
  result.cachedEvidenceVersion = CACHED_EVIDENCE_VERSION;
  for (const [id, data, location, remedy] of [
    ['M1-1.2','明确父子关系及完整家族末级BSR','单商品返回和variation数量不证明完整家族','后台关系导出或具有明确完整性含义的接口证据'],
    ['M1-1.4','Top12尚未返回字段的实际值/明确空白状态','已知非空字段不足6项，不能排除低于50%','后台字段导出；已知值不必重复提交'],
    ['M1-4.2','完整子体名单及后台选项命名','已取得本次返回商品标题，但无法比较未返回兄弟子体','后台子体关系/选项导出'],
  ]) {
    const rule = get(id);
    if (['unknown','unverified'].includes(rule.status)) setEvidence(rule, rule.checks ?? [], [{data,location,remedy}]);
  }
  const requirements = [
    ['后台类目属性及填写状态', ['M1-1.1','M1-1.4','M1-2.1','M1-2.4'], '类目必填字段全集、每字段实际值/明确空白状态；标题对应属性按未验证声明列出。'],
    ['Warranty及Item Highlights字段', ['M1-2.5','M1-3.5'], '明确的后台原文或可靠接口字段映射。五点保修承诺、second_title不能自动替代。'],
    ['完整变体关系、主题及父体属性', ['M1-1.2','M1-4.1','M1-4.2','M1-4.3'], '父ASIN、全部子体及末级BSR、variation theme、各选项映射和父体品牌/属性。'],
    ['有效开发规格及额外OE依据', ['M1-1.3','M1-2.2'], '仅补具体缺失字段、已确认差异的有效值、未被开发清单支持的额外OE；不对已一致字段统一索要独立实物报告。'],
    ['图片制作来源', ['M1-5.3'], '哪些图片由AI生成的制作记录/源文件，供AI-generated标注核查。'],
    ['Confirmed Fit实际状态', ['M2-2.2.3'], '选车条件及对应徽章/接口状态；开发表Fitment完成标记不替代徽章。'],
    ['后台Search Terms原文', ['M1-8.1','M2-2.3.3'], '真实后台ST全文，供结构和字节/标点/禁词外扣核查。'],
    ['开发OE基准', ['M2-2.1.1','M2-2.1.2','M2-2.3.1'], '同一SKU的开发主OE及完整替换OE清单；不从Listing倒填基准自证。'],
    ['适配扩展依据或有效资料版本', ['M2-2.2.1'], '见逐车型对照及资料版本差异；已有排量资料不再重复索取。'],
    ['其它有歧义的本地证据', ['M1-5.1','M1-7.4','M2-2.2.2','M2-2.4.1','M2-2.4.2','M2-2.4.3'], '只保留无法由现有原文/像素唯一确定或缺少有效图片缓存引用的具体片段，不将其归为后台数据缺失。'],
  ];
  result.dataRequirements = requirements.map(([name, ids, requiredData]) => {
    const rules = result.rules.filter(rule => ids.includes(rule.ruleId) && ['unknown','unverified'].includes(rule.status));
    return { name, requiredData, ruleIds: rules.map(rule => rule.ruleId), excludedBudget: rules.reduce((sum, rule) => sum + (rule.maxPoints ?? 0), 0), details: rules.map(rule => ({ ruleId: rule.ruleId, reason: rule.reason, evidenceDetails: rule.evidenceDetails })) };
  }).filter(requirement => requirement.ruleIds.length);
  // Surface processing limitations separately, never label existing fields as absent.
  const processingIds = new Set(result.rules.filter(rule => ['M1-3.5','M1-2.5'].includes(rule.ruleId) && ['unknown','unverified'].includes(rule.status) && rule.evidenceDetails?.interpretationLimits?.length && !rule.evidenceDetails?.missingData?.length).map(rule => rule.ruleId));
  const processingRules = result.rules.filter(rule => processingIds.has(rule.ruleId));
  if (processingRules.length) {
    result.dataRequirements = result.dataRequirements.map(group => ({...group, ruleIds:group.ruleIds.filter(id=>!processingIds.has(id)), details:group.details.filter(item=>!processingIds.has(item.ruleId))})).filter(group=>group.ruleIds.length);
    for (const group of result.dataRequirements) group.excludedBudget = result.rules.filter(rule=>group.ruleIds.includes(rule.ruleId)).reduce((sum,rule)=>sum+(rule.maxPoints??0),0);
    result.dataRequirements.push({name:'已有证据的解释限制（非字段缺失）',requiredData:'原文已取得，具体未解析语境/评分边界见明细；不得重复索取同一字段或默认通过。',ruleIds:processingRules.map(rule=>rule.ruleId),excludedBudget:processingRules.reduce((sum,rule)=>sum+(rule.maxPoints??0),0),details:processingRules.map(rule=>({ruleId:rule.ruleId,reason:rule.reason,evidenceDetails:rule.evidenceDetails}))});
  }
  return result;
}
