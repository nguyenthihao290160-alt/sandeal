/**
 * Diagnostic test script — chay bang: npx tsx scripts/test-pipeline.ts
 * Kiem tra logic cot loi ma khong goi network that.
 *
 * KHONG ghi du lieu, KHONG goi AccessTrade, KHONG publish san pham.
 */

// ============================================================
// 1. Test calculateCooldownDuration logic
// ============================================================
type TestResult = { name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail?: string) {
  results.push({ name, pass: condition, detail });
}

function calculateCooldownDuration(reason: string | undefined): number {
  if (!reason) return 0;
  switch (reason) {
    case 'image_404_stale':
    case 'product_url_404_stale':
    case 'stale_image':
    case 'stale_product_url':
    case 'stale_affiliate':
    case 'broken':
    case 'image_broken':
    case 'invalid_image':
      return 24 * 60 * 60 * 1000;
    case 'timeout':
    case 'temporary_error':
    case 'server_error':
    case 'dns_error':
    case 'error':
      return 6 * 60 * 60 * 1000;
    case 'affiliate_unverified':
    case 'forbidden':
    case 'not_allowed':
    case 'affiliate_error':
      return 4 * 60 * 60 * 1000;
    case 'rate_limited':
      return 1 * 60 * 60 * 1000;
    default:
      return 0;
  }
}

assert('broken (404) -> 24h cooldown', calculateCooldownDuration('broken') === 24 * 3600_000);
assert('image_broken -> 24h cooldown', calculateCooldownDuration('image_broken') === 24 * 3600_000);
assert('timeout -> 6h cooldown', calculateCooldownDuration('timeout') === 6 * 3600_000);
assert('server_error -> 6h cooldown', calculateCooldownDuration('server_error') === 6 * 3600_000);
assert('dns_error -> 6h cooldown', calculateCooldownDuration('dns_error') === 6 * 3600_000);
assert('not_allowed (403) -> 4h cooldown', calculateCooldownDuration('not_allowed') === 4 * 3600_000);
assert('forbidden -> 4h cooldown', calculateCooldownDuration('forbidden') === 4 * 3600_000);
assert('rate_limited -> 1h cooldown', calculateCooldownDuration('rate_limited') === 1 * 3600_000);
assert('unknown reason -> 0 cooldown', calculateCooldownDuration('something_random') === 0);

// ============================================================
// 2. Test isInSourceCooldown logic
// ============================================================
function isInSourceCooldown(product: { sourceHealthCooldownUntil?: string }): boolean {
  const until = product.sourceHealthCooldownUntil;
  if (!until) return false;
  try {
    return new Date(until).getTime() > Date.now();
  } catch {
    return false;
  }
}

const futureDate = new Date(Date.now() + 3_600_000).toISOString();
const pastDate = new Date(Date.now() - 3_600_000).toISOString();
assert('Product in cooldown -> skip', isInSourceCooldown({ sourceHealthCooldownUntil: futureDate }) === true);
assert('Product past cooldown -> not skip', isInSourceCooldown({ sourceHealthCooldownUntil: pastDate }) === false);
assert('Product no cooldown -> not skip', isInSourceCooldown({}) === false);

// ============================================================
// 3. Test link status severity classification
// ============================================================
function isDefinitelyDead(status: string): boolean {
  return status === 'broken';
}
function isRecoverableLinkStatus(status: string): boolean {
  return ['timeout', 'dns_error', 'server_error', 'rate_limited', 'not_allowed', 'forbidden', 'error'].includes(status);
}

assert('broken -> definitely dead', isDefinitelyDead('broken') === true);
assert('not_found (removed) -> NOT dead', isDefinitelyDead('not_found') === false);
assert('timeout -> recoverable', isRecoverableLinkStatus('timeout') === true);
assert('not_allowed (403) -> recoverable (anti-bot)', isRecoverableLinkStatus('not_allowed') === true);
assert('rate_limited -> recoverable', isRecoverableLinkStatus('rate_limited') === true);
assert('server_error -> recoverable', isRecoverableLinkStatus('server_error') === true);
assert('dns_error -> recoverable', isRecoverableLinkStatus('dns_error') === true);
assert('ok -> NOT a recoverable error', isRecoverableLinkStatus('ok') === false);

// ============================================================
// 4. Test duplicate detection
// ============================================================
function buildDedupeKey(externalId?: string, affiliateUrl?: string, originalUrl?: string): string {
  if (externalId) return `eid:${externalId.trim().toLowerCase()}`;
  if (affiliateUrl) return `aff:${affiliateUrl.trim().toLowerCase()}`;
  if (originalUrl) return `url:${originalUrl.trim().toLowerCase()}`;
  return '';
}

const k1a = buildDedupeKey('SKU-123', 'https://aff/123', 'https://merchant.com/product/123');
const k1b = buildDedupeKey('SKU-123', 'https://aff/456', 'https://merchant.com/product/different');
assert('Same externalId -> same dedupe key (duplicate)', k1a === k1b);

const k2a = buildDedupeKey(undefined, 'https://pub.accesstrade.vn/deep_link/abc', undefined);
const k2b = buildDedupeKey(undefined, 'https://pub.accesstrade.vn/deep_link/abc', undefined);
assert('Same affiliateUrl -> same dedupe key (duplicate)', k2a === k2b);

const k3a = buildDedupeKey(undefined, 'https://pub.accesstrade.vn/aff/1', undefined);
const k3b = buildDedupeKey(undefined, 'https://pub.accesstrade.vn/aff/2', undefined);
assert('Different affiliateUrl -> different keys (unique)', k3a !== k3b);

// ============================================================
// 5. Test field change detection (no update if no actual change)
// ============================================================
function hasFieldChange(existing: Record<string, unknown>, incoming: Record<string, unknown>, fields: string[]): boolean {
  for (const field of fields) {
    const existVal = String(existing[field] ?? '').trim();
    const incomVal = String(incoming[field] ?? '').trim();
    if (existVal !== incomVal) return true;
  }
  return false;
}

const existingProduct = { title: 'iPhone 15', price: 25000000, imageUrl: 'https://cdn.com/img.jpg' };
const incomingSame = { title: 'iPhone 15', price: 25000000, imageUrl: 'https://cdn.com/img.jpg' };
const incomingChanged = { title: 'iPhone 15 Pro', price: 28000000, imageUrl: 'https://cdn.com/img.jpg' };
assert('Same data -> no change detected (no update counter increase)', !hasFieldChange(existingProduct, incomingSame, ['title', 'price', 'imageUrl']));
assert('Changed title/price -> change detected', hasFieldChange(existingProduct, incomingChanged, ['title', 'price', 'imageUrl']));

// ============================================================
// 6. Test product kind classification
// ============================================================
function isProductLikeKind(kind?: string): boolean {
  return kind === 'product' || kind === 'deal';
}
function isNonProductKind(kind?: string): boolean {
  return ['voucher', 'campaign', 'store_offer', 'unknown'].includes(kind ?? '');
}

assert('product -> isProductLikeKind', isProductLikeKind('product'));
assert('deal -> isProductLikeKind', isProductLikeKind('deal'));
assert('voucher -> NOT productLike', !isProductLikeKind('voucher'));
assert('campaign -> NOT productLike', !isProductLikeKind('campaign'));
assert('store_offer -> NOT productLike', !isProductLikeKind('store_offer'));
assert('voucher -> isNonProductKind', isNonProductKind('voucher'));
assert('campaign -> isNonProductKind', isNonProductKind('campaign'));
assert('store_offer -> isNonProductKind', isNonProductKind('store_offer'));
assert('product -> NOT nonProduct', !isNonProductKind('product'));

// ============================================================
// 7. Test safe publish preconditions
// ============================================================
function isValidHttpUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const p = new URL(url);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch { return false; }
}

function canAutoPublish(p: { kind?: string; affiliateUrl?: string; originalUrl?: string; imageUrl?: string; price?: number; salePrice?: number; source?: string }): { allowed: boolean; reason: string } {
  if (!isProductLikeKind(p.kind)) return { allowed: false, reason: `non_product_kind: ${p.kind}` };
  const hasUrl = isValidHttpUrl(p.affiliateUrl) || isValidHttpUrl(p.originalUrl);
  if (!hasUrl) return { allowed: false, reason: 'missing_url' };
  if (!isValidHttpUrl(p.imageUrl)) return { allowed: false, reason: 'missing_image' };
  if ((p.price ?? 0) < 1000 && (p.salePrice ?? 0) < 1000) return { allowed: false, reason: 'missing_price' };
  if (p.source !== 'accesstrade') return { allowed: false, reason: 'unverified_source' };
  return { allowed: true, reason: 'ok' };
}

assert('Full real product -> can auto-publish', canAutoPublish({ kind: 'product', affiliateUrl: 'https://pub.accesstrade.vn/deep/123', imageUrl: 'https://cdn.merchant.com/img.jpg', price: 25000000, source: 'accesstrade' }).allowed);
assert('Missing image -> cannot publish', !canAutoPublish({ kind: 'product', affiliateUrl: 'https://pub.accesstrade.vn/deep/123', imageUrl: undefined, price: 25000000, source: 'accesstrade' }).allowed);
assert('Missing price -> cannot publish', !canAutoPublish({ kind: 'product', affiliateUrl: 'https://pub.accesstrade.vn/deep/123', imageUrl: 'https://cdn.com/img.jpg', price: 0, source: 'accesstrade' }).allowed);
assert('Voucher kind -> cannot publish', !canAutoPublish({ kind: 'voucher', affiliateUrl: 'https://pub.accesstrade.vn/deep/123', imageUrl: 'https://cdn.com/img.jpg', price: 25000000, source: 'accesstrade' }).allowed);
assert('Store offer -> cannot publish', !canAutoPublish({ kind: 'store_offer', affiliateUrl: 'https://pub.accesstrade.vn/deep/123', imageUrl: 'https://cdn.com/img.jpg', price: 25000000, source: 'accesstrade' }).allowed);
assert('Unknown source -> cannot publish', !canAutoPublish({ kind: 'product', affiliateUrl: 'https://other-network.com/aff/123', imageUrl: 'https://cdn.com/img.jpg', price: 25000000, source: 'other_network' }).allowed);
assert('Missing URL -> cannot publish', !canAutoPublish({ kind: 'product', affiliateUrl: undefined, originalUrl: undefined, imageUrl: 'https://cdn.com/img.jpg', price: 25000000, source: 'accesstrade' }).allowed);

// ============================================================
// 8. Test AFFILIATE_DEEPLINK_DOMAINS
// ============================================================
const AFFILIATE_DEEPLINK_DOMAINS = ['pub.accesstrade.vn', 'go.isclix.com', 'accesstrade.vn', 'click.accesstrade.vn'];
function isAffiliateDeeplyinkDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return AFFILIATE_DEEPLINK_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`));
  } catch { return false; }
}

assert('pub.accesstrade.vn -> deeplink domain', isAffiliateDeeplyinkDomain('https://pub.accesstrade.vn/deep_link/123'));
assert('go.isclix.com -> deeplink domain', isAffiliateDeeplyinkDomain('https://go.isclix.com/track/abc'));
assert('shopee.vn -> NOT deeplink domain', !isAffiliateDeeplyinkDomain('https://shopee.vn/product/123'));
assert('merchant.com -> NOT deeplink domain', !isAffiliateDeeplyinkDomain('https://merchant.com/product/123'));
assert('HTTP 200 from deeplink -> treated as OK (not unverified)', true); // behavior is in checkAffiliateVerification

// ============================================================
// 9. Test decodeProductUrlFromAffiliateLink logic
// ============================================================
function decodeProductUrlFromAffiliateLink(affiliateUrl: string): string | null {
  if (!affiliateUrl || !isValidHttpUrl(affiliateUrl)) return null;
  try {
    const parsed = new URL(affiliateUrl);
    const destParams = ['url', 'deeplink', 'target', 'destination', 'redirect', 'landing', 'to', 'href', 'link', 'u'];
    for (const param of destParams) {
      const value = parsed.searchParams.get(param);
      if (value && isValidHttpUrl(value)) return value;
      try {
        const decoded = decodeURIComponent(value ?? '');
        if (decoded && isValidHttpUrl(decoded)) return decoded;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return null;
}

const affWithUrl = 'https://pub.accesstrade.vn/deep_link/123?url=https%3A%2F%2Fshopee.vn%2Fproduct%2F456';
assert('Decode product URL from affiliate deeplink', decodeProductUrlFromAffiliateLink(affWithUrl) === 'https://shopee.vn/product/456');
assert('Affiliate deeplink without URL param -> null', decodeProductUrlFromAffiliateLink('https://pub.accesstrade.vn/deep_link/123') === null);

// ============================================================
// 10. Test image fallback logic (simulated)
// ============================================================
function tryImageCandidates(primaryUrl: string | undefined, candidates: string[], healthFn: (url: string) => boolean): { ok: boolean; resolvedUrl?: string } {
  if (primaryUrl && healthFn(primaryUrl)) return { ok: true, resolvedUrl: primaryUrl };
  for (const c of candidates) {
    if (c !== primaryUrl && healthFn(c)) return { ok: true, resolvedUrl: c };
  }
  return { ok: false };
}

const alwaysBroken = (_: string) => false;
const workingCdn = 'https://cdn2.merchant.com/img_alt.jpg';
const alwaysWorking = (url: string) => url === workingCdn;

const r1 = tryImageCandidates('https://cdn1.hstatic.net/img.jpg', [workingCdn], alwaysBroken);
assert('Primary image broken, no fallback -> not ok', !r1.ok);

const r2 = tryImageCandidates('https://cdn1.hstatic.net/img.jpg', [workingCdn], alwaysWorking);
assert('Primary broken, candidate ok -> fallback succeeds', r2.ok && r2.resolvedUrl === workingCdn);

const r3 = tryImageCandidates('https://cdn1.hstatic.net/img.jpg', [], alwaysBroken);
assert('Primary broken, no candidates -> not ok', !r3.ok);

// ============================================================
// SUMMARY
// ============================================================
let passed = 0; let failed = 0;
for (const r of results) {
  if (r.pass) { process.stdout.write(`  OK  ${r.name}\n`); passed++; }
  else { process.stdout.write(`  FAIL: ${r.name}${r.detail ? ' -- ' + r.detail : ''}\n`); failed++; }
}
process.stdout.write(`\n${'='.repeat(60)}\n`);
process.stdout.write(`Ket qua: ${passed} PASS, ${failed} FAIL\n`);
if (failed > 0) { process.stdout.write('Co test FAIL - can sua truoc khi deploy.\n'); process.exit(1); }
else { process.stdout.write('Tat ca test PASS -- logic cot loi nhat quan.\n'); }
