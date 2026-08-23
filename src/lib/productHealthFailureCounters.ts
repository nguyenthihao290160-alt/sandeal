import type {
  Product,
  ProductHealthEvidenceScope,
  ProductHealthFailureCounter,
} from './types';

export const HEALTH_FAILURE_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export interface ProductHealthObservation {
  scope: Exclude<ProductHealthEvidenceScope, 'legacy'>;
  healthy: boolean;
  reason?: string;
}

type ObservedHealthScope = ProductHealthObservation['scope'];

const UNKNOWN_LEGACY_RECOVERY_SCOPES: ObservedHealthScope[] = [
  'price',
  'productUrl',
  'affiliateUrl',
  'image',
];

function legacyStatusIsHealthy(value: string | undefined): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return ['ok', 'healthy', 'verified', 'fresh', 'redirect_ok', 'redirected', 'not_applicable'].includes(normalized)
    || /^2\d\d$/.test(normalized);
}

/**
 * Old records stored one scalar and a free-form reason. Recover a scope only
 * when the old evidence identifies that scope; an unrecognizable reason keeps
 * the former comprehensive recovery requirement.
 */
function inferLegacyRecoveryScopes(product: Partial<Product>, reason: string | undefined): ObservedHealthScope[] | null {
  const normalized = String(reason || '').trim().toLowerCase();
  const inferred = new Set<ObservedHealthScope>();
  const add = (scope: ObservedHealthScope, matches: boolean) => { if (matches) inferred.add(scope); };
  const failedStatus = (value: unknown): boolean => /(?:broken|not_found|invalid|timeout|error|failed|unhealthy|stale|conflict|missing|unverified|mismatch|4\d\d|5\d\d)/i
    .test(String(value || ''));

  // Historical post-publish monitor reasons were positional:
  // product,affiliate,image,public:<status>:<identity>.
  const tokens = normalized.split(',').map(value => value.trim()).filter(Boolean);
  if (tokens.length >= 4 && tokens[3].startsWith('public:')) {
    add('productUrl', !legacyStatusIsHealthy(tokens[0]));
    add('affiliateUrl', !legacyStatusIsHealthy(tokens[1]));
    add('image', !legacyStatusIsHealthy(tokens[2]));
    const publicStatus = tokens[3].split(':')[1];
    add('publicPage', !legacyStatusIsHealthy(publicStatus));
  }

  const failedSegments = tokens.filter(failedStatus);
  add('price', failedSegments.some(segment => /(?:^|[:_\s-])price(?:[:_\s-]|$)/.test(segment)));
  add('affiliateUrl', failedSegments.some(segment => /(?:^|[:_\s-])(?:affiliate|deeplink|deep-link|gateway)(?:[:_\s-]|$)/.test(segment)));
  add('image', failedSegments.some(segment => /(?:^|[:_\s-])(?:image|thumbnail|photo)(?:[:_\s-]|$)/.test(segment)));
  add('publicPage', failedSegments.some(segment => /(?:^|[:_\s-])public(?:[_\s-]*page)?(?:[:_\s-]|$)/.test(segment)));
  add('source', failedSegments.some(segment => /(?:^|[:_\s-])(?:source|merchant|transport|circuit|connection)(?:[:_\s-]|$)/.test(segment)));
  add('productUrl', failedSegments.some(segment => /(?:^|[:_\s-])(?:product[_\s-]*url|canonical[_\s-]*url|product)(?:[:_\s-]|$)/.test(segment)));
  if (!inferred.has('affiliateUrl')) {
    add('productUrl', failedSegments.some(segment => /(?:^|[:_\s-])link(?:[:_\s-]|$)/.test(segment)));
  }

  add('productUrl', failedStatus(product.linkHealthStatus));
  add('affiliateUrl', failedStatus(product.affiliateHealthStatus));
  add('image', failedStatus(product.imageHealthStatus));
  add('price', failedStatus(product.priceVerificationStatus) || ['STALE', 'CONFLICTED', 'UNAVAILABLE'].includes(String(product.priceTruthState || '')));

  return inferred.size ? [...inferred] : null;
}

function validTimestamp(value: string | undefined): number | null {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

export function updateProductHealthFailureCounters(
  product: Partial<Product>,
  observations: ProductHealthObservation[],
  now = Date.now(),
): {
  counters: NonNullable<Product['healthFailureCounters']>;
  consecutiveFailures: number;
  activeReasons: string[];
  lastHealthyAt?: string;
} {
  const checkedAt = new Date(now).toISOString();
  const counters: NonNullable<Product['healthFailureCounters']> = structuredClone(product.healthFailureCounters || {});
  if (Object.keys(counters).length === 0 && Number(product.consecutiveHealthFailures) > 0) {
    counters.legacy = {
      consecutiveFailures: Math.max(0, Math.floor(Number(product.consecutiveHealthFailures))),
      checkedAt: product.updatedAt || checkedAt,
      lastFailureAt: product.updatedAt || checkedAt,
      reason: product.sourceHealthReason || 'legacy_unscoped_health_failure',
    };
  }

  for (const observation of observations) {
    const prior = counters[observation.scope];
    const next: ProductHealthFailureCounter = observation.healthy
      ? {
          consecutiveFailures: 0,
          checkedAt,
          lastFailureAt: prior?.lastFailureAt,
          lastHealthyAt: checkedAt,
        }
      : {
          consecutiveFailures: Math.max(0, Number(prior?.consecutiveFailures || 0)) + 1,
          checkedAt,
          lastFailureAt: checkedAt,
          lastHealthyAt: prior?.lastHealthyAt,
          reason: String(observation.reason || 'health_check_failed').slice(0, 240),
        };
    counters[observation.scope] = next;
  }

  // Supersede legacy evidence only when this observation coherently verifies
  // every scope identified by its old reason. Unknown legacy evidence keeps
  // the conservative comprehensive requirement.
  const legacyRecoveryScopes = counters.legacy
    ? inferLegacyRecoveryScopes(product, counters.legacy.reason || product.sourceHealthReason)
      || UNKNOWN_LEGACY_RECOVERY_SCOPES
    : [];
  if (counters.legacy && legacyRecoveryScopes.every(scope =>
    observations.some(observation => observation.scope === scope && observation.healthy))) {
    counters.legacy = {
      ...counters.legacy,
      consecutiveFailures: 0,
      checkedAt,
      lastHealthyAt: checkedAt,
      reason: undefined,
    };
  }

  const active = Object.values(counters).filter((counter): counter is ProductHealthFailureCounter => {
    const timestamp = validTimestamp(counter.checkedAt);
    return counter.consecutiveFailures > 0
      && timestamp !== null
      && timestamp <= now
      && now - timestamp <= HEALTH_FAILURE_EVIDENCE_MAX_AGE_MS;
  });
  const healthyTimes = Object.values(counters)
    .map(counter => validTimestamp(counter?.lastHealthyAt))
    .filter((value): value is number => value !== null && value <= now);
  return {
    counters,
    consecutiveFailures: active.reduce((maximum, counter) => Math.max(maximum, counter.consecutiveFailures), 0),
    activeReasons: [...new Set(active.map(counter => counter.reason).filter((reason): reason is string => Boolean(reason)))],
    lastHealthyAt: healthyTimes.length ? new Date(Math.max(...healthyTimes)).toISOString() : product.lastHealthyAt,
  };
}
