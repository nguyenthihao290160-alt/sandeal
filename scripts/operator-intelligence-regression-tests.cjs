/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const temporaryRoot = path.resolve(root, '.test-tmp');
const testRoot = path.resolve(temporaryRoot, `operator-intelligence-${process.pid}-${Date.now()}`);
if (!testRoot.startsWith(`${temporaryRoot}${path.sep}`)) throw new Error('UNSAFE_TEST_ROOT');
fs.mkdirSync(testRoot, { recursive: true });

process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = path.join(testRoot, 'data');
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = ['operator', 'fixture'].join('-');
process.env.BASIC_AUTH_PASSWORD = ['local', 'fixture', 'only'].join('-');
process.env.ALLOW_PAID_AI = 'false';
process.env.ALLOW_PUBLISHING_API = 'false';
process.env.AUTO_PUBLISH_ENABLED = 'false';
process.env.TOKEN_VAULT_SECRET_KEY = ['isolated', 'fixture', 'vault', 'material', 'only'].join('-');
delete process.env.MONGODB_URI;
delete process.env.SANDEAL_STORAGE_DRIVER;
delete process.env.GEMINI_API_KEY;

global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_OPERATOR_INTELLIGENCE_TESTS'); };
require('./register-typescript.cjs');

const storage = require('../src/lib/storage/adapter.ts');
const automationStore = require('../src/lib/automation/store.ts');
const jobsRoute = require('../src/app/api/automation/jobs/route.ts');
const jobDetailRoute = require('../src/app/api/automation/jobs/[id]/route.ts');
const botRegistry = require('../src/lib/automation/botRegistry.ts');
const accessTrade = require('../src/lib/integrations/accesstrade.ts');
const accessTradeRoute = require('../src/app/api/product-sources/accesstrade/search/route.ts');
const productStorage = require('../src/lib/storage/products.ts');
const productDetail = require('../src/lib/dashboard/productDetailStatus.ts');
const urlSafety = require('../src/lib/product-intelligence/urlSafety.ts');
const productHealth = require('../src/lib/bots/productHealthCheck.ts');
const systemCapability = require('../src/lib/health/systemCapability.ts');
const credentialTruth = require('../src/lib/ai/credentialTruth.ts');
const secretProjection = require('../src/lib/security/secrets.ts');
const { NextRequest } = require('next/server');

const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const fixedNow = Date.parse('2026-07-24T04:00:00.000Z');
const auth = `Basic ${Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASSWORD}`).toString('base64')}`;
let passed = 0;
let failed = 0;
let jobsListPayloadBytes = 0;

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

async function resetCollections(...names) {
  for (const name of names) await storage.writeCollection(name, []);
}

function request(url, authenticated = true) {
  return new NextRequest(url, authenticated ? { headers: { authorization: auth } } : undefined);
}

function candidate(overrides = {}) {
  const observedAt = new Date(fixedNow).toISOString();
  return {
    schemaVersion: 2,
    sourceId: 'serum-source-1',
    sourceItemId: 'serum-source-1',
    externalId: 'serum-source-1',
    title: 'Serum dưỡng ẩm mini 25ml',
    kind: 'product',
    recordType: 'PRODUCT',
    platform: 'accesstrade',
    source: 'accesstrade',
    originalUrl: 'https://merchant.example/products/serum-mini',
    canonicalProductUrl: 'https://merchant.example/products/serum-mini',
    imageUrl: 'https://images.example/serum.jpg',
    price: 80_000,
    currency: 'VND',
    tags: [],
    benefits: [],
    warnings: [],
    riskLevel: 'low',
    status: 'needs_review',
    publicHidden: true,
    publicBlocked: true,
    verifiedSource: true,
    sourceVerified: true,
    autoPublishEligible: false,
    priceObservedAt: observedAt,
    priceVerificationStatus: 'VERIFIED',
    fieldProvenance: {
      price: {
        value: 80_000,
        source: 'accesstrade',
        verificationStatus: 'VERIFIED',
        verifiedAt: observedAt,
      },
      imageUrl: {
        value: 'https://images.example/serum.jpg',
        source: 'accesstrade',
        verificationStatus: 'VERIFIED',
        verifiedAt: observedAt,
      },
    },
    createdAt: observedAt,
    updatedAt: observedAt,
    ...overrides,
  };
}

function capabilityInput(overrides = {}) {
  return {
    web: { status: 'alive' },
    worker: { status: 'active' },
    scheduler: { status: 'active' },
    queue: { pending: 0, running: 0, stuck: 0, staleJobs: 0 },
    control: {
      publishPaused: false,
      publishPausedByOperator: false,
      publishBlockedByRuntime: false,
      publishBlockedByPolicy: false,
      publishRuntimeReasons: [],
      publishPolicyReasons: [],
      workerPaused: false,
      schedulerPaused: false,
      ingestionPaused: false,
      killSwitch: false,
    },
    runtime: { publishSafe: true, reasons: [] },
    release: { releaseMismatch: false },
    ai: { providerStatus: 'ready', budgetAvailable: true, policyAllowed: true },
    ...overrides,
  };
}

function geminiCredential(overrides = {}) {
  const now = new Date(fixedNow).toISOString();
  return {
    id: 'gemini-fixture',
    platform: 'gemini',
    maskedValue: '****only',
    status: 'valid',
    role: 'backup',
    lastCheckedAt: now,
    metadata: {
      generationStatus: 'available',
      generationReady: true,
      generationVerifiedAt: now,
      lastGenerationSucceededAt: now,
      lastSuccessfulRequestAt: now,
      lastLightTestAt: now,
      discoveredModelCount: 2,
      supportedModels: ['gemini-2.5-flash-lite'],
      supportedGenerateContentModels: ['gemini-2.5-flash-lite'],
      preferredModel: 'gemini-2.5-flash-lite',
      testedModel: 'gemini-2.5-flash-lite',
      freePolicyEligible: true,
      quotaGroupId: 'free-fixture-group',
      adapterReady: true,
      runtimeRouteReady: true,
      diagnosticCategory: 'READY',
    },
    ...overrides,
  };
}

async function prepareRepresentativeJobs() {
  await resetCollections('automation-jobs', 'automation-job-projections', 'automation-job-list-projections-v2', 'automation-audit');
  const created = await automationStore.createAutomationJob({
    type: 'HEALTH_CHECK',
    payload: { scope: 'fixture' },
    idempotencyKey: 'operator-list-fixture-seed',
    requestedBy: 'operator-fixture',
    riskLevel: 'LOW',
  });
  const jobs = Array.from({ length: 60 }, (_, index) => {
    const createdAt = new Date(fixedNow - index * 60_000).toISOString();
    return {
      ...structuredClone(created.job),
      id: `fixture-job-${String(index).padStart(3, '0')}`,
      operationId: `fixture-operation-${String(index).padStart(3, '0')}`,
      idempotencyKey: `fixture-key-${String(index).padStart(3, '0')}`,
      createdAt,
      updatedAt: createdAt,
      progress: { processed: index, total: 100, succeeded: index, skipped: 0, failed: 0, percentage: index, updatedAt: createdAt },
      executionPlan: Array.from({ length: 40 }, (_, step) => ({
        id: `step-${step}`,
        capability: 'INSPECT_PRODUCT_HEALTH',
        dependsOn: [],
        reason: 'Representative detail text '.repeat(8),
        status: 'PENDING',
        risk: 'LOW',
        approvalRequired: false,
        expectedWrite: [],
        externalCall: false,
        fallback: ['LOCAL_RULES'],
      })),
      disclosure: {
        provider: 'LOCAL_RULES',
        model: 'system',
        externalRequests: index % 3,
        aiRequests: 0,
        fallbackReason: index % 2 ? 'LOCAL_FALLBACK' : undefined,
        evidenceCoverage: 75,
      },
      result: {
        rows: Array.from({ length: 180 }, (_, row) => ({
          row,
          summary: 'Large detail-only result '.repeat(12),
          apiKey: ['must', 'not', 'leave', 'server'].join('-'),
        })),
        authorization: `Bearer ${['fixture', 'authorization', 'value'].join('-')}`,
      },
      checkpoint: {
        cursor: index,
        outputs: { password: ['detail', 'fixture', 'only'].join('-'), text: 'kept' },
        updatedAt: createdAt,
      },
      workerInstanceId: `worker-instance-${'x'.repeat(180)}`,
    };
  });
  await storage.writeCollection('automation-jobs', jobs);
  await storage.writeCollection('automation-job-list-projections-v2', jobs.map(automationStore.projectAutomationJobListItem));
  return { jobs, seedJobId: created.job.id };
}

async function main() {
  const preparedJobs = await prepareRepresentativeJobs();
  const representativeJobs = preparedJobs.jobs;

  await test('Jobs list v2 giữ nguyên projection status cũ để rollback', async () => {
    const legacyProjection = await storage.readCollection('automation-job-projections');
    const compactProjection = await storage.readCollection('automation-job-list-projections-v2');
    assert.ok(legacyProjection.some(job => job.id === preparedJobs.seedJobId));
    assert.equal(compactProjection.length, 60);
    assert.equal(Object.hasOwn(compactProjection[0], 'result'), false);
  });

  await test('Jobs API vẫn yêu cầu xác thực', async () => {
    const response = await jobsRoute.GET(request('http://localhost/api/automation/jobs?page=1&pageSize=50', false));
    assert.equal(response.status, 401);
  });

  let compactBody;
  await test('Jobs API trả compact DTO, phân trang thật và query bounded', async () => {
    const response = await jobsRoute.GET(request('http://localhost/api/automation/jobs?page=1&pageSize=50'));
    assert.equal(response.status, 200);
    compactBody = await response.json();
    assert.equal(compactBody.data.items.length, 50);
    assert.equal(compactBody.data.pagination.totalItems, 60);
    assert.equal(compactBody.data.meta.projection, 'compact-v2');
    assert.equal(compactBody.data.meta.dataAccess.source, 'compact-read-model');
    assert.ok(compactBody.data.meta.dataAccess.queryCount <= 2);
    const first = compactBody.data.items[0];
    for (const field of ['result', 'executionPlan', 'checkpoint', 'disclosure', 'payload', 'workerInstanceId', 'claimToken']) {
      assert.equal(Object.hasOwn(first, field), false, `${field} must not be in list DTO`);
    }
    assert.equal(typeof first.id, 'string');
    assert.equal(typeof first.status, 'string');
    assert.ok(first.progress);
  });

  await test('Jobs list 50 hàng nằm dưới ngân sách 300 KB', () => {
    const bytes = Buffer.byteLength(JSON.stringify(compactBody), 'utf8');
    jobsListPayloadBytes = bytes;
    assert.ok(bytes <= automationStore.AUTOMATION_JOB_LIST_PAYLOAD_BUDGET_BYTES, `${bytes} > list budget`);
    assert.ok(bytes < 300 * 1024);
  });

  await test('Jobs API cap pageSize về 50 và trang sau không trùng', async () => {
    const capped = await jobsRoute.GET(request('http://localhost/api/automation/jobs?page=1&pageSize=500'));
    assert.equal(capped.status, 200);
    const cappedBody = await capped.json();
    assert.equal(cappedBody.data.items.length, 50);
    assert.equal(cappedBody.data.pagination.pageSize, 50);
    assert.equal(cappedBody.data.meta.pageSizeCapped, true);
    const firstTen = await jobsRoute.GET(request('http://localhost/api/automation/jobs?page=1&pageSize=10'));
    const firstTenBody = await firstTen.json();
    const second = await jobsRoute.GET(request('http://localhost/api/automation/jobs?page=2&pageSize=10'));
    const secondBody = await second.json();
    const firstIds = new Set(firstTenBody.data.items.map((item) => item.id));
    assert.ok(secondBody.data.items.every((item) => !firstIds.has(item.id)));
    const beyond = await jobsRoute.GET(request('http://localhost/api/automation/jobs?page=99&pageSize=10'));
    const beyondBody = await beyond.json();
    assert.equal(beyondBody.data.pagination.page, 99);
    assert.equal(beyondBody.data.items.length, 0);
    assert.ok(beyondBody.data.meta.dataAccess.queryCount <= 2);
    const invalidPage = await jobsRoute.GET(request('http://localhost/api/automation/jobs?page=10001&pageSize=10'));
    assert.equal(invalidPage.status, 400);
  });

  await test('Chi tiết job chỉ tải explicit và loại secret', async () => {
    const id = representativeJobs[0].id;
    const response = await jobDetailRoute.GET(
      request(`http://localhost/api/automation/jobs/${encodeURIComponent(id)}`),
      { params: Promise.resolve({ id }) },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.data.result);
    assert.ok(body.data.executionPlan);
    assert.equal(Object.hasOwn(body.data, 'payload'), false);
    assert.equal(Object.hasOwn(body.data, 'claimToken'), false);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('must-not-leave-server'), false);
    assert.equal(serialized.includes('fixture-authorization-value'), false);
    assert.equal(serialized.includes('detail-fixture-only'), false);
  });

  await test('Jobs UI có loading, slow/timeout, retry, stale-data refresh và detail on demand', () => {
    const ui = source('src/app/dashboard/ai-bots/bot-control-center.tsx');
    assert.ok(ui.includes("type ResourcePhase = 'idle' | 'loading' | 'refreshing' | 'loaded' | 'empty' | 'error' | 'timeout'"));
    assert.ok(ui.includes('TableSkeleton'));
    assert.ok(ui.includes('Máy chủ đang phản hồi chậm'));
    assert.ok(ui.includes('Thử lại'));
    assert.ok(ui.includes('dữ liệu hợp lệ gần nhất vẫn được hiển thị'));
    assert.ok(ui.includes('openJobDetail'));
    assert.ok(ui.includes('/api/automation/jobs/${encodeURIComponent(jobId)}'));
    assert.equal(ui.includes('JSON.stringify(job.result'), false);
  });

  await test('Bot Registry có 24 capability và không hiện empty trong loading', () => {
    assert.equal(botRegistry.listBotRegistry().length, 24);
    const ui = source('src/app/dashboard/ai-bots/bot-control-center.tsx');
    const loadingBranch = ui.slice(ui.indexOf("(['idle', 'loading'].includes(registryPhase)"), ui.indexOf("registryPhase === 'empty'"));
    assert.ok(loadingBranch.includes('TableSkeleton'));
    assert.equal(loadingBranch.includes('Chưa có registry'), false);
    assert.ok(ui.includes("registryPhase === 'empty'"));
    assert.ok(ui.includes('registry.length === 0'));
    assert.ok(ui.includes("registryPhase === 'refreshing'"));
    assert.ok(ui.includes('aria-current'));
  });

  await test('Matcher serum chuẩn hóa case, khoảng trắng, dấu và ranh giới từ', () => {
    for (const [textValue, query] of [
      ['SERUM dưỡng ẩm', 'serum'],
      ['  serum   dưỡng ẩm  ', 'SERUM'],
      ['Tinh chất-serum dưỡng ẩm', 'serum'],
      ['Sữa rửa mặt dịu nhẹ', 'sua rua mat'],
      ['sua rua mat dịu nhẹ', 'SỮA RỬA MẶT'],
    ]) assert.equal(accessTrade.matchesAccessTradeSearchQuery(textValue, query), true, `${textValue} / ${query}`);
    for (const textValue of ['seruminous formula', 'preserumx', 'phụ kiện serumx']) {
      assert.equal(accessTrade.matchesAccessTradeSearchQuery(textValue, 'serum'), false, textValue);
    }
  });

  await test('Diagnostics nhóm rejection, giới hạn sample và che metadata nhạy cảm', () => {
    const records = [
      { product_id: 'p1', product_name: 'Serum dưỡng ẩm thật', url: 'https://merchant.example/p1', image: 'https://img.example/p1.jpg', price: 100_000 },
      { product_id: 'p2', product_name: 'Kem dưỡng da', description: '<b>không liên quan</b> https://x.example/?token=fixture-sensitive-value', url: 'https://merchant.example/p2', image: 'https://img.example/p2.jpg', price: 90_000 },
      { product_id: 'p3', product_name: 'Sữa rửa mặt', url: 'https://merchant.example/p3', image: 'https://img.example/p3.jpg', price: 80_000 },
      { id: 'v1', title: 'Voucher giảm giá Serum 20%', type: 'voucher', url: 'https://merchant.example/v1' },
      { id: 'c1', title: 'Chiến dịch Serum mùa hè', type: 'campaign', url: 'https://merchant.example/c1' },
    ];
    const result = accessTrade.processAccessTradePayload(
      { data: records, total: records.length },
      { keyword: 'serum', kind: 'product', limit: 20, diagnosticReason: 'KEYWORD_MISMATCH', diagnosticPage: 1, diagnosticPageSize: 1 },
      { endpoint: 'datafeed', fetchedAt: new Date(fixedNow).toISOString() },
    );
    const mismatch = result.diagnostics.rejectionGroups.find((group) => group.reason === 'KEYWORD_MISMATCH');
    assert.ok(mismatch);
    assert.equal(mismatch.count, 2);
    assert.equal(mismatch.samples.length, 1);
    assert.equal(mismatch.pagination.pageSize, 1);
    assert.ok(mismatch.matcherRule.includes('MATCH_NORMALIZED_WORD_BOUNDARIES'));
    assert.ok(mismatch.explanationVi);
    assert.ok(mismatch.samples[0].originalProviderTitle);
    assert.ok(mismatch.samples[0].normalizedTitle);
    assert.ok(mismatch.samples[0].normalizedRelevantText);
    assert.equal(mismatch.samples[0].stage, 'AFTER_NORMALIZATION');
    assert.equal(JSON.stringify(result.diagnostics).includes('fixture-sensitive-value'), false);
    assert.ok(result.diagnostics.rejectionGroups.some((group) => group.reason === 'VOUCHER_RECORD'));
    assert.ok(result.diagnostics.rejectionGroups.some((group) => group.reason === 'CAMPAIGN_RECORD'));
    assert.equal(result.items.every((item) => item.kind === 'product'), true);
    const publicResult = accessTradeRoute.compactPublicAccessTradeResult(result);
    assert.equal(Object.hasOwn(publicResult.items[0], 'rawData'), false);
    assert.equal(publicResult.items[0].rawPayloadOmitted, true);
  });

  await test('Diagnostics hỗ trợ trang sample explicit', () => {
    const records = Array.from({ length: 6 }, (_, index) => ({
      product_id: `mismatch-${index}`,
      product_name: `Kem dưỡng số ${index}`,
      url: `https://merchant.example/mismatch-${index}`,
      image: `https://img.example/mismatch-${index}.jpg`,
      price: 50_000 + index,
    }));
    const first = accessTrade.processAccessTradePayload({ data: records }, { keyword: 'serum', diagnosticReason: 'KEYWORD_MISMATCH', diagnosticPage: 1, diagnosticPageSize: 2 });
    const second = accessTrade.processAccessTradePayload({ data: records }, { keyword: 'serum', diagnosticReason: 'KEYWORD_MISMATCH', diagnosticPage: 2, diagnosticPageSize: 2 });
    const firstGroup = first.diagnostics.rejectionGroups.find((group) => group.reason === 'KEYWORD_MISMATCH');
    const secondGroup = second.diagnostics.rejectionGroups.find((group) => group.reason === 'KEYWORD_MISMATCH');
    assert.equal(firstGroup.samples.length, 2);
    assert.equal(secondGroup.samples.length, 2);
    assert.notDeepEqual(firstGroup.samples.map((item) => item.id), secondGroup.samples.map((item) => item.id));
  });

  await test('Duplicate save giữ evidence mạnh, bổ sung field thiếu và không tạo bản ghi mới', async () => {
    await resetCollections('products', 'product-duplicate-merge-audit');
    const initial = await productStorage.upsertSourceCandidateProduct(candidate({ merchant: undefined }));
    const merged = await productStorage.upsertSourceCandidateProduct(candidate({
      merchant: 'merchant-store',
      price: 1,
      imageUrl: 'https://weaker.example/image.jpg',
      fieldProvenance: {
        price: { value: 1, source: 'provider-weak', verificationStatus: 'UNVERIFIED' },
        imageUrl: { value: 'https://weaker.example/image.jpg', source: 'provider-weak', verificationStatus: 'UNVERIFIED' },
      },
    }));
    assert.equal(merged.created, false);
    assert.equal(merged.product.id, initial.product.id);
    assert.equal(merged.product.price, 80_000);
    assert.equal(merged.product.imageUrl, 'https://images.example/serum.jpg');
    assert.equal(merged.product.merchant, 'merchant-store');
    assert.ok(merged.mapping.enrichedFields.includes('nhà bán'));
    assert.ok(merged.mapping.notUpdatedFields.some((item) => item.reason === 'EXISTING_EVIDENCE_STRONGER'));
    assert.equal((await productStorage.getAllProducts()).length, 1);
  });

  await test('Repeated và concurrent duplicate saves idempotent', async () => {
    await resetCollections('products', 'product-duplicate-merge-audit');
    const results = await Promise.all(Array.from({ length: 12 }, () => productStorage.upsertSourceCandidateProduct(candidate())));
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(new Set(results.map((result) => result.product.id)).size, 1);
    assert.equal((await productStorage.getAllProducts()).length, 1);
  });

  await test('Save UX chỉ có một action mở sản phẩm và chống double submit', () => {
    const ui = source('src/app/dashboard/product-sources/page.tsx');
    assert.equal((ui.match(/Xem sản phẩm đã có/g) || []).length, 1);
    assert.ok(ui.includes('saveInFlightRef.current.has(itemId)'));
    assert.ok(ui.includes('Idempotency-Key'));
    assert.ok(ui.includes('sandeal:source-candidate-mappings:v1'));
    assert.ok(ui.includes('technicalFields'));
    assert.ok(ui.includes('Chi tiết kỹ thuật'));
  });

  await test('Product Detail sắp root cause ổn định và không để mã lạ thống trị UI', () => {
    const blockers = [
      'review:low_originality',
      'image_http_not_200',
      'affiliate_url_unverified',
      'merchant_quarantined_30shinestore',
      'price_unverified',
      'product_url_unhealthy',
      'claims_unverified',
      'auto_publish_ineligible',
      'unknown_fixture_code',
    ];
    const summary = productDetail.deriveProductRemediationSummary(blockers, blockers.slice(0, 8), 'KEEP_QUARANTINED');
    assert.deepEqual(summary.rootCauses.slice(0, 8).map((item) => item.id), [
      'MERCHANT_POLICY', 'PRODUCT_URL', 'AFFILIATE_URL', 'IMAGE', 'PRICE', 'EVIDENCE', 'CONTENT_REVIEW', 'PUBLISHING',
    ]);
    assert.equal(summary.total, blockers.length);
    assert.equal(summary.critical, 8);
    assert.match(productDetail.localizeProductBlocker('unknown_fixture_code'), /chi tiết kỹ thuật/i);
    assert.equal(productDetail.localizeProductBlocker('unknown_fixture_code').includes('unknown_fixture_code'), false);
  });

  await test('Product Detail giữ Safe Publish/CANARY khóa, giải thích score/risk và tránh action trùng', () => {
    const ui = source('src/app/dashboard/products/[id]/page.tsx');
    const css = source('src/app/dashboard/products/[id]/product-detail.module.css');
    assert.ok(ui.includes('blockerSeverityLabel'));
    assert.ok(ui.includes('không phải trạng thái sẵn sàng đăng'));
    assert.ok(ui.includes('Chấm lại chỉ cập nhật điểm'));
    assert.ok(ui.includes('rootCauseList'));
    assert.ok(ui.includes('canonicalLinkEnabled'));
    assert.ok(ui.includes('noopener noreferrer nofollow'));
    assert.ok(ui.includes('canaryDisabledReason'));
    assert.ok(ui.includes('publishDisabledReason'));
    assert.equal((ui.match(/handleAction\('score'\)/g) || []).length, 1);
    assert.ok(ui.includes('truncateIdentifier'));
    assert.ok(ui.includes('aria-expanded={showTechnical}'));
    assert.ok(ui.includes('chi tiết kỹ thuật'));
    assert.ok(css.includes('width: min(100%, 1440px)'));
    assert.ok(css.includes('@media (max-width: 680px)'));
    assert.equal(css.includes('word-break: break-all'), false);
  });

  await test('URL checker chặn protocol và đích local/private', () => {
    for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'http://127.0.0.1/private', 'http://169.254.169.254/latest', 'https://user:pass@example.com/']) {
      assert.equal(urlSafety.validateExternalUrl(value).safe, false, value);
    }
    assert.equal(urlSafety.validateExternalUrl('https://merchant.example/product').safe, true);
  });

  await test('Safe fetch giới hạn redirect và chặn redirect tới private network', async () => {
    let calls = 0;
    await assert.rejects(
      () => urlSafety.fetchExternalSafely('https://safe.example/start', {
        resolveDns: false,
        maxRedirects: 2,
        fetchImpl: async () => {
          calls += 1;
          return new Response(null, { status: 302, headers: { location: calls === 1 ? 'https://safe.example/next' : 'http://127.0.0.1/private' } });
        },
      }),
      /PRIVATE_NETWORK/,
    );
    assert.equal(calls, 2);
  });

  await test('Image verifier fail-closed với content type sai và body quá lớn', async () => {
    const invalidType = await productHealth.checkImageHealth('https://images.example/not-image', {
      resolveDns: false,
      fetchImpl: async () => new Response('not an image', { status: 200, headers: { 'content-type': 'text/html', 'content-length': '12' } }),
    });
    assert.equal(invalidType.ok, false);
    assert.equal(invalidType.status, 'invalid_image');
    const oversized = await productHealth.checkImageHealth('https://images.example/huge', {
      resolveDns: false,
      fetchImpl: async () => new Response(null, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(30 * 1024 * 1024) } }),
    });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.status, 'too_large');
  });

  await test('Verifier dùng durable audit, retry/circuit và không còn raw legacy fetch', () => {
    const jobs = source('src/lib/product-intelligence/jobs.ts');
    const imageResolver = source('src/lib/bots/imageResolver.ts');
    const linkHealth = source('src/lib/bots/linkHealth.ts');
    assert.ok(jobs.includes('ProductReprocessAudit'));
    assert.ok(jobs.includes('sourceHealthCooldownUntil'));
    assert.ok(jobs.includes('recordDomainHealth'));
    assert.ok(imageResolver.includes('fetchExternalSafely'));
    assert.ok(imageResolver.includes('checkImageHealth'));
    assert.equal(linkHealth.includes('legacyCheckUrl'), false);
  });

  await test('App Health giữ dịch vụ healthy khi publishing hoặc AI bị chặn', () => {
    const publishing = systemCapability.deriveSystemCapabilityStatus(capabilityInput({
      control: { ...capabilityInput().control, publishBlockedByRuntime: true, publishRuntimeReasons: ['ZERO_TOUCH_SLO_FAILED'] },
      runtime: { publishSafe: false, reasons: ['ZERO_TOUCH_SLO_FAILED'] },
    }));
    assert.equal(publishing.operationalStatus, 'OPERATIONAL');
    assert.equal(publishing.publishingStatus, 'BLOCKED');
    assert.equal(publishing.emergencyStatus, 'OFF');
    const ai = systemCapability.deriveSystemCapabilityStatus(capabilityInput({
      ai: { providerStatus: 'blocked_by_policy', budgetAvailable: true, policyAllowed: true },
    }));
    assert.equal(ai.operationalStatus, 'OPERATIONAL');
    assert.equal(ai.aiStatus, 'BLOCKED');
    assert.equal(ai.overallStatus, 'LIMITED');
  });

  await test('App Health phân biệt stale role, pause, emergency và release mismatch', () => {
    assert.equal(systemCapability.deriveSystemCapabilityStatus(capabilityInput({ worker: { status: 'stale' } })).operationalStatus, 'DEGRADED');
    assert.equal(systemCapability.deriveSystemCapabilityStatus(capabilityInput({ scheduler: { status: 'stale' } })).operationalStatus, 'DEGRADED');
    const paused = capabilityInput();
    paused.control.publishPausedByOperator = true;
    assert.equal(systemCapability.deriveSystemCapabilityStatus(paused).publishingStatus, 'PAUSED');
    const emergency = capabilityInput();
    emergency.control.killSwitch = true;
    assert.equal(systemCapability.deriveSystemCapabilityStatus(emergency).overallStatus, 'EMERGENCY_STOP');
    const mismatch = systemCapability.deriveSystemCapabilityStatus(capabilityInput({ release: { releaseMismatch: true } }));
    assert.equal(mismatch.operationalStatus, 'DEGRADED');
    assert.equal(mismatch.publishingStatus, 'BLOCKED');
    const ui = source('src/app/dashboard/app-health/page.tsx');
    assert.ok(ui.includes('Lý do hiện tại'));
    assert.ok(ui.includes('Lịch sử audit'));
  });

  await test('Gemini discovery và minimal generation không tự thành production route', () => {
    const discovered = credentialTruth.getCredentialTruth(geminiCredential({
      role: 'backup',
      metadata: {
        ...geminiCredential().metadata,
        generationStatus: 'unchecked',
        lastGenerationSucceededAt: undefined,
        generationVerifiedAt: undefined,
        lastSuccessfulRequestAt: undefined,
        freePolicyEligible: false,
        adapterReady: false,
        runtimeRouteReady: false,
      },
    }), fixedNow);
    assert.equal(discovered.dimensions.modelDiscoveryAvailable, true);
    assert.equal(discovered.dimensions.endToEndMinimalGenerationPassed, false);
    assert.equal(discovered.productionReady, false);
    const probed = credentialTruth.getCredentialTruth(geminiCredential(), fixedNow);
    assert.equal(probed.generationReady, true);
    assert.equal(probed.productionReady, false);
    assert.equal(probed.failureClass, 'routing');
  });

  await test('Gemini phân loại permission, auth, policy, quota, model và routing', () => {
    const permission = credentialTruth.getCredentialTruth(geminiCredential({ status: 'missing_permission', metadata: { ...geminiCredential().metadata, generationStatus: 'missing_permission', diagnosticCategory: 'PERMISSION_DENIED' } }), fixedNow);
    assert.equal(permission.failureClass, 'permission');
    const authentication = credentialTruth.getCredentialTruth(geminiCredential({ status: 'invalid', metadata: { ...geminiCredential().metadata, generationStatus: 'invalid', diagnosticCategory: 'INVALID_KEY' } }), fixedNow);
    assert.equal(authentication.failureClass, 'authentication');
    const policy = credentialTruth.getCredentialTruth(geminiCredential({ metadata: { ...geminiCredential().metadata, freePolicyEligible: false } }), fixedNow);
    assert.equal(policy.failureClass, 'policy');
    const quota = credentialTruth.getCredentialTruth(geminiCredential({ metadata: { ...geminiCredential().metadata, generationStatus: 'quota_exhausted', diagnosticCategory: 'QUOTA_EXCEEDED' } }), fixedNow);
    assert.equal(quota.failureClass, 'quota');
    const model = credentialTruth.getCredentialTruth(geminiCredential({ metadata: { ...geminiCredential().metadata, supportedGenerateContentModels: [], diagnosticCategory: 'MODEL_NOT_AVAILABLE' } }), fixedNow);
    assert.equal(model.failureClass, 'model');
  });

  await test('Gemini production readiness chỉ true khi đủ mọi gate và là tuyến chính', () => {
    const truth = credentialTruth.getCredentialTruth(geminiCredential({ role: 'primary' }), fixedNow);
    assert.equal(truth.productionReady, true);
    assert.equal(truth.dimensions.productionReady, true);
    assert.equal(Object.values(truth.dimensions).every(Boolean), true);
    assert.equal(truth.failureClass, null);
    assert.equal(truth.routePolicy, 'FREE_ONLY');
    assert.equal(truth.selectedProvider, 'gemini');
    const ui = source('src/app/dashboard/token-vault/page.tsx');
    assert.ok(ui.includes('GEMINI_DIMENSION_LABELS'));
    assert.ok(ui.includes('Sẵn sàng production'));
    assert.ok(ui.includes('Generation probe thành công chưa đủ'));
    assert.equal(ui.includes('encryptedValue'), false);
  });

  await test('Token Vault projection loại secret và metadata không được phép', () => {
    const secretMetadataKey = ['api', 'Key'].join('');
    const secretMetadataValue = ['metadata', 'fixture', 'must', 'not', 'leak'].join('-');
    const bearerFixture = ['Bearer', 'hidden', 'fixture', 'token'].join(' ');
    const safe = secretProjection.toSafeCredential({
      ...geminiCredential({ role: 'primary' }),
      credentialType: 'api_key',
      label: 'Gemini fixture',
      encryptedValue: 'encrypted-fixture-value',
      permissions: ['generateContent'],
      metadata: {
        ...geminiCredential().metadata,
        [secretMetadataKey]: secretMetadataValue,
        arbitrary: bearerFixture,
        errorCategory: 'PERMISSION_DENIED',
      },
      createdAt: new Date(fixedNow).toISOString(),
      updatedAt: new Date(fixedNow).toISOString(),
    });
    const serialized = JSON.stringify(safe);
    assert.equal(Object.hasOwn(safe, 'encryptedValue'), false);
    assert.equal(Object.hasOwn(safe.metadata, secretMetadataKey), false);
    assert.equal(Object.hasOwn(safe.metadata, 'arbitrary'), false);
    assert.equal(serialized.includes(secretMetadataValue), false);
    assert.equal(serialized.includes(bearerFixture), false);
    assert.equal(safe.metadata.errorCategory, 'PERMISSION_DENIED');
  });

  await test('Active navigation/tabs và metadata an toàn được giữ', () => {
    const nav = source('src/app/dashboard/layout.tsx');
    const tabs = source('src/app/dashboard/ai-bots/bot-control-center.tsx');
    const layout = source('src/app/layout.tsx');
    assert.ok(nav.includes('aria-current'));
    assert.ok(tabs.includes('activeTab'));
    assert.ok(layout.includes('SanDeal'));
    for (const forbidden of ['/var/www', 'pm2', 'MONGODB_URI', 'API_KEY']) assert.equal(layout.includes(forbidden), false);
  });

  console.log(`\nJobs compact payload (50 representative rows): ${jobsListPayloadBytes} bytes uncompressed`);
  console.log(`Operator intelligence: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });
