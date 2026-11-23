// Migrated from the accepted automotive audit script; runtime I/O is injected by the service.
import { cleanText } from './audit-data.mjs';
import { getCachedAttribute as getAttribute, getCachedAttributes as getAttributes } from './cached-attributes.mjs';

const normalizeText = value => cleanText(value).toLowerCase().replace(/[^a-z0-9]/g, '');

// Explains local evidence without making model calls or treating absent crawler fields as seller omissions.
export function addEvidenceDetails(result, task) {
  const attributes = getAttributes(task.product);
  const images = result.snapshotReview?.review?.images ?? [];
  const fields = task.source.fields;
  const sourceLabel = `上架资料第${task.source.row}行`;
  const publicTexts = [task.product.title, ...(task.product.bullets ?? []), ...attributes.map(item => item.value), ...images.filter(item => item.isReadable).map(item => item.text)].filter(Boolean);
  const missing = (data, location, remedy) => ({ data, location, remedy });
  const describeAttribute = (name, aliases) => {
    const attribute = getAttribute(task.product, aliases);
    return attribute.value ? `${name}已返回：${attribute.value}（${attribute.evidence.map(item => item.path).join('、')}）` : attribute.hasConflict ? `${name}返回多个不同值，不能选一个冒充唯一值` : `${name}未返回；不能据此判定后台未填`;
  };
  const specs = [
    ['材质', ['Material', 'Material Type']], ['重量', ['Item Weight', 'Weight']],
    ['尺寸', ['Product Dimensions', 'Item Dimensions L x W x H', 'Item Dimensions']], ['颜色', ['Color', 'Colour']],
  ];
  const dimensionImages = images.filter(item => item.isReadable && /\d+(?:\.\d+)?\s*(?:["″]|inches|\bcm\b)/i.test(item.text));
  const knownSpecs = [...specs.map(([name, aliases]) => describeAttribute(name, aliases)), ...dimensionImages.map(item => `图片${item.imageId}已有尺寸文字：${item.text}；不能替代后台填写状态或独立实物尺寸`)];
  const missingSpecs = specs.filter(([, aliases]) => !getAttribute(task.product, aliases).value).map(([name]) => missing(`后台${name}属性实际值及填写状态`, '爬虫公开属性未提供唯一值', '卖家后台商品属性导出'));
  const missingBaselines = [
    ['尺寸', ['产品尺寸（CM）', '产品尺寸(Inch)--AI']], ['重量', ['产品重量（KG）', '产品重量（LB）--AI']], ['安装位置', ['安装位置']],
  ].filter(([, names]) => names.every(name => !cleanText(fields[name]))).map(([name, names]) => missing(`${name}开发/实物比对基准`, `${sourceLabel}：${names.join('、')}为空`, '该SKU开发规格或实物测量记录'));
  const knownAccuracy = (result.rules.find(item => item.ruleId === 'M1-1.3')?.checks ?? []).filter(check => check.status !== 'unknown').map(check => `${check.name}：${check.detail}`);
  const thread = getAttribute(task.product, ['Thread Size']);
  if (thread.value && normalizeText(fields['产品信息（产品名称+OE+适配信息+产品卖点）']).includes(normalizeText(thread.value))) knownAccuracy.push(`螺纹规格${thread.value}与飞书综合产品信息一致`);
  knownAccuracy.push(...knownSpecs);

  const sourceFitment = cleanText(fields['适配车型分行']);
  const fitmentRows = sourceFitment.split(/[;；\n]+/).map(cleanText).filter(Boolean);
  const fitmentChecks = fitmentRows.map(row => ({ name: '开发适配行对照', status: publicTexts.some(text => normalizeText(text).includes(normalizeText(row))) ? 'pass' : 'unknown', detail: row }));
  const sourceFitmentText = `${sourceFitment}\n${fields['产品信息（产品名称+OE+适配信息+产品卖点）'] ?? ''}`;
  const extraDisplacements = [...new Set(publicTexts.join('\n').match(/\b\d+(?:\.\d+)?\s*L\b/gi) ?? [])].filter(value => !normalizeText(sourceFitmentText).includes(normalizeText(value)));
  const fitmentRule = result.rules.find(item => item.ruleId === 'M2-2.2.1');
  const fitmentMissing = [
    ...(!sourceFitment ? [missing('开发适配车型清单', `${sourceLabel}适配车型分行为空`, '补充该SKU开发适配表')] : []),
    ...(fitmentChecks.some(check => check.status === 'unknown') ? [missing('未匹配适配行的对应Listing声明', '已返回内容未建立逐行匹配', '核对具体年份/车型/变速箱对应关系，不将未匹配直接定为错误')] : []),
    ...(extraDisplacements.length ? [missing(`额外排量声明${extraDisplacements.join('、')}的适配依据`, '公开文案有声明，飞书适配及综合产品信息没有对应排量', '该SKU含排量限制的开发适配表')] : []),
  ];
  const knownFitment = fitmentChecks.map(check => `${check.status === 'pass' ? '已匹配' : '尚未匹配'}：${check.detail}`);
  const highlight = getAttribute(task.product, ['Item Highlight', 'Item Highlights']).value ?? '';
  if (/Ram\s+1500\s+Classic/i.test(sourceFitment) && /Ram\s+1500/i.test(highlight) && !/Classic/i.test(highlight)) {
    knownFitment.push('Item Highlight的Ram 1500表述省略了开发资料中的Classic限定；已记录范围差异，不直接认定所有Ram 1500均适配。');
    fitmentMissing.push(missing('省略Classic限定后适配范围的依据', '开发适配行限定Ram 1500 Classic，Highlight仅写Ram 1500', '开发适配范围说明，或将文案明确限定到已核验车型'));
  }
  if (fitmentRule && ['unknown', 'unverified'].includes(fitmentRule.status) && fitmentChecks.length) {
    fitmentRule.checks = [...fitmentChecks, ...(fitmentRule.checks ?? [])];
    // Preserve the validated semantic observation: exact row matches do not validate extra claims.
    knownFitment.push(fitmentRule.reason);
  }

  const availableAttributeNames = [...new Set(attributes.filter(item => item.value).map(item => item.name))];
  const comparison = result.snapshotReview?.review?.aplusComparison;
  const titleRule = result.rules.find(item => item.ruleId === 'M1-1.1');
  const titleClaims = result.snapshotReview?.review?.titleAttributes?.claims ?? [];
  const details = {
    'M1-2.1': { knownFacts: [`返回了${availableAttributeNames.length}种非空公开属性：${availableAttributeNames.join('、')}`], missingData: [missing('类目必填字段全集及每项实际填写状态', '公开爬虫返回不包含后台字段定义/完整空白状态', '卖家后台属性导出及该类目必填字段定义')] },
    'M1-2.2': { knownFacts: knownAccuracy, missingData: missingBaselines },
    'M1-2.4': { knownFacts: knownSpecs, missingData: missingSpecs },
    'M1-4.1': { knownFacts: [`爬虫返回组有${task.family.length}个商品；可比较返回商品，但数量不证明主题设置正确`], missingData: [missing('真实变体主题及各子体选项映射', 'variant返回组没有variation theme设置', '后台变体关系/主题导出')] },
    'M1-4.3': { knownFacts: [`已有${task.family.length}个返回商品；返回组不等于已验证父子关系，当前目标品牌${getAttribute(task.product, ['Brand', 'Brand Name']).value ?? '未取得'}`], missingData: [missing('父ASIN、父体品牌/核心属性及明确父子关系', '没有明确父体身份及属性；飞书Parent items也不提供有效父体证据', '后台父子关系和父体属性导出')] },
    'M1-5.3': { knownFacts: [`已缓存${images.length}张图片识别结果；可读OCR中${images.some(item => item.isReadable && /AI[- ]generated/i.test(item.text)) ? '发现' : '未发现'}AI-generated标注。未看到标注不能证明图片由AI生成`], missingData: [missing('哪些图片由AI生成的制作来源', '图片外观和OCR不能证明生成来源', '素材制作记录/源文件及AI生成图片清单')] },
    'M1-7.4': { knownFacts: comparison ? [`缓存A+与主辅图对照：${comparison.outcome}；${comparison.reason}`] : ['没有已验证的A+与主辅图比对结果'], missingData: [missing('独立实物外观依据', '同一Listing图片相互一致不等于与实物一致', '该SKU实物/验货照片或实物资料')] },
    'M2-2.2.1': { knownFacts: knownFitment, missingData: fitmentMissing, interpretationLimits: fitmentMissing.length ? [] : [fitmentRule?.reason ?? '已有资料尚未形成全部适配声明的完整对应'] },
    'M2-2.2.3': { knownFacts: [`飞书Fitment是否完成：${fields['Fitment是否完成'] ?? '空'}；${describeAttribute('适配类型', ['Automotive Fit Type'])}；这些不等于绿色徽章已显示`], missingData: [missing('Confirmed Fit实际徽章状态及选车条件', '爬虫没有页面徽章状态', '对应选车条件下的页面/接口状态证据')] },
    'M2-2.3.3': { knownFacts: ['提交表ST及爬虫backendKeywords未提供可核验原文；空返回不证明后台没填'], missingData: [missing('真实后台Search Terms原文', '提交表RPA字段为空、爬虫没有有效ST原文', '后台导出或RPA读取的ST原文')] },
    'M1-8.1': { knownFacts: ['无真实ST原文，不能计算字节数及判定标点/大小写/推广词'], missingData: [missing('真实后台Search Terms原文', '与M2-2.3.3相同缺口，不重复计算缺失评分预算', '后台导出或RPA读取的ST原文')] },
    'M1-1.1': { knownFacts: [titleRule?.reason ?? '', ...titleClaims.map(claim => `${claim.claim}：${({ match: '与属性匹配', conflict: '存在冲突', unverified: '对应属性未核实' })[claim.status] ?? claim.status}；${claim.validationNote ?? ''}`)].filter(Boolean), missingData: [missing(`真实属性值：${titleClaims.filter(claim => claim.status === 'unverified').map(claim => claim.claim).join('、') || '报告中尚未核实的标题声明'}`, '缓存引用不能证明该标题声明与对应属性一致或矛盾', '补充相应后台属性；不以开发名称替代后台属性')] },
    'M1-1.3': { knownFacts: [...knownAccuracy, ...(result.semantic?.findings ?? []).filter(item => item.type === 'oe_difference').map(item => `发现号码差异，尚非确定造假：${item.message}`)], missingData: [...missingBaselines, ...((result.semantic?.findings ?? []).some(item => item.type === 'oe_difference') ? [missing('开发清单外额外OE的有效性依据', '号码不同不自动等于同一参数矛盾或造假', '该SKU替换OE对照依据')] : [])] },
  };
  for (const rule of result.rules) {
    if (!['unknown', 'unverified'].includes(rule.status)) continue;
    const detail = details[rule.ruleId];
    rule.evidenceDetails = detail ?? { knownFacts: (rule.checks ?? []).filter(check => check.status !== 'unknown').map(check => `${check.name}：${check.detail}`), missingData: [], interpretationLimits: [rule.reason] };
    if (!rule.evidenceDetails.missingData.length && !rule.evidenceDetails.interpretationLimits?.length) rule.evidenceDetails.interpretationLimits = [rule.reason];
  }
  return result;
}
