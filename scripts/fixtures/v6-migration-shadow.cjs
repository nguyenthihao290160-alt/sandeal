/* eslint-disable @typescript-eslint/no-require-imports */
const { fixture } = require('./v6-domain-contract.cjs');
const { normalizeCanonicalProduct } = require('../../src/lib/canonicalProduct.ts');
const { domainJson } = require('../../src/lib/storage/domainSerialization.ts');
function shadowFixture() {
  const products = [], snapshots = [];
  for (let index = 0; index < 32; index++) {
    const id = `shadow-product-${String(index).padStart(3,'0')}`, external = `shadow-external-${index}`;
    const status = ['needs_review','approved','published','archived'][index % 4];
    const value = domainJson(normalizeCanonicalProduct({ ...fixture(id, external), status,
      publicHidden: status !== 'published', publicBlocked: false, needsVerification: status !== 'published',
      lifecycleState: status === 'published' ? 'PUBLISHED' : status === 'approved' ? 'READY_FOR_PUBLISH' : status === 'archived' ? 'HIDDEN' : 'STAGED',
      price: 200 + index, merchant: 'Explicit test merchant', category: 'test-category',
      offers: [{ id: `shadow-offer-${index}`, source:'accesstrade', merchant:'Explicit test merchant', price:200+index, originalPrice:300+index,
        affiliateUrl:`https://fixture.invalid/affiliate/${index}`, health:'UNKNOWN', observedAt:'2026-09-01T00:00:00.000Z', confidence:0, primary:true }],
      sourceMappings: [{ source:'accesstrade', sourceId:external, originalUrl:`https://fixture.invalid/products/${external}`,
        normalizedOriginalUrl:`https://fixture.invalid/products/${external}`, firstSeenAt:'2026-09-01T00:00:00.000Z', lastSeenAt:'2026-09-01T00:00:00.000Z' }],
    }));
    products.push(value);
    for (let day = 1; day <= 2; day++) snapshots.push({ id:`shadow-price-${index}-${day}`, productId:id, source:'accesstrade', price:200+index,
      currency:'VND', availability:'unknown', capturedAt:`2026-09-0${day}T00:00:00.000Z`, operationId:'explicit-shadow-fixture', sourceHash:`fixture-fact-${index}` });
  }
  // One byte-equivalent duplicate tests explicit classification, not silent loss.
  products.push(structuredClone(products[0]));
  return { 'products.json':products, 'price-history.json':snapshots,
    'automation-settings.json':{enabled:false,freeOnly:true,allowPaidAi:false,maxItemsPerRun:20},
    'scheduler-config.json':{enabled:false,intervalMinutes:30} };
}
module.exports = { shadowFixture };
