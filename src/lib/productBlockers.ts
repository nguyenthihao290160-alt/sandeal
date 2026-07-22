import type { CanonicalProductBlocker } from './types';

const SEVERITY_RANK: Record<CanonicalProductBlocker['severity'], number> = { INFO: 0, WARNING: 1, BLOCKER: 2 };

export function normalizeBlockerCode(value: unknown): string {
  let code = String(value || '').trim().toLowerCase();
  while (/^(?:stored|review):/i.test(code)) code = code.replace(/^(?:stored|review):/i, '').trim();
  return code
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160) || 'unknown_blocker';
}

function blockerCategory(code: string): CanonicalProductBlocker['category'] {
  if (/affiliate/.test(code)) return 'AFFILIATE';
  if (/image|photo|thumbnail/.test(code)) return 'IMAGE';
  if (/price|currency/.test(code)) return 'PRICE';
  if (/duplicate|merged/.test(code)) return 'DUPLICATE';
  if (/url|link|domain/.test(code)) return 'LINK';
  if (/review|claim|content|seo|originality|disclosure|evidence/.test(code)) return 'CONTENT_EVIDENCE';
  if (/source|provenance/.test(code)) return 'PROVENANCE';
  return 'POLICY';
}

function blockerTarget(category: CanonicalProductBlocker['category']): string {
  if (category === 'AFFILIATE') return 'affiliate_url';
  if (category === 'IMAGE') return 'image_url';
  if (category === 'PRICE') return 'price';
  if (category === 'LINK') return 'product_url';
  if (category === 'DUPLICATE') return 'product_identity';
  return 'product';
}

function fromLegacy(value: string, checkedAt: string): CanonicalProductBlocker {
  const reviewScoped = /^(?:(?:stored):)*review:/i.test(value.trim());
  const storedSource = /^stored:/i.test(value.trim());
  const code = normalizeBlockerCode(value);
  const category = blockerCategory(code);
  return {
    code,
    category,
    target: blockerTarget(category),
    scope: reviewScoped ? 'REVIEW' : 'PUBLICATION',
    severity: 'BLOCKER',
    source: storedSource ? 'STORED_SNAPSHOT' : 'CURRENT_RULES',
    message: code.replace(/_/g, ' '),
    checkedAt,
  };
}

export function canonicalBlockerKey(blocker: Pick<CanonicalProductBlocker, 'code' | 'category' | 'target' | 'scope'>): string {
  return `${normalizeBlockerCode(blocker.code)}|${blocker.category}|${blocker.target}|${blocker.scope}`;
}

export function canonicalizeProductBlockers(
  values: Array<string | Partial<CanonicalProductBlocker>> | undefined,
  checkedAt = new Date().toISOString(),
): CanonicalProductBlocker[] {
  const deduplicated = new Map<string, CanonicalProductBlocker>();
  for (const raw of values || []) {
    const candidate = typeof raw === 'string'
      ? fromLegacy(raw, checkedAt)
      : {
        code: normalizeBlockerCode(raw.code),
        category: raw.category || blockerCategory(normalizeBlockerCode(raw.code)),
        target: raw.target || blockerTarget(raw.category || blockerCategory(normalizeBlockerCode(raw.code))),
        scope: raw.scope || 'PUBLICATION',
        severity: raw.severity || 'BLOCKER',
        source: raw.source || 'CURRENT_RULES',
        message: String(raw.message || normalizeBlockerCode(raw.code).replace(/_/g, ' ')).slice(0, 500),
        checkedAt: raw.checkedAt && Number.isFinite(Date.parse(raw.checkedAt)) ? raw.checkedAt : checkedAt,
      } satisfies CanonicalProductBlocker;
    const key = canonicalBlockerKey(candidate);
    const existing = deduplicated.get(key);
    if (!existing || SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[existing.severity]
      || Date.parse(candidate.checkedAt) > Date.parse(existing.checkedAt)) deduplicated.set(key, candidate);
  }
  return [...deduplicated.values()].sort((left, right) =>
    SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity]
    || left.category.localeCompare(right.category)
    || left.code.localeCompare(right.code));
}

export function canonicalBlockerCodes(values: Array<string | Partial<CanonicalProductBlocker>> | undefined): string[] {
  return [...new Set(canonicalizeProductBlockers(values).map(blocker => blocker.code))];
}
