// Migrated from the accepted automotive audit script; runtime I/O is injected by the service.
// These are internal document rules, not statements about Amazon enforcement.
export const RULE_CONFLICTS = {
  'M1-2.1': { page: 6, body: '正文案例：缺失超过3个必填属性为0分。', attachment: '每缺1项扣1分，缺失至少6项才为0分。' },
  'M1-3.4': { page: 10, body: 'M1标题不得包含车型。', attachment: 'M2正文第18页的固定标题结构要求包含适配车型；同一标题无法同时满足。' },
  'M1-5.1': { page: 11, body: '正文还检查DPI、标识等，接受多种图片格式。', attachment: 'JPEG、纯白背景、85–100%占比、长边至少1000像素；后三项各扣1分。' },
  'M1-5.2': { page: 12, body: '辅图至少6张，并有场景图。', attachment: '辅图至少5张，并有场景图；两项各扣1.5分。' },
  'M1-5.3': { page: 12, body: '标注要求针对AI生成人物图。', attachment: '标注要求针对AI生成图片，范围更广。' },
  'M1-8.1': { page: 15, body: '标点、大小写、复数、竞品词、重复词等分别检查。', attachment: '逗号或大写扣1.5、推广词扣1、超过249字节扣3；累计上限未确定。' },
  'M2-2.1.3': { page: 17, body: '标题／五点／ST至少两处出现OE得4分，1处2分，0处0分。', attachment: '标题／五点／后台属性正确位置；位置不规范扣2分。' },
  'M2-2.2.1': { page: 17, body: '每个遗漏或错误的适配项扣1.5分。', attachment: '每处与开发表不一致扣1分。' },
  'M2-2.2.2': { page: 17, body: '标题／五点／后台适配属性至少两处。', attachment: '五点／后台适配属性／ST；位置不规范扣2分。' },
  'M2-2.3.1': { page: 18, body: '品牌＋主OE＋产品词＋适配车型；同时与M1禁车型矛盾。', attachment: '品牌＋零件号＋产品名称＋数量。' },
  'M2-2.3.2': { page: 18, body: '适配在前、OE第二、后三点特性；错序扣分细则不同。', attachment: 'OE在前、适配第二、材质规格、功能卖点、安装说明；结构不规范扣2分。' },
  'M2-2.3.3': { page: 18, body: '产品词、OE两种连字符格式、年份及通用属性等。', attachment: 'OE＋车型＋功能＋品牌；与ST避免重复和连字符要求存在交叉冲突。' },
  'M2-2.4.1': { page: 19, body: '每处命中扣1分。', attachment: '出现禁用词即扣满4分。' },
  'M2-2.4.2': { page: 20, body: '每处命中扣1.5分。', attachment: '出现禁用认证词即扣满3分。' },
  'M2-2.4.3': { page: 20, body: '每处命中扣1分。', attachment: '出现商标禁用词即扣满3分。' },
};

const DATA_GAPS = {
  'M1-1.1': '缺少完整后台属性；已返回字段可比对，不能据此宣布所有标题声明都通过。',
  'M1-1.2': '响应有同组商品，但没有父ASIN、家族完整性和全部功能资料。',
  'M1-1.3': '核心参数需与开发表逐项比对；缺少的基准参数不能补猜，也不能用未列入资料的额外号码直接认定造假。',
  'M1-1.4': '未返回后台Top12完整字段及已填写/空白状态，不能计算真实填写率。',
  'M1-2.1': '缺后台必填字段全集及空白状态，页面未展示不等于后台缺填。',
  'M1-2.2': '开发表尺寸/重量等基准与后台属性未必齐全，尚不能覆盖所有属性的准确性。',
  'M1-2.3': '缺可比对的品牌字段；本批次注册品牌基准取说明PDF第7页明确给出的DAFOLOGIA。',
  'M1-2.4': '需要材质、产品尺寸、重量和颜色；包装尺寸不能替代产品尺寸，未返回字段不视为后台未填写。',
  'M1-2.5': '没有明确Warranty属性；五点提及保修不证明后台Warranty完整。',
  'M1-3.1': '缺少一致的商品品牌字段或标题。',
  'M1-3.2': '缺少标题文本。',
  'M1-3.3': '标题核心要素尚未完成语义核查。',
  'M1-3.5': '缺少明确Item Highlight属性，second_title不能自动当作该字段。',
  'M1-4.1': '爬虫未返回变体主题，如Color/Size等后台设置。',
  'M1-4.2': '可以对照响应内子体标题，但缺少完整家族名单和后台变体命名值。',
  'M1-4.3': '爬虫未返回父体品牌和核心属性，不能只拿子体之间的一致代替父子一致。',
  'M1-5.1': '主图原始文件与视觉检测尚未执行；URL中尺寸字样不算实际像素证据。',
  'M1-5.2': '辅图数量可数，场景内容尚未读取。',
  'M1-5.3': '缺少图片制作来源或AI生成记录，不能由观感猜测是否AI制作。',
  'M1-6.1': '未取得完整五点；没有返回不等于实际缺填。',
  'M1-6.2': '五点核心卖点尚未完成语义核查。',
  'M1-7.1': '没有取得A+资源；缺抓取结果不等于商品未上传。',
  'M1-7.2': 'A+图片内容尚未读取。',
  'M1-7.3': 'A+图片内容尚未读取。',
  'M1-7.4': '缺少独立实物照片；Listing图片之间相似不能证明与实物一致。',
  'M1-7.5': 'A+图片内容尚未读取。',
  'M1-8.1': '提交表后台搜索词为空，爬虫backendKeywords空数组不证明真实ST为空。',
  'M2-2.1.1': '尚无AutoCare/适配查询工具的OE反查结果；可以先核对开发资料一致性。',
  'M2-2.1.2': '尚无每个OE的有效性反查结果；可以先核对开发清单覆盖。',
  'M2-2.1.3': '标题、五点可检查，未取得真实后台ST。',
  'M2-2.2.1': '需要开发表适配清单及完整Listing适配对照。',
  'M2-2.2.2': '没有取得真实后台ST；已有标题、五点、适配属性可分别检查。',
  'M2-2.2.3': '未返回Confirmed Fit徽标颜色/状态；开发表Fitment是不能替代绿色徽标。',
  'M2-2.3.3': '未取得真实后台ST。',
  'M2-2.4.1': '敏感词原表有裁切，缺完整词表；主辅图文字及ST也未完整核查。',
  'M2-2.4.2': '缺完整词表、全部文案及可能涉及的认证凭证。',
  'M2-2.4.3': '缺完整词表、全部文案及可能涉及的商标授权凭证。',
};

export function getPdfSource(page) {
  return { file: '审计说明-完整.pdf', page };
}

export function initializeRules(catalog) {
  return catalog.rules.map(rule => {
    const conflict = RULE_CONFLICTS[rule.ruleId];
    const gap = DATA_GAPS[rule.ruleId];
    const isUnreviewed = ['M1-3.3', 'M1-6.2', 'M1-5.1', 'M1-5.2', 'M1-7.2', 'M1-7.3', 'M1-7.5'].includes(rule.ruleId);
    return {
      ruleId: rule.ruleId, name: rule.name, kind: rule.kind, maxPoints: rule.maxPoints,
      earnedPoints: null, status: 'unknown',
      reason: conflict ? `${conflict.body} ${conflict.attachment} 尚未选定计分口径。${gap ?? ''}` : gap,
      pendingType: conflict ? 'rule_conflict' : isUnreviewed ? 'not_reviewed' : 'missing_evidence',
      blockers: [...(conflict ? [{ type: 'rule_conflict', ...conflict }] : []), ...(gap ? [{ type: isUnreviewed ? 'not_reviewed' : 'missing_evidence', message: gap }] : [])],
      evidence: [], checks: [], sourceRefs: [rule.source, ...(conflict ? [getPdfSource(conflict.page)] : [])],
    };
  });
}
