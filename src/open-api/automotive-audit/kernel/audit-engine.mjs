// Migrated from the accepted automotive audit script; runtime I/O is injected by the service.
import { cleanText, getFieldText, parseLastBsr } from './audit-data.mjs';
import { getCachedAttribute as getAttribute, getCachedAttributes as getAttributes } from './cached-attributes.mjs';
import { initializeRules, getPdfSource } from './audit-policy.mjs';

const MATERIAL_NAMES = [['aluminum', /\balumin(?:um|ium)(?: alloy)?\b|铝(?:合金)?/gi], ['plastic', /\bplastic\b|塑料/gi], ['steel', /\b(?:stainless )?steel\b|钢/gi], ['cotton', /\bcotton\b|纯棉|棉/gi], ['polyester', /\bpolyester\b|涤纶/gi], ['rubber', /\brubber\b|橡胶/gi], ['copper', /\bcopper\b|铜/gi]];

export function parseMaterials(text) {
  return MATERIAL_NAMES.filter(([, pattern]) => { pattern.lastIndex = 0; return pattern.test(cleanText(text)); }).map(([name]) => name);
}

export function compareMaterials(left, right) {
  const leftValues = parseMaterials(left);
  const rightValues = parseMaterials(right);
  // Broad "metal", coatings and mixed-component descriptions are not contradictions.
  const hasQualification = /\b(?:coated|coating|sleeve|core|insert|vs|versus|replacement for|replaces|not|non|free|alternative|with)\b|(?:包覆|内芯|替代|非|不含)/i.test(left + ' ' + right);
  return { leftValues, rightValues, isContradiction: !hasQualification && leftValues.length === 1 && rightValues.length === 1 && leftValues[0] !== rightValues[0] };
}

export function parsePartNumbers(text) {
  return [...new Set(parsePartNumberForms(text).map(value => value.replace(/[-‐‑–]/g, '')))];
}

export function parsePartNumberForms(text) {
  return [...new Set((cleanText(text).match(/[A-Za-z0-9]+(?:[-‐‑–][A-Za-z0-9]+)*/g) ?? []).filter(value => /\d/.test(value) && value.replace(/[-‐‑–]/g, '').length >= 4).map(value => value.toUpperCase()))];
}

export function hasPartNumber(text, partNumber) {
  return parsePartNumbers(text).includes(partNumber.toUpperCase().replace(/[-‐‑–]/g, ''));
}

export function scoreTitleLength(title) {
  const length = [...title].length;
  return { length, points: length === 100 ? null : length <= 75 ? 3 : length < 100 ? 1.5 : 0 };
}

export function summarizeScores(rules) {
  const scoredRules = rules.filter(rule => rule.kind === 'scored');
  const evaluatedRules = scoredRules.filter(rule => ['pass', 'fail'].includes(rule.status));
  const round = value => Math.round(value * 1000) / 1000;
  const maxPoints = round(scoredRules.reduce((sum, rule) => sum + rule.maxPoints, 0));
  const evaluatedPoints = round(evaluatedRules.reduce((sum, rule) => sum + (rule.evaluatedPoints ?? rule.maxPoints), 0));
  // Keep calculation precision; only presentation may round before displaying.
  const earnedPoints = evaluatedRules.reduce((sum, rule) => sum + rule.earnedPoints, 0);
  return { maxPoints, evaluatedPoints, earnedPoints, pendingPoints: round(maxPoints - evaluatedPoints), coverage: maxPoints ? evaluatedPoints / maxPoints : 0, convertedScore: evaluatedPoints ? round(100 * earnedPoints / evaluatedPoints) : null };
}

export function calculateTotals(rules) {
  const modules = ['M1', 'M2'].map(moduleId => {
    const scoredRules = rules.filter(rule => rule.kind === 'scored' && rule.ruleId.startsWith(moduleId));
    return { moduleId, ...summarizeScores(scoredRules) };
  });
  const vetoes = rules.filter(rule => rule.kind === 'veto');
  const failedVetoes = vetoes.filter(rule => rule.status === 'fail');
  const hasPendingRules = rules.some(rule => ['unknown', 'not_applicable'].includes(rule.status));
  const rawPoints = modules.reduce((sum, module) => sum + module.earnedPoints, 0);
  const penalty = rules.filter(rule => rule.kind === 'external_penalty').reduce((sum, rule) => sum + (rule.deductionPoints ?? 0), 0);
  // Confirmed veto wins even while other rules are unknown. Never dilute it into a subtotal.
  const finalScore = failedVetoes.length ? 0 : hasPendingRules ? null : Math.max(0, rawPoints - penalty);
  const grade = finalScore === null ? null : finalScore >= 90 ? 'S' : finalScore >= 80 ? 'A' : finalScore >= 70 ? 'B' : finalScore >= 60 ? 'C' : 'D';
  return { modules, summary: summarizeScores(rules), finalScore, grade, hasConfirmedVeto: failedVetoes.length > 0, vetoRuleIds: failedVetoes.map(rule => rule.ruleId), pendingVetoCount: vetoes.filter(rule => rule.status === 'unknown').length, evaluatedPoints: modules.reduce((sum, module) => sum + module.evaluatedPoints, 0), hasPendingRules };
}

export function auditTask(task, catalog) {
  const product = task.product;
  const sourceFields = task.source.fields;
  const rules = initializeRules(catalog);
  const findings = [];
  const getRule = ruleId => rules.find(rule => rule.ruleId === ruleId);
  const setRule = (ruleId, points, reason, evidence = []) => {
    const rule = getRule(ruleId);
    Object.assign(rule, { earnedPoints: points, status: rule.kind === 'veto' ? 'fail' : points === rule.maxPoints ? 'pass' : 'fail', reason, evidence, pendingType: null, blockers: [], decisionMethod: 'deterministic' });
  };
  const addFinding = (type, message, evidence, recommendation) => findings.push({ type, message, evidence, recommendation });
  const title = cleanText(product.title);
  const titleEvidence = { source: 'listing', path: '/title', value: product.title };
  const attributes = getAttributes(product);
  const material = getAttribute(product, ['Material', 'Material Type']);
  const materialComparison = compareMaterials(title, material.value ?? '');
  if (material.hasConflict) getRule('M1-1.1').reason = '材质属性不同抓取位置不一致，需核对来源。';
  if (materialComparison.isContradiction) {
    setRule('M1-1.1', null, '标题材质与明确返回的商品材质属性矛盾，命中1处即一票否决。', [titleEvidence, ...material.evidence]);
  } else {
    getRule('M1-1.1').evidence = [titleEvidence, ...material.evidence];
    getRule('M1-1.1').reason = '已比对可解析的标题材质；未发现确定冲突。规格、车型等语义及后台完整属性尚待核查，不能判全部通过。';
  }
  const quantity = getAttribute(product, ['Number of Items']);
  const titleQuantity = title.match(/\b(?:pack of\s+(\d+)|(\d+)\s*[- ]?(?:pack|pcs|pieces))\b/i);
  if (quantity.value && /^\d+$/.test(quantity.value) && titleQuantity && Number(titleQuantity[1] ?? titleQuantity[2]) !== Number(quantity.value)) {
    setRule('M1-1.1', null, '标题包装数量与商品 Number of Items 属性不一致，一票否决。', [titleEvidence, ...quantity.evidence]);
  }
  const familyCategories = task.family.map(member => ({ asin: member.asin, category: member.bsr.category, evidence: member.bsr.evidence }));
  const knownCategories = familyCategories.map(member => member.category).filter(Boolean);
  const hasCompleteReturnedFamily = task.hasCrawlerVariantGroup === true && task.family.length > 1 && task.product.extra?.variations === task.family.length && new Set(task.family.map(member => member.asin)).size === task.family.length;
  getRule('M1-1.2').evidence = familyCategories;
  getRule('M1-1.2').reason = `本次响应包含${task.family.length}个商品；${new Set(knownCategories).size > 1 ? '末级BSR品类有差异' : '可解析的末级BSR品类未见差异'}。接口没有父ASIN和家族完整性证明，功能一致性仍待核查。`;
  if ((task.hasVerifiedParentRelation || hasCompleteReturnedFamily) && new Set(knownCategories).size > 1) {
    setRule('M1-1.2', null, '已验证的返回变体组存在末级BSR品类不同，按用户指定的类目判据一票否决。', familyCategories);
  } else if (hasCompleteReturnedFamily && knownCategories.length === task.family.length) {
    Object.assign(getRule('M1-1.2'), { status: 'pass', earnedPoints: null, pendingType: null, blockers: [], scope: 'crawler_returned_family_last_bsr', decisionMethod: 'deterministic', reason: `接口声明${task.product.extra.variations}个变体并返回${task.family.length}个唯一商品，最后一个BSR品类均为${knownCategories[0]}，按用户指定的BSR末级类目判据通过。范围限本次返回组，不宣称已查询卖家后台父体。` });
  }
  getRule('M1-1.2').checks.push({ name: '返回组末级BSR一致性', status: knownCategories.length === task.family.length && knownCategories.length > 1 && new Set(knownCategories).size === 1 ? 'pass' : 'unknown', detail: familyCategories.map(member => `${member.asin}: ${member.category ?? '未返回'}`).join('；') });
  const coreFields = [
    ['Brand', ['Brand', 'Brand Name']], ['MPN', ['Manufacturer Part Number']],
    ['Fitment Type', ['Fitment Type', 'Automotive Fit Type']], ['Part Type ID', ['Part Type ID']],
    ['Vehicle Fitment Code', ['Vehicle Fitment Code', 'KType']], ['Material', ['Material', 'Material Type']],
    ['Size', ['Size', 'Product Dimensions', 'Item Dimensions L x W x H']], ['Color', ['Color', 'Colour']],
    ['Position', ['Position']], ['Item Package Quantity', ['Item Package Quantity']],
    ['OEM Part Number', ['OEM Part Number', 'OEM Equivalent Part Number']], ['Warranty', ['Manufacturer Warranty Description', 'Warranty Description', 'Warranty']],
  ].map(([name, aliases]) => ({ name, attribute: getAttribute(product, aliases) }));
  const confirmedFilled = coreFields.filter(item => item.attribute.value && !item.attribute.hasConflict);
  const fillRule = getRule('M1-1.4');
  fillRule.checks = coreFields.map(item => ({ name: item.name, status: item.attribute.value && !item.attribute.hasConflict ? 'pass' : 'unknown', detail: item.attribute.value ?? '未取得明确值，不直接算留白' }));
  fillRule.evidence = confirmedFilled.flatMap(item => item.attribute.evidence);
  if (confirmedFilled.length >= 6) Object.assign(fillRule, { status: 'pass', earnedPoints: null, pendingType: null, blockers: [], decisionMethod: 'deterministic', scope: 'minimum_confirmed_attribute_coverage', reason: `Top12中已明确取得${confirmedFilled.length}项非空值，填写率下限${Math.round(confirmedFilled.length / 12 * 100)}%，足以排除“低于50%”这一否决条件；其它字段未知，不视为已填或留白。` });
  const referenceMaterial = cleanText(sourceFields['材质']);
  const specificationFields = [
    ['材质', material],
    ['产品尺寸', getAttribute(product, ['Product Dimensions', 'Item Dimensions L x W x H', 'Size'])],
    ['重量', getAttribute(product, ['Item Weight', 'Weight'])],
    ['颜色', getAttribute(product, ['Color', 'Colour'])],
  ];
  const returnedSpecifications = specificationFields.filter(([, attribute]) => attribute.value && !attribute.hasConflict);
  const missingSpecifications = specificationFields.filter(([, attribute]) => !attribute.value || attribute.hasConflict);
  const specificationRule = getRule('M1-2.4');
  specificationRule.checks = specificationFields.map(([name, attribute]) => ({ name, status: attribute.value && !attribute.hasConflict ? 'pass' : 'unknown', detail: attribute.value ?? (attribute.hasConflict ? '抓取位置之间数值冲突' : '快照未返回；不能直接算后台缺填') }));
  specificationRule.evidence = specificationFields.flatMap(([, attribute]) => attribute.evidence);
  specificationRule.reason = `已返回：${returnedSpecifications.map(([name]) => name).join('、') || '无'}。未取得一致值：${missingSpecifications.map(([name]) => name).join('、') || '无'}；包装尺寸不替代产品尺寸，缺抓取字段不直接扣后台缺填分。`;
  if (!missingSpecifications.length) setRule('M1-2.4', 3, '材质、产品尺寸、重量和颜色均有明确且一致的属性值，填写完整度计满分；数值准确性另按M1-2.2核查。', specificationRule.evidence);
  const referenceGaps = [
    ['产品尺寸', ['产品尺寸（CM）', '产品尺寸(Inch)--AI']],
    ['重量', ['产品重量（KG）', '产品重量（LB）--AI']],
    ['安装位置', ['安装位置']],
  ].filter(([, fields]) => fields.every(field => !cleanText(sourceFields[field]))).map(([name]) => name);
  if (referenceGaps.length) {
    getRule('M1-2.2').reason = `上架资料第${task.source.row}行缺少${referenceGaps.join('、')}比对基准；已返回的材质等可以逐项核对，但无法确认所有属性准确，整项暂不结算。`;
    getRule('M1-2.2').checks.push({ name: '开发表材质对照', status: referenceMaterial && material.value && referenceMaterial.toLowerCase() === material.value.toLowerCase() ? 'pass' : 'unknown', detail: `开发表：${referenceMaterial || '未提供'}；属性：${material.value || '未返回'}。` });
  }
  if (compareMaterials(referenceMaterial, material.value ?? '').isContradiction) {
    const evidence = [{ source: 'product_source', sheet: task.source.sheet, row: task.source.row, field: '材质', value: referenceMaterial }, ...material.evidence];
    addFinding('source_mismatch', `上架资料材质为${referenceMaterial}，商品属性为${material.value}。`, evidence, '核对实物与上架资料版本，确认后修正错误一方；此项不是标题与属性冲突。');
    getRule('M1-1.3').evidence = evidence;
    getRule('M1-1.3').reason = '发现上架资料与商品材质不一致；需核实实物或确认资料为有效产品事实，不能仅凭两个版本矛盾认定造假。';
    getRule('M1-2.2').evidence = evidence;
    getRule('M1-2.2').reason = '材质对照不一致，待确认资料版本和属性覆盖范围后计分。';
  }
  const brand = getAttribute(product, ['Brand', 'Brand Name']);
  if (brand.value && !brand.hasConflict) {
    setRule('M1-2.3', brand.value === 'DAFOLOGIA' ? 2 : 0, `本批次审计说明第7页明确的正确品牌为DAFOLOGIA；实际品牌为${brand.value}，按完全匹配（区分大小写）核对。未声称另行查询AutoCare。`, brand.evidence);
    getRule('M1-2.3').sourceRefs.push(getPdfSource(7));
  }
  if (title && brand.value && cleanText(product.brand).toLowerCase() === brand.value.toLowerCase()) {
    const escapedBrand = brand.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hasBrandPrefix = new RegExp(`^${escapedBrand}(?:\\s|$|[®™,:-])`, 'i').test(title);
    setRule('M1-3.1', hasBrandPrefix ? 3 : 0, hasBrandPrefix ? '标题以商品品牌开头。' : `标题未以商品品牌 ${brand.value} 开头。`, [titleEvidence, ...brand.evidence]);
  }
  if (title) {
    const lengthResult = scoreTitleLength(title);
    if (lengthResult.points !== null) setRule('M1-3.2', lengthResult.points, `标题${lengthResult.length}个Unicode字符（含空格）。`, [titleEvidence]);
    else getRule('M1-3.2').reason = `标题恰好${lengthResult.length}字符，规则边界有重叠或未定义，待确认。`;
  }
  const warranty = getAttribute(product, ['Manufacturer Warranty Description', 'Warranty Description', 'Warranty']);
  if (warranty.value && /\d+\s*[- ]?\s*(?:month|year)/i.test(warranty.value) && /\bcovers?\b/i.test(warranty.value)) {
    setRule('M1-2.5', 3, '已返回保修期限和保障范围；不额外要求规则未规定的排除条款。', warranty.evidence);
  } else if (warranty.value) {
    getRule('M1-2.5').evidence = warranty.evidence;
    getRule('M1-2.5').reason = '已返回保修文本，完整性需语义核查；未将短语自动等同于未填写。';
    getRule('M1-2.5').pendingType = 'not_reviewed';
  }
  if (Array.isArray(product.bullets) && product.bullets.filter(value => cleanText(value)).length >= 5) {
    setRule('M1-6.1', 1.5, `抓取到${product.bullets.filter(value => cleanText(value)).length}条非空描述，没有缺少五点；超出5条不另造扣分规则。`, [{ path: '/bullets', value: product.bullets }]);
  }
  if (Array.isArray(product.aplus) && product.aplus.some(value => typeof value === 'string' && /^https:\/\//.test(value))) {
    setRule('M1-7.1', 1, `已返回${product.aplus.length}个A+图片资源；图片内文案尚未核查。`, [{ path: '/aplus', value: product.aplus }]);
  }
  const highlight = getAttribute(product, ['Item Highlight', 'Item Highlights']);
  getRule('M1-3.5').evidence = highlight.evidence;
  getRule('M1-3.5').reason = highlight.value ? '已找到明确命名的Item Highlight属性，语句形式待核查。' : '没有明确命名的Item Highlights属性；不把second_title默认映射为该字段。';
  const expectedOes = parsePartNumbers(sourceFields['OE信息分行']);
  const expectedOeForms = parsePartNumberForms(sourceFields['OE信息分行']);
  const expectedMainOes = parsePartNumbers(sourceFields['主OE']);
  const normalizeFitment = value => cleanText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  const fitmentRows = cleanText(sourceFields['适配车型分行']).split(/[;；\n]+/).map(value => value.trim()).filter(Boolean);
  const fitmentAttributes = attributes.filter(attribute => /Part Interchange Info|Vehicle Fitment|Compatible Vehicles|Fitment Information/i.test(attribute.name));
  const fitmentCoverage = fitmentRows.map(value => ({ value, bullets: (product.bullets ?? []).map((text, index) => ({ path: `/bullets/${index}`, value: text })).filter(item => normalizeFitment(item.value).includes(normalizeFitment(value))), attributes: fitmentAttributes.filter(item => normalizeFitment(item.value).includes(normalizeFitment(value))) }));
  const fitmentRule = getRule('M2-2.2.2');
  fitmentRule.evidence = fitmentCoverage;
  fitmentRule.checks.push(...fitmentCoverage.map(item => ({ name: item.value, status: item.bullets.length && item.attributes.length ? 'pass' : 'unknown', detail: `五点${item.bullets.length ? '已找到' : '未逐字找到'}；适配结构化属性${item.attributes.length ? '已找到' : '未逐字找到'}。` })));
  if (fitmentCoverage.length && fitmentCoverage.every(item => item.bullets.length && item.attributes.length)) setRule('M2-2.2.2', 4, `开发适配清单${fitmentCoverage.length}条均在五点和Part Interchange等适配结构化属性中找到；两处共同满足正文与附件位置要求，不再因ST未返回而挂起。位置评分不替代新增排量细节的准确性验证。`, fitmentCoverage);
  getRule('M2-2.2.1').checks.push({ name: '开发清单覆盖', status: fitmentCoverage.length && fitmentCoverage.every(item => item.bullets.length || item.attributes.length) ? 'pass' : 'unknown', detail: `${fitmentCoverage.filter(item => item.bullets.length || item.attributes.length).length}/${fitmentCoverage.length}条在五点或适配属性逐字找到；额外适配声明另行验证。` });
  const textLocations = [{ path: '/title', value: title }, ...(product.bullets ?? []).map((value, index) => ({ path: `/bullets/${index}`, value })), ...attributes.filter(attribute => /(?:OEM|Interchange|Part Number)/i.test(attribute.name)), ...(product.description ? [{ path: '/description', value: product.description }] : [])];
  const oeCoverage = expectedOes.map(oe => ({ oe, locations: textLocations.filter(location => hasPartNumber(location.value, oe)) }));
  const oeFormCoverage = expectedOeForms.map(oe => ({ oe, locations: textLocations.filter(location => parsePartNumberForms(location.value).includes(oe)) }));
  const sourceOeEvidence = [{ source: 'product_source', row: task.source.row, field: '主OE', value: sourceFields['主OE'] }, { source: 'product_source', row: task.source.row, field: 'OE信息分行', value: sourceFields['OE信息分行'] }];
  for (const ruleId of ['M2-2.1.1', 'M2-2.1.2']) {
    const rule = getRule(ruleId);
    const numbers = ruleId === 'M2-2.1.1' ? expectedMainOes : expectedOeForms;
    const coverage = ruleId === 'M2-2.1.1' ? numbers.map(oe => ({ oe, locations: textLocations.filter(location => hasPartNumber(location.value, oe)) })) : oeFormCoverage;
    rule.sourceRefs.push(getPdfSource(16));
    rule.evidence = [...sourceOeEvidence, ...coverage];
    rule.checks.push({ name: ruleId === 'M2-2.1.1' ? '开发表主OE对照' : '开发表OE逐种写法覆盖', status: numbers.length && coverage.every(item => item.locations.length) ? 'pass' : 'unknown', detail: numbers.length ? `${coverage.filter(item => item.locations.length).length}/${numbers.length}项在现有文字找到。` : '开发表未提供该项OE。' });
    rule.reason = numbers.length ? `${rule.checks[0].detail} 正文还要求OE反查有效性，缺少反查记录，所以整项暂不结算；这属于外部证据缺失，不再整项标为规则冲突。` : '开发表未提供OE，缺少内部比对基准和外部反查记录。';
  }
  const hasTitleOe = expectedOes.some(oe => hasPartNumber(title, oe));
  const hasBulletOe = expectedOes.some(oe => (product.bullets ?? []).some(bullet => hasPartNumber(bullet, oe)));
  if (hasTitleOe && hasBulletOe) {
    setRule('M2-2.1.3', 4, '开发清单中的OE同时出现在标题和五点；正文要求至少两处、附件要求规范位置，当前事实同时满足两种口径，计4分。其它位置组合的冲突仍保留。', [...sourceOeEvidence, ...oeCoverage]);
  }
  if (expectedOes.length) addFinding('oe_comparison', `开发表${expectedOes.length}个规范化OE，现有文字中匹配${oeCoverage.filter(item => item.locations.length).length}个；号码写法另逐项保留。A+与主辅图未执行全量OE识别，文字未匹配不直接视为整页缺失。`, oeCoverage, '逐项核对OE写法、适配车型和号码有效性；已匹配不代表完成外部反查。');
  else addFinding('data_gap', '上架资料未提供OE清单，无法核对OE真实性与完整性。', [{ row: task.source.row, field: 'OE信息分行', value: sourceFields['OE信息分行'] }], '补齐当前SKU的OE资料。');
  const searchTerms = task.submissions.map(record => getFieldText(record.fields['后台搜索词（rpa）'])).filter(Boolean);
  const searchTermBytes = searchTerms.map(value => ({ value, bytes: Buffer.byteLength(value, 'utf8') }));
  const auxiliaryImages = [...new Set((product.otherImagesUrl ?? []).filter(url => url && url !== product.imageUrl))];
  getRule('M1-5.2').checks.push({ name: '辅图资源数量', status: auxiliaryImages.length >= 6 ? 'pass' : 'unknown', detail: `排除主图并按URL去重后${auxiliaryImages.length}张；附件要求5张，正文要求6张。场景内容未核查。` });
  const facts = { titleLength: [...title].length, brand: brand.value, material: material.value, referenceMaterial, bsr: parseLastBsr(product), familyCategories, hasVerifiedParentRelation: task.hasVerifiedParentRelation, mainOes: expectedMainOes, oeCoverage, oeFormCoverage, fitmentReference: sourceFields['适配车型分行'] ?? null, imageCount: auxiliaryImages.length + (product.imageUrl ? 1 : 0), auxiliaryImageCount: auxiliaryImages.length, aplusImageCount: product.aplus?.length ?? 0, bulletCount: product.bullets?.length ?? 0, searchTermBytes };
  return { asin: task.asin, sku: task.sku, recordIds: task.recordIds, title, fetchedAt: task.fetchedAt, provenance: { sourceRow: task.source.row, rawResponsePath: task.rawResponsePath, productPointer: task.productPointer, responseSha256: task.responseSha256 }, rules, findings, facts, totals: calculateTotals(rules) };
}
