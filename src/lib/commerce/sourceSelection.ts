import { createHash } from 'crypto';

export interface SourceSelectionCandidate<T = unknown> {
  value: T;
  provider: string;
  sourceId: string;
  sourceHash: string;
  merchantUrl: string;
  merchantDomain?: string;
  campaign?: string;
  category?: string;
  keyword?: string;
  priority?: number;
  eligible?: boolean;
  skipReason?: string;
}

export interface SourceSelectionOptions {
  limit: number;
  scheduleBucket: string;
  maximumPerMerchant: number;
  maximumPerCampaign: number;
}

export interface SourceSelectionSkip<T> {
  candidate: SourceSelectionCandidate<T>;
  reason: string;
}

export interface SourceSelectionResult<T> {
  selected: SourceSelectionCandidate<T>[];
  skipped: Array<SourceSelectionSkip<T>>;
}

const TRACKING_PARAMETER = /^(?:utm_.+|fbclid|gclid|ref|aff(?:iliate)?|affiliate_id|click_id|sub\d*)$/i;

export function normalizedMerchantDomain(value: string): string {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''); }
  catch { return 'unknown'; }
}

export function canonicalMerchantUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    const entries = [...url.searchParams.entries()]
      .filter(([name]) => !TRACKING_PARAMETER.test(name))
      .sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
    url.search = '';
    for (const [name, parameterValue] of entries) url.searchParams.append(name, parameterValue);
    return url.toString();
  } catch {
    return '';
  }
}

function normalizedDimension(value: string | undefined, fallback: string): string {
  return String(value || fallback).trim().toLowerCase().slice(0, 160) || fallback;
}

function deterministicRank(candidate: SourceSelectionCandidate, bucket: string): string {
  return createHash('sha256')
    .update(`${bucket}\0${candidate.provider}\0${candidate.sourceId}\0${candidate.sourceHash}`)
    .digest('hex');
}

/**
 * Deterministic least-represented selection. The scorer considers provider,
 * campaign, merchant, category and keyword counts before the stable bucket
 * rank, so no provider result ordering can monopolize an intake run.
 */
export function selectDiversifiedSources<T>(
  input: Array<SourceSelectionCandidate<T>>,
  options: SourceSelectionOptions,
): SourceSelectionResult<T> {
  const limit = Math.max(0, Math.floor(options.limit));
  const merchantCap = Math.max(1, Math.floor(options.maximumPerMerchant));
  const campaignCap = Math.max(1, Math.floor(options.maximumPerCampaign));
  const skipped: Array<SourceSelectionSkip<T>> = [];
  const deduplicated: SourceSelectionCandidate<T>[] = [];
  const sourceIdentities = new Set<string>();
  const merchantUrls = new Set<string>();

  for (const candidate of input) {
    if (candidate.eligible === false) {
      skipped.push({ candidate, reason: candidate.skipReason || 'SOURCE_UNHEALTHY' });
      continue;
    }
    const identity = `${normalizedDimension(candidate.provider, 'unknown')}:${candidate.sourceId}:${candidate.sourceHash}`;
    const canonicalUrl = canonicalMerchantUrl(candidate.merchantUrl);
    if (!canonicalUrl) {
      skipped.push({ candidate, reason: 'INVALID_MERCHANT_URL' });
      continue;
    }
    if (sourceIdentities.has(identity) || merchantUrls.has(canonicalUrl)) {
      skipped.push({ candidate, reason: 'DUPLICATE_SOURCE_OR_MERCHANT_URL' });
      continue;
    }
    sourceIdentities.add(identity);
    merchantUrls.add(canonicalUrl);
    deduplicated.push(candidate);
  }

  const selected: SourceSelectionCandidate<T>[] = [];
  const remaining = new Set(deduplicated);
  const counts = {
    provider: new Map<string, number>(),
    campaign: new Map<string, number>(),
    merchant: new Map<string, number>(),
    category: new Map<string, number>(),
    keyword: new Map<string, number>(),
  };
  const count = (map: Map<string, number>, key: string) => map.get(key) || 0;

  while (selected.length < limit && remaining.size > 0) {
    const eligible = [...remaining].filter(candidate => {
      const merchant = normalizedDimension(candidate.merchantDomain || normalizedMerchantDomain(candidate.merchantUrl), 'unknown');
      const campaign = normalizedDimension(candidate.campaign, 'uncategorized-campaign');
      if (count(counts.merchant, merchant) >= merchantCap) return false;
      if (count(counts.campaign, campaign) >= campaignCap) return false;
      return true;
    });
    if (!eligible.length) break;
    eligible.sort((left, right) => {
      const dimensions = (candidate: SourceSelectionCandidate<T>) => {
        const provider = normalizedDimension(candidate.provider, 'unknown');
        const campaign = normalizedDimension(candidate.campaign, 'uncategorized-campaign');
        const merchant = normalizedDimension(candidate.merchantDomain || normalizedMerchantDomain(candidate.merchantUrl), 'unknown');
        const category = normalizedDimension(candidate.category, 'uncategorized');
        const keyword = normalizedDimension(candidate.keyword, 'unkeyed');
        return [
          count(counts.merchant, merchant),
          count(counts.campaign, campaign),
          count(counts.provider, provider),
          count(counts.category, category),
          count(counts.keyword, keyword),
          -(candidate.priority || 0),
        ];
      };
      const a = dimensions(left);
      const b = dimensions(right);
      for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] - b[index];
      return deterministicRank(left, options.scheduleBucket).localeCompare(deterministicRank(right, options.scheduleBucket));
    });
    const chosen = eligible[0];
    selected.push(chosen);
    remaining.delete(chosen);
    const dimensions: Array<[Map<string, number>, string]> = [
      [counts.provider, normalizedDimension(chosen.provider, 'unknown')],
      [counts.campaign, normalizedDimension(chosen.campaign, 'uncategorized-campaign')],
      [counts.merchant, normalizedDimension(chosen.merchantDomain || normalizedMerchantDomain(chosen.merchantUrl), 'unknown')],
      [counts.category, normalizedDimension(chosen.category, 'uncategorized')],
      [counts.keyword, normalizedDimension(chosen.keyword, 'unkeyed')],
    ];
    for (const [map, key] of dimensions) map.set(key, count(map, key) + 1);
  }

  for (const candidate of remaining) {
    const merchant = normalizedDimension(candidate.merchantDomain || normalizedMerchantDomain(candidate.merchantUrl), 'unknown');
    const campaign = normalizedDimension(candidate.campaign, 'uncategorized-campaign');
    const reason = count(counts.merchant, merchant) >= merchantCap
      ? 'MERCHANT_SELECTION_CAP'
      : count(counts.campaign, campaign) >= campaignCap ? 'CAMPAIGN_SELECTION_CAP' : 'BATCH_LIMIT';
    skipped.push({ candidate, reason });
  }
  return { selected, skipped };
}
