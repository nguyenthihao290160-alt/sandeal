import { createHash } from 'node:crypto';
import type { OutboundEvent } from '@/lib/product-intelligence/types';
import { validateExternalUrl } from '@/lib/product-intelligence/urlSafety';
import type { Product, ProductOffer } from '@/lib/types';

export const REVENUE_INTEGRITY_RULE_VERSION = 'revenue-integrity-v2';

const BOT_PATTERN = /(?:^|[^a-z])(?:bot|crawler|spider|preview|headless|lighthouse|uptime|monitor|curl|wget)(?:[^a-z]|$)/i;
const TRACKING_PATTERN = /^(?:aff(?:iliate)?(?:_?(?:id|sid|sub))?|click_?id|sub(?:_?id)?|tracking(?:_?id)?|ref|utm_.+)$/i;
const HEALTHY_PRODUCT_LINK = new Set(['ok', 'redirect_ok']);
const BROKEN_PRODUCT_LINK = new Set(['broken', 'not_found', 'affiliate_error', 'product_unavailable', 'forbidden']);
const DEGRADED_PRODUCT_LINK = new Set(['rate_limited', 'server_error', 'timeout', 'dns_error', 'error']);
const MAX_REDIRECT_CHAIN = 8;

export interface RevenueIntegrityResult {
  eligible: boolean;
  reasons: string[];
  merchant: string | null;
  sourceConsistent: boolean;
  merchantConsistent: boolean;
  trackingPresent: boolean;
  redirectHealthy: boolean | null;
  selectedOfferId: string | null;
  publicRedirectPath: string;
  fingerprint: string;
  ruleVersion: string;
}

export interface RevenueIntegrityMerchantHealth {
  merchant: string;
  healthyProducts: number;
  degradedProducts: number;
  brokenProducts: number;
  unknownProducts: number;
}

export interface RevenueIntegritySummary {
  outboundClicks: number;
  redirectSuccesses: number;
  brokenAffiliateProducts: number;
  degradedAffiliateProducts: number;
  trafficWithBrokenOffer: Array<{ productId: string; outboundClicks: number }>;
  merchantHealth: RevenueIntegrityMerchantHealth[];
  ruleVersion: string;
}

function parseHttpUrl(value?: string): URL | null {
  const result = validateExternalUrl(value);
  return result.safe && result.normalizedUrl ? new URL(result.normalizedUrl) : null;
}

function normalizedHost(url: URL | null): string | null {
  return url?.hostname.toLowerCase().replace(/^www\./, '') || null;
}

function canonicalSource(value?: string): string {
  return String(value || '').toLowerCase().replace(/affiliate/g, '').replace(/shop/g, '').replace(/[^a-z0-9]+/g, '');
}

function sourceMatches(product: Partial<Product>, offer?: ProductOffer): boolean {
  if (!offer) return true;
  const actual = canonicalSource(offer.source);
  const expected = [product.source, product.affiliateSource, product.platform]
    .map(canonicalSource)
    .filter(Boolean);
  return Boolean(actual) && expected.some(value => value === actual || value.includes(actual) || actual.includes(value));
}

function canonicalMerchant(value?: string | null): string {
  if (!value) return '';
  const parsed = parseHttpUrl(value);
  return (normalizedHost(parsed) || value)
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '');
}

function domainsRelated(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

function merchantsRelated(left?: string | null, right?: string | null): boolean {
  const a = canonicalMerchant(left);
  const b = canonicalMerchant(right);
  return Boolean(a && b) && (a === b || (Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a))));
}

function expectedMerchant(product: Partial<Product>, productUrl: URL | null): string | null {
  return product.identity?.merchant || normalizedHost(productUrl);
}

function redirectChainDecision(input: {
  affiliate: URL | null;
  productUrl: URL | null;
  redirectChain?: string[];
}): { healthy: boolean | null; reasons: string[] } {
  if (input.redirectChain === undefined) return { healthy: null, reasons: [] };
  if (!input.redirectChain.length || input.redirectChain.length > MAX_REDIRECT_CHAIN) {
    return { healthy: false, reasons: ['redirect_chain_invalid'] };
  }
  const parsed = input.redirectChain.map(item => parseHttpUrl(item));
  if (parsed.some(item => !item)) return { healthy: false, reasons: ['redirect_chain_unsafe'] };
  const urls = parsed.map(item => item!.toString());
  if (new Set(urls).size !== urls.length) return { healthy: false, reasons: ['redirect_loop'] };
  const reasons: string[] = [];
  if (!input.affiliate || urls[0] !== input.affiliate.toString()) reasons.push('redirect_origin_mismatch');
  if (!domainsRelated(normalizedHost(parsed.at(-1) || null), normalizedHost(input.productUrl))) reasons.push('redirect_merchant_mismatch');
  return { healthy: reasons.length === 0, reasons };
}

export function selectRevenueIntegrityOffer(product: Partial<Product>): ProductOffer | undefined {
  const offers = Array.isArray(product.offers) ? product.offers : [];
  return offers.find(offer => offer.id === product.bestOfferId)
    || offers.find(offer => offer.primary)
    || undefined;
}

export function inspectRevenueIntegrity(input: {
  product: Partial<Product>;
  offer?: ProductOffer;
  redirectChain?: string[];
  now?: number;
}): RevenueIntegrityResult {
  const affiliate = parseHttpUrl(input.offer?.affiliateUrl || input.product.affiliateUrl);
  const productUrl = parseHttpUrl(input.product.originalUrl);
  const expected = expectedMerchant(input.product, productUrl);
  const merchant = input.offer?.merchant || expected;
  const reasons: string[] = [];
  if (!affiliate) reasons.push('invalid_affiliate_url');
  if (!productUrl) reasons.push('invalid_product_url');

  const sourceConsistent = sourceMatches(input.product, input.offer);
  if (!sourceConsistent) reasons.push('offer_source_mismatch');
  const merchantConsistent = input.offer ? merchantsRelated(merchant, expected) : true;
  if (!merchantConsistent) reasons.push('offer_merchant_mismatch');

  const health = input.offer?.health || String(input.product.affiliateHealthStatus || '').toUpperCase();
  if (health !== 'HEALTHY' && !HEALTHY_PRODUCT_LINK.has(health.toLowerCase())) reasons.push('affiliate_offer_unhealthy');
  if (input.offer?.expiresAt && Date.parse(input.offer.expiresAt) <= (input.now ?? Date.now())) reasons.push('affiliate_offer_expired');
  if (input.offer?.observedAt && !Number.isFinite(Date.parse(input.offer.observedAt))) reasons.push('affiliate_offer_observation_invalid');

  const trackingPresent = Boolean(affiliate && [...affiliate.searchParams.keys()].some(key => TRACKING_PATTERN.test(key)));
  if (!trackingPresent) reasons.push('tracking_parameter_missing');

  const redirect = redirectChainDecision({ affiliate, productUrl, redirectChain: input.redirectChain });
  reasons.push(...redirect.reasons);
  const fingerprint = createHash('sha256')
    .update(`${affiliate?.toString() || ''}|${canonicalMerchant(merchant)}|${canonicalSource(input.offer?.source || input.product.source)}|${input.product.id || ''}`)
    .digest('hex');
  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    merchant,
    sourceConsistent,
    merchantConsistent,
    trackingPresent,
    redirectHealthy: redirect.healthy,
    selectedOfferId: input.offer?.id || null,
    publicRedirectPath: `/go/${encodeURIComponent(String(input.product.id || ''))}`,
    fingerprint,
    ruleVersion: REVENUE_INTEGRITY_RULE_VERSION,
  };
}

export function isCountableOutboundClick(input: {
  userAgent?: string;
  method?: string;
  purpose?: string;
  nextRouterPrefetch?: string;
}): boolean {
  const prefetch = `${input.purpose || ''} ${input.nextRouterPrefetch || ''}`;
  return (input.method || 'GET').toUpperCase() === 'GET'
    && !BOT_PATTERN.test(input.userAgent || '')
    && !/prefetch|prerender/i.test(prefetch);
}

type IntegrityState = 'healthy' | 'degraded' | 'broken' | 'unknown';

function integrityState(product: Product, result: RevenueIntegrityResult, offer: ProductOffer | undefined, now: number): IntegrityState {
  const health = String(offer?.health || product.affiliateHealthStatus || '').toLowerCase();
  if (result.eligible) return 'healthy';
  if (offer?.expiresAt && Date.parse(offer.expiresAt) <= now) return 'broken';
  if (offer?.health === 'BROKEN' || BROKEN_PRODUCT_LINK.has(health)
    || result.reasons.some(reason => ['invalid_affiliate_url', 'offer_merchant_mismatch', 'offer_source_mismatch', 'affiliate_offer_expired'].includes(reason))) return 'broken';
  if (offer?.health === 'DEGRADED' || DEGRADED_PRODUCT_LINK.has(health)) return 'degraded';
  return 'unknown';
}

export function summarizeRevenueIntegrity(input: {
  products: Product[];
  events: OutboundEvent[];
  cutoff?: number;
  now?: number;
}): RevenueIntegritySummary {
  const now = input.now ?? Date.now();
  const cutoff = input.cutoff ?? 0;
  const clicks = input.events.filter(event => event.eventType === 'OUTBOUND_CLICK'
    && Number.isFinite(Date.parse(event.timestamp))
    && Date.parse(event.timestamp) >= cutoff
    && Date.parse(event.timestamp) <= now);
  const clicksByProduct = new Map<string, number>();
  for (const event of clicks) {
    if (event.productId) clicksByProduct.set(event.productId, (clicksByProduct.get(event.productId) || 0) + 1);
  }

  const merchantHealth = new Map<string, RevenueIntegrityMerchantHealth>();
  const states = new Map<string, IntegrityState>();
  for (const product of input.products) {
    const offer = selectRevenueIntegrityOffer(product);
    const result = inspectRevenueIntegrity({ product, offer, now });
    const state = integrityState(product, result, offer, now);
    states.set(product.id, state);
    const merchant = result.merchant || 'unknown';
    const current = merchantHealth.get(merchant) || {
      merchant,
      healthyProducts: 0,
      degradedProducts: 0,
      brokenProducts: 0,
      unknownProducts: 0,
    };
    if (state === 'healthy') current.healthyProducts += 1;
    else if (state === 'degraded') current.degradedProducts += 1;
    else if (state === 'broken') current.brokenProducts += 1;
    else current.unknownProducts += 1;
    merchantHealth.set(merchant, current);
  }

  return {
    outboundClicks: clicks.length,
    redirectSuccesses: clicks.length,
    brokenAffiliateProducts: [...states.values()].filter(state => state === 'broken').length,
    degradedAffiliateProducts: [...states.values()].filter(state => state === 'degraded').length,
    trafficWithBrokenOffer: [...clicksByProduct.entries()]
      .filter(([productId]) => states.get(productId) === 'broken')
      .map(([productId, outboundClicks]) => ({ productId, outboundClicks }))
      .sort((left, right) => right.outboundClicks - left.outboundClicks || left.productId.localeCompare(right.productId)),
    merchantHealth: [...merchantHealth.values()]
      .sort((left, right) => right.brokenProducts - left.brokenProducts || left.merchant.localeCompare(right.merchant)),
    ruleVersion: REVENUE_INTEGRITY_RULE_VERSION,
  };
}

export function revenueIntegrityDisclosure(result: RevenueIntegrityResult): Record<string, unknown> {
  return {
    eligible: result.eligible,
    reasons: result.reasons,
    merchant: result.merchant,
    sourceConsistent: result.sourceConsistent,
    merchantConsistent: result.merchantConsistent,
    trackingPresent: result.trackingPresent,
    redirectHealthy: result.redirectHealthy,
    selectedOfferId: result.selectedOfferId,
    publicRedirectPath: result.publicRedirectPath,
    fingerprint: result.fingerprint,
    ruleVersion: result.ruleVersion,
  };
}
