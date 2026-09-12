/* eslint-disable @typescript-eslint/no-require-imports */
const { moneyFixture } = require('./v6-money-engine.cjs');
const { D1DealStore } = require('../../src/lib/storage/d1/d1DealStore.ts');
const DAY = 86400000;
function history(product, now, values = [1200000, ...Array(9).fill(1600000)]) {
  return values.map((price, index) => ({ id: `deal-fixture-${product.id}-${index}`, productId: product.id, source: 'accesstrade',
    price, currency: 'VND', availability: 'available', capturedAt: new Date(now - index * DAY - 60000).toISOString(),
    operationId: `deal-fixture-observation-${index}`, sourceHash: `explicit-synthetic-price-${index}-${price}` }));
}
async function dealFixture(work) {
  await moneyFixture(async context => {
    const seeded = await context.seed(), now = Date.now();
    const product = { ...seeded, price: 1600000, offers: verifiedPublicOffers(seeded.offers) };
    const input = { product, history: history(product, now), providers: await context.money.providers(), revenue: [],
      allowedHosts: ['merchant.example'], now, testOnly: true };
    const store = new D1DealStore(context.db, true);
    const env = { ...context.env, SANDEAL_DEAL_INTELLIGENCE_ENABLED: 'true', AFFILIATE_REDIRECT_HOSTS: 'merchant.example' };
    async function persist() {
      const stored = await context.adapter.domain.getProduct(product.id);
      const changed = await context.adapter.domain.replaceProduct(product, stored.version);
      if (changed.status !== 'APPLIED') throw new Error('DEAL_FIXTURE_WRITE_FAILED');
      for (const row of [...input.history].reverse()) await context.adapter.domain.appendPriceSnapshot(row, { forceCheckpoint: true, checkpointHours: 24 });
    }
    await work({ ...context, now, product, input, store, env, persist });
  });
}
function verifiedPublicOffers(offers) {
  return offers.map(offer => ({ ...offer, health: 'HEALTHY', productLinkHealth: 'HEALTHY', affiliateHealth: 'HEALTHY',
    sourceVerified: true, sourceConfidence: 1, priceConfidence: 1 }));
}
module.exports = { dealFixture, history, verifiedPublicOffers, DAY };
