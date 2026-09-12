/* eslint-disable @typescript-eslint/no-require-imports */
const { normalizeCanonicalProduct } = require('../../src/lib/canonicalProduct.ts');
const { generateEditorialReview } = require('../../src/lib/editorialReview.ts');
// Synthetic catalogue proof only, always inserted into an isolated local D1.
function cloudflareProduct(id = 'local-audio', overrides = {}) {
  const now = new Date().toISOString();
  const source = { id, sourceId: id, title: `Tai nghe kiểm chứng ${id}`, slug: id,
    description: 'Explicit local runtime fixture. No live merchant data.', kind: 'product', platform: 'website', source: 'manual',
    originalUrl: `https://merchant.example/products/${id}`, canonicalProductUrl: `https://merchant.example/products/${id}`,
    canonicalUrlSource: 'manual', canonicalUrlStatus: 'verified', canonicalUrlVerifiedAt: now,
    affiliateUrl: `https://merchant.example/products/${id}?affiliate=fixture`, affiliateUrlSource: 'manual', affiliateUrlStatus: 'verified', affiliateUrlVerifiedAt: now,
    imageUrl: `https://merchant.example/images/${id}.jpg`, price: 1500000, salePrice: 1200000, currency: 'VND', category: 'Audio', brand: 'Fixture Brand',
    status: 'published', publicHidden: false, publicBlocked: false, needsVerification: false, lifecycleState: 'PUBLISHED',
    verifiedSource: true, sourceVerified: true, autoPublished: false, autoPublishEligible: true,
    linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok', imageUrlHttpStatus: 200, imageContentType: 'image/jpeg',
    linkLastCheckedAt: now, affiliateLastCheckedAt: now, imageLastCheckedAt: now, priceObservedAt: now,
    priceTruthState: 'FRESH', priceVerificationStatus: 'VERIFIED', fieldProvenance: { price: { source: 'provider_api', fetchedAt: now, verificationStatus: 'VERIFIED' } },
    lastSeenAt: now, priceLastChangedAt: now, availability: 'available', qualityScore: 86, qualityBand: 'good',
    opportunityScore: 78, opportunityBand: 'recommended', dealScore: 82, dealBand: 'featured', riskLevel: 'low',
    createdAt: now, updatedAt: now,
    offers: [{ id: `${id}-offer`, source: 'manual', merchant: 'Fixture merchant', price: 1200000,
      affiliateUrl: `https://merchant.example/products/${id}`, health: 'HEALTHY', observedAt: now, confidence: 1, primary: true }],
    specifications: { connection: 'Bluetooth', model: id }, sourceHash: `local-fixture-${id}`,
    ...overrides };
  return normalizeCanonicalProduct({ ...source, reviewContent: generateEditorialReview(source, [], now) });
}
module.exports = { cloudflareProduct };
