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

/**
 * These blockers are authoritative until an explicit workflow supplies
 * applicable superseding evidence. A generic health/reprocess observation is
 * not such evidence, so it must not clear or downgrade them.
 */
export function isFailClosedProductBlocker(
  blocker: Pick<CanonicalProductBlocker, 'code' | 'source' | 'message'>,
): boolean {
  const code = normalizeBlockerCode(blocker.code);
  const source = String(blocker.source || '');
  const message = String(blocker.message || '');
  const explicitAuthority = `${code}_${source}`;
  const explicitCode = /(?:^|_)(?:manual|operator|human|unknown|policy|compliance|legal|permanent|confirmed_broken|prohibited|waiting_external|awaiting_external|external_evidence|requires_external|manual_review|operator_review|human_review|review_required|requires_review|blocked_by_policy|(?:stale|partial|contradictory|insufficient|missing|unavailable)_evidence|evidence_(?:stale|partial|contradictory|insufficient|missing|unavailable))(?:_|$)/i;
  const explicitMessage = /(?:manual|operator|human|(?:unknown|stale|partial|contradictory|insufficient|missing|unavailable) evidence|policy|compliance|legal hold|permanent failure|confirmed broken|waiting for external|awaiting external|external evidence|requires (?:manual|operator|human) review|review required)/i;
  return explicitCode.test(explicitAuthority) || explicitMessage.test(message);
}

type ProductBlockerState = {
  currentBlockers?: Array<string | Partial<CanonicalProductBlocker>>;
  publicBlockReasons?: string[];
  publicBlockReason?: string;
};

/**
 * Reconcile a newly calculated blocker set without allowing an automated
 * observation to erase persisted manual, unknown, policy, permanent, or
 * waiting-for-external-evidence blockers. Recalculated health blockers are
 * intentionally allowed to be superseded by the caller's current evidence.
 */
export function preserveFailClosedProductBlockers(
  previous: ProductBlockerState,
  next: Array<string | Partial<CanonicalProductBlocker>> | undefined,
  checkedAt = new Date().toISOString(),
): CanonicalProductBlocker[] {
  const persisted = previous.currentBlockers?.length
    ? previous.currentBlockers
    : [
        ...(previous.publicBlockReasons || []),
        ...(previous.publicBlockReason ? [previous.publicBlockReason] : []),
      ];
  const retained = canonicalizeProductBlockers(persisted, checkedAt)
    .filter(isFailClosedProductBlocker)
    .map(blocker => blocker.source === 'CURRENT_RULES'
      ? { ...blocker, source: 'PERSISTED_FAIL_CLOSED' }
      : blocker);
  const retainedKeys = new Set(retained.map(canonicalBlockerKey));
  const recalculated = canonicalizeProductBlockers(next, checkedAt)
    .filter(blocker => !retainedKeys.has(canonicalBlockerKey(blocker)));
  return canonicalizeProductBlockers([...recalculated, ...retained], checkedAt);
}
