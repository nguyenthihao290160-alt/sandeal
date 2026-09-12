/* eslint-disable @typescript-eslint/no-require-imports */
require('../register-typescript.cjs');
const { openWorker } = require('./cloudflare-local.cjs');
const { cloudflareProduct } = require('../fixtures/v6-cloudflare-product.cjs');
const { D1JobStore } = require('../../src/lib/storage/d1/d1JobStore.ts');
const { createD1StorageAdapter } = require('../../src/lib/storage/d1/d1StorageAdapter.ts');
const { makeMessage } = require('../../src/lib/platform/cloudflareContracts.ts');
function delivery(body, id = 'local-delivery') {
  const result = { id, body, attempts: 1, ackCount: 0, retries: [], ack() { this.ackCount++; }, retry(options) { this.retries.push(options); } };
  return result;
}
async function fixture(work, options = {}) {
  const runtime = await openWorker({ queue: options.queue === true, bindings: { SANDEAL_AUTOPILOT_ENABLED: 'true' } });
  try {
    const sent = [], now = Date.now(), store = new D1JobStore(runtime.db), adapter = createD1StorageAdapter(runtime.db), product = cloudflareProduct();
    await adapter.domain.createProduct(product);
    const env = { SANDEAL_RUNTIME: 'cloudflare', SANDEAL_LOCAL_ONLY: 'true', SANDEAL_PRODUCTION: 'false', SANDEAL_AUTOPILOT_ENABLED: 'true',
      DB: runtime.db, JOB_QUEUE: { async send(message) { sent.push(message); } } };
    const input = { type: 'CAPTURE_PRICE_HISTORY', payload: { productId: product.id }, idempotencyKey: 'local-fixture-job' };
    await work({ runtime, db: runtime.db, sent, now, store, adapter, product, env, input,
      async job(overrides = {}) { return (await store.createJob({ ...input, ...overrides }, now)).job; },
      message(job) { return delivery(makeMessage(job)); },
      async history() { return (await runtime.db.prepare('SELECT * FROM price_history WHERE product_id=?').bind(product.id).all()).results; } });
  } finally { await runtime.dispose(); }
}
module.exports = { fixture, delivery };
