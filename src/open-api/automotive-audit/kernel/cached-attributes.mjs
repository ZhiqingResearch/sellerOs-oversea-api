// Migrated from the accepted automotive audit script; runtime I/O is injected by the service.
import { cleanText, getAttributes } from './audit-data.mjs';

// Keep the model-input builder unchanged: these extra sources are for local decisions only.
const ALIASES = [
  ['Brand', 'Brand Name'], ['Material', 'Material Type'],
  ['Product Dimensions', 'Item Dimensions', 'Item Dimensions L x W x H'],
  ['Color', 'Colour'], ['Item Weight', 'Weight'],
];
const keyOf = name => cleanText(name).toLowerCase().replace(/\s+/g, ' ');
export function getCachedAttributes(product) {
  return [
    ...getAttributes(product),
    ...Object.entries(product.extra?.overviews ?? {}).filter(([, value]) => typeof value === 'string' && value.trim()).map(([name, value]) => ({ name, value: cleanText(value), path: `/extra/overviews/${name.replace(/~/g, '~0').replace(/\//g, '~1')}` })),
    ...(cleanText(product.brand) ? [{ name: 'Brand', value: cleanText(product.brand), path: '/brand' }] : []),
  ];
}
export function getCachedAttribute(product, names) {
  const requested = new Set(names.map(keyOf));
  for (const group of ALIASES) if (group.some(name => requested.has(keyOf(name)))) for (const name of group) requested.add(keyOf(name));
  const evidence = getCachedAttributes(product).filter(item => requested.has(keyOf(item.name)) && item.value);
  // Do not collapse conflicting values or infer that package dimensions are product dimensions.
  const values = [...new Set(evidence.map(item => item.value))];
  return { value: values.length === 1 ? values[0] : null, hasConflict: values.length > 1, evidence };
}

export function hasFitmentStatement(text) {
  // A named object after an explicit compatibility statement is enough for LOCATION checks.
  // Never require its brand to appear in a closed dictionary; reminders alone are not claims.
  const statement = (text ?? '').match(/\b(?:compatible with|fits?(?: for)?|suitable for)\s+(?:(?:19|20)\d{2}[-–‑—\d ,]*)?([a-z][a-z0-9-]*(?:[ /-]+[a-z0-9][a-z0-9.-]*))/i);
  return Boolean(statement && !/^(?:your|most|many|all|the|a|an|existing|various|certain|vehicles?|cars?|models?)\b/i.test(statement[1]) &&
    !/^(?:please\s+)?(?:verify|check|confirm)\b/i.test(cleanText(text)));
}
