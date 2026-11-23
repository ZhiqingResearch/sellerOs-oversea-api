// Migrated from the accepted automotive audit script; runtime I/O is injected by the service.
import crypto from 'node:crypto';


export function hashValue(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
}

export function cleanText(value) {
  return String(value ?? '').replace(/[\u200e\u200f\u202a-\u202e\ufeff]/g, '').trim();
}

export function getFieldText(value) {
  return Array.isArray(value) ? value.map(item => item.text ?? '').join('') : cleanText(value);
}

export function parseAsin(value) {
  const text = cleanText(value);
  return text.match(/^([A-Z0-9]{10})(?:\?|$)/i)?.[1]?.toUpperCase()
    ?? text.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/i)?.[1]?.toUpperCase() ?? null;
}

export function getPointer(value, pointer) {
  return pointer.split('/').slice(1).reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], value);
}

export function getAttributes(product) {
  const attributes = [];
  const addPairs = (pairs, prefix) => {
    for (const [index, pair] of (Array.isArray(pairs) ? pairs : []).entries()) {
      if (Array.isArray(pair) && pair.length === 2) attributes.push({ name: cleanText(pair[0]), value: cleanText(pair[1]), path: `${prefix}/${index}/1` });
    }
  };
  addPairs(product.product_information, '/product_information');
  for (const [group, pairs] of Object.entries(product.product_information_hhl ?? {})) {
    addPairs(pairs, `/product_information_hhl/${group.replace(/~/g, '~0').replace(/\//g, '~1')}`);
  }
  return attributes;
}

export function getAttribute(product, names) {
  const attributes = getAttributes(product).filter(item => names.some(name => name.toLowerCase() === item.name.toLowerCase()));
  const values = [...new Set(attributes.map(item => item.value).filter(Boolean))];
  return { value: values.length === 1 ? values[0] : null, hasConflict: values.length > 1, evidence: attributes };
}

// Keep rank order: the last BSR entry is the user's category criterion.
export function parseLastBsr(product) {
  const attribute = getAttribute(product, ['Best Sellers Rank']);
  if (!attribute.value) return { category: null, reason: attribute.hasConflict ? 'BSR两个来源不一致' : '未抓到BSR品类', evidence: attribute.evidence };
  const matches = [...attribute.value.matchAll(/#[\d,]+\s+in\s+([^#\n]+)(?:\n|$)/g)];
  const categories = matches.map(match => match[1].replace(/\s*\(See Top 100.*$/i, '').trim());
  return { category: categories.at(-1) || null, categories, evidence: attribute.evidence, reason: categories.length ? '按原始顺序取最后一个BSR排名品类' : 'BSR格式无法解析' };
}
