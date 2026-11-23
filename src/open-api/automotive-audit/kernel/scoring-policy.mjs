// Migrated from the accepted automotive audit script; runtime I/O is injected by the service.
import { calculateTotals, hasPartNumber } from './audit-engine.mjs';

export const SCORING_POLICY = {
  id: 'attachment-scoring-20261019',
  status: 'test_review',
  description: '用户明确要求优先；分值和扣分采用评分附件，正文补充核查方法。正文额外条件保留观察，不另行增加附件扣分或阻断条件。',
};

export function applyScoringPolicy(result, task, catalog) {
  const getRule = id => result.rules.find(rule => rule.ruleId === id);
  const decisions = [];
  function settle(ruleId, points, reason) {
    const rule = getRule(ruleId);
    decisions.push({ ruleId, previousPoints: rule.earnedPoints, points, reason });
    Object.assign(rule, { earnedPoints: points, status: points === rule.maxPoints ? 'pass' : 'fail', pendingType: null, blockers: [], reason, scoringPolicyId: SCORING_POLICY.id });
  }
  // The attachment explicitly deducts for missing part number and quantity here.
  // The brand-prefix deduction belongs to M1-3.1; do not invent a second brand deduction.
  const titleElements = getRule('M1-3.3').checks;
  const partNumber = titleElements.find(check => check.name === '零件号');
  const quantity = titleElements.find(check => check.name === '数量');
  if ([partNumber, quantity].every(check => check && ['pass', 'fail'].includes(check.status))) {
    settle('M1-3.3', 4 - [partNumber, quantity].filter(check => check.status === 'fail').length, '按附件扣分细则：零件号、数量每缺1项扣1分。品牌开头由M1-3.1独立计分；四要素检查事实仍保留。');
  }
  const claims = result.snapshotReview?.review?.titleAttributes?.claims ?? [];
  const hasTitleFitment = claims.some(claim => /车型|年份/.test(claim.claim) && claim.evidence.some(item => item.ref === 'listing:title' && /\b(?:19|20)\d{2}\b/.test(item.quote)));
  if (hasTitleFitment) settle('M1-3.4', 0, '标题包含车型和年份，按附件“无车型信息”项得0分；不同时采用正文M2要求标题包含车型的冲突条件。');
  const auxiliary = getRule('M1-5.2');
  const auxiliaryScore = auxiliary.candidates?.find(candidate => candidate.source.startsWith('附件'))?.earnedPoints;
  if (Number.isFinite(auxiliaryScore)) settle('M1-5.2', auxiliaryScore, `按附件辅图至少5张并包含使用场景的标准结算；本次${result.facts.auxiliaryImageCount}张，场景核查见明细。正文6张门槛不参与本版扣分。`);
  const mainImageRule = getRule('M1-5.1');
  let mainImageScore = mainImageRule.candidates?.find(candidate => candidate.source === '评分附件')?.earnedPoints;
  const originalImage = result.snapshotReview?.originalMainImage;
  const metrics = originalImage?.metrics;
  if (metrics && result.snapshotReview.review.main.background === 'white' && metrics.dominantFraction >= 0.8 && metrics.boxes.every(item => item.occupancy !== null && item.occupancy >= 0.87 && item.occupancy < 0.99) && originalImage.technical.format === 'jpeg') {
    const isExactWhite = metrics.dominantRgb.every(value => value === 255);
    const hasEnoughPixels = Math.max(metrics.width, metrics.height) >= 1000;
    mainImageScore = 3 - (isExactWhite ? 0 : 1) - (hasEnoughPixels ? 0 : 1);
    mainImageRule.evidence.push({ source: 'source_image_pixel_analysis', sha256: originalImage.sha256, metrics });
    mainImageRule.checks = mainImageRule.checks.filter(check => !['主图背景', '商品占比'].includes(check.name));
    mainImageRule.checks.push(
      { name: '主图背景', status: isExactWhite ? 'pass' : 'fail', detail: `源图边缘${metrics.borderPixels}个像素中，主色RGB(${metrics.dominantRgb.join(',')})占${(metrics.dominantFraction * 100).toFixed(1)}%；按正文明确的纯白RGB(255,255,255)检测，附件非纯白扣1分。图像视觉接近白色不替代像素判据。` },
      { name: '商品占比', status: 'pass', detail: `源图4种前景分离阈值测得长边占比${(Math.min(...metrics.boxes.map(item => item.occupancy)) * 100).toFixed(1)}%–${(Math.max(...metrics.boxes.map(item => item.occupancy)) * 100).toFixed(1)}%，均满足85%要求。` },
    );
  }
  if (Number.isFinite(mainImageScore)) settle('M1-5.1', mainImageScore, '按附件JPEG、纯白背景、商品占比、最长边像素结算；DPI仅保留观察，不阻断附件计分。');
  else if (mainImageRule.checks.length) mainImageRule.reason = `按附件检查JPEG、纯白背景、商品占比、最长边像素。尚不能定论的条件：${mainImageRule.checks.filter(check => ['文件格式', '主图背景', '商品占比', '最长边像素'].includes(check.name) && check.status === 'unknown').map(check => `${check.name}（${check.detail}）`).join('；')}。DPI不作为附件计分前置条件。`;
  for (const ruleId of ['M2-2.1.1', 'M2-2.1.2']) {
    const rule = getRule(ruleId);
    if (rule.checks[0]?.status === 'pass') settle(ruleId, 4, `${rule.checks[0].detail} 按附件完成与开发表主OE/清单覆盖对照，计4分。未执行外部反查，不宣称已验证OE权威有效性；外部反查不作为本版附件计分前置条件。`);
  }
  if (titleElements.some(check => ['品牌', '零件号', '产品名称', '数量'].includes(check.name) && check.status === 'fail')) {
    settle('M2-2.3.1', 0, '按附件要求品牌＋零件号＋产品名称＋数量；标题缺少品牌或数量，结构不规范扣2分。不采用正文含车型的冲突结构。');
  }
  const bullets = task.product.bullets ?? [];
  if (bullets.length >= 2 && result.facts.oeCoverage.length && !result.facts.oeCoverage.some(item => hasPartNumber(bullets[0], item.oe)) && result.facts.oeCoverage.some(item => hasPartNumber(bullets[1], item.oe)) && /^.*Compatibility:/i.test(bullets[0])) {
    settle('M2-2.3.2', 0, '按附件固定顺序OE→适配→材质规格→功能→安装；当前第1点适配、第2点OE，结构不规范扣2分。正文250字符和相反顺序仅保留观察，不叠加扣分。');
  }
  const gapReasons = {
    'M1-2.1': '未返回后台必填字段全集及实际空白状态；页面未展示不能当作后台未填。取得字段状态后按附件每缺1项扣1分、最多扣6分。',
    'M1-5.3': '已读取图片，但没有制作来源证据，不能判断哪些图片由AI生成。按附件对AI生成图片检查标注，不再保留人物范围口径选择。',
    'M1-8.1': '提交表后台搜索词为空且爬虫backendKeywords为空数组，无法确定真实后台ST。取得原文后按附件逗号/大写扣1.5、促销词扣1、超249字节扣3，类别内不重复、类别间累加。',
    'M2-2.3.3': '没有真实后台ST，暂不能检查附件要求的OE＋车型词＋功能词＋品牌词结构。',
  };
  for (const rule of result.rules) {
    const sourceRule = catalog.rules.find(item => item.ruleId === rule.ruleId);
    rule.dimension = sourceRule.original['评分维度'];
    if (rule.status !== 'unknown') continue;
    if (gapReasons[rule.ruleId]) rule.reason = gapReasons[rule.ruleId];
    if (rule.ruleId === 'M2-2.2.1') rule.reason = rule.reason.replace(/ 如确认有错项.*$/, ' 尚无额外排量声明的核实依据；确认错误后按附件每处扣1分。');
    if (rule.ruleId.startsWith('M2-2.4.')) rule.reason = rule.reason.replace('；扣分口径仅在确定命中后才影响结算。', '；确认违规命中后按附件扣满该项。');
    if (rule.reason.includes('尚未选定计分口径。')) {
      const evidenceGap = rule.reason.split('尚未选定计分口径。').at(-1);
      rule.reason = `按附件“${sourceRule.original['评分标准']}”核查。${evidenceGap || '当前输入尚不足以完成该项内容核查，未赋分。'}`;
    }
    rule.pendingType = 'missing_evidence';
    rule.blockers = [{ type: 'missing_evidence', message: rule.reason }];
  }
  result.scoringPolicy = { ...SCORING_POLICY, decisions };
  result.diagnostics.policyDecisions = [];
  result.diagnostics.dataGaps = result.rules.filter(rule => rule.status === 'unknown').map(rule => ({ ruleId: rule.ruleId, name: rule.name, reason: rule.reason, checks: rule.checks }));
  result.totals = calculateTotals(result.rules);
  return result;
}
