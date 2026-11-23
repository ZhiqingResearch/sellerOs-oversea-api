// Migrated from the accepted automotive audit script; runtime I/O is injected by the service.
import { cleanText } from './audit-data.mjs';
import { hasPartNumber, parsePartNumbers } from './audit-engine.mjs';
import { hasFitmentStatement } from './cached-attributes.mjs';

export const AUTOMOTIVE_BODY_POLICY = {
  id: 'automotive-body-deduplicated-v1',
  description: '用户确认：标题允许适配车型；OE标题和五点结构采用正文第18页，五点为适配→OE→产品卖点（末点可为适配提醒）。标题品牌/数量仍由CDQ核查；同一字段同一缺陷只保留一处实际扣分，CDQ已扣的标题缺号/超长不在OE再扣。其它未涉及规则沿用原口径；缺证据剔除分母、CDQ60%/OE40%不变。',
};

const VEHICLE = /\b(?:Hyundai|Kia|Ford|Lincoln|Dodge|Ram|Chevrolet|Chevy|GMC|Cadillac|Buick|Nissan|Infiniti|Toyota|Lexus|Honda|Acura|BMW|Mercedes|Benz|Volkswagen|VW|Audi|Jeep|Chrysler|Mazda|Subaru|Volvo|Mitsubishi|Suzuki|Isuzu|Pontiac|Saturn|Scion|Land Rover|Jaguar|Porsche|Fiat)\b/i;
const FEATURE = /\b(?:aluminum|aluminium|plastic|steel|rubber|material|construction|resistan\w*|durab\w*|prevent\w*|protect\w*|regulat\w*|control\w*|maintain\w*|cool\w*|seal\w*|reduc\w*|improv\w*|transfer\w*|absorb\w*|restore\w*|drain\w*|capacity|quarts?|threaded|port|monitor\w*|install\w*|bolt.on|plug.and.play)\b/i;

const FEATURE_SIGNALS = [
  { name: '包装内容/配套部件', pattern: /\b(?:includes?|contains?|comes? with)\b[^.!?]*(?:\b(?:belts?|tensioners?|pulleys?|covers?|gaskets?|hardware|mounts?|brackets?|struts?|connectors?|switch(?:es)?|bolts?|screws?|seals?)\b)/i },
  { name: '原车结构/安装位置匹配', pattern: /\b(?:match(?:es|ing)?|original)\s+(?:(?:the\s+)?original\s+)?(?:mounting\s+(?:design|specifications?)|steering column\s+location|front[- ]left\s+driver\s+door\s+position)/i },
  { name: '电气接口匹配/针脚规格', pattern: /\b(?:matching\s+electrical\s+connections?|electrical\s+connection|\d+[- ]pin\s+(?:plug[- ]in\s+)?connector)\b/i },
  { name: '替换设计与原车系统匹配', pattern: /\b(?:meets?\s+original\s+equipment\s+standards|proper\s+integration\s+with\s+[^.!?]+\bsystem)\b/i },
];

// Every classification keeps the actual paragraph and the matching span.
// Headings alone ("quality", "replacement", "package") do not prove a selling point.
export function analyzeBodyBullet(text, index, coverage = {}) {
  const decide = (role, reason, quote = text ?? '') => ({ role, reason, evidence: [{ path: `/bullets/${index}`, quote }] });
  if (!text?.trim()) return decide('missing', '该条未填写');
  const normalized = text.replace(/^[^A-Za-z]+/, '');
  const heading = normalized.split(/[\]】：:–—]/)[0];
  if (/^(?:OEM?\b|OE\b|Part Number|Reference)/i.test(heading)) return decide('oe', '明确的OE/零件号段落标题', heading);
  if (/^(?:Compatib|Fitment|Fits|Vehicle|Application)/i.test(heading)) return decide('fitment', '明确的车型适配段落标题', heading);
  for (const key of ['material', 'function', 'usage']) {
    const reference = coverage[key]?.find(ref => ref.ref === `listing:bullet:${index}` && ref.quote?.trim() && text.includes(ref.quote) && (key !== 'usage' || FEATURE_SIGNALS.some(signal => signal.pattern.test(ref.quote)) || FEATURE.test(ref.quote)));
    if (reference) return decide('feature', `复用已校验的${key}引用，仅认可当前段落中的实际原文`, reference.quote);
  }
  for (const signal of FEATURE_SIGNALS) {
    const match = text.match(signal.pattern);
    if (match) return decide('feature', signal.name, match[0]);
  }
  const featureMatch = text.match(FEATURE);
  if (featureMatch) return decide('feature', '原文包含具体材质、功能或安装特性', featureMatch[0]);
  if (index === 4 && /(?:verify|check|confirm).*(?:vehicle|fitment|year|model|part number)/i.test(text)) return decide('reminder', '末点包含具体适配核对提醒');
  if (/\b(?:OE|OEM|part numbers?)\b/i.test(text) && parsePartNumbers(text).length) return decide('oe', '原文含OE/零件号说明及具体号码');
  if (hasFitmentStatement(text)) return decide('fitment', '原文含适配表达及明确对象，不依赖品牌白名单');
  return decide('unknown', '原文已取得，但没有可定位的具体产品特性或段落用途证据；不因非空自动认定卖点');
}

export function classifyBodyBullet(text, index, coverage = {}) {
  return analyzeBodyBullet(text, index, coverage).role;
}

// Only identical defect keys are deduplicated, not merely shared evidence text.
// Confirmed sub-issues own their deduction even when other fields lack evidence.
export function deduplicateBodyIssues(issues, owners) {
  const seen = new Map(owners.map(owner => [owner.key, owner]));
  return issues.map(issue => {
    const owner = seen.get(issue.key);
    if (owner) return { ...issue, appliedPoints: 0, suppressedBy: owner.ruleId };
    seen.set(issue.key, issue);
    return { ...issue, appliedPoints: issue.points, suppressedBy: null };
  });
}

export function applyAutomotiveBodyPolicy(result, task) {
  const get = id => result.rules.find(rule => rule.ruleId === id);
  const title = cleanText(task.product.title);
  const bullets = task.product.bullets ?? [];
  const titleEvidence = [{ source: 'listing', path: '/title', value: title }];
  const owners = [];
  const changes = [];
  const isDeducted = id => (get(id)?.status === 'fail' && Number.isFinite(get(id).earnedPoints)) || get(id)?.confirmedIssues?.some(issue => issue.deductionPoints > 0 && issue.evidence?.length);
  if (isDeducted('M1-3.1')) owners.push({ key: 'title:brand', ruleId: 'M1-3.1' });
  if (isDeducted('M1-3.2')) owners.push({ key: 'title:length', ruleId: 'M1-3.2' });
  if (isDeducted('M1-3.3')) {
    for (const check of get('M1-3.3').checks ?? []) {
      if (check.status === 'fail' && ['零件号', '数量'].includes(check.name)) owners.push({ key: check.name === '零件号' ? 'title:part-number' : 'title:quantity', ruleId: 'M1-3.3' });
    }
  }
  if (isDeducted('M1-6.1')) {
    for (let index = bullets.length; index < 5; index++) owners.push({ key: `bullet:${index}:missing`, ruleId: 'M1-6.1' });
  }

  function settle(ruleId, checks, issues, evidence, description) {
    const rule = get(ruleId);
    const scoredIssues = deduplicateBodyIssues(issues, owners);
    const deduction = Math.min(rule.maxPoints, scoredIssues.reduce((sum, issue) => sum + issue.appliedPoints, 0));
    const hasUnknown = checks.some(check => check.status === 'unknown');
    const points = hasUnknown ? null : rule.maxPoints - deduction;
    const details = scoredIssues.map(issue => `${issue.message}：${issue.suppressedBy ? `由${issue.suppressedBy}计分，本项不重复扣` : `扣${issue.appliedPoints}分`}`).join('；');
    const reason = `${description}${details ? ` ${details}。` : hasUnknown ? ' 尚有要素缺少核查依据。' : ' 已取得内容满足本项，不扣分。'}${hasUnknown ? ' 缺证据部分剔除，已确认扣分保留计入。' : ''}`;
    changes.push({ ruleId, previousPoints: rule.earnedPoints, points, reason });
    Object.assign(rule, {
      earnedPoints: points, status: hasUnknown ? 'unknown' : points === rule.maxPoints ? 'pass' : 'fail',
      checks, reason, evidence, pendingType: hasUnknown ? 'missing_evidence' : null,
      blockers: hasUnknown ? [{ type: 'missing_evidence', message: reason }] : [],
      confirmedIssues: hasUnknown ? scoredIssues.filter(issue => issue.appliedPoints > 0).map(issue => ({ key: issue.key, message: issue.message, deductionPoints: issue.appliedPoints, evidence, recommendation: issue.message })) : [],
      scoringIssues: scoredIssues, decisionMethod: 'cached_body_rules', scoringPolicyId: AUTOMOTIVE_BODY_POLICY.id,
      sourceRefs: [{ file: '审计说明-完整.pdf', page: ruleId === 'M1-3.4' ? 9 : 18 }],
    });
    delete rule.evidenceDetails;
    if (hasUnknown) rule.evidenceDetails = { knownFacts: checks.filter(check => check.status !== 'unknown').map(check => check.detail), missingData: [], interpretationLimits: checks.filter(check => check.status === 'unknown').map(check => check.detail) };
    return rule;
  }

  const allowed = settle('M1-3.4', [{ name: '标题原文', status: title ? 'pass' : 'unknown', detail: title || '未取得标题原文' }], [], titleEvidence, '用户明确覆盖原禁车型条款：标题允许带适配车型，保留原3分预算，不因车型出现扣分；适配真实性与标题属性冲突仍由原规则独立核查。');
  allowed.name = '标题适配车型（允许）';

  const mainOes = parsePartNumbers(task.source.fields['主OE']);
  const partCheck = get('M1-3.3').checks?.find(check => check.name === '零件号');
  const vehicleClaim = result.snapshotReview?.review?.titleAttributes?.claims?.some(claim => /车型|适配|适用/.test(claim.claim) && claim.evidence?.some(ref => ref.ref === 'listing:title'));
  const hasFitment = VEHICLE.test(title) || Boolean(vehicleClaim) || hasFitmentStatement(title);
  const hasPreposition = /\b(?:for|fits?|compatible with)\s+.+/i.test(title);
  const hasMainOe = mainOes.some(oe => hasPartNumber(title, oe));
  const titleChecks = [
    { name: '主OE', status: !title || !mainOes.length ? 'unknown' : hasMainOe ? 'pass' : 'fail', detail: `开发表主OE：${mainOes.join('、') || '未提供'}；标题：${title || '未取得'}。其它替换OE不冒充主OE。` },
    { name: '适配车型', status: !title ? 'unknown' : hasFitment ? 'pass' : 'fail', detail: hasFitment ? '标题已包含适配车型表达' : '标题未找到适配车型表达' },
    { name: '适配介词', status: !title ? 'unknown' : !hasFitment || hasPreposition ? 'pass' : 'fail', detail: hasPreposition ? '标题包含for/Fits/Compatible with表达' : '有车型时需适配介词；无车型不再叠加缺介词' },
    { name: '标题长度', status: !title ? 'unknown' : [...title].length > 75 ? 'fail' : 'pass', detail: `${[...title].length}字符，正文上限75` },
  ];
  const titleIssues = [];
  if (title && mainOes.length && !hasMainOe) titleIssues.push({ key: partCheck?.status === 'fail' ? 'title:part-number' : 'title:main-oe', ruleId: 'M2-2.3.1', points: 0.5, message: `标题缺少开发主OE ${mainOes.join('、')}` });
  if (title && !hasFitment) titleIssues.push({ key: 'title:fitment', ruleId: 'M2-2.3.1', points: 0.5, message: '标题缺少主适配车型' });
  if (title && hasFitment && !hasPreposition) titleIssues.push({ key: 'title:preposition', ruleId: 'M2-2.3.1', points: 0.5, message: '适配车型缺少for/Fits/Compatible with介词' });
  if ([...title].length > 75) titleIssues.push({ key: 'title:length', ruleId: 'M2-2.3.1', points: 0.5, message: '标题超过75字符' });
  settle('M2-2.3.1', titleChecks, titleIssues, [...titleEvidence, { source: 'development', row: task.source.row, field: '主OE', value: task.source.fields['主OE'] }], '正文第18页：主OE、主适配车型、适配介词和标题长度分别检查，每类0.5分。品牌与数量由CDQ原项核查，本项不再按缺品牌/数量整体扣2分。');

  const bulletAnalyses = Array.from({ length: 5 }, (_, index) => analyzeBodyBullet(bullets[index], index, result.semantic?.bulletCoverage));
  const roles = bulletAnalyses.map(analysis => analysis.role);
  const hasOeBullet = roles.includes('oe');
  const hasFitmentBullet = roles.includes('fitment');
  const hasUnknownRole = roles.includes('unknown');
  const bulletChecks = roles.map((role, index) => ({ name: `第${index + 1}点`, status: role === 'unknown' ? 'unknown' : 'pass', detail: `${role}；${bulletAnalyses[index].reason}；${[...(bullets[index] ?? '')].length}字符；${bullets[index] ?? '未填写'}`, evidence: bulletAnalyses[index].evidence }));
  const bulletIssues = [];
  const addBulletIssue = (key, message) => bulletIssues.push({ key, ruleId: 'M2-2.3.2', points: 0.5, message });
  for (let index = 0; index < 5; index++) {
    if (roles[index] === 'missing') addBulletIssue(`bullet:${index}:missing`, `第${index + 1}点缺失`);
  }
  if (!hasFitmentBullet && !hasUnknownRole && roles[0] !== 'missing') addBulletIssue('bullets:fitment', '五点缺少适配车型');
  if (!hasOeBullet && !hasUnknownRole && roles[1] !== 'missing') addBulletIssue('bullets:oe', '五点缺少OE');
  const featureCount = roles.filter(role => ['feature', 'reminder'].includes(role)).length;
  const missingSlots = roles.slice(2).filter(role => role === 'missing').length;
  if (!hasUnknownRole) for (let index = featureCount + missingSlots; index < 3; index++) addBulletIssue(`bullets:feature:${index}`, `产品卖点/末点适配提醒不足3条（现有${featureCount}条）`);
  const hasWrongOrder = roles.every(role => !['missing', 'unknown'].includes(role)) && hasOeBullet && hasFitmentBullet && (roles[0] !== 'fitment' || roles[1] !== 'oe' || roles.slice(2).some((role, index) => role !== 'feature' && !(index === 2 && role === 'reminder')));
  if (hasWrongOrder) addBulletIssue('bullets:order', '五点未按适配→OE→产品卖点排列');
  bullets.slice(0, 5).forEach((bullet, index) => { if ([...bullet].length > 250) addBulletIssue(`bullet:${index}:length`, `第${index + 1}点${[...bullet].length}字符，超过250`); });
  const bulletRule = settle('M2-2.3.2', bulletChecks, bulletIssues, bullets.map((value, index) => ({ source: 'listing', path: `/bullets/${index}`, value })), '正文第18页：适配→OE→产品卖点，末点可为适配提醒；缺项每项0.5分，错序一次0.5分，每点超过250字符扣0.5分，合计最多扣本项2分。不强制材质→功能→安装顺序。');
  bulletRule.classifierVersion = 'evidence-spans-v2';

  result.scoringPolicy = { ...result.scoringPolicy, ...AUTOMOTIVE_BODY_POLICY, decisions: [...(result.scoringPolicy?.decisions ?? []).filter(item => !changes.some(change => change.ruleId === item.ruleId)), ...changes] };
  result.deduplication = { policy: '同一来源字段同一缺陷只扣一次；保留已有CDQ扣分，OE只核查正文的独立专业要求。缺证据项的已确认扣分仍保留归属，纯缺口不占用扣分归属。', owners, issues: ['M2-2.3.1', 'M2-2.3.2'].flatMap(id => get(id).scoringIssues) };
  return result;
}
