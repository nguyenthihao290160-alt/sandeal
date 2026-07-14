/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandeal-prompt08-tests-'));
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'prompt08-test';
process.env.BASIC_AUTH_PASSWORD = 'local-test-password';
process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
process.env.ALLOW_PAID_AI = 'false';
process.env.ALLOW_PUBLISHING_API = 'false';
process.env.AUTO_PUBLISH_ENABLED = 'false';

require('./register-typescript.cjs');

const TEST_NOW = Date.parse('2026-07-14T03:00:00.000Z');
const auth = `Basic ${Buffer.from('prompt08-test:local-test-password').toString('base64')}`;
const jsonHeaders = { authorization: auth, 'content-type': 'application/json' };
let passed = 0;
let failed = 0;

async function test(name, work) {
  try {
    await work();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`);
  }
}

function makeProduct(overrides = {}) {
  const id = String(overrides.id || `product-${Math.random().toString(36).slice(2, 10)}`);
  const now = new Date(TEST_NOW).toISOString();
  return {
    id,
    title: `San pham chinh hang ${id}`,
    slug: id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    description: 'Thong tin san pham duoc tong hop tu nguon, gom dac diem, pham vi su dung va cac luu y can xac minh.',
    kind: 'product',
    platform: 'website',
    source: 'manual',
    originalUrl: `https://merchant.example/products/${encodeURIComponent(id)}`,
    affiliateUrl: `https://merchant.example/products/${encodeURIComponent(id)}?aff_id=test-track`,
    imageUrl: `https://merchant.example/images/${encodeURIComponent(id)}.jpg`,
    price: 1_500_000,
    salePrice: 1_200_000,
    currency: 'VND',
    category: 'Audio',
    brand: 'Example',
    sku: `SKU-${id}`,
    specifications: { Connection: 'Bluetooth', Color: 'Black', Warranty: '12 months' },
    tags: ['audio'],
    benefits: [],
    warnings: [],
    riskLevel: 'low',
    status: 'needs_review',
    verifiedSource: true,
    sourceVerified: true,
    autoPublishEligible: true,
    publicHidden: true,
    needsVerification: true,
    linkHealthStatus: 'ok',
    affiliateHealthStatus: 'ok',
    imageHealthStatus: 'ok',
    linkLastCheckedAt: now,
    imageLastCheckedAt: now,
    lastSeenAt: now,
    priceLastChangedAt: now,
    availability: 'available',
    sourceHash: `source-${id}`,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const productsStore = require('../src/lib/storage/products.ts');
  const editorial = require('../src/lib/editorialReview.ts');
  const safePublish = require('../src/lib/safePublish.ts');
  const publicFilter = require('../src/lib/publicProductFilter.ts');
  const publicProducts = require('../src/lib/product-intelligence/publicProducts.ts');
  const importer = require('../src/lib/product-intelligence/importer.ts');
  const urlSafety = require('../src/lib/product-intelligence/urlSafety.ts');
  const dedupe = require('../src/lib/product-intelligence/dedupe.ts');
  const scoring = require('../src/lib/product-intelligence/scoring.ts');
  const priceHistory = require('../src/lib/product-intelligence/priceHistory.ts');
  const contentStudio = require('../src/lib/product-intelligence/contentStudio.ts');
  const growth = require('../src/lib/product-intelligence/growth.ts');
  const alerts = require('../src/lib/product-intelligence/alerts.ts');
  const savedViews = require('../src/lib/product-intelligence/savedViews.ts');
  const intelligenceJobs = require('../src/lib/product-intelligence/jobs.ts');
  const automationStore = require('../src/lib/automation/store.ts');
  const automationWorker = require('../src/lib/automation/worker.ts');
  const publicProductsRoute = require('../src/app/api/public/products/route.ts');
  const publicEventsRoute = require('../src/app/api/public/events/route.ts');
  const outboundRoute = require('../src/app/go/[productId]/route.ts');
  const importRoute = require('../src/app/api/dashboard/import/route.ts');
  const bulkRoute = require('../src/app/api/dashboard/bulk/route.ts');
  const { NextRequest } = require('next/server');

  const collections = [
    'products', 'price-history', 'duplicate-groups', 'import-batches', 'content-drafts',
    'outbound-events', 'growth-daily', 'product-alerts', 'recommended-actions', 'saved-views',
    'automation-jobs', 'automation-control', 'automation-audit', 'automation-ai-usage',
    'automation-circuits', 'automation-settings', 'token-vault',
  ];

  async function reset(...selected) {
    for (const collection of selected.length ? selected : collections) {
      await adapter.writeCollection(collection, []);
    }
  }

  function makePublicProduct(overrides = {}) {
    const product = makeProduct(overrides);
    const now = product.updatedAt;
    const reviewContent = editorial.generateEditorialReview(product, [], now);
    const published = safePublish.applySafePublishDecision({ ...product, reviewContent }, now);
    assert.equal(published.status, 'published', `public fixture was blocked: ${(published.publicBlockReasons || []).join(',')}`);
    assert.equal(publicFilter.isPublicSafeProduct(published), true);
    return published;
  }

  // Fail closed if an implementation accidentally attempts real network access.
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT08_TESTS'); };

  await test('public query parser whitelists filters and caps pageSize at 50', () => {
    const parsed = publicProducts.parsePublicProductQuery(new URLSearchParams('q=headset&page=2&pageSize=50&hasImage=true&sort=deal_desc'));
    assert.equal(parsed.page, 2);
    assert.equal(parsed.pageSize, 50);
    assert.equal(parsed.hasImage, true);
    assert.equal(parsed.sort, 'deal_desc');
    assert.throws(() => publicProducts.parsePublicProductQuery(new URLSearchParams('pageSize=51')), error => error.field === 'pageSize');
    assert.throws(() => publicProducts.parsePublicProductQuery(new URLSearchParams('dropTable=true')), error => error.field === 'dropTable');
    assert.throws(() => publicProducts.parsePublicProductQuery(new URLSearchParams('priceMin=20&priceMax=10')), error => error.field === 'priceMin');
  });

  await test('public DTO exposes only allowlisted fields and internal redirect', () => {
    const dto = publicProducts.toPublicProductCardDto(makeProduct({
      id: 'dto-safe', rawData: { apiKey: 'must-not-leak' }, secret: 'must-not-leak', trackingCode: 'private-code',
    }));
    const serialized = JSON.stringify(dto);
    assert.equal(dto.outboundHref, '/go/dto-safe');
    assert.equal(Object.hasOwn(dto, 'originalUrl'), false);
    assert.equal(Object.hasOwn(dto, 'affiliateUrl'), false);
    assert.equal(Object.hasOwn(dto, 'rawData'), false);
    assert.equal(serialized.includes('must-not-leak'), false);
    assert.equal(serialized.includes('private-code'), false);
  });

  await test('public API returns only public-safe products and rejects invalid filters', async () => {
    await reset('products');
    const published = makePublicProduct({ id: 'public-only' });
    const blocked = makeProduct({ id: 'private-draft', rawData: { password: 'hidden-value' } });
    await adapter.writeCollection('products', [published, blocked]);
    const response = await publicProductsRoute.GET(new NextRequest('http://localhost/api/public/products?pageSize=10'));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.items.map(item => item.id), ['public-only']);
    assert.equal(JSON.stringify(body).includes('hidden-value'), false);
    assert.equal((await publicProductsRoute.GET(new NextRequest('http://localhost/api/public/products?unknown=x'))).status, 400);
    assert.equal((await publicProductsRoute.GET(new NextRequest('http://localhost/api/public/products?pageSize=51'))).status, 400);
  });

  await test('public filtering, sorting, URL pagination and populated category facets work', async () => {
    await reset('products');
    await adapter.writeCollection('products', [
      makePublicProduct({ id: 'audio-low', category: 'Audio', salePrice: 500_000 }),
      makePublicProduct({ id: 'audio-high', category: 'Audio', salePrice: 900_000 }),
      makePublicProduct({ id: 'home-one', category: 'Home', salePrice: 300_000 }),
    ]);
    const query = new URLSearchParams('category=Audio&sort=price_asc&page=2&pageSize=1');
    const result = await publicProducts.queryPublicProducts(query);
    assert.equal(result.pagination.totalItems, 2);
    assert.equal(result.pagination.page, 2);
    assert.equal(result.items[0].id, 'audio-high');
    assert.deepEqual(result.facets.categories, [{ name: 'Audio', count: 2 }]);
    assert.equal(result.items.length <= result.pagination.pageSize, true);
  });

  await test('CSV preview reports row errors independently and neutralizes formulas', async () => {
    await reset('products', 'import-batches');
    const csv = [
      'title,originalUrl,price,source,brand,sku',
      '=HYPERLINK("https://bad.example"),https://merchant.example/good,120000,csv,BrandA,A-1',
      ',http://127.0.0.1/private,not-a-number,csv,BrandB,B-1',
    ].join('\n');
    const preview = await importer.previewCsvImport(csv);
    assert.equal(preview.totalRows, 2);
    assert.equal(preview.validRows, 1);
    assert.equal(preview.invalidRows, 1);
    assert.equal(preview.publicSideEffect, false);
    assert.equal(preview.rows[0].normalized.title.startsWith("'="), true);
    assert.equal(preview.rows[1].errors.includes('title_required'), true);
    assert.equal(preview.rows[1].errors.some(code => code.includes('private_network')), true);
    assert.equal(importer.escapeCsvCell('=1+1').startsWith("'="), true);
  });

  await test('CSV apply is idempotent and never publishes imported rows', async () => {
    await reset('products', 'import-batches');
    const csv = 'title,originalUrl,price,source,externalId\nValid product,https://merchant.example/import-one,199000,csv,external-1';
    const preview = await importer.previewCsvImport(csv);
    const first = await importer.applyImportBatch(preview.previewId, 'import-operation-one');
    const second = await importer.applyImportBatch(preview.previewId, 'import-operation-two');
    const stored = await productsStore.getAllProducts();
    assert.equal(first.created, 1);
    assert.equal(second.unchanged, 1);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, 'needs_review');
    assert.notEqual(stored[0].publicHidden, false);
  });

  await test('manual URL import blocks unsafe targets and truthfully requires metadata', () => {
    assert.equal(importer.previewManualUrl('file:///etc/passwd').reason, 'UNSAFE_PROTOCOL');
    assert.equal(importer.previewManualUrl('http://localhost/admin').reason, 'PRIVATE_NETWORK');
    assert.equal(importer.previewManualUrl('http://169.254.169.254/latest/meta-data').valid, false);
    const supported = importer.previewManualUrl('https://merchant.example/product/1');
    assert.equal(supported.valid, true);
    assert.equal(supported.adapterSupported, false);
    assert.equal(supported.status, 'metadata_required');
  });

  await test('safe URL fetch blocks redirect to private network and redirect loops with mocks', async () => {
    let calls = 0;
    const privateRedirect = async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    };
    await assert.rejects(
      urlSafety.fetchExternalSafely('https://public.example/start', { resolveDns: false, fetchImpl: privateRedirect }),
      /PRIVATE_NETWORK/,
    );
    assert.equal(calls, 1);
    const loop = async url => new Response(null, { status: 302, headers: { location: String(url) } });
    await assert.rejects(
      urlSafety.fetchExternalSafely('https://public.example/loop', { resolveDns: false, fetchImpl: loop }),
      /REDIRECT_LOOP/,
    );
  });

  await test('exact duplicate signals produce high confidence', () => {
    const left = makeProduct({ id: 'exact-left', source: 'csv', sourceId: 'source-42' });
    const right = makeProduct({ id: 'exact-right', source: 'csv', sourceId: 'source-42' });
    const candidate = dedupe.compareProducts(left, right);
    assert.equal(candidate.confidence, 1);
    assert.equal(candidate.matchedSignals.includes('source_external_id'), true);
  });

  await test('fuzzy duplicate detection never auto-merges or archives products', async () => {
    await reset('products', 'duplicate-groups');
    const left = makeProduct({ id: 'fuzzy-left', title: 'Headphone Bluetooth ANC Model X100', brand: 'Sound', category: 'Audio', price: 1_000_000, salePrice: undefined, imageUrl: undefined });
    const right = makeProduct({ id: 'fuzzy-right', title: 'Headphone Bluetooth ANC Model X100', brand: 'Sound', category: 'Audio', price: 1_050_000, salePrice: undefined, imageUrl: undefined });
    const candidate = dedupe.compareProducts(left, right);
    assert.equal(candidate.confidence >= 0.68 && candidate.confidence < 0.9, true, `confidence=${candidate.confidence}`);
    await adapter.writeCollection('products', [left, right]);
    const result = await dedupe.detectDuplicateGroups([left, right], 'dedupe-dry-run', { dryRun: true });
    assert.equal(result.groups.length, 1);
    assert.equal(result.changed, false);
    assert.equal((await adapter.readCollection('duplicate-groups')).length, 0);
    assert.deepEqual((await productsStore.getAllProducts()).map(item => item.status), ['needs_review', 'needs_review']);
  });

  await test('merge preview has no side effect and preserves primary provenance', async () => {
    await reset('products', 'duplicate-groups');
    const primary = makeProduct({ id: 'merge-primary', source: 'csv', sourceId: 'same-source', sourceHash: 'primary-provenance', qualityScore: 90, verifiedSource: true, description: undefined });
    const secondary = makeProduct({ id: 'merge-secondary', source: 'csv', sourceId: 'same-source', sourceHash: 'secondary-provenance', qualityScore: 40, verifiedSource: false, description: 'Metadata supplied by the secondary source.' });
    await adapter.writeCollection('products', [primary, secondary]);
    const detection = await dedupe.detectDuplicateGroups(await productsStore.getAllProducts(), 'dedupe-store');
    assert.equal(detection.groups.length, 1);
    const before = await productsStore.getAllProducts();
    const preview = await dedupe.previewDuplicateMerge(detection.groups[0].id, primary.id);
    const after = await productsStore.getAllProducts();
    assert.deepEqual(after, before);
    assert.equal(preview.businessDataChanged, false);
    assert.equal(preview.requiresApproval, true);
    assert.equal(preview.merged.source, 'csv');
    assert.equal(preview.merged.sourceHash, 'primary-provenance');
    assert.equal(after.find(item => item.id === secondary.id).status, 'needs_review');
  });

  await test('quality, opportunity and deal scores are deterministic and explainable', () => {
    const product = makeProduct({ id: 'score-deterministic' });
    const first = scoring.calculateProductScores(product, undefined, TEST_NOW);
    const second = scoring.calculateProductScores(product, undefined, TEST_NOW);
    assert.deepEqual(second, first);
    assert.equal(first.quality.rules.length >= 8, true);
    assert.equal(first.quality.rules.every(rule => rule.code && rule.label && Number.isFinite(rule.points)), true);
    assert.equal(typeof first.opportunity.breakdown.quality, 'number');
    assert.equal(first.deal.version.startsWith('deal-'), true);
  });

  await test('quality BLOCKER caps score and deal score uses no AI or market-low claim', () => {
    const blocked = scoring.calculateQualityScore(makeProduct({ id: 'blocked-score', price: undefined, salePrice: undefined }), TEST_NOW);
    assert.equal(blocked.band, 'blocked');
    assert.equal(blocked.score <= 39, true);
    assert.equal(blocked.blockers.includes('missing_price'), true);
    const product = makeProduct({ id: 'deal-score', price: 2_000_000, salePrice: 1_400_000 });
    const quality = scoring.calculateQualityScore(product, TEST_NOW);
    const deal = scoring.calculateDealScore(product, quality, undefined, TEST_NOW);
    const text = JSON.stringify(deal).toLowerCase();
    assert.equal(deal.dealScore > 0, true);
    assert.equal(text.includes('re nhat'), false);
    assert.equal(text.includes('thap nhat thi truong'), false);
    assert.equal(text.includes('ai_draft'), false);
  });

  await test('price snapshots skip unchanged data and statistics remain correct', async () => {
    await reset('price-history');
    const product = makeProduct({ id: 'price-product', price: 100_000, salePrice: undefined });
    const first = await priceHistory.capturePriceSnapshot(product, 'price-op-1', { capturedAt: '2026-07-10T00:00:00.000Z' });
    const duplicate = await priceHistory.capturePriceSnapshot(product, 'price-op-2', { capturedAt: '2026-07-10T01:00:00.000Z' });
    const changed = await priceHistory.capturePriceSnapshot({ ...product, price: 80_000 }, 'price-op-3', { capturedAt: '2026-07-12T00:00:00.000Z' });
    const snapshots = await priceHistory.listPriceHistory(product.id);
    const stats = priceHistory.calculatePriceStatistics(product.id, snapshots);
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.reason, 'unchanged');
    assert.equal(changed.created, true);
    assert.deepEqual({ current: stats.current, lowest: stats.lowest, highest: stats.highest, average: stats.average }, { current: 80_000, lowest: 80_000, highest: 100_000, average: 90_000 });
    assert.equal(stats.lastChange, -20_000);
    assert.equal(stats.changeCount, 1);
    assert.equal(stats.trackingDays, 2);
  });

  await test('local content draft works without Gemini and cannot overwrite source facts', async () => {
    await reset('products', 'content-drafts');
    const source = makeProduct({ id: 'local-draft' });
    await adapter.writeCollection('products', [source]);
    const before = await productsStore.getProductById(source.id);
    const draft = await contentStudio.createLocalContentDraft(source.id, 'prompt08-test');
    const repeated = await contentStudio.createLocalContentDraft(source.id, 'prompt08-test');
    assert.equal(repeated.id, draft.id);
    assert.deepEqual(draft.verifiedSpecifications, source.specifications);
    await contentStudio.updateContentDraft(draft.id, { verifiedSpecifications: { Connection: 'Unverified replacement' } });
    const after = await productsStore.getProductById(source.id);
    assert.deepEqual(after.specifications, before.specifications);
    assert.equal(JSON.stringify(draft).toLowerCase().includes('gemini'), false);
  });

  await test('editorial guard blocks unverified claims, missing disclosure, stale price and broken link', () => {
    const product = makeProduct({
      id: 'editorial-blocked',
      priceLastChangedAt: '2026-06-01T00:00:00.000Z',
      lastSeenAt: '2026-06-01T00:00:00.000Z',
      linkHealthStatus: 'broken',
      lastEditorialCheckAt: '2026-05-01T00:00:00.000Z',
    });
    const draft = {
      id: 'draft-editorial', productId: product.id, status: 'pending_review',
      title: 'Editorial title with enough detail', summary: 'S'.repeat(220), verdict: 'Evidence-based conclusion.',
      strengths: ['Documented strength'], limitations: ['Documented limitation'], suitableFor: [], notSuitableFor: [], buyingNotes: [],
      verifiedSpecifications: {}, faq: [], metaTitle: 'Editorial title', metaDescription: 'M'.repeat(100), slug: 'editorial-title', affiliateDisclosure: '',
      claims: [{ id: 'claim-1', field: 'summary', text: 'An unsupported important claim.', type: 'UNVERIFIED', evidenceFactIds: [] }],
      createdBy: 'test', createdAt: new Date(TEST_NOW).toISOString(), updatedAt: new Date(TEST_NOW).toISOString(),
    };
    const result = contentStudio.runEditorialGuard(draft, product, TEST_NOW);
    const codes = result.issues.map(issue => issue.code);
    assert.equal(result.status, 'BLOCKED');
    for (const code of ['unverified_claim', 'missing_disclosure', 'stale_price', 'link_unhealthy', 'editorial_stale']) assert.equal(codes.includes(code), true, code);
  });

  await test('outbound routes preserve tracking while stored events omit raw privacy data', async () => {
    await reset('products', 'outbound-events');
    const publicProduct = makePublicProduct({
      id: 'outbound-public',
      affiliateUrl: 'https://merchant.example/buy?aff_id=keep-me&utm_source=sandeal',
    });
    await adapter.writeCollection('products', [publicProduct]);
    const viewRequest = new NextRequest('http://localhost/api/public/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'private-auth-header', 'user-agent': 'Prompt08-Unique-Full-Agent/1.0', 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ productId: publicProduct.id, contentPageId: 'content-one', rawIp: '203.0.113.9', fingerprint: 'forbidden-fingerprint' }),
    });
    assert.equal((await publicEventsRoute.POST(viewRequest)).status, 204);
    const redirect = await outboundRoute.GET(
      new NextRequest(`http://localhost/go/${publicProduct.id}?content=content-one`, { headers: { 'user-agent': 'Prompt08-Unique-Full-Agent/1.0' } }),
      { params: Promise.resolve({ productId: publicProduct.id }) },
    );
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location').includes('aff_id=keep-me'), true);
    const stored = await growth.listOutboundEvents();
    const serialized = JSON.stringify(stored);
    assert.equal(stored.length, 2);
    assert.equal(serialized.includes('203.0.113.9'), false);
    assert.equal(serialized.includes('forbidden-fingerprint'), false);
    assert.equal(serialized.includes('private-auth-header'), false);
    assert.equal(serialized.includes('Prompt08-Unique-Full-Agent'), false);
  });

  await test('growth aggregation avoids divide-by-zero and never invents revenue', async () => {
    await reset('outbound-events', 'growth-daily');
    await growth.recordGrowthEvent({ eventType: 'click', productId: 'click-only', source: 'manual', referrerCategory: 'direct', deviceCategory: 'desktop', timestamp: new Date(TEST_NOW).toISOString() });
    await growth.aggregateGrowthMetrics(TEST_NOW);
    const summary = await growth.getGrowthSummary(30);
    assert.equal(summary.views, 0);
    assert.equal(summary.clicks, 1);
    assert.equal(summary.ctr, undefined);
    assert.equal(summary.revenueAvailable, false);
    assert.equal(Object.hasOwn(summary, 'revenue'), false);
  });

  await test('alerts deduplicate across evaluations and reopen when a resolved fault recurs', async () => {
    await reset('products', 'product-alerts', 'automation-jobs', 'automation-control', 'automation-ai-usage', 'automation-circuits', 'automation-settings', 'token-vault');
    await adapter.writeCollection('products', [makeProduct({ id: 'alert-product', linkHealthStatus: 'broken', duplicateConfidence: 0.95, qualityScore: 30, qualityBand: 'poor' })]);
    const first = await alerts.evaluateAlerts('alerts-first', TEST_NOW);
    const initial = await alerts.listAlerts({ limit: 500 });
    const second = await alerts.evaluateAlerts('alerts-second', TEST_NOW + 1_000);
    const repeated = await alerts.listAlerts({ limit: 500 });
    assert.equal(first.created >= 3, true);
    assert.equal(second.created, 0);
    assert.equal(new Set(repeated.map(item => item.deduplicationKey)).size, repeated.length);
    assert.equal(repeated.length, initial.length);
    const broken = repeated.find(item => item.type === 'broken_link');
    await alerts.updateAlertStatus(broken.id, 'resolved');
    const recurrence = await alerts.evaluateAlerts('alerts-recurrence', TEST_NOW + 2_000);
    assert.equal(recurrence.reopened >= 1, true);
    assert.equal((await alerts.listAlerts({ limit: 500 })).find(item => item.id === broken.id).status, 'new');
  });

  await test('today recommendations are data-derived, bounded and not duplicated', async () => {
    await reset('products', 'product-alerts', 'recommended-actions', 'automation-control', 'token-vault');
    await adapter.writeCollection('products', [
      makeProduct({ id: 'missing-price-one', price: undefined, salePrice: undefined }),
      makeProduct({ id: 'missing-price-two', price: undefined, salePrice: undefined }),
    ]);
    const first = await alerts.generateRecommendedActions(TEST_NOW);
    const second = await alerts.generateRecommendedActions(TEST_NOW + 1_000);
    const priceAction = first.find(item => item.deduplicationKey === 'today:missing-price');
    assert.equal(first.length <= 5, true);
    assert.equal(priceAction.objectCount, 2);
    assert.equal(priceAction.href.includes('/dashboard/'), true);
    assert.equal(priceAction.completionCriteria.length > 10, true);
    assert.deepEqual(second.map(item => item.id).sort(), first.map(item => item.id).sort());
  });

  await test('saved views reject non-whitelisted filters and keep one default per page', async () => {
    await reset('saved-views');
    await assert.rejects(
      savedViews.createSavedView({ name: 'Unsafe view', page: 'products', filters: { apiKey: 'secret' }, columns: [], viewMode: 'table' }),
      /INVALID_FILTER/,
    );
    const first = await savedViews.createSavedView({ name: 'Quality first', page: 'products', filters: { qualityBand: 'good' }, columns: ['title'], viewMode: 'table', isDefault: true, createdBy: 'dashboard-admin' });
    const second = await savedViews.createSavedView({ name: 'Recent products', page: 'products', filters: { status: 'needs_review' }, columns: ['title'], viewMode: 'list', isDefault: true, createdBy: 'dashboard-admin' });
    const stored = await savedViews.listSavedViews('products');
    assert.equal(stored.find(item => item.id === first.id).isDefault, false);
    assert.equal(stored.find(item => item.id === second.id).isDefault, true);
  });

  await test('bulk preview is side-effect free and reports skipped items plus approval', async () => {
    await reset('products');
    await adapter.writeCollection('products', [makeProduct({ id: 'bulk-preview' })]);
    const before = fs.readFileSync(path.join(tempDir, 'products.json'), 'utf8');
    const preview = await intelligenceJobs.previewBulkOperation({ action: 'archive', productIds: ['bulk-preview', 'missing-product'] });
    const after = fs.readFileSync(path.join(tempDir, 'products.json'), 'utf8');
    assert.equal(preview.businessDataChanged, false);
    assert.deepEqual(preview.valid, ['bulk-preview']);
    assert.deepEqual(preview.skipped, ['missing-product']);
    assert.equal(preview.requiresApproval, true);
    assert.equal(preview.estimatedAiUsage, 0);
    assert.equal(after, before);
  });

  await test('bulk apply creates a durable HIGH-risk job instead of running in HTTP', async () => {
    await reset('products', 'automation-jobs', 'automation-control', 'automation-audit');
    await adapter.writeCollection('products', [makeProduct({ id: 'bulk-durable' })]);
    const response = await bulkRoute.POST(new NextRequest('http://localhost/api/dashboard/bulk', {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ mode: 'apply', confirmed: true, action: 'archive', productIds: ['bulk-durable'], idempotencyKey: 'bulk-durable-job-001' }),
    }));
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.data.status, 'WAITING_APPROVAL');
    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, 'automation-jobs.json'), 'utf8'));
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].type, 'BULK_PRODUCT_OPERATION');
    assert.equal(onDisk[0].riskLevel, 'HIGH');
    assert.equal((await productsStore.getProductById('bulk-durable')).status, 'needs_review');
  });

  await test('worker dispatches SCORE_PRODUCTS and maps legacy score to opportunityScore', async () => {
    await reset('products', 'price-history', 'automation-jobs', 'automation-control', 'automation-audit');
    await adapter.writeCollection('products', [makeProduct({ id: 'worker-score' })]);
    const created = await automationStore.createAutomationJob({
      type: 'SCORE_PRODUCTS', payload: { productIds: ['worker-score'] }, idempotencyKey: 'worker-score-job-001',
      operationId: 'worker-score-operation', requestedBy: 'prompt08-test', riskLevel: 'MEDIUM',
    });
    const run = await automationWorker.processAutomationBatch('prompt08-worker', 1);
    const job = await automationStore.getAutomationJob(created.job.id);
    const product = await productsStore.getProductById('worker-score');
    assert.equal(run.succeeded, 1);
    assert.equal(job.status, 'SUCCEEDED');
    assert.equal(typeof product.qualityScore, 'number');
    assert.equal(product.score, product.opportunityScore);
    assert.equal(product.scoreVersion.startsWith('opportunity-'), true);
  });

  await test('kill switch prevents queued product-intelligence side effects', async () => {
    await reset('products', 'automation-jobs', 'automation-control', 'automation-audit');
    await adapter.writeCollection('products', [makeProduct({ id: 'kill-switch-product', category: 'Before' })]);
    const created = await automationStore.createAutomationJob({
      type: 'BULK_PRODUCT_OPERATION', payload: { action: 'assign_category', productIds: ['kill-switch-product'], category: 'After' },
      idempotencyKey: 'kill-switch-bulk-001', requestedBy: 'prompt08-test', riskLevel: 'MEDIUM',
    });
    await automationStore.updateAutomationControl({ killSwitch: true, reason: 'Prompt08 local safety test' }, 'prompt08-test');
    const run = await automationWorker.processAutomationBatch('prompt08-kill-worker', 1);
    const job = await automationStore.getAutomationJob(created.job.id);
    assert.equal(run.claimed, 0);
    assert.notEqual(job.status, 'SUCCEEDED');
    assert.equal((await productsStore.getProductById('kill-switch-product')).category, 'Before');
  });

  await test('import apply API enqueues a durable IMPORT_PRODUCTS job', async () => {
    await reset('products', 'import-batches', 'automation-jobs', 'automation-control', 'automation-audit');
    const preview = await importer.previewCsvImport('title,originalUrl,price\nQueued import,https://merchant.example/queued,90000');
    const response = await importRoute.POST(new NextRequest('http://localhost/api/dashboard/import', {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ mode: 'apply', previewId: preview.previewId, idempotencyKey: 'import-queue-job-001' }),
    }));
    assert.equal(response.status, 201);
    const jobs = await automationStore.getAllAutomationJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].type, 'IMPORT_PRODUCTS');
    assert.equal((await productsStore.getAllProducts()).length, 0);
  });

  await test('admin APIs return 401 anonymously and 403 when server permission is absent', async () => {
    const anonymous = await importRoute.POST(new NextRequest('http://localhost/api/dashboard/import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'manual', url: 'https://merchant.example/item' }),
    }));
    assert.equal(anonymous.status, 401);
    process.env.SANDEAL_ADMIN_PERMISSIONS = 'VIEW_PRODUCTS';
    try {
      const forbidden = await importRoute.POST(new NextRequest('http://localhost/api/dashboard/import', {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ mode: 'manual', url: 'https://merchant.example/item' }),
      }));
      assert.equal(forbidden.status, 403);
      const body = await forbidden.json();
      assert.equal(body.code, 'FORBIDDEN');
    } finally {
      process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
    }
  });

  global.fetch = originalFetch;
  console.log(`\nPrompt08 product intelligence targeted: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(error => {
    failed += 1;
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
