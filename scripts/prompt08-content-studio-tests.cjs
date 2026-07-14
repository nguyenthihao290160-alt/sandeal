/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandeal-content-studio-'));
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'content-test';
process.env.BASIC_AUTH_PASSWORD = 'local-only-password';
process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
process.env.ALLOW_PAID_AI = 'false';
process.env.ALLOW_PUBLISHING_API = 'false';

require('./register-typescript.cjs');

const { NextRequest } = require('next/server');
const adapter = require('../src/lib/storage/adapter.ts');
const products = require('../src/lib/storage/products.ts');
const content = require('../src/lib/product-intelligence/contentStudio.ts');
const contentRoute = require('../src/app/api/dashboard/content/route.ts');

const now = new Date().toISOString();
const auth = `Basic ${Buffer.from('content-test:local-only-password').toString('base64')}`;
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

function product(overrides = {}) {
  return {
    id: 'content-product', title: 'Tai nghe Bluetooth Example chính hãng', slug: 'tai-nghe-bluetooth-example',
    description: 'Dữ liệu sản phẩm do nguồn cung cấp và cần được kiểm chứng trước khi đăng.',
    kind: 'product', platform: 'website', source: 'manual',
    originalUrl: 'https://merchant.example/products/content-product', affiliateUrl: 'https://merchant.example/products/content-product?aff_id=sandeal',
    imageUrl: 'https://merchant.example/images/content-product.jpg', price: 1_500_000, salePrice: 1_200_000, currency: 'VND',
    category: 'Audio', brand: 'Example', sku: 'EX-CONTENT-1', specifications: { Connection: 'Bluetooth', Warranty: '12 months' },
    tags: ['audio'], benefits: [], warnings: [], riskLevel: 'low', status: 'needs_review',
    verifiedSource: true, sourceVerified: true, autoPublishEligible: true, publicHidden: true, needsVerification: true,
    linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok', linkLastCheckedAt: now,
    priceLastChangedAt: now, lastSeenAt: now, createdAt: now, updatedAt: now,
    ...overrides,
  };
}

function draftForGuard(overrides = {}) {
  const claimText = 'Kết nối Bluetooth được ghi nhận trong thông số nguồn.';
  return {
    id: 'guard-draft', productId: 'content-product', status: 'drafting',
    title: 'Đánh giá tai nghe Bluetooth Example từ dữ liệu nguồn',
    summary: 'Bài viết tổng hợp dữ liệu nguồn đã xác minh, phạm vi sử dụng, mức giá ghi nhận và các điểm người mua vẫn cần đối chiếu trước khi quyết định.',
    verdict: 'Sản phẩm phù hợp để cân nhắc khi các thông số nguồn đáp ứng nhu cầu và liên kết bán vẫn hoạt động.',
    strengths: [claimText], limitations: [], suitableFor: ['Người cần kết nối Bluetooth'], notSuitableFor: [], buyingNotes: ['Kiểm tra giá tại thời điểm mua.'],
    verifiedSpecifications: { Connection: 'Bluetooth', Warranty: '12 months' }, faq: [],
    metaTitle: 'Đánh giá tai nghe Bluetooth Example từ nguồn',
    metaDescription: 'SanDeal tổng hợp thông số, giá và nguồn kiểm chứng của tai nghe Bluetooth Example để người mua cân nhắc minh bạch trước khi truy cập nhà bán.',
    slug: 'danh-gia-tai-nghe-bluetooth-example',
    affiliateDisclosure: 'SanDeal có thể nhận hoa hồng khi người đọc mua qua liên kết tiếp thị liên kết.',
    claims: [{ id: 'human-claim', field: 'strengths', text: claimText, type: 'HUMAN_CONFIRMED', evidenceFactIds: [] }],
    createdBy: 'content-test', createdAt: now, updatedAt: now,
    ...overrides,
  };
}

async function reset() {
  for (const name of ['products', 'content-drafts', 'automation-audit']) await adapter.writeCollection(name, []);
}

(async () => {
  await test('local draft is idempotent, audited and cannot overwrite canonical specifications', async () => {
    await reset();
    const source = product();
    await adapter.writeCollection('products', [source]);
    const created = await content.createLocalContentDraft(source.id, 'content-test', 'content-create-1');
    const repeated = await content.createLocalContentDraft(source.id, 'content-test', 'content-create-2');
    assert.equal(repeated.id, created.id);
    const returned = await content.updateContentDraft(created.id, { verifiedSpecifications: { Connection: 'Unverified replacement' } }, { actor: 'content-test', operationId: 'content-update-1' });
    assert.deepEqual(returned.verifiedSpecifications, source.specifications);
    assert.deepEqual((await products.getProductById(source.id)).specifications, source.specifications);
    const stored = await content.getContentDraft(created.id);
    assert.deepEqual(stored.verifiedSpecifications, source.specifications);
    const audit = await adapter.readCollection('automation-audit');
    assert.equal(audit.some(event => event.operationType === 'CONTENT_DRAFT_CREATED'), true);
    assert.equal(audit.some(event => event.operationType === 'CONTENT_SOURCE_FACT_UPDATE_IGNORED'), true);
    assert.equal(JSON.stringify(audit).includes('Unverified replacement'), false);
  });

  await test('draft update validation rejects unknown fields, oversized lists and duplicate claim ids', async () => {
    assert.throws(() => content.validateContentDraftUpdates({ status: 'published' }), /INVALID_CONTENT_UPDATE_FIELD/);
    assert.throws(() => content.validateContentDraftUpdates({ strengths: Array.from({ length: 31 }, () => 'x') }), /INVALID_CONTENT_LIST/);
    const duplicate = { id: 'same-claim', field: 'summary', text: 'Fact', type: 'UNVERIFIED', evidenceFactIds: [] };
    assert.throws(() => content.validateContentDraftUpdates({ claims: [duplicate, duplicate] }), /DUPLICATE_CLAIM_ID/);
  });

  await test('Editorial Guard blocks HUMAN_CONFIRMED without valid evidence and source fact changes', () => {
    const source = product();
    const missingEvidence = content.runEditorialGuard(draftForGuard(), source);
    assert.equal(missingEvidence.status, 'BLOCKED');
    assert.equal(missingEvidence.issues.some(issue => issue.code === 'human_confirmation_without_evidence'), true);
    const validEvidence = content.runEditorialGuard(draftForGuard({ claims: [{ ...draftForGuard().claims[0], evidenceFactIds: ['spec_38b8e756'] }] }), source);
    assert.equal(validEvidence.issues.some(issue => issue.code === 'human_confirmation_without_evidence'), true, 'unknown evidence must remain blocked');
    const titleEvidence = content.runEditorialGuard(draftForGuard({ claims: [{ ...draftForGuard().claims[0], evidenceFactIds: ['title'] }] }), source);
    assert.equal(titleEvidence.issues.some(issue => issue.code === 'human_confirmation_without_evidence'), false);
    const modifiedFacts = content.runEditorialGuard(draftForGuard({ verifiedSpecifications: { Connection: 'Wi-Fi' } }), source);
    assert.equal(modifiedFacts.issues.some(issue => issue.code === 'source_fact_modified'), true);
  });

  await test('Editorial Guard requires claim classification for strengths and limitations', () => {
    const source = product();
    const result = content.runEditorialGuard(draftForGuard({ claims: [] }), source);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.issues.some(issue => issue.code === 'missing_claim_classification'), true);
  });

  await test('editorial check persists its result and writes sanitized audit', async () => {
    await reset();
    await adapter.writeCollection('products', [product()]);
    await adapter.writeCollection('content-drafts', [draftForGuard()]);
    const result = await content.editorialCheckDraft('guard-draft', { actor: 'content-test', operationId: 'content-check-1' });
    assert.equal(result.status, 'BLOCKED');
    const stored = await content.getContentDraft('guard-draft');
    assert.equal(stored.lastEditorialCheck.status, 'BLOCKED');
    const audit = await adapter.readCollection('automation-audit');
    const event = audit.find(item => item.operationId === 'content-check-1');
    assert.equal(event.operationType, 'CONTENT_EDITORIAL_CHECKED');
    assert.equal(event.result.status, 'BLOCKED');
  });

  await test('scheduled workflow does not publish and direct published transition is rejected', async () => {
    await reset();
    const source = product();
    const approvedDraft = draftForGuard({ status: 'approved' });
    await adapter.writeCollection('products', [source]);
    await adapter.writeCollection('content-drafts', [approvedDraft]);
    const scheduledAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const scheduled = await content.transitionContentDraft(approvedDraft.id, 'scheduled', { actor: 'content-test', operationId: 'content-schedule-1', scheduledAt });
    assert.equal(scheduled.draft.status, 'scheduled');
    assert.equal((await products.getProductById(source.id)).status, 'needs_review');
    await assert.rejects(() => content.transitionContentDraft(approvedDraft.id, 'published', { actor: 'content-test', operationId: 'content-publish-reject-1' }), /SAFE_PUBLISH_REQUIRED/);
    assert.equal((await content.getContentDraft(approvedDraft.id)).status, 'scheduled');
    const audit = await adapter.readCollection('automation-audit');
    assert.equal(audit.some(event => event.operationType === 'CONTENT_DIRECT_PUBLISH_REJECTED' && event.risk === 'BLOCKER'), true);
  });

  await test('Content API enforces auth, permission, size limit and Safe Publish boundary', async () => {
    const anonymous = await contentRoute.POST(new NextRequest('http://localhost/api/dashboard/content', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'check', draftId: 'guard-draft' }),
    }));
    assert.equal(anonymous.status, 401);

    process.env.SANDEAL_ADMIN_PERMISSIONS = 'MANAGE_CONTENT';
    const forbidden = await contentRoute.POST(new NextRequest('http://localhost/api/dashboard/content', {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'transition', draftId: 'guard-draft', status: 'approved' }),
    }));
    assert.equal(forbidden.status, 403);

    process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
    const oversized = await contentRoute.POST(new NextRequest('http://localhost/api/dashboard/content', {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'update', draftId: 'guard-draft', updates: { summary: 'x'.repeat(130 * 1024) } }),
    }));
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).code, 'REQUEST_TOO_LARGE');

    const directPublish = await contentRoute.POST(new NextRequest('http://localhost/api/dashboard/content', {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'transition', draftId: 'guard-draft', status: 'published' }),
    }));
    assert.equal(directPublish.status, 409);
    const body = await directPublish.json();
    assert.equal(body.code, 'SAFE_PUBLISH_REQUIRED');
    assert.equal(typeof body.operationId, 'string');
    assert.equal(directPublish.headers.get('x-operation-id'), body.operationId);
  });

  await test('Content dashboard returns canonical evidence without internal product object', async () => {
    const response = await contentRoute.GET(new NextRequest('http://localhost/api/dashboard/content', { headers: { authorization: auth } }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(Array.isArray(body.data.items), true);
    assert.equal(Array.isArray(body.data.items[0].evidenceFacts), true);
    assert.equal(Object.prototype.hasOwnProperty.call(body.data.items[0].product, 'affiliateUrl'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(body.data.items[0].product, 'rawPayload'), false);
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  if (failed) {
    console.error(`\nContent Studio: ${passed} passed, ${failed} failed`);
    process.exitCode = 1;
  } else {
    console.log(`\nContent Studio: ${passed} passed, 0 failed`);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
