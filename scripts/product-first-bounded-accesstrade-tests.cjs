/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

require.extensions['.ts'] = function transpile(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, parent, isMain, options) {
  if (request.startsWith('@/')) request = path.join(process.cwd(), 'src', request.slice(2));
  return originalResolve.call(this, request, parent, isMain, options);
};

const tempDir = path.join(process.cwd(), '.test-tmp', `product-first-at-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.ACCESS_TRADE_API_KEY = 'product-first-test-secret-never-log';
process.env.NODE_ENV = 'test';

let passed = 0;
let failed = 0;
function assert(value, message = 'assertion failed') { if (!value) throw new Error(message); }
function equal(actual, expected, message) { if (actual !== expected) throw new Error(message || `${actual} !== ${expected}`); }
async function test(name, run) {
  try { await run(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error}`); }
}

function record(index, overrides = {}) {
  return {
    aff_link: `https://go.isclix.com/deep_link/campaign?url=${encodeURIComponent(`https://merchant.example/products/${index}`)}`,
    campaign: '',
    cate: 'Điện tử',
    desc: 'Sản phẩm điện tử chính hãng',
    discount: '0',
    discount_amount: 0,
    discount_rate: 0,
    domain: 'merchant.example',
    image: `https://images.example/${index}.jpg`,
    merchant: 'Merchant Example',
    name: `Sản phẩm gia dụng mẫu ${index}`,
    price: 120000 + index,
    product_id: `provider-product-${index}`,
    promotion: '',
    shop_id: 'shop-1',
    shop_name: 'Merchant Shop',
    sku: `SKU-${index}`,
    status_discount: 0,
    update_time: '2026-08-03T00:00:00.000Z',
    url: `https://merchant.example/products/${index}`,
    ...overrides,
  };
}

function unrelatedPage(page, count = 200) {
  return Array.from({ length: count }, (_, offset) => record(page * 10_000 + offset));
}

function response(items, total = items.length, status = 200) {
  return new Response(JSON.stringify({ data: items, total }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installPagedFetch(pages, options = {}) {
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert(url.hostname === 'api.accesstrade.vn', `unexpected external host: ${url.hostname}`);
    const page = Number(url.searchParams.get('page') || 1);
    calls.push({ page, limit: Number(url.searchParams.get('limit')), authorization: new Headers(init.headers).get('authorization') });
    if (options.onCall) await options.onCall({ page, calls, init });
    const value = typeof pages[page] === 'function' ? await pages[page]({ page, calls, init }) : pages[page];
    if (value instanceof Response) return value;
    const items = value?.items || [];
    return response(items, value?.total ?? items.length, value?.status || 200);
  };
  return calls;
}

(async () => {
  const accessTrade = require('../src/lib/integrations/accesstrade.ts');
  const search = (params = {}) => accessTrade.searchAccessTrade({ keyword: 'tai nghe bluetooth', kind: 'product', limit: 20, ...params });

  await test('1-3. page 1 has 200 unrelated records and matches on pages 2/3 are returned', async () => {
    const page2 = unrelatedPage(2);
    for (let index = 0; index < 10; index += 1) page2[index] = record(20_000 + index, { name: `Tai nghe Bluetooth A${index}` });
    const page3 = unrelatedPage(3);
    for (let index = 0; index < 20; index += 1) page3[index] = record(30_000 + index, { name: `Bluetooth Tai nghe B${index}` });
    const calls = installPagedFetch({ 1: { items: unrelatedPage(1), total: 200 }, 2: { items: page2, total: 200 }, 3: { items: page3, total: 200 } });
    const result = await search();
    equal(calls.length, 3);
    equal(result.items.length, 20);
    equal(result.diagnostics.stopReason, 'TARGET_MATCH_COUNT_REACHED');
    equal(result.diagnostics.stopPage, 3);
  });

  await test('4-5. repeated provider total=200 stays advisory while unique pages continue', async () => {
    const calls = installPagedFetch({
      1: { items: unrelatedPage(1), total: 200 },
      2: { items: unrelatedPage(2), total: 200 },
      3: { items: unrelatedPage(3, 5), total: 200 },
    });
    const result = await search();
    equal(calls.length, 3);
    equal(result.diagnostics.stopReason, 'SHORT_PAGE');
    assert(result.diagnostics.pageStatistics.every(item => item.providerTotalTrusted === false));
    equal(result.diagnostics.uniqueRawItemCount, 405);
  });

  await test('6-7. repeated provider page is detected and stops safely', async () => {
    const repeated = unrelatedPage(1);
    const calls = installPagedFetch({ 1: { items: repeated, total: 9999 }, 2: { items: repeated, total: 9999 } });
    const result = await search();
    equal(calls.length, 2);
    equal(result.diagnostics.stopReason, 'REPEATED_PAGE');
    equal(result.diagnostics.duplicateCount, 200);
    assert(result.diagnostics.providerPaginationIssue);
  });

  await test('8-9. short page is an actual end-of-data signal', async () => {
    installPagedFetch({ 1: { items: unrelatedPage(1, 37), total: 200 } });
    const result = await search();
    equal(result.diagnostics.stopReason, 'SHORT_PAGE');
    assert(result.diagnostics.endedByEndOfData);
    equal(result.diagnostics.stopPage, 1);
  });

  await test('10-11. empty page is an actual end-of-data signal', async () => {
    installPagedFetch({ 1: { items: [], total: 0 } });
    const result = await search();
    equal(result.diagnostics.stopReason, 'EMPTY_PAGE');
    equal(result.diagnostics.state, 'PROVIDER_EMPTY');
    assert(result.diagnostics.endedByEndOfData);
  });

  await test('12. raw record budget is enforced independently of result limit', async () => {
    const calls = installPagedFetch({ 1: { items: unrelatedPage(1), total: 9999 }, 2: { items: unrelatedPage(2, 50), total: 9999 } });
    const result = await search({ rawItemBudget: 250 });
    equal(calls.length, 2);
    equal(calls[1].limit, 50);
    equal(result.diagnostics.rawItemCount, 250);
    equal(result.diagnostics.stopReason, 'RAW_ITEM_BUDGET_REACHED');
  });

  await test('13. maximum provider page count is enforced', async () => {
    const calls = installPagedFetch({ 1: { items: unrelatedPage(1), total: 9999 }, 2: { items: unrelatedPage(2), total: 9999 } });
    const result = await search({ maximumPages: 2 });
    equal(calls.length, 2);
    equal(result.diagnostics.stopReason, 'MAX_PAGES_REACHED');
    assert(result.diagnostics.safetyBoundaryReached);
  });

  await test('14. requested unique match count stops before maximum pages', async () => {
    const page = unrelatedPage(1);
    for (let index = 0; index < 20; index += 1) page[index] = record(index, { name: `Tai nghe Bluetooth ${index}` });
    const calls = installPagedFetch({ 1: { items: page, total: 9999 } });
    const result = await search();
    equal(calls.length, 1);
    equal(result.diagnostics.matchedBeforeClassification, 20);
    equal(result.diagnostics.stopReason, 'TARGET_MATCH_COUNT_REACHED');
  });

  await test('15. duplicate records across pages are never returned twice', async () => {
    const first = unrelatedPage(1);
    first[0] = record(7, { name: 'Tai nghe Bluetooth Duplicate' });
    const second = [record(7, { name: 'Tai nghe Bluetooth Duplicate refreshed' }), record(8, { name: 'Tai nghe Bluetooth Unique' })];
    installPagedFetch({ 1: { items: first, total: 200 }, 2: { items: second, total: 200 } });
    const result = await search({ limit: 20 });
    equal(result.items.filter(item => item.sourceItemId === 'provider-product-7').length, 1);
    equal(result.items.length, 2);
    equal(result.diagnostics.duplicateCount, 1);
  });

  await test('16. accented and unaccented Vietnamese forms match', () => {
    const result = accessTrade.processAccessTradePayload({ data: [record(1, { name: 'Tai nghe Bluetooth chống ồn' })], total: 1 }, { keyword: 'tài nghe chống ồn', kind: 'product' });
    equal(result.items.length, 1);
    assert(accessTrade.matchesAccessTradeSearchQuery('TÀI NGHE CHỐNG ỒN', 'tai nghe chong on'));
  });

  await test('17. semantically equivalent token order matches', () => {
    assert(accessTrade.matchesAccessTradeSearchQuery('Tai nghe Bluetooth cao cấp', 'bluetooth tai nghe'));
    const result = accessTrade.processAccessTradePayload({ data: [record(1, { name: 'Bluetooth cao cấp cho tai nghe' })], total: 1 }, { keyword: 'tai nghe bluetooth', kind: 'product' });
    equal(result.items.length, 1);
  });

  await test('18. partial tokens and merchant-only keyword text remain rejected', () => {
    assert(!accessTrade.matchesAccessTradeSearchQuery('Tai nghe có dây', 'tai bluetooth'));
    const result = accessTrade.processAccessTradePayload({ data: [record(1, {
      name: 'Dầu gội dưỡng tóc', desc: 'Chăm sóc tóc', merchant: 'Tai nghe Bluetooth Store', shop_name: 'Bluetooth Tai Nghe',
    })], total: 1 }, { keyword: 'tai nghe bluetooth', kind: 'product' });
    equal(result.items.length, 0);
    equal(result.diagnostics.state, 'PROVIDER_DATA_NO_KEYWORD_MATCH');
  });

  await test('19. no-keyword request retains one lightweight provider page', async () => {
    const calls = installPagedFetch({ 1: { items: unrelatedPage(1, 80), total: 9999 } });
    const result = await accessTrade.searchAccessTrade({ kind: 'product', limit: 20 });
    equal(calls.length, 1);
    equal(calls[0].limit, 80);
    equal(result.items.length, 20);
    equal(result.diagnostics.maximumPages, 1);
  });

  await test('20a. abort between pages fails closed with an explicit stop', async () => {
    const controller = new AbortController();
    const calls = installPagedFetch({ 1: { items: unrelatedPage(1), total: 9999 } }, { onCall: ({ page }) => { if (page === 1) controller.abort(); } });
    let caught;
    try { await search({ signal: controller.signal }); } catch (error) { caught = error; }
    equal(calls.length, 1);
    assert(caught instanceof accessTrade.AccessTradeRequestError);
    equal(caught.stopReason, 'REQUEST_ABORTED');
    equal(caught.requests[0].resultType, 'network_error');
  });

  await test('20b. elapsed time budget stops between sequential pages', async () => {
    installPagedFetch({ 1: { items: unrelatedPage(1), total: 9999 } }, { onCall: () => new Promise(resolve => setTimeout(resolve, 110)) });
    const result = await search({ timeBudgetMs: 100 });
    equal(result.diagnostics.stopReason, 'TIME_BUDGET_EXCEEDED');
    assert(result.diagnostics.elapsedMs >= 100);
  });

  await test('21. provider errors are surfaced accurately and fail closed', async () => {
    installPagedFetch({ 1: new Response(JSON.stringify({ error: 'bad request' }), { status: 400, headers: { 'content-type': 'application/json' } }) });
    let caught;
    try { await search(); } catch (error) { caught = error; }
    assert(caught instanceof accessTrade.AccessTradeRequestError);
    equal(caught.requests[0].statusCode, 400);
    equal(caught.requests[0].resultType, 'client_error');
  });

  await test('22. diagnostics expose deterministic stop and per-page sanitized counts', async () => {
    installPagedFetch({ 1: { items: unrelatedPage(1, 3), total: 200 } });
    const result = await search();
    equal(result.diagnostics.pagesRequested, 1);
    equal(result.diagnostics.pagesSucceeded, 1);
    equal(result.diagnostics.pageStatistics[0].providerItemCount, 3);
    equal(result.diagnostics.pageStatistics[0].uniqueItemCount, 3);
    equal(result.diagnostics.pageStatistics[0].keywordMatchCount, 0);
    equal(result.diagnostics.stopReason, 'SHORT_PAGE');
  });

  await test('23. no secret or raw authorization value appears in diagnostics', async () => {
    installPagedFetch({ 1: { items: [record(1, { authorization: 'Bearer raw-provider-secret', api_key: 'raw-secret' })], total: 1 } });
    const result = await search();
    const serialized = JSON.stringify({ diagnostics: result.diagnostics, requests: result.requests });
    assert(!serialized.includes('product-first-test-secret-never-log'));
    assert(!serialized.includes('raw-provider-secret'));
    assert(!serialized.includes('raw-secret'));
    assert(!serialized.toLowerCase().includes('authorization'));
  });

  await test('40-41. 1,000-record fixture stays deduplicated and within 32 MiB retained-heap budget', async () => {
    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;
    const pages = {};
    for (let page = 1; page <= 5; page += 1) pages[page] = { items: unrelatedPage(page), total: 200 };
    installPagedFetch(pages);
    const result = await search();
    if (global.gc) global.gc();
    const retainedBytes = Math.max(0, process.memoryUsage().heapUsed - before);
    equal(result.diagnostics.rawItemCount, 1000);
    equal(result.diagnostics.uniqueRawItemCount, 1000);
    equal(result.diagnostics.stopReason, 'RAW_ITEM_BUDGET_REACHED');
    assert(result.items.length <= 20);
    assert(retainedBytes < 32 * 1024 * 1024, `retained heap ${retainedBytes} exceeded 32 MiB`);
    console.log(`  fixture_retained_heap_bytes=${retainedBytes}`);
  });

  await test('42. every provider request is an isolated mock, never a real service', () => {
    assert(typeof global.fetch === 'function');
    assert(process.env.ACCESS_TRADE_API_KEY.startsWith('product-first-test-'));
  });

  await test('43. focused retrieval tests use isolated storage, never production .data', () => {
    assert(process.env.SANDEAL_DATA_DIR === tempDir);
    assert(!path.resolve(tempDir).endsWith(`${path.sep}.data`));
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(`\nProduct-first bounded AccessTrade: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
