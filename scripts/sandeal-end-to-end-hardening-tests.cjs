/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = process.cwd();
const tempDir = path.join(root, '.test-tmp', `sandeal-e2e-hardening-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'hardening-e2e';
process.env.BASIC_AUTH_PASSWORD = 'local-test-password';
delete process.env.SANDEAL_STORAGE_DRIVER;
delete process.env.MONGODB_URI;
require('./register-typescript.cjs');

const adapter = require('../src/lib/storage/adapter.ts');
const products = require('../src/lib/storage/products.ts');
const settings = require('../src/lib/storage/automationSettings.ts');
const store = require('../src/lib/automation/store.ts');
const worker = require('../src/lib/automation/worker.ts');
const eligibility = require('../src/lib/productEligibility.ts');
const reviewQuality = require('../src/lib/reviewQuality.ts');
const safePublish = require('../src/lib/safePublish.ts');
const publicFilter = require('../src/lib/publicProductFilter.ts');
const pipelineTruth = require('../src/lib/product-intelligence/productPipelineTruth.ts');
const dashboardProducts = require('../src/lib/dashboard/products.ts');
const releaseIdentity = require('../src/lib/releaseIdentity.ts');
const jobsRoute = require('../src/app/api/automation/jobs/route.ts');
const { NextRequest } = require('next/server');

const auth = `Basic ${Buffer.from('hardening-e2e:local-test-password').toString('base64')}`;
const headers = { authorization: auth, 'content-type': 'application/json' };
let passed = 0;
let failed = 0;

async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error.stack || error}`); }
}

async function reset() {
  for (const collection of [
    'products', 'automation-jobs', 'automation-control', 'automation-audit',
    'automation-ai-usage', 'automation-circuits', 'domain-circuit-breakers',
    'runtime-role-leases', 'runtime-role-conflicts', 'pipeline-daily-usage',
  ]) await adapter.writeCollection(collection, []);
  await settings.updateAutomationSettings({ enabled: true, maxItemsPerRun: 10, maxItemsPerDay: 50 });
}

function scanProduct(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: 'scan-product', title: 'Sản phẩm kiểm thử durable health', slug: 'san-pham-durable-health',
    kind: 'product', platform: 'website', source: 'manual', price: 250000, currency: 'VND',
    tags: [], benefits: [], warnings: [], riskLevel: 'low', status: 'needs_review',
    verifiedSource: true, sourceVerified: true, autoPublishEligible: true,
    publicHidden: true, publicBlocked: false, needsVerification: true,
    createdAt: now, updatedAt: now, ...overrides,
  };
}

function approvedProduct(overrides = {}) {
  const now = new Date().toISOString();
  const sourceHash = 'source-hash-current';
  const factTitle = { id: 'title', label: 'Tên', value: 'Tai nghe Bluetooth X200', sourceField: 'title', sourceName: 'merchant_api', verifiedAt: now };
  const factPrice = { id: 'price', label: 'Giá', value: 890000, sourceField: 'price', sourceName: 'merchant_api', verifiedAt: now };
  const claim = (id, text, factId) => ({ id, text, claimType: 'factual', evidenceFactIds: [factId], confidence: 'high' });
  return scanProduct({
    id: 'eligible-product', title: 'Tai nghe Bluetooth X200 chính hãng', slug: 'tai-nghe-bluetooth-x200',
    description: 'Thông tin kỹ thuật được nhà bán công bố và SanDeal đối chiếu theo nguồn ghi rõ.',
    originalUrl: 'https://merchant.example/products/x200', affiliateUrl: 'https://tracking.example/x200',
    affiliateUrlSource: 'manual', affiliateUrlProvider: 'manual', imageUrl: 'https://images.example/x200.jpg',
    price: 890000, priceObservedAt: now, priceTruthState: 'FRESH', sourceHash,
    linkHealthStatus: 'ok', linkLastCheckedAt: now, canonicalUrlStatus: 'verified', canonicalUrlVerifiedAt: now,
    productUrlFinalDomain: 'merchant.example', productUrlHttpStatus: 200,
    affiliateHealthStatus: 'ok', affiliateLastCheckedAt: now, affiliateUrlStatus: 'verified', affiliateUrlVerifiedAt: now,
    affiliateUrlFinalDomain: 'merchant.example', affiliateUrlHttpStatus: 200,
    imageHealthStatus: 'ok', imageLastCheckedAt: now, imageUrlHttpStatus: 200, imageContentType: 'image/jpeg',
    duplicateStatus: 'CLEAR', claimValidationStatus: 'VERIFIED',
    reviewContent: {
      reviewStatus: 'approved', reviewVersion: 2, reviewMethod: 'source_data_analysis', reviewerType: 'automated_editorial',
      reviewDisclosure: 'SanDeal có thể nhận hoa hồng affiliate qua một số liên kết; giá người mua thanh toán không thay đổi.',
      reviewTitle: 'Đánh giá dữ liệu Tai nghe Bluetooth X200',
      reviewSummary: 'Dữ liệu hiện có cho thấy mẫu tai nghe này có mức giá được ghi nhận rõ, liên kết và hình ảnh đã được kiểm tra. Nhận định dưới đây dựa trên thông tin nguồn, không phải trải nghiệm sử dụng trực tiếp.',
      reviewVerdict: 'Phù hợp để cân nhắc khi người mua ưu tiên thông tin nguồn minh bạch và vẫn kiểm tra lại điều kiện cuối cùng tại nhà bán.',
      suitableFor: ['Người cần tai nghe không dây và muốn đối chiếu nguồn trước khi mua.'],
      notSuitableFor: ['Người cần kết luận từ thử nghiệm sử dụng trực tiếp.'],
      keyFacts: [factTitle, factPrice],
      strengths: [claim('strength-1', 'Giá quan sát có timestamp và nguồn dữ liệu cụ thể.', 'price')],
      limitations: [claim('limitation-1', 'Chưa có bằng chứng thử nghiệm sử dụng trực tiếp.', 'title')],
      buyingConsiderations: ['Kiểm tra lại giá, tồn kho và điều kiện giao dịch tại nhà bán trước khi thanh toán.'],
      factualClaims: [claim('fact-1', 'Tên sản phẩm được ghi nhận từ dữ liệu nguồn.', 'title')],
      inferredClaims: [], unknownClaims: [],
      evidenceSources: [
        { name: 'merchant_api', fields: ['title', 'price'], checkedAt: now },
        { name: 'sandeal_health_probe', fields: ['originalUrl', 'affiliateUrl', 'imageUrl'], checkedAt: now },
      ],
      sourceConfidence: 'high', dataQualityScore: 95, productSafetyScore: 95,
      contentQualityScore: 95, originalityScore: 95, seoReadinessScore: 95, editorialConfidence: 95,
      reviewBlockReasons: [], reviewedAt: now, contentUpdatedAt: now, sourceHash, reviewContentHash: 'review-hash-current',
    },
    ...overrides,
  });
}

function jobRequest(idempotencyKey, productId = 'scan-product') {
  return new NextRequest('http://localhost/api/automation/jobs', {
    method: 'POST', headers,
    body: JSON.stringify({
      type: 'RECHECK_PRODUCT_HEALTH',
      payload: { productIds: [productId], limit: 10, healthTarget: 'all', trigger: 'test' },
      idempotencyKey, dryRun: false,
    }),
  });
}

(async () => {
  await test('API enqueue → durable queue → worker → persistence → terminal counters', async () => {
    await reset();
    await adapter.writeCollection('products', [scanProduct()]);
    const response = await jobsRoute.POST(jobRequest('health-e2e-1'));
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.data.status, 'PENDING');
    const jobId = body.data.id;
    const duplicateResponse = await jobsRoute.POST(jobRequest('health-e2e-overlapping'));
    const duplicateBody = await duplicateResponse.json();
    assert.equal(duplicateBody.code, 'REUSED_ACTIVE_JOB');
    assert.equal(duplicateBody.data.id, jobId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tempDir, 'automation-jobs.json'), 'utf8')).length, 1);

    const run = await worker.processAutomationBatch('hardening-worker', 1);
    assert.deepEqual({ claimed: run.claimed, succeeded: run.succeeded, failed: run.failed }, { claimed: 1, succeeded: 1, failed: 0 });
    const terminal = await store.getAutomationJob(jobId);
    assert.equal(terminal.status, 'SUCCEEDED');
    assert.equal(terminal.result.total, 1);
    assert.equal(terminal.result.processed, 1);
    assert.equal(terminal.result.healthy, 0);
    assert.equal(terminal.result.unhealthy, 1);
    assert.equal(terminal.result.quarantined, 0);
    assert.equal(terminal.result.unchanged, 0);
    assert.equal(terminal.result.skipped, 0);
    assert.equal(terminal.result.failed, 0);
    assert.ok(Number.isFinite(terminal.result.durationMs));
    const stored = await products.getProductById('scan-product');
    assert.equal(stored.linkHealthStatus, 'error');
    assert.equal(stored.affiliateHealthStatus, 'error');
    assert.equal(stored.imageHealthStatus, 'error');
    assert.equal(stored.publicHidden, true);
    assert.equal(stored.publicBlocked, true);
    assert.ok(stored.publicBlockReasons.includes('missing_affiliate_url'));
    const transitions = (await adapter.readCollection('automation-audit')).filter(item => item.jobId === jobId).map(item => item.nextState);
    assert.ok(transitions.includes('PENDING'));
    assert.ok(transitions.includes('RUNNING'));
    assert.ok(transitions.includes('SUCCEEDED'));
  });

  await test('persistence lỗi không thể kết thúc SUCCEEDED giả và giữ counters thật', async () => {
    await reset();
    await adapter.writeCollection('products', [scanProduct()]);
    const created = await store.createAutomationJob({
      type: 'RECHECK_PRODUCT_HEALTH', payload: { productIds: ['scan-product'], healthTarget: 'all' },
      idempotencyKey: 'health-persistence-failure', requestedBy: 'hardening-test', riskLevel: 'MEDIUM', dryRun: false,
    });
    const records = await adapter.readCollection('automation-jobs');
    records[0].attemptCount = records[0].maxAttempts - 1;
    await adapter.writeCollection('automation-jobs', records);
    const originalSave = products.saveCanonicalProduct;
    products.saveCanonicalProduct = async () => null;
    try {
      const run = await worker.processAutomationBatch('persistence-failure-worker', 1);
      assert.equal(run.failed, 1);
    } finally {
      products.saveCanonicalProduct = originalSave;
    }
    const terminal = await store.getAutomationJob(created.job.id);
    assert.equal(terminal.status, 'FAILED');
    assert.equal(terminal.lastErrorCode, 'STORAGE_ERROR');
    assert.equal(terminal.retryable, false);
    assert.equal(terminal.result.total, 1);
    assert.equal(terminal.result.processed, 0);
    assert.equal(terminal.result.failed, 1);
    assert.equal(terminal.result.persistenceErrors.length, 1);
    const unchanged = await products.getProductById('scan-product');
    assert.equal(unchanged.publicBlocked, false);
  });

  await test('một eligibility engine cấp cùng operational truth cho publish, dashboard và detail', () => {
    const product = approvedProduct();
    const canonical = eligibility.evaluateProductEligibility(product);
    assert.equal(canonical.criticalBlockers.length, 0);
    assert.equal(canonical.eligibleForReview, true);
    assert.equal(canonical.eligibleForCanary, true);
    assert.equal(canonical.eligibleForPublish, true);
    assert.equal(canonical.eligibleForPublic, false);
    assert.equal(safePublish.evaluateSafePublish(product).eligible, canonical.eligibleForPublish);
    assert.equal(dashboardProducts.toDashboardProductItem(product).safePublishStatus, 'qualified');
    const detail = pipelineTruth.buildProductPipelineTruth({ product, jobs: [], actions: [], launchEnabled: false, effectiveMode: 'OBSERVE', now: Date.now() });
    assert.deepEqual(detail.eligibility.criticalBlockers, canonical.criticalBlockers);
    const published = safePublish.applySafePublishDecision(product);
    assert.equal(publicFilter.isPublicSafeProduct(published), true);
    assert.equal(eligibility.evaluateProductEligibility(published).eligibleForPublic, true);
  });

  await test('quarantine 30shinestore là mềm, chính xác merchant và khóa Safe Publish', () => {
    const quarantined = approvedProduct({ originalUrl: 'https://30shinestore.com/products/x200' });
    const decision = eligibility.evaluateProductEligibility(quarantined);
    assert.ok(decision.criticalBlockers.includes('merchant_quarantined_30shinestore'));
    assert.equal(safePublish.evaluateSafePublish(quarantined).eligible, false);
    const unrelated = eligibility.evaluateProductEligibility(approvedProduct({ originalUrl: 'https://30shine-example.com/products/x200' }));
    assert.equal(unrelated.criticalBlockers.includes('merchant_quarantined_30shinestore'), false);
  });

  await test('health stale và URL affiliate thiếu đều fail-closed độc lập', () => {
    const staleAt = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const stale = eligibility.evaluateProductEligibility(approvedProduct({ linkLastCheckedAt: staleAt }));
    assert.ok(stale.criticalBlockers.includes('product_health_stale'));
    const missingAffiliate = eligibility.evaluateProductEligibility(approvedProduct({
      affiliateUrl: undefined, affiliateHealthStatus: 'unknown', affiliateLastCheckedAt: undefined,
    }));
    assert.equal(missingAffiliate.criticalBlockers.includes('product_url_unhealthy'), false);
    assert.ok(missingAffiliate.criticalBlockers.includes('missing_affiliate_url'));
    assert.equal(missingAffiliate.eligibleForPublish, false);
  });

  await test('Review Quality deterministic chặn nội dung mỏng, claim thiếu nguồn và disclosure thiếu', () => {
    const valid = reviewQuality.evaluateReviewQuality(approvedProduct());
    assert.equal(valid.criticalIssues.length, 0);
    assert.ok(valid.qualityScore >= 75);
    const product = approvedProduct();
    product.reviewContent = {
      ...product.reviewContent,
      reviewSummary: 'Quá ngắn.', reviewVerdict: 'Thiếu dữ liệu.', reviewDisclosure: '',
      factualClaims: [{ ...product.reviewContent.factualClaims[0], evidenceFactIds: [] }],
    };
    const invalid = reviewQuality.evaluateReviewQuality(product);
    assert.ok(invalid.criticalIssues.includes('review_thin_content'));
    assert.ok(invalid.criticalIssues.includes('unsupported_claims'));
    assert.ok(invalid.criticalIssues.includes('affiliate_disclosure_missing'));
    assert.equal(invalid.reviewPolicyVersion, 'review-quality-v1');
  });

  await test('release identity dùng Git SHA nhúng, không dùng Next BUILD_ID làm commit', () => {
    const before = { build: process.env.SANDEAL_BUILD_COMMIT, runtime: process.env.SANDEAL_RELEASE_ID, git: process.env.GIT_COMMIT_SHA, public: process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID };
    const built = 'a'.repeat(40); const runtime = 'b'.repeat(40);
    try {
      process.env.SANDEAL_BUILD_COMMIT = built;
      process.env.SANDEAL_RELEASE_ID = built;
      delete process.env.GIT_COMMIT_SHA;
      process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = built;
      const matching = releaseIdentity.getReleaseIdentity();
      assert.equal(matching.commitSha, built);
      assert.equal(matching.releaseMismatch, false);
      process.env.SANDEAL_RELEASE_ID = runtime;
      const mismatched = releaseIdentity.getReleaseIdentity();
      assert.equal(mismatched.buildId, built);
      assert.equal(mismatched.runtimeReleaseId, runtime);
      assert.equal(mismatched.releaseMismatch, true);
    } finally {
      const restore = (key, value) => value === undefined ? delete process.env[key] : process.env[key] = value;
      restore('SANDEAL_BUILD_COMMIT', before.build); restore('SANDEAL_RELEASE_ID', before.runtime);
      restore('GIT_COMMIT_SHA', before.git); restore('NEXT_PUBLIC_SANDEAL_RELEASE_ID', before.public);
    }
    const identitySource = fs.readFileSync(path.join(root, 'src/lib/releaseIdentity.ts'), 'utf8');
    const nextConfig = fs.readFileSync(path.join(root, 'next.config.ts'), 'utf8');
    const manifest = fs.readFileSync(path.join(root, 'scripts/release-manifest.cjs'), 'utf8');
    assert.doesNotMatch(identitySource, /BUILD_ID/);
    assert.doesNotMatch(nextConfig, /generateBuildId/);
    assert.match(manifest, /manifest\.releaseId !== manifest\.commitSha/);
    assert.doesNotMatch(manifest, /manifest\.buildId !== manifest\.commitSha/);
  });

  await test('PM2 truyền cùng release cho web/worker/scheduler và chặn env rollback lệch checkout', () => {
    const previousOptIn = process.env.SANDEAL_ENABLE_PROMPT10_RUNTIME;
    const previousRelease = process.env.SANDEAL_RELEASE_ID;
    try {
      process.env.SANDEAL_ENABLE_PROMPT10_RUNTIME = 'true';
      delete process.env.SANDEAL_RELEASE_ID;
      delete require.cache[require.resolve('../ecosystem.config.cjs')];
      const ecosystem = require('../ecosystem.config.cjs');
      assert.deepEqual(ecosystem.apps.map(app => app.name), ['sandeal', 'sandeal-worker', 'sandeal-scheduler']);
      const ids = new Set(ecosystem.apps.map(app => app.env.SANDEAL_RELEASE_ID));
      assert.equal(ids.size, 1);
      for (const app of ecosystem.apps) {
        assert.equal(app.env.SANDEAL_BUILD_COMMIT, app.env.SANDEAL_RELEASE_ID);
        assert.equal(app.env.GIT_COMMIT_SHA, app.env.SANDEAL_RELEASE_ID);
      }
    } finally {
      if (previousOptIn === undefined) delete process.env.SANDEAL_ENABLE_PROMPT10_RUNTIME; else process.env.SANDEAL_ENABLE_PROMPT10_RUNTIME = previousOptIn;
      if (previousRelease === undefined) delete process.env.SANDEAL_RELEASE_ID; else process.env.SANDEAL_RELEASE_ID = previousRelease;
    }
    const mismatch = spawnSync(process.execPath, ['-e', "require('./ecosystem.config.cjs')"], {
      cwd: root, encoding: 'utf8', env: { ...process.env, SANDEAL_RELEASE_ID: 'f'.repeat(40) },
    });
    assert.notEqual(mismatch.status, 0);
    assert.match(`${mismatch.stderr}${mismatch.stdout}`, /does not match the checked-out Git commit/);
  });

  await test('metadata/icon/social preview đồng bộ và blocked product dùng fallback SanDeal', () => {
    assert.equal(fs.existsSync(path.join(root, 'src/app/favicon.ico')), false);
    for (const file of ['src/app/icon.tsx', 'src/app/apple-icon.tsx', 'src/app/opengraph-image.tsx', 'src/app/manifest.ts', 'src/app/deals/[slug]/opengraph-image.tsx']) assert.ok(fs.existsSync(path.join(root, file)), file);
    const layout = fs.readFileSync(path.join(root, 'src/app/layout.tsx'), 'utf8');
    const manifest = fs.readFileSync(path.join(root, 'src/app/manifest.ts'), 'utf8');
    const productSeo = fs.readFileSync(path.join(root, 'src/lib/seo/productSeo.ts'), 'utf8');
    const dynamicPreview = fs.readFileSync(path.join(root, 'src/app/deals/[slug]/opengraph-image.tsx'), 'utf8');
    assert.match(layout, /siteName: 'SanDeal'/);
    assert.match(layout, /summary_large_image/);
    assert.match(layout, /locale: 'vi_VN'/);
    assert.match(manifest, /name: 'SanDeal'/);
    assert.match(manifest, /512-maskable\.png/);
    assert.match(productSeo, /indexing\.indexable \? `\$\{canonical\}\/opengraph-image` : new URL\('\/opengraph-image'/);
    assert.match(dynamicPreview, /getPublicProductBySlugSafe/);
    assert.doesNotMatch(dynamicPreview, /imageUrl/);
  });

  await test('UI poll đúng job, refresh terminal records và không dùng stale cache', () => {
    const polling = fs.readFileSync(path.join(root, 'src/lib/dashboard/scanPolling.ts'), 'utf8');
    const sources = fs.readFileSync(path.join(root, 'src/app/dashboard/product-sources/page.tsx'), 'utf8');
    const list = fs.readFileSync(path.join(root, 'src/app/dashboard/products/products-dashboard.tsx'), 'utf8');
    assert.match(polling, /encodeURIComponent\(options\.jobId\)/);
    assert.match(polling, /cache: 'no-store'/);
    const terminalPoll = sources.indexOf('const job = await pollScanJob({');
    assert.ok(terminalPoll >= 0 && sources.indexOf('await loadRecent();', terminalPoll) > terminalPoll);
    assert.match(sources, /fetch\('\/api\/products\?limit=10', \{ cache: 'no-store' \}\)/);
    assert.match(list, /if \(\['completed', 'failed', 'cancelled', 'blocked'\]\.includes\(next\.status\)\) \{\s*refresh\(\)/s);
  });

  await test('dashboard/home/product detail dùng operational truth và bố cục responsive', () => {
    const dashboard = fs.readFileSync(path.join(root, 'src/app/dashboard/page.tsx'), 'utf8');
    const dashboardCss = fs.readFileSync(path.join(root, 'src/app/dashboard/dashboard.module.css'), 'utf8');
    const home = fs.readFileSync(path.join(root, 'src/components/public/HomepageSections.tsx'), 'utf8');
    const publicCss = fs.readFileSync(path.join(root, 'src/components/public/public.module.css'), 'utf8');
    const detail = fs.readFileSync(path.join(root, 'src/app/dashboard/products/[id]/page.tsx'), 'utf8');
    assert.match(dashboard, /Product Health Scanner/);
    assert.match(dashboard, /inlineConfirm/);
    assert.doesNotMatch(dashboard, /modalBackdrop/);
    assert.match(dashboardCss, /@media \(max-width: 600px\)/);
    assert.match(home, /Kiểm tra giá và độ tin cậy trước khi mua/);
    assert.match(publicCss, /min\(430px, 52svh\)/);
    assert.match(detail, /pipelineTruth\.health\.productLink/);
    assert.match(detail, /pipelineTruth\.health\.affiliateLink/);
    assert.match(detail, /affiliateUrlFinalDomain/);
  });

  console.log(`\nSanDeal end-to-end hardening: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(error => { console.error(error); process.exit(1); });
