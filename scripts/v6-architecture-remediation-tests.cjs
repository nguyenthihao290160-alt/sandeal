/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
require('./register-typescript.cjs');
const { runDomainContract, fixture } = require('./fixtures/v6-domain-contract.cjs');
const { fileStorageAdapter } = require('../src/lib/storage/fileStorageAdapter.ts');
const { createStorage, withStorageAdapter, getStorageAdapter } = require('../src/lib/storage/storageFactory.ts');
const products = require('../src/lib/storage/products.ts');
const history = require('../src/lib/product-intelligence/priceHistory.ts');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sandeal-v6-domain-'));
const saved = { SANDEAL_RUNTIME: process.env.SANDEAL_RUNTIME, SANDEAL_DATA_DIR: process.env.SANDEAL_DATA_DIR, SANDEAL_STORAGE_DRIVER: process.env.SANDEAL_STORAGE_DRIVER };
Object.assign(process.env, { SANDEAL_RUNTIME: 'legacy', SANDEAL_DATA_DIR: temporary, SANDEAL_STORAGE_DRIVER: 'file' });
let passed = 0; let failed = 0;
async function test(name, work) { try { await work(); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); } }
async function main() {
  await runDomainContract('file', fileStorageAdapter, test);
  await test('legacy competing writer without revision advancement is still detected', async () => {
    const before = await fileStorageAdapter.domain.getProduct('file-product');
    await fileStorageAdapter.runTransaction('products', rows => rows.map(row => row.id === 'file-product' ? { ...row, price: 999 } : row));
    assert.deepEqual(await fileStorageAdapter.domain.replaceProduct({ ...before.value, price: 1 }, before.version), { status: 'CONFLICT', reason: 'VERSION' });
    assert.equal((await fileStorageAdapter.domain.getProduct('file-product')).value.price, 999);
  });
  await test('point product repository and price domain never request global collections', async () => {
    const queries = []; const forbidden = () => { throw new Error('FULL_COLLECTION_FORBIDDEN'); };
    const spy = { driver: 'file', domain: { ...fileStorageAdapter.domain,
      getPriceHistory: async query => { queries.push(query); return []; },
    }, readCollection: forbidden, scanCollection: forbidden, runTransaction: forbidden };
    await withStorageAdapter(spy, async () => {
      assert.equal((await products.getProductById('file-product')).id, 'file-product');
      assert.equal((await products.getProductBySlug('file-product')).id, 'file-product');
      assert.deepEqual(await history.listPriceHistory('file-product', 100), []);
    });
    assert.deepEqual(queries, [{ productId: 'file-product', limit: 100 }]);
  });
  await test('source ingestion uses bounded identity capability and keeps distinct titles', async () => {
    let identities = 0;
    const underlying = fileStorageAdapter.domain;
    const spy = { ...fileStorageAdapter, domain: { ...underlying, findProductIdentity: query => { identities++; return underlying.findProductIdentity(query); } },
      readCollection: () => { throw new Error('FULL_COLLECTION_FORBIDDEN'); } };
    await withStorageAdapter(spy, async () => {
      const a = await products.upsertSourceCandidateProduct(fixture('source-a'));
      const b = await products.upsertSourceCandidateProduct(fixture('source-a'));
      const c = await products.upsertSourceCandidateProduct({ ...fixture('source-b'), title: a.product.title });
      assert.equal(a.product.id, b.product.id); assert.notEqual(a.product.id, c.product.id);
      assert.equal(identities, 3);
    });
  });
  await test('publication implementation uses entity CAS for write and rollback', () => {
    const source = fs.readFileSync('src/lib/storage/products.ts', 'utf8');
    const publish = source.slice(source.indexOf('export async function publishCanonicalProductTransaction'), source.indexOf('export interface PublicationAudit'));
    assert.doesNotMatch(publish, /readCanonicalProducts|runTransaction|writeCollection/);
    assert.match(publish, /replaceProduct\(candidate, record\.version\)/);
    assert.match(publish, /replaceProduct\(previous, committedVersion\)/);
    assert.match(publish, /requireDurablePublishAuthorization/);
  });
  await test('binding seam rejects missing/invalid bindings and wrong driver before legacy creation', () => {
    for (const bindings of [undefined, {}, { DB: {} }]) assert.throws(() => createStorage({ runtime: 'cloudflare', bindings }), /CLOUDFLARE_STORAGE_BINDING_UNAVAILABLE/);
    const binding = { prepare() {}, async batch() {} };
    assert.throws(() => createStorage({ runtime: 'cloudflare', bindings: { DB: binding }, createD1: () => fileStorageAdapter }), /CLOUDFLARE_STORAGE_CAPABILITY_MISMATCH/);
    assert.throws(() => createStorage({ runtime: 'unknown' }), error => error.code === 'SANDEAL_RUNTIME_UNSUPPORTED');
    assert.equal(createStorage({ runtime: 'legacy' }), fileStorageAdapter);
  });
  await test('Cloudflare scope cannot inject or fall back to FileStorage', () => {
    process.env.SANDEAL_RUNTIME = 'cloudflare';
    try {
      assert.throws(() => withStorageAdapter(fileStorageAdapter, getStorageAdapter), /CLOUDFLARE_STORAGE_CAPABILITY_MISMATCH/);
      assert.throws(getStorageAdapter, /CLOUDFLARE_STORAGE_BINDING_UNAVAILABLE/);
    } finally { process.env.SANDEAL_RUNTIME = 'legacy'; }
  });
  await test('valid binding is passed explicitly and concurrent scopes remain isolated', async () => {
    const binding = { prepare() {}, async batch() {} };
    const supplied = { driver: 'd1', domain: { capabilities: { nativeIndexedQueries: true } }, settingsStore: {} };
    const constructed = createStorage({ runtime: 'cloudflare', bindings: { DB: binding }, createD1: received => {
      assert.equal(received, binding); return supplied;
    } });
    assert.equal(constructed, supplied);
    await Promise.all([withStorageAdapter(constructed, async () => {
      await Promise.resolve(); assert.equal(getStorageAdapter(), constructed);
    }), withStorageAdapter(fileStorageAdapter, async () => {
      await Promise.resolve(); assert.equal(getStorageAdapter(), fileStorageAdapter);
    })]);
    assert.equal(getStorageAdapter(), fileStorageAdapter);
  });
  await test('domain JSON omits optional fields but rejects lossy or executable data', () => {
    const { domainJson } = require('../src/lib/storage/domainSerialization.ts');
    assert.deepEqual(domainJson({ optional: undefined, price: 1 }), { price: 1 });
    for (const value of [{ price: NaN }, { price: Infinity }, { run() {} }, { date: new Date() }, { values: [undefined] }]) {
      assert.throws(() => domainJson(value), error => error.code === 'DOMAIN_PAYLOAD_INVALID');
    }
    const cycle = {}; cycle.self = cycle;
    assert.throws(() => domainJson(cycle), error => error.code === 'DOMAIN_PAYLOAD_INVALID');
  });
}
main().catch(error => { failed++; console.error('FAIL setup', error); }).finally(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  console.log(`V6 architecture remediation: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
});
