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

const tempDir = path.join(process.cwd(), '.test-tmp', `sandeal-dashboard-tests-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'dashboard-test';
process.env.BASIC_AUTH_PASSWORD = 'not-a-real-secret';
delete process.env.NEXT_PUBLIC_SITE_URL;

let passed = 0;
let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error}`); }
}
function assert(value, message = 'assertion failed') { if (!value) throw new Error(message); }
function equal(actual, expected, message) { if (actual !== expected) throw new Error(message || `${actual} !== ${expected}`); }
const auth = `Basic ${Buffer.from('dashboard-test:not-a-real-secret').toString('base64')}`;
const headers = { authorization: auth, 'content-type': 'application/json' };
const now = '2026-07-14T01:00:00.000Z';
const product = (overrides = {}) => ({
  id: 'p-1', title: 'Tai nghe chính hãng', slug: 'tai-nghe', kind: 'product',
  platform: 'website', source: 'manual', originalUrl: 'https://shop.test/p-1',
  imageUrl: 'https://img.test/p-1.jpg', price: 120000, currency: 'VND', tags: [],
  benefits: [], warnings: [], riskLevel: 'low', status: 'needs_review',
  verifiedSource: true, linkHealthStatus: 'ok', imageHealthStatus: 'ok',
  createdAt: now, updatedAt: now, ...overrides,
});

(async () => {
  const adapter = require('../src/lib/storage/adapter.ts');
  const dashboard = require('../src/lib/dashboard/products.ts');
  const productsRoute = require('../src/app/api/dashboard/products/route.ts');
  const scanRoute = require('../src/app/api/dashboard/scan/route.ts');
  const configRoute = require('../src/app/api/dashboard/config/route.ts');
  const sourcesRoute = require('../src/app/api/product-sources/route.ts');
  const archiveRoute = require('../src/app/api/products/[id]/archive/route.ts');
  const { NextRequest } = require('next/server');

  await adapter.writeCollection('products', [
    product(),
    product({ id: 'p-2', title: 'Voucher giảm giá', slug: 'voucher', kind: 'voucher', platform: 'accesstrade', source: 'accesstrade', status: 'archived', riskLevel: 'medium', price: undefined }),
    product({ id: 'p-3', title: 'Loa bị lỗi link', slug: 'loa-loi', kind: 'product', status: 'draft', linkHealthStatus: 'not_found', riskLevel: 'high' }),
  ]);

  await test('summary được tính từ dữ liệu thật và cùng tập filter với list', () => {
    const parsed = dashboard.parseDashboardProductQuery(new URLSearchParams('kind=product&pageSize=10'));
    assert(parsed.ok);
    const result = dashboard.buildDashboardProducts([
      product(), product({ id: 'p-2', kind: 'voucher' }), product({ id: 'p-3', kind: 'product' }),
    ], parsed.query);
    equal(result.items.length, 2);
    equal(result.summary.totalItems, 2);
    equal(result.summary.realProducts, 2);
    equal(result.summary.vouchers, 0);
  });

  await test('query sai trả validation thay vì lỗi 500', async () => {
    const request = new NextRequest('http://localhost/api/dashboard/products?sort=drop_table&pageSize=500', { headers });
    const response = await productsRoute.GET(request);
    equal(response.status, 400);
    const body = await response.json();
    equal(body.code, 'VALIDATION_ERROR');
  });

  await test('API danh sách trả summary, pagination và DTO tối thiểu', async () => {
    const request = new NextRequest('http://localhost/api/dashboard/products?platform=website&pageSize=1', { headers });
    const response = await productsRoute.GET(request);
    equal(response.status, 200);
    const body = await response.json();
    equal(body.data.items.length, 1);
    equal(body.data.summary.totalItems, 2);
    equal(body.data.pagination.pageSize, 1);
    assert(!Object.prototype.hasOwnProperty.call(body.data.items[0], 'rawData'));
    assert(!JSON.stringify(body).includes('not-a-real-secret'));
  });

  await test('chạy thử trả contract tác vụ và không thay đổi storage', async () => {
    const before = JSON.stringify(await adapter.readCollection('products'));
    const request = new NextRequest('http://localhost/api/dashboard/scan', { method: 'POST', headers, body: JSON.stringify({ dryRun: true, limit: 2 }) });
    const response = await scanRoute.POST(request);
    equal(response.status, 200);
    const body = await response.json();
    equal(body.data.status, 'completed');
    equal(body.data.result.changed, 0);
    equal(JSON.stringify(await adapter.readCollection('products')), before);
  });

  await test('form nguồn kiểm tra URL và không lưu khi lỗi', async () => {
    const request = new NextRequest('http://localhost/api/product-sources', { method: 'POST', headers, body: JSON.stringify({ name: 'Nguồn lỗi', url: 'javascript:bad', platform: 'website', kind: 'product' }) });
    const response = await sourcesRoute.POST(request);
    equal(response.status, 400);
    const body = await response.json();
    equal(body.code, 'VALIDATION_ERROR');
    equal((await adapter.readCollection('product-sources')).length, 0);
  });

  await test('form nguồn trim dữ liệu, lưu thật và chặn submit trùng URL', async () => {
    const payload = { name: '  Nguồn chính  ', url: '  https://source.test/feed  ', platform: 'website', kind: 'product', enabled: true };
    const first = await sourcesRoute.POST(new NextRequest('http://localhost/api/product-sources', { method: 'POST', headers, body: JSON.stringify(payload) }));
    equal(first.status, 201);
    const created = (await first.json()).data;
    equal(created.name, 'Nguồn chính');
    equal(created.url, 'https://source.test/feed');
    const duplicate = await sourcesRoute.POST(new NextRequest('http://localhost/api/product-sources', { method: 'POST', headers, body: JSON.stringify(payload) }));
    equal(duplicate.status, 409);
    equal((await adapter.readCollection('product-sources')).length, 1);
  });

  await test('route quản trị từ chối người chưa đăng nhập', async () => {
    const dashboardResponse = await productsRoute.GET(new NextRequest('http://localhost/api/dashboard/products'));
    equal(dashboardResponse.status, 401);
    const sourceResponse = await sourcesRoute.GET(new NextRequest('http://localhost/api/product-sources'));
    equal(sourceResponse.status, 401);
  });

  await test('route lưu trữ kiểm tra quyền ở backend', async () => {
    const before = JSON.stringify(await adapter.readCollection('products'));
    const response = await archiveRoute.POST(new NextRequest('http://localhost/api/products/p-1', { method: 'POST' }), { params: Promise.resolve({ id: 'p-1' }) });
    equal(response.status, 401);
    equal(JSON.stringify(await adapter.readCollection('products')), before);
  });

  await test('thiếu URL công khai trả trạng thái cần cấu hình', async () => {
    const response = await configRoute.GET(new NextRequest('http://localhost/api/dashboard/config', { headers }));
    equal(response.status, 200);
    const body = await response.json();
    equal(body.code, 'CONFIGURATION_REQUIRED');
    equal(body.data.publicUrl, null);
  });

  await test('contract trạng thái có đầy đủ nhãn tiếng Việt cho PROMPT #06', () => {
    const strings = require('../src/lib/dashboard/strings.ts').dashboardStrings.status;
    ['pending', 'waiting_approval', 'running', 'waiting_retry', 'completed', 'failed', 'cancelled', 'blocked', 'unavailable'].forEach((status) => assert(strings[status], `missing ${status}`));
  });

  console.log(`\nDashboard targeted: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
