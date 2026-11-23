// Migrated from the accepted automotive audit script; runtime I/O is injected by the service.
import { getAttributes, getAttribute, cleanText } from './audit-data.mjs';
import { compareMaterials, hasPartNumber } from './audit-engine.mjs';

import { WORD_LISTS, VOCABULARY_SOURCE } from './reviewed-vocabulary.mjs';

export function scanWords(texts, words) {
  const hits = [];
  for (const source of texts) {
    for (const word of words) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`\\b${escaped}\\b`, 'gi');
      for (const match of source.text.matchAll(pattern)) {
        const context = source.text.slice(Math.max(0, match.index - 60), match.index + match[0].length + 100);
        hits.push({ source: source.id, term: match[0], context, isContextualReference: /^(original|factory)$/i.test(word) && /(?:verify your original part number|replacement for the factory|compared to the factory)/i.test(context) });
      }
    }
  }
  return hits;
}

export function finalizeDiagnostics(result, task) {
  const getRule = id => result.rules.find(rule => rule.ruleId === id);
  const attributes = getAttributes(task.product);
  const material = getAttribute(task.product, ['Material', 'Material Type']);
  const referenceMaterial = cleanText(task.source.fields['材质']);
  const quantity = getAttribute(task.product, ['Number of Items', 'Item Package Quantity']);
  const referenceQuantity = cleanText(task.source.fields['包装数量']);
  const coreRule = getRule('M1-1.3');
  coreRule.checks.push(
    { name: '材质对照', status: material.value && referenceMaterial && !compareMaterials(material.value, referenceMaterial).isContradiction && material.value.toLowerCase() === referenceMaterial.toLowerCase() ? 'pass' : 'unknown', detail: `属性${material.value ?? '未返回'}；开发表${referenceMaterial || '未提供'}。` },
    { name: '包装数量', status: quantity.value && referenceQuantity && /^\d+$/.test(quantity.value) && quantity.value === referenceQuantity ? 'pass' : 'unknown', detail: `Number of Items/包装数量${quantity.value ?? '未返回'}；开发表${referenceQuantity || '未提供'}。` },
    { name: '开发OE覆盖', status: result.facts.oeCoverage.length && result.facts.oeCoverage.every(item => item.locations.length) ? 'pass' : 'unknown', detail: `${result.facts.oeCoverage.filter(item => item.locations.length).length}/${result.facts.oeCoverage.length}个开发OE已找到，额外OE有效性需独立证明。` },
  );
  const oeFindings = result.semantic?.findings?.filter(item => item.type === 'oe_difference') ?? [];
  if (coreRule.status === 'unknown') {
    coreRule.reason = `已完成材质、包装数量和开发OE的现有证据对照。${oeFindings.map(item => item.message).join(' ')} ${getRule('M1-2.2').reason} 未发现可确定的核心参数造假；无法验证的额外声明仍保留。`;
    coreRule.evidence.push(...oeFindings.flatMap(item => item.evidence));
  }
  const texts = [{ id: 'title', text: result.title }, ...(task.product.bullets ?? []).map((text, index) => ({ id: `bullet:${index}`, text })), ...attributes.map(item => ({ id: item.path, text: item.value })), ...(task.product.description ? [{ id: 'description', text: task.product.description }] : [])];
  if (result.snapshotReview?.status === 'success') texts.push(...result.snapshotReview.review.images.filter(image => image.isReadable).map(image => ({ id: image.imageId, text: image.text })));
  if (result.snapshotReview?.status === 'success') {
    for (const finding of result.findings.filter(item => item.type === 'oe_comparison')) {
      finding.message = finding.message.replace('A+与主辅图未执行全量OE识别，文字未匹配不直接视为整页缺失。', `已补充读取${result.snapshotReview.review.images.length}张图片OCR；本项覆盖统计仍按可定位的文字字段，不将图片文字识别冒充OE有效性反查。`);
    }
    getRule('M1-7.1').reason = `已返回${task.product.aplus.length}个A+图片资源，内容检查结果见M1-7.2至M1-7.5。`;
  }
  const seen = new Set();
  const uniqueTexts = texts.filter(item => { if (seen.has(item.text)) return false; seen.add(item.text); return true; });
  for (const [ruleId, words] of Object.entries(WORD_LISTS)) {
    const rule = getRule(ruleId);
    const hits = scanWords(uniqueTexts, words);
    const uncertainHits = hits.filter(hit => !hit.isContextualReference);
    rule.checks = [{ name: '文档列明词表及现有文案扫描', status: uncertainHits.length ? 'unknown' : 'pass', detail: `已按${words.length}个文档列明词条检查标题、五点、返回属性${result.snapshotReview?.status === 'success' ? `及${result.snapshotReview.review.images.length}张图片OCR` : ''}；命中${hits.length}处，其中${hits.filter(hit => hit.isContextualReference).length}处为原车/旧件对照语境，不能机械判成认证或商标违规。` }];
    rule.evidence = [{ dictionary: { source: '审计说明-完整.pdf', page: ruleId === 'M2-2.4.3' ? 20 : 19, isCompleteForListedTerms: true, terms: words, verifiedSource: VOCABULARY_SOURCE }, scannedSources: uniqueTexts.map(item => item.id), hits }];
    rule.pendingType = 'missing_evidence';
    rule.reason = `${rule.checks[0].detail} ${uncertainHits.length ? '其它命中需结合具体语境验证。' : '已扫描范围未发现明确风险命中。'}完整词表已从网页核对，仍未取得真实后台ST，无法声称全部字段扫描完成；扣分口径仅在确定命中后才影响结算。`;
  }
  // Explicitly preserve both outcomes when the current evidence makes a difference.
  const bulletRule = getRule('M2-2.3.2');
  const bullets = task.product.bullets ?? [];
  bulletRule.checks = bullets.map((text, index) => ({ name: `第${index + 1}点`, status: 'pass', detail: `${[...text].length}字符；${text.slice(0, 100)}` }));
  if (bullets.length >= 2) bulletRule.reason = `已检查现有五点顺序：第1点为${bullets[0].slice(0, 55)}；第2点为${bullets[1].slice(0, 55)}。正文要求适配→OE，附件要求OE→适配；这会改变本样例判分，保留为口径选择。${bullets.some(text => [...text].length > 250) ? '另有单点超过正文250字符限制，具体字符数已列出。' : ''}`;
  const titleRule = getRule('M2-2.3.1');
  titleRule.checks = [{ name: '标题当前结构', status: getRule('M1-3.3').status, detail: `${result.title}；品牌、数量等要素的逐项结论见M1-3.3。` }, { name: '开发主OE在标题中', status: !result.facts.mainOes.length ? 'unknown' : result.facts.mainOes.some(oe => hasPartNumber(result.title, oe)) ? 'pass' : 'fail', detail: `开发主OE为${result.facts.mainOes.join('、') || '未提供'}；标题按完整号码边界比对。` }];
  const activePolicyRules = new Set(['M1-3.4', 'M1-5.2', 'M2-2.3.1', 'M2-2.3.2']);
  for (const rule of result.rules.filter(item => item.status === 'unknown')) {
    if (activePolicyRules.has(rule.ruleId)) rule.pendingType = 'rule_conflict';
    else if (rule.checks?.length && rule.pendingType === 'not_reviewed') rule.pendingType = 'missing_evidence';
    else if (rule.pendingType === 'rule_conflict') rule.pendingType = 'missing_evidence';
    const differences = (rule.blockers ?? []).filter(item => item.type === 'rule_conflict');
    rule.ruleDifferences = differences;
    rule.blockers = rule.pendingType === 'rule_conflict' && differences.length ? differences : [{ type: rule.pendingType, message: rule.reason }];
  }
  const pending = result.rules.filter(rule => rule.status === 'unknown');
  result.diagnostics = {
    policyDecisions: [
      { key: 'title', title: '标题车型与汽配标题结构', ruleIds: ['M1-3.4', 'M2-2.3.1'], description: '正文M1禁车型，正文M2要求车型，附件M2要求数量。当前标题有车型但无品牌/数量，两套标准对同一标题的要求不同。' },
      { key: 'auxiliary_count', title: '辅图数量门槛', ruleIds: ['M1-5.2'], description: getRule('M1-5.2').reason },
      { key: 'bullet_order', title: '五点固定顺序', ruleIds: ['M2-2.3.2'], description: bulletRule.reason },
    ].filter(group => group.ruleIds.some(id => pending.some(rule => rule.ruleId === id && rule.pendingType === 'rule_conflict'))),
    dataGaps: pending.filter(rule => rule.pendingType !== 'rule_conflict').map(rule => ({ ruleId: rule.ruleId, name: rule.name, reason: rule.reason, checks: rule.checks })),
    confirmedIssues: result.rules.flatMap(rule => (rule.confirmedIssues ?? []).map(issue => ({ ruleId: rule.ruleId, ...issue }))),
    statement: '需要选择口径的事项与客观数据缺口分开；代码已执行的部分检查保留在单项证据中。缺口不当成运营违规，也不影响其它项核查。',
  };
  return result;
}
