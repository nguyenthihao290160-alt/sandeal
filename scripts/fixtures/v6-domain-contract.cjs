/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { normalizeCanonicalProduct } = require('../../src/lib/canonicalProduct.ts');
const fixture = (id, sourceId = id) => normalizeCanonicalProduct({
  id, sourceId, title: `Fixture product ${id}`, source: 'accesstrade', platform: 'other', kind: 'product',
  slug: id, price: 100, originalUrl: `https://fixture.invalid/products/${sourceId}`,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
});
async function runDomainContract(label, adapter, test) {
  const domain = adapter.domain;
  const product = fixture(`${label}-product`);
  let first;
  await test(`${label}: product create/read preserves canonical domain`, async () => {
    first = await domain.createProduct(product, { source: product.source, sourceId: product.sourceId });
    assert.equal(first.status, 'APPLIED');
    assert.equal(first.record.version.revision, 1);
    assert.equal((await domain.getProduct(product.id)).value.title, product.title);
    assert.equal((await domain.getProductBySlug(product.slug)).value.id, product.id);
  });
  await test(`${label}: source identity converges and rejects concurrent duplicate creation`, async () => {
    assert.equal((await domain.findProductIdentity({ source: product.source, sourceId: product.sourceId }))[0].value.id, product.id);
    const duplicate = fixture(`${label}-duplicate`, product.sourceId);
    assert.deepEqual(await domain.createProduct(duplicate, { source: product.source, sourceId: product.sourceId }), { status: 'CONFLICT', reason: 'IDENTITY' });
    assert.equal(await domain.getProduct(duplicate.id), null);
  });
  await test(`${label}: source uniqueness also guards direct entity creation`, async () => {
    const duplicate = fixture(`${label}-direct-duplicate`, product.sourceId);
    assert.deepEqual(await domain.createProduct(duplicate), { status: 'CONFLICT', reason: 'IDENTITY' });
    assert.equal(await domain.getProduct(duplicate.id), null);
  });
  await test(`${label}: revision one applies once, stale conflict preserves newer offer/publication`, async () => {
    const update = await domain.replaceProduct({ ...first.record.value, price: 125, status: 'approved' }, first.record.version);
    assert.equal(update.status, 'APPLIED'); assert.equal(update.record.version.revision, 2);
    const stale = await domain.replaceProduct({ ...product, price: 5, status: 'archived' }, first.record.version);
    assert.deepEqual(stale, { status: 'CONFLICT', reason: 'VERSION' });
    assert.equal((await domain.getProduct(product.id)).value.price, 125);
    assert.equal((await domain.getProduct(product.id)).value.status, 'approved');
    const retry = await domain.replaceProduct({ ...update.record.value, price: 150 }, update.record.version);
    assert.equal(retry.status, 'APPLIED'); assert.equal(retry.record.version.revision, 3);
    assert.equal((await domain.getProduct(product.id)).value.price, 150);
  });
  await test(`${label}: missing record rejects conditional update`, async () => {
    assert.deepEqual(await domain.replaceProduct(fixture(`${label}-absent`), first.record.version), { status: 'NOT_FOUND' });
  });
  await test(`${label}: distinct stable source products never merge on similar titles`, async () => {
    const distinct = { ...fixture(`${label}-distinct`), title: product.title };
    assert.equal((await domain.createProduct(distinct, { source: distinct.source, sourceId: distinct.sourceId })).status, 'APPLIED');
    const found = await domain.findProductIdentity({ source: distinct.source, sourceId: distinct.sourceId });
    assert.deepEqual(found.map(row => row.value.id), [distinct.id]);
  });
  await test(`${label}: bounded product page validates limit and keyset`, async () => {
    const page = await domain.listProducts({ limit: 1 }); assert.equal(page.length, 1);
    const next = await domain.listProducts({ limit: 1, afterId: page[0].value.id });
    assert.equal(next.length, 1); assert.notEqual(next[0].value.id, page[0].value.id);
    await assert.rejects(() => domain.listProducts({ limit: 0 }), error => error.code === 'DOMAIN_QUERY_LIMIT_INVALID');
  });
  await test(`${label}: price append suppresses identical repeats but permits return to prior price`, async () => {
    const snap = { id: `${label}-price-1`, productId: product.id, source: 'accesstrade', price: 100, currency: 'VND', availability: 'unknown', capturedAt: '2026-09-01T00:00:00.000Z', operationId: 'fixture', sourceHash: 'a' };
    const options = { forceCheckpoint: false, checkpointHours: 24 };
    assert.equal((await domain.appendPriceSnapshot(snap, options)).created, true);
    assert.equal((await domain.appendPriceSnapshot({ ...snap, id: `${label}-repeat` }, options)).created, false);
    assert.equal((await domain.appendPriceSnapshot({ ...snap, id: `${label}-price-2`, capturedAt: '2026-09-02T00:00:00.000Z', price: 120, sourceHash: 'b' }, options)).created, true);
    assert.equal((await domain.appendPriceSnapshot({ ...snap, id: `${label}-price-3`, capturedAt: '2026-09-03T00:00:00.000Z' }, options)).created, true);
  });
  await test(`${label}: price query is bounded, chronological and cursor-addressable`, async () => {
    const rows = await domain.getPriceHistory({ productId: product.id, limit: 2 });
    assert.equal(rows.length, 2); assert.deepEqual(rows.map(row => row.price), [120, 100]);
    const older = await domain.getPriceHistory({ productId: product.id, limit: 2, before: rows[0] });
    assert.equal(older.length, 1); assert.equal(older[0].price, 100);
    await assert.rejects(() => domain.getPriceHistory({ productId: product.id, limit: 731 }), error => error.code === 'DOMAIN_QUERY_LIMIT_INVALID');
  });
  await test(`${label}: publication audit effect replay keeps the first durable event`, async () => {
    const event = { id: `${label}-audit`, effectKey: `${label}-effect`, productId: product.id, action: 'fixture-state', timestamp: '2026-09-01T00:00:00.000Z' };
    assert.equal((await domain.appendProductAudit('publication', event, event.effectKey)).created, true);
    const replay = await domain.appendProductAudit('publication', { ...event, action: 'must-not-overwrite' }, event.effectKey);
    assert.equal(replay.created, false); assert.deepEqual(replay.event, event);
  });
}
module.exports = { runDomainContract, fixture };
