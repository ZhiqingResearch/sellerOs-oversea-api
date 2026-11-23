// Migrated from the accepted automotive audit script; runtime I/O is injected by the service.
import { cleanText } from './audit-data.mjs';

// Keep record boundaries: collapsing newlines lets the next vehicle donate its year.
export const normalizeFitmentText = value => cleanText(value).toLowerCase().replace(/[‐‑–—]/g, '-').replace(/\bchevy\b/g, 'chevrolet').replace(/[^\S\n]+/g, ' ');
const YEAR = /\b((?:19|20)\d{2})(?:\s*-\s*((?:19|20)\d{2}|\d{2}))?\b/g;
export function getYears(text) {
  const years = new Set();
  for (const match of normalizeFitmentText(text).matchAll(YEAR)) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2].length === 2 ? match[1].slice(0, 2) + match[2] : match[2]) : start;
    if (end < start || end - start > 60) continue;
    for (let year = start; year <= end; year++) years.add(year);
  }
  return [...years];
}
function getVehicleLabel(row) {
  return normalizeFitmentText(row).replace(/\([^)]*\)/g, '').trim().replace(/^(?:(?:compatible with|fits?(?: for)?|vehicle compatibility:|and)\s*)+/i, '').replace(YEAR, '').replace(/\b(?:l[468]|v[468]|\d+cyl|\d+(?:\.\d+)?\s*l|[0-9][a-z]{2}-[a-z]{2}|turbo|ecoboost|gas|flex|fhev|\d+hp\d+(?:\/\d+hp\d+)?)\b/g, '').replace(/^[\s,;/.]+|[\s,;/.]+$/g, '').replace(/\s+/g, ' ');
}
export function expandVehicleSeries(text) {
  const normalized = normalizeFitmentText(text).replace(/\b((?:can-am\s+)?defender(?:\s+max)?)\s+(hd\d+)((?:\s*\/\s*hd\d+)+)(\s+(?:19|20)\d{2}(?:\s*-\s*\d{2,4})?)/g, (match, model, first, rest, years) => {
    return [first, ...rest.match(/hd\d+/g)].map(trim => `${model} ${trim}${years}`).join('; ');
  });
  // Expand a repeated model stem, not engine alternatives such as 8HP70/8HP75.
  return normalized.replace(/\b([a-z][a-z-]*-)(\d{2,3}(?:\s+hd)?)((?:\s*(?:\/|,|\band\b)\s*(?:\1)?\d{2,3}(?:\s+hd)?)+)([^;\n,]*)/g, (match, stem, first, rest, suffix) => {
    if (!getYears(suffix).length) return match;
    const members = [first, ...[...rest.matchAll(/\d{2,3}(?:\s+hd)?/g)].map(item => item[0])];
    return members.map(member => `${stem}${member}${suffix}`).join('; ');
  });
}
export function parseFitmentRows(text) {
  const groups = new Map();
  const expanded = expandVehicleSeries(text).replace(/\([^)]*\)/g, '').replace(/\s+and\s+(?=[a-z][^;\n,]*\b(?:19|20)\d{2})/g, '; ').replace(/(^|[;,\n])(\s*(?:compatible with\s+)?(?:19|20)\d{2}(?:-\d{2,4})?),\s*(?=[a-z])/g, '$1$2 ');
  for (const row of expanded.split(/[;；\n,，]+/).filter(Boolean)) {
    const label = getVehicleLabel(row);
    const years = getYears(row);
    if (!label || !years.length) continue;
    // A single leading year can also cover explicitly joined complete names.
    for (const member of label.split(/\s+and\s+/)) {
      const group = groups.get(member) ?? { label: member, years: [], rows: [] };
      group.years = [...new Set([...group.years, ...years])]; group.rows.push(row);
      groups.set(member, group);
    }
  }
  return [...groups.values()];
}
function escapePattern(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function findVehicleYears(text, label, { allowOmittedBrand = false, includeUndated = false } = {}) {
  const normalized = expandVehicleSeries(text).replace(/(^|[;,\n])(\s*(?:compatible with\s+)?(?:19|20)\d{2}(?:-\d{2,4})?),\s*(?=[a-z])/g, '$1$2 ');
  const words = label.split(' ');
  const hasBrand = allowOmittedBrand && words.length > 1 && /^[a-z]+(?:-[a-z]+)*$/.test(words[0]);
  const aliases = hasBrand ? [label, words.slice(1).join(' ')] : [label];
  const declarations = [];
  for (const alias of aliases) {
    const pattern = new RegExp(`\\b${escapePattern(alias)}\\b`, 'g');
    for (const match of normalized.matchAll(pattern)) {
      const before = normalized.slice(0, match.index).split(/[;；\n]/).at(-1);
      const after = normalized.slice(match.index + match[0].length).split(/[;；\n,，]/)[0];
      // A model suffix (Cooper Countryman / Transit-350 HD) is a different model.
      const tail = after.replace(/^\s*(?:(?:[lv][3468]|[23468]cyl|\d+(?:\.\d+)?\s*l|[0-9][a-z]{2}-[a-z]{2}|[0-9]hp[0-9]+(?:\/[0-9]hp[0-9]+)?|turbo|ecoboost|gas|flex|fhev)\s*)*/i, '').trim();
      const next = tail.match(/^(?:19|20)\d{2}(?:\s*-\s*\d{2,4})?(?:(?:\s*(?:and|\/|&)\s*)(?:19|20)\d{2}(?:\s*-\s*\d{2,4})?)*/);
      const prefix = before.split(/[,，]|\band\b/).at(-1).replace(/^[^a-z0-9]*(?:(?:vehicle\s+)?(?:compatibility|fitment)[:\]】]*\s*)?/i, '').replace(/^(?:compatible with|fits?(?: for)?|and)\s*/i, '').trim();
      const previous = prefix.match(/^(?:19|20)\d{2}(?:\s*-\s*\d{2,4})?$/);
      if (alias !== label && prefix && !previous) continue; // Do not match another explicit brand.
      // Only an explicit leading year can govern a coordinated list. A trailing
      // year on the preceding vehicle must never be inherited by the next one.
      const sentencePrefix = before.split(/\.\s+/).at(-1);
      const sharedPrefix = sentencePrefix.match(/(?:^|compatible with\s+|fits?(?: for)?\s+)((?:19|20)\d{2}(?:\s*-\s*\d{2,4})?)\s+([a-z][\s\S]*)$/i);
      const hasSharedYear = sharedPrefix && /,|\band\b/.test(sharedPrefix[2]) && !getYears(sharedPrefix[2]).length;
      const years = getYears(next?.[0] ?? previous?.[0] ?? (hasSharedYear ? sharedPrefix[1] : ''));
      const hasModelBoundary = !tail || /^(?:[,(.;&/]|and\b|with\b|without\b|models?\b|replace\b|for\b)/i.test(tail) || Boolean(next);
      if (hasModelBoundary && (years.length || includeUndated)) declarations.push({ years, value: text, normalizedSpan: `${previous && !next ? previous[0] + ' ' : hasSharedYear && !next ? sharedPrefix[1] + ' ' : ''}${match[0]}${next ? after : ''}`, matchedLabel: alias });
    }
  }
  return declarations;
}

// A known independent source row is the anchor. Absence in a regex is NOT a mismatch.
export function compareFitmentClaims(source, locations) {
  const groups = parseFitmentRows(source);
  const checks = [];
  const issues = [];
  for (const group of groups) {
    const declarations = locations.flatMap(location => findVehicleYears(location.value, group.label, { allowOmittedBrand: true, includeUndated: true }).map(item => ({ ...item, path: location.path })));
    const covered = new Set(declarations.flatMap(item => item.years));
    const hasCoverage = group.years.every(year => covered.has(year));
    checks.push({ name: group.label, status: hasCoverage ? 'pass' : declarations.length ? 'fail' : 'unknown', detail: `${group.rows.join('；')}；${hasCoverage ? '完整年份区间已有明确声明覆盖' : declarations.length ? '已找到车型声明，但未完整覆盖开发年份' : '当前原文未能定位声明，不把字符串未匹配判作错误'}`, evidence: declarations });
    const excess = [...new Set(declarations.flatMap(item => item.years.filter(year => !group.years.includes(year))))];
    if (excess.length) issues.push({ key: `fitment:${group.label}:years`, message: `${group.label}较开发清单扩展年份${excess.join('、')}`, points: 1, evidence: [{ source: 'development', value: group.rows.join('\n') }, ...declarations.filter(item => item.years.some(year => excess.includes(year)))] });
    const missingYears = group.years.filter(year => !covered.has(year));
    if (declarations.length && missingYears.length && !excess.length) issues.push({ key: `fitment:${group.label}:years`, message: `${group.label}未覆盖开发清单年份${missingYears.join('、')}`, points: 1, evidence: [{ source: 'development', value: group.rows.join('\n') }, ...declarations] });
  }
  return { groups, checks, issues };
}
