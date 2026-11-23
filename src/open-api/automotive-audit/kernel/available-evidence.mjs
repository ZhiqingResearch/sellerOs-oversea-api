// Migrated from the accepted automotive audit script; runtime I/O is injected by the service.
import { getFieldText, cleanText } from './audit-data.mjs';
import { getCachedAttribute as getAttribute, getCachedAttributes as getAttributes, hasFitmentStatement } from './cached-attributes.mjs';
import { hasImageTextEvidence } from './cached-image-evidence.mjs';
import { hasPartNumber, parsePartNumbers, parseMaterials } from './audit-engine.mjs';
import { scanWords } from './audit-diagnostics.mjs';
import { WORD_LISTS } from './reviewed-vocabulary.mjs';
import { addEvidenceDetails } from './evidence-details.mjs';

const VEHICLE_NAMES = /\b(?:Hyundai|Kia|Ford|Lincoln|Dodge|Ram|Chevrolet|Chevy|GMC|Cadillac|Buick|Nissan|Infiniti|Toyota|Lexus|Honda|Acura|BMW|Mercedes|Benz|Volkswagen|VW|Audi|Jeep|Chrysler|Mazda|Subaru|Volvo|Mitsubishi|Suzuki|Isuzu|Pontiac|Saturn|Scion|Peugeot|Renault|Citroen|Land Rover|Jaguar|Porsche|Fiat)\b/i;
const QUANTITY = /\b(?:pack\s+of\s+\d+|\d+\s*[- ]?(?:pack|packs|pcs|pieces|count|pc)|single\s+(?:piece|pack))\b/i;
const MATERIAL = /\b(?:alumin(?:um|ium)|plastic|steel|rubber|copper|brass|nylon|polyamide|polypropylene|silicone|polyester|ABS|metal|composite|iron|alloy)\b/i;
const FITMENT = /\b(?:compatible with|fits?(?: for)?|fitment|suitable for|designed for)\b/i;
const FUNCTION = /\b(?:prevent|protect|regulat|control|maintain|cool|seal|resist|reduce|improve|transfer|absorb|restore|shift|drain|durab|corrosion|leak)/i;
const INSTALLATION = /\b(?:install|installation|plug.and.play|direct replacement|replace|mount|bolt.on)\b/i;

function getBulletCategory(text) {
  const heading = text.replace(/^[^A-Za-z]+/, '').split(/[:–—]/)[0];
  if (/^(?:OEM?|OE|Part Number|Reference)/i.test(heading)) return 'oe';
  if (/^(?:Compatib|Fitment|Fits|Vehicle|Application)/i.test(heading)) return 'fitment';
  if (/^(?:Install|Easy Install|Simple Install|Complete Kit|Package)/i.test(heading)) return 'installation';
  if (/^(?:Material|Premium|Durable|Quality)/i.test(heading) && MATERIAL.test(text)) return 'material';
  if (/\b(?:OE|OEM|part numbers?)\b/i.test(text)) return 'oe';
  if (FITMENT.test(text) && VEHICLE_NAMES.test(text)) return 'fitment';
  if (MATERIAL.test(text)) return 'material';
  if (/\b(?:installation|install|plug.and.play|bolt.on)\b/i.test(text)) return 'installation';
  return FUNCTION.test(text) ? 'function' : 'unclassified';
}

export function classifyWordHit(hit, ruleId) {
  const text = hit.context;
  const term = hit.term.toLowerCase();
  if (hit.isContextualReference) return { verdict: 'reference', reason: '原车/旧件或对照编号语境，不是本产品原厂身份声明' };
  if (ruleId === 'M2-2.4.2') {
    if (/\b(?:not|never|no)\s+(?:EPA|CARB|California|50.State)/i.test(text)) return { verdict: 'reference', reason: '明确否定认证/合法性，不是认证声明' };
    return { verdict: 'violation', reason: '可见文案出现文档列明的认证/合法性声明' };
  }
  if (ruleId === 'M2-2.4.1') {
    if (/\b(?:EGR|DPF|DOC|SCR|DEF|cat(?:alytic)?|CEL|MIL|emissions?)\b/i.test(text) && /delete|bypass|remov|block.?off|defeat|eliminat|catless|de.cat|emulator/i.test(text)) return { verdict: 'violation', reason: '排放系统对象与移除/屏蔽含义同时出现' };
    if (!/\b(?:EGR|DPF|DOC|SCR|DEF|emissions?|catalytic|exhaust)\b/i.test(text) &&
      (/\bON[- ]OFF[- ]ON\b/i.test(text) || /\boff[- ]road\s+(?:conditions|environments)|(?:for|in)\s+off[- ]road\b/i.test(text) || /(?:pry tool|crowbar|installation|install|scratch.free|damage.free|removal tool)/i.test(text) && /remov/i.test(term))) {
      return { verdict: 'reference', reason: '原文为开关状态、使用环境或普通安装拆卸，不是排放系统删除/绕过声明' };
    }
    if (/^(?:off|remove|removal|delete)$/.test(term) && /\b(?:engine|bolt|screw|hose|cover|battery|drain|old|worn|damaged|turn|switch|coolant|pan)\b/i.test(text) && !/\b(?:EGR|DPF|DOC|SCR|DEF|emission|catalytic)\b/i.test(text)) return { verdict: 'reference', reason: '普通维修拆装/关闭发动机语境，未描述排放系统篡改' };
  }
  if (ruleId === 'M2-2.4.3' && /^(?:original|factory)$/.test(term)) {
    if (!/\b(?:genuine|authentic|original\s+OEM)\b/i.test(text) && /\b(?:original\s+(?:OE\s+number|equipment\s+standards|cable\s+size|switch\s+configuration|control\s+layout|switch\s+is\s+faulty|specs)|factory[- ](?:style\s+installation|like\s+fit|checked\s+(?:quality|construction))|existing\s+factory\s+wiring)\b/i.test(text)) {
      return { verdict: 'reference', reason: '原文明确为原件规格/线路/编号对照、匹配安装或制造质检，不是本商品原厂身份声明' };
    }
    if (/\b(?:install|mount|reuse|using)\b.{0,30}\boriginal\s+(?:bolts?|screws?|fasteners?)\b/i.test(text)) return { verdict: 'reference', reason: '安装时沿用原车紧固件，不宣称本商品为原厂产品' };
    if (/\b(?:your original|original part number|original equipment number|factory thermostat|factory pan|factory transmission|factory unit|factory components?|factory specifications?|original specifications?|original design|original fit|original performance|original function|factory fit|factory performance|factory mounting|factory location|factory.install|OE.?style|OEM.?style)\b/i.test(text) || /(?:replacement for|replaces?|compared to|matches?|restore|same as|verify|check|confirm).{0,45}\b(?:original|factory)\b/i.test(text)) return { verdict: 'reference', reason: '原件对照、替换或性能匹配语境，不将其直接当作原厂商品声明' };
    if (/\b(?:genuine|original|factory)\s+(?:OEM|brand.new|authentic|product|part)\b/i.test(text)) return { verdict: 'violation', reason: '直接宣称商品原厂/正品身份，符合文档列明的禁用语境' };
  }
  return { verdict: 'unresolved', reason: '现有局部上下文不能唯一确定含义；保留具体命中，不推定违规' };
}

// Uses only the current task and previously validated model observations.
// It never imports a provider or makes a network request.
export function applyAvailableEvidence(result, task) {
  const get = id => result.rules.find(rule => rule.ruleId === id);
  const attributes = getAttributes(task.product);
  const title = cleanText(task.product.title);
  const bullets = task.product.bullets ?? [];
  const titleEvidence = { source: 'listing', path: '/title', value: title };
  const bulletEvidence = bullets.map((value, index) => ({ source: 'listing', path: `/bullets/${index}`, value }));
  const observations = [];
  function settle(id, points, reason, evidence) {
    const rule = get(id);
    Object.assign(rule, { earnedPoints: points, status: points === rule.maxPoints ? 'pass' : 'fail', reason, evidence, blockers: [], pendingType: null, decisionMethod: 'available_evidence', confirmedIssues: [] });
    observations.push({ ruleId: id, points, reason });
  }
  function limit(id, reason, checks, evidence, issues = []) {
    Object.assign(get(id), { status: 'unknown', earnedPoints: null, reason, checks, evidence, confirmedIssues: issues, pendingType: 'missing_evidence', blockers: [{ type: 'missing_evidence', message: reason }], decisionMethod: 'available_evidence' });
  }

  const titleReview = result.ruleReview?.rules?.find(rule => rule.ruleId === 'M1-3.3');
  const brand = getAttribute(task.product, ['Brand', 'Brand Name']);
  const partTokens = parsePartNumbers(title).filter(value => value.length >= 5 && !/^(?:19|20)\d{2}(?:19|20)\d{2}$/.test(value));
  const numberInTitle = partTokens.length > 0;
  const hasQuantity = QUANTITY.test(title);
  if (title) {
    const checks = [
      { name: '品牌', status: !brand.value ? 'unknown' : title.toLowerCase().includes(brand.value.toLowerCase()) ? 'pass' : 'fail', detail: brand.value ? `商品品牌${brand.value}；核对完整标题` : '未取得商品品牌属性' },
      { name: '零件号', status: numberInTitle ? 'pass' : titleReview?.elements?.partNumber === 'absent' ? 'fail' : 'unknown', detail: numberInTitle ? `标题中有零件号形式${partTokens.join('、')}；此项仅核查要素存在，真实性另核查` : '标题中未识别明确零件号，结合已缓存语义结果核查' },
      { name: '产品名称', status: titleReview?.elements?.productName === 'present' ? 'pass' : titleReview?.elements?.productName === 'absent' ? 'fail' : 'unknown', detail: title },
      { name: '数量', status: hasQuantity ? 'pass' : 'fail', detail: hasQuantity ? title.match(QUANTITY)[0] : '完整标题没有明确pack/pcs/count/件数表达，年份和车型数字不算数量' },
    ];
    get('M1-3.3').checks = checks;
    const required = checks.filter(check => ['零件号', '数量'].includes(check.name));
    if (required.every(check => check.status !== 'unknown')) settle('M1-3.3', 4 - required.filter(check => check.status === 'fail').length, '按附件核查标题零件号与数量，每缺一项扣1分；不以开发OE缺失阻断要素存在性检查。', [titleEvidence]);
    else limit('M1-3.3', '数量已核查；零件号形式仍不足以判定。已确认缺项继续记录，未核实部分不贡献得分。', checks, [titleEvidence], hasQuantity ? [] : [{ key: 'title-quantity', message: '标题未标明数量', deductionPoints: 1, evidence: [titleEvidence], recommendation: '补充明确数量' }]);
    if (checks.some(check => check.status === 'fail')) settle('M2-2.3.1', 0, '完整标题已确认缺少品牌、零件号、产品名称或数量中的至少一项，按附件结构不规范扣2分。', [titleEvidence, ...brand.evidence]);
    else if (checks.every(check => check.status === 'pass')) {
      const order = [brand.value, partTokens[0]].map(value => title.toLowerCase().indexOf(value.toLowerCase()));
      const quantityIndex = title.search(QUANTITY);
      if (order[0] === 0 && order[1] > order[0] && quantityIndex > order[1] + partTokens[0].length && /[a-z]/i.test(title.slice(order[1] + partTokens[0].length, quantityIndex))) settle('M2-2.3.1', 2, '标题要素完整且品牌在前、零件号随后、产品词与数量按顺序出现。', [titleEvidence]);
      else settle('M2-2.3.1', 0, '标题四要素存在，但未按品牌→零件号→产品名称→数量顺序排列。', [titleEvidence]);
    } else limit('M2-2.3.1', '已检查完整标题，剩余缺口为商品品牌/产品词的对应证据，不依赖开发OE真实性核查。', checks, [titleEvidence]);
    const titleClaims = result.snapshotReview?.review?.titleAttributes?.claims ?? [];
    const vehicleClaim = titleClaims.some(claim => /车型|适用|适配|年份|compatible|fitment|vehicle/i.test(claim.claim) && claim.evidence.some(ref => ref.ref === 'listing:title'));
    if (VEHICLE_NAMES.test(title) || vehicleClaim) settle('M1-3.4', 0, '完整标题含车型/适配信息；附件该项得0分，不额外要求同时出现年份。', [titleEvidence]);
    else if (!FITMENT.test(title) && !/\bfor\b/i.test(title) && titleClaims.length) settle('M1-3.4', 3, '完整标题和已缓存标题声明未出现车型/适配表达。', [titleEvidence]);
    else limit('M1-3.4', '标题已读取，但适配表达未能可靠区分车型与产品用途；这是当前语义判定限制，不是缺少标题。', [{ name: '完整标题', status: 'unknown', detail: title }], [titleEvidence]);
  }

  if (bullets.length >= 5) {
    const expected = ['oe', 'fitment', 'material', 'function', 'installation'];
    const categories = bullets.slice(0, 5).map(getBulletCategory);
    const mismatched = categories.findIndex((category, index) => category !== 'unclassified' && category !== expected[index]);
    get('M2-2.3.2').checks = categories.map((category, index) => ({ name: `第${index + 1}点`, status: category === 'unclassified' ? 'unknown' : category === expected[index] ? 'pass' : 'fail', detail: `期望${expected[index]}；识别${category}；${bullets[index]}` }));
    if (mismatched >= 0) settle('M2-2.3.2', 0, `第${mismatched + 1}点为${categories[mismatched]}，不符合附件OE→适配→材质规格→功能→安装的顺序，扣2分。检查不依赖开发OE清单。`, bulletEvidence);
    else if (categories.every((category, index) => category === expected[index])) settle('M2-2.3.2', 2, '五点按附件固定顺序逐一匹配。', bulletEvidence);
    else limit('M2-2.3.2', '五点原文完整；部分段落功能无法由已有语义结果和局部分类唯一确定，具体段落已列出。', get('M2-2.3.2').checks, bulletEvidence);
    const coverage = result.semantic?.bulletCoverage;
    const rawText = bullets.join('\n');
    const covered = { material: MATERIAL.test(rawText) || coverage?.material?.some(ref => parseMaterials(ref.quote).length), function: Boolean(coverage?.function?.length) || FUNCTION.test(rawText), usage: Boolean(coverage?.usage?.length) || (FITMENT.test(rawText) && VEHICLE_NAMES.test(rawText)) || INSTALLATION.test(rawText) };
    get('M1-6.2').checks = Object.entries(covered).map(([name, value]) => ({ name, status: value ? 'pass' : 'fail', detail: value ? '已在完整五点或已校验语义引用中找到' : '已读取完整五点，没有对应的具体表达；泛称质量好不代替具体材质' }));
    const rejectedFields = (result.semantic?.rejectedCoverageFields ?? []).filter(field => !covered[field]);
    if (rejectedFields.length) limit('M1-6.2', `已读取五点，但缓存模型的${rejectedFields.join('、')}引用校验失败，不能将被丢弃的引用当作内容不存在。`, get('M1-6.2').checks.map(check => rejectedFields.includes(check.name) ? { ...check, status: 'unknown', detail: '缓存引用未通过原文校验，本地匹配不足以判定缺失' } : check), bulletEvidence);
    else if (result.semantic?.status === 'success') settle('M1-6.2', Object.values(covered).every(Boolean) ? 1.5 : 0, Object.values(covered).every(Boolean) ? '已核查完整五点，具体材质、功能、使用场景均覆盖。' : `已核查完整五点，未覆盖${Object.keys(covered).filter(key => !covered[key]).join('、')}，按附件扣1.5分。`, bulletEvidence);
  }

  const original = result.snapshotReview?.originalMainImage;
  if (original?.status === 'success' && original.metrics) {
    const metrics = original.metrics;
    const visual = result.snapshotReview.review.main;
    const occupancies = metrics.boxes.map(item => item.occupancy).filter(Number.isFinite);
    const occupancyPass = occupancies.length === 4 && occupancies.every(value => value >= 0.85 && value <= 1);
    const occupancyFail = occupancies.length === 4 && occupancies.every(value => value < 0.85);
    const patches = (metrics.backgroundPatches ?? []).filter(patch => patch.isOutsideForeground && patch.min.every((value, channel) => value >= 250 && patch.max[channel] - value <= 2));
    const patchBackground = patches.length >= 2 ? patches.every(patch => patch.min.every(value => value === 255)) ? 'pass' : 'fail' : 'unknown';
    const background = visual.background === 'nonwhite' ? 'fail' : visual.background === 'white' && metrics.dominantFraction >= 0.5 ? metrics.dominantRgb.every(value => value === 255) ? 'pass' : 'fail' : visual.background === 'white' ? patchBackground : 'unknown';
    const checks = [
      { name: '文件格式', status: original.technical.format === 'jpeg' ? 'pass' : 'unknown', detail: `源文件实际格式${original.technical.format}；附件未指定非JPEG扣分数额，不自行补扣` },
      { name: '主图背景', status: background, detail: `源图边缘主色RGB(${metrics.dominantRgb.join(',')})、占比${(metrics.dominantFraction * 100).toFixed(1)}%；主体框外可复核背景块${patches.length}个：${patches.map(patch => `${patch.min.join(',')}至${patch.max.join(',')}`).join('；')}。按严格RGB255标准；众数不足50%时使用实际背景块，不把检测门槛作为业务规则。` },
      { name: '商品占比', status: occupancyPass ? 'pass' : occupancyFail ? 'fail' : 'unknown', detail: `四种阈值长边占比：${occupancies.map(value => (value * 100).toFixed(1) + '%').join('、')}；85%为方案门槛，不另加87%或99%业务门槛` },
      { name: '最长边像素', status: Math.max(metrics.width, metrics.height) >= 1000 ? 'pass' : 'fail', detail: `${metrics.width}×${metrics.height}` },
    ];
    const evidence = [{ source: 'source_image', sha256: original.sha256, url: original.url, metrics }];
    const issues = checks.filter(check => check.status === 'fail').map(check => ({ key: check.name, message: check.name + '不满足附件要求', deductionPoints: 1, evidence, recommendation: '按该项标准修改源图' }));
    get('M1-5.1').checks = checks;
    if (checks.every(check => check.status !== 'unknown')) settle('M1-5.1', 3 - issues.length, '源图格式、背景、占比和像素分别核查；按附件背景/占比/像素每项不符扣1分。', evidence);
    else limit('M1-5.1', `源图和指标已取得；已确认${issues.length}项不符。剩余检测限制：${checks.filter(check => check.status === 'unknown').map(check => check.name).join('、')}。未知项不贡献得分，已确认扣分计入上限约束。`, checks, evidence, issues);
  }

  const images = result.snapshotReview?.review?.images ?? [];
  const ocr = images.filter(image => image.isReadable).map(image => ({ path: image.imageId, value: image.text, source: 'cached_image_ocr' }));
  const locations = [{ path: '/title', value: title }, ...bulletEvidence, ...attributes, ...(task.product.description ? [{ path: '/description', value: task.product.description }] : []), ...ocr];
  const hasReadableScope = Boolean(title && bullets.length && images.length && !task.unavailableImageIds?.length && images.every(image => hasImageTextEvidence(image, result.snapshotReview)));
  for (const [id, field] of [['M2-2.1.1', '主OE'], ['M2-2.1.2', 'OE信息分行']]) {
    const expected = parsePartNumbers(task.source.fields[field]);
    if (!expected.length) { limit(id, `上架资料第${task.source.row}行${field}为空；不能核查与开发基准的一致性。`, [], [{ source: 'development', row: task.source.row, field, value: task.source.fields[field] }]); continue; }
    const matches = expected.map(oe => ({ oe, locations: locations.filter(location => hasPartNumber(location.value, oe)) }));
    const missing = matches.filter(match => !match.locations.length);
    const rule = get(id);
    rule.checks = matches.map(match => ({ name: match.oe, status: match.locations.length ? 'pass' : hasReadableScope ? 'fail' : 'unknown', detail: match.locations.length ? match.locations.map(location => location.path).join('、') : '本次可用Listing文字和图片OCR未找到' }));
    if (!missing.length || hasReadableScope) settle(id, id === 'M2-2.1.1' ? missing.length ? 0 : 4 : Math.max(0, 4 - missing.length), `开发${field}规范化后${expected.length}个号码，公开Listing文字与可读图片OCR找到${expected.length - missing.length}个。按附件内部对照计分，不要求外部反查；连字符不同不重复计为缺失。`, [{ source: 'development', row: task.source.row, field, value: task.source.fields[field] }, ...matches]);
    else limit(id, `开发基准已取得，文字/OCR已匹配${expected.length - missing.length}/${expected.length}；部分图片不可读，未将未匹配号码断言为缺失。`, rule.checks, matches);
  }
  const knownOes = parsePartNumbers([task.source.fields['主OE'], task.source.fields['OE信息分行'], ...attributes.filter(a => /OEM|OE Equivalent|Interchange/i.test(a.name)).map(a => a.value)].filter(Boolean).join('\n'));
  const positioned = [{ path: '/title', value: title }, ...bulletEvidence, ...attributes.filter(a => /OEM|Part Number|Interchange/i.test(a.name))].filter(location => knownOes.some(oe => hasPartNumber(location.value, oe)) || (location.path?.startsWith('/bullets/') && /\b(?:OE|OEM|part numbers?)\b/i.test(location.value) && parsePartNumbers(location.value).length));
  if (positioned.length) settle('M2-2.1.3', 4, '已确认OE位于附件列明的标题/五点/OE属性位置之一；此项检查位置，不复用开发OE真实性要求，也不要求未列于本项的ST。', positioned);
  else limit('M2-2.1.3', '标题、五点和已返回OE属性均已检查，未取得可定位的OE；后台属性不完整，不能把未抓到判作卖家没填。', [], locations.filter(location => !location.source));
  const fitmentLocations = [...bulletEvidence, ...attributes.filter(attribute => /Fitment|Compatible Vehicles|Part Interchange/i.test(attribute.name))].filter(location => hasFitmentStatement(location.value));
  if (fitmentLocations.length) settle('M2-2.2.2', 4, '适配信息已位于附件列明的五点/后台适配属性位置之一；位置与车型真实性分开核查，不要求开发行逐字匹配，也不把ST缺失传递为已知位置不明。', fitmentLocations);
  else limit('M2-2.2.2', '已检查五点和返回适配属性，没有足够可定位的适配表达；真实后台适配属性/ST仍未取得。', [], bulletEvidence);

  const searchTerms = task.submissions.map(record => getFieldText(record.fields['后台搜索词（rpa）'])).filter(Boolean);
  const texts = locations.map(location => ({ id: location.path, text: location.value })).filter(item => typeof item.text === 'string' && item.text);
  texts.push(...searchTerms.map((text, index) => ({ id: `submitted:ST:${index}`, text })));
  const expectedImageIds = [
    ...(task.product.imageUrl ? ['main:0'] : []),
    ...[...new Set(task.product.otherImagesUrl ?? [])].filter(url => url && url !== task.product.imageUrl).map((_, index) => `aux:${index}`),
    ...[...new Set(task.product.aplus ?? [])].map((_, index) => `aplus:${index}`),
  ];
  const hasPublicTextScope = Boolean(title && bullets.length && attributes.length && expectedImageIds.length && expectedImageIds.every(id => images.some(image => image.imageId === id && hasImageTextEvidence(image, result.snapshotReview))));
  const scopeNotes = [
    ...(!task.product.description ? ['description未返回；本次只对已取得的Listing内容判定，不证明线上没有独立描述。'] : []),
    ...(!searchTerms.length ? ['真实后台ST未取得；不作为这三项公开文案检查的硬前置条件，ST结构和外扣仍独立受限。'] : []),
    '只按审计文档列明词表及其语境检查，不表示完成全部法律风险审查。',
  ];
  for (const [id, words] of Object.entries(WORD_LISTS)) {
    const hits = scanWords(texts, words).map(hit => ({ ...hit, ...classifyWordHit(hit, id) }));
    const violations = hits.filter(hit => hit.verdict === 'violation');
    const unresolved = hits.filter(hit => hit.verdict === 'unresolved');
    const evidence = [{ scannedSources: texts.map(text => text.id), words, hits }];
    const checks = hits.map(hit => ({ name: `${hit.term} @ ${hit.source}`, status: hit.verdict === 'violation' ? 'fail' : hit.verdict === 'reference' ? 'pass' : 'unknown', detail: `${hit.context}；${hit.reason}` }));
    if (violations.length) settle(id, 0, `已有文本确认${violations.length}处文档禁用语境，按附件扣满该项；不因后台ST未取得而忽略已确认问题。`, evidence);
    else if (hasPublicTextScope && !unresolved.length) settle(id, get(id).maxPoints, `已检查本次取得的标题、五点、属性及全部返回图片OCR：${hits.length}处词表命中均未构成文档列明的违规语境，按本次快照范围计分。ST未取得不阻断本项。`, evidence);
    else limit(id, `可见文字/OCR已核查：${hits.length}处命中，${hits.length - unresolved.length}处已排除，${unresolved.length}处语境仍不足。${!hasPublicTextScope ? '返回文字或图片识别范围不完整。' : ''}限制来自实际可读内容/语义，不来自ST前置条件。`, checks, evidence);
    get(id).checks = checks;
    get(id).scopeNotes = scopeNotes;
  }
  for (const rule of result.rules) {
    if (rule.status === 'unknown' && /尚未选定计分口径|保留为口径选择|仍需确认/.test(rule.reason)) rule.reason = `已采用评分附件口径。${rule.checks.length ? rule.checks.map(check => `${check.name}：${check.detail}`).join('；') : '现有输入缺少该项可核验依据。'} 未确认部分不贡献得分。`;
  }
  result.scoringPolicy.decisions = [...result.scoringPolicy.decisions.filter(decision => !observations.some(item => item.ruleId === decision.ruleId)), ...observations];
  return addEvidenceDetails(result, task);
}
