/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const testRoot = path.join(root, '.test-tmp', `master-m4-intelligence-${process.pid}-${Date.now()}`);
const dataDir = path.join(testRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = dataDir;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.NODE_ENV = 'test';
require('./register-typescript.cjs');

const extraction = require('../src/lib/product-intelligence/deterministicExtraction.ts');
const registry = require('../src/lib/automation/providerRegistry.ts');
const fallback = require('../src/lib/automation/providerFallback.ts');
const contracts = require('../src/lib/ai/canonicalDataContract.ts');
const { LocalAiAdapter, evaluateLocalAiBenchmark } = require('../src/lib/ai/localAiAdapter.ts');
const alerting = require('../src/lib/automation/operatorAlerting.ts');
const storage = require('../src/lib/storage/adapter.ts');
const categorization = require('../src/lib/product-intelligence/smartCategorization.ts');
const golden = require('./fixtures/master-m4-vietnamese-category-golden.json');

let passed = 0;
let failed = 0;

async function test(name, work) {
  try {
    await work();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error instanceof Error ? error.stack : error}`);
  }
}

function canonicalPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    contractVersion: 'ai-canonical-proposal-v1',
    providerId: 'local-ai',
    modelId: 'isolated-fixture',
    promptVersion: 'm4-fixture-v1',
    inputHash: 'a'.repeat(64),
    evidenceFactIds: ['fact:one'],
    confidence: 0.95,
    suggestions: {
      title: 'Sản phẩm đã được chuẩn hóa',
      description: 'Mô tả kiểm thử đủ dài, chỉ dựa trên bằng chứng đã biết và không tạo dữ kiện giá hoặc liên kết mới.',
      category: 'dien-tu-cong-nghe',
    },
    generatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function editorialPayload(overrides = {}) {
  return {
    reviewTitle: 'Đánh giá dựa trên bằng chứng đã kiểm tra',
    reviewSummary: 'Nội dung đánh giá kiểm thử này đủ dài và chỉ mô tả những thông tin đã được liên kết tới bằng chứng xác định trong hồ sơ sản phẩm.',
    reviewVerdict: 'Cần đối chiếu nhu cầu trước khi quyết định.',
    suitableFor: ['Người cần tính năng đã được xác minh'],
    notSuitableFor: ['Người cần dữ kiện hiện chưa có'],
    buyingConsiderations: ['Kiểm tra lại giá và điều kiện tại trang bán'],
    factualClaims: [{
      id: 'claim:factual:one',
      text: 'Sản phẩm có dữ kiện đã xác minh.',
      claimType: 'factual',
      evidenceFactIds: ['fact:one'],
      confidence: 'high',
    }],
    inferredClaims: [],
    unknownClaims: [],
    ...overrides,
  };
}

function localResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function run() {
  await test('Deterministic extraction handles attribute order, JSON-LD graphs, entities, and provenance', async () => {
    const html = `<!doctype html>
      <html><head>
        <meta content="Tiêu đề OG &amp; an toàn" property="og:title">
        <meta content="/og.jpg" property="og:image">
        <link href="/canonical-item" rel="alternate canonical">
        <script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@graph': [{
            '@type': ['Thing', 'Product'],
            name: 'Điện thoại từ JSON-LD',
            description: 'Mô tả có &amp; thực thể HTML',
            image: [{ contentUrl: '/primary.jpg' }],
            brand: { name: 'Fixture Brand' },
            sku: 'SKU-01',
            category: 'Điện tử',
            offers: { price: '1299000', priceCurrency: 'vnd', url: '/buy' },
          }],
        })}</script>
      </head><body>PRIVATE_SENTINEL_NOT_FOR_OUTPUT</body></html>`;
    const result = extraction.extractDeterministicProductData(
      html,
      'https://merchant.example/products/one',
      Date.UTC(2026, 0, 1),
    );
    assert.equal(result.title.value, 'Điện thoại từ JSON-LD');
    assert.equal(result.title.provenance.source, 'JSON_LD_PRODUCT');
    assert.equal(result.title.provenance.sourceUrl, 'https://merchant.example/products/one');
    assert.match(result.title.provenance.valueHash, /^[a-f0-9]{64}$/);
    assert.equal(result.description.value, 'Mô tả có & thực thể HTML');
    assert.equal(result.price.value, 1299000);
    assert.equal(result.currency.value, 'VND');
    assert.equal(result.images[0].value, 'https://merchant.example/primary.jpg');
    assert.equal(result.canonicalUrl.value, 'https://merchant.example/buy');
    assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL_NOT_FOR_OUTPUT'), false);
    assert.deepEqual(result.warnings, []);
  });

  await test('Extraction is bounded, rejects unsafe sources, and reports malformed or excessive JSON-LD', async () => {
    assert.throws(
      () => extraction.extractDeterministicProductData('x'.repeat(512 * 1024 + 1), 'https://merchant.example/item'),
      /HTML_TOO_LARGE/,
    );
    assert.throws(
      () => extraction.extractDeterministicProductData('<title>x</title>', 'http://127.0.0.1:8080/private'),
      /SOURCE_URL_INVALID/,
    );
    const scripts = Array.from({ length: 17 }, () => (
      '<script type="application/ld+json">{invalid}</script>'
    )).join('');
    const result = extraction.extractDeterministicProductData(
      `${scripts}<meta property="og:title" content="Safe fallback title">`,
      'https://merchant.example/item',
    );
    assert.equal(result.title.value, 'Safe fallback title');
    assert.ok(result.warnings.includes('JSON_LD_INVALID'));
    assert.ok(result.warnings.includes('JSON_LD_SCRIPT_LIMIT_REACHED'));
  });

  await test('Image resolver is wired to the single bounded deterministic page extractor', async () => {
    const source = fs.readFileSync(path.join(root, 'src/lib/bots/imageResolver.ts'), 'utf8');
    assert.match(source, /extractDeterministicProductData/);
    assert.match(source, /maxBytes:\s*512 \* 1024/);
    assert.equal((source.match(/fetchExternalSafely\(/g) || []).length, 1);
    assert.doesNotMatch(source, /extractOpenGraphImage|extractJsonLdImage/);
  });

  await test('Provider registry declares transport, cost, concurrency, response, retry, and capability policy', async () => {
    const providers = registry.listProviderDeclarations();
    assert.deepEqual(providers.map(item => item.id), ['deterministic-rules', 'gemini', 'local-ai']);
    assert.equal(providers.every(item => item.freeOnly), true);
    assert.equal(providers.every(item => item.maximumConcurrency >= 1 && item.maximumConcurrency <= 4), true);
    assert.equal(providers.every(item => item.responseLimitBytes <= 512 * 1024), true);
    assert.equal(registry.getProviderDeclaration('local-ai').transport, 'LOOPBACK_HTTP');
    assert.equal(registry.getProviderDeclaration('local-ai').separateProcess, true);
    assert.equal(registry.getProviderDeclaration('gemini').featureFlag, 'AI_CLOUD_FALLBACK');
    providers[0].capabilities.length = 0;
    assert.ok(registry.getProviderDeclaration('deterministic-rules').capabilities.length > 0);
  });

  await test('Cloud and local fallbacks default OFF and cannot call injected transports', async () => {
    let calls = 0;
    const result = await fallback.executeBoundedProviderFallback({
      capability: 'EDITORIAL_REVIEW',
      input: { fixture: true },
      providerOrder: ['local-ai', 'gemini'],
      adapters: [
        { id: 'local-ai', execute: async () => { calls += 1; return {}; } },
        { id: 'gemini', execute: async () => { calls += 1; return {}; } },
      ],
      validateOutput: value => value,
      environment: {},
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
    assert.deepEqual(result.attempts.map(item => item.failureCode), ['FEATURE_DISABLED', 'FEATURE_DISABLED']);
  });

  await test('Fallback retries only declared transient failures within a bounded provider chain', async () => {
    let calls = 0;
    const sleeps = [];
    const result = await fallback.executeBoundedProviderFallback({
      capability: 'EDITORIAL_REVIEW',
      input: { fixture: true },
      providerOrder: ['gemini'],
      adapters: [{
        id: 'gemini',
        execute: async () => {
          calls += 1;
          if (calls === 1) throw new Error('network unavailable');
          return { valid: true };
        },
      }],
      validateOutput: value => {
        assert.deepEqual(value, { valid: true });
        return value;
      },
      environment: { AI_CLOUD_FALLBACK: 'ACTIVE' },
      sleep: async ms => { sleeps.push(ms); },
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [1000]);
    assert.deepEqual(result.attempts.map(item => item.status), ['FAILED', 'SUCCEEDED']);
    assert.equal(JSON.stringify(result.attempts).includes('fixture'), false);
  });

  await test('Terminal provider failures do not retry and ignored abort still settles at deadline', async () => {
    let terminalCalls = 0;
    const terminal = await fallback.executeBoundedProviderFallback({
      capability: 'EDITORIAL_REVIEW',
      input: {},
      providerOrder: ['gemini'],
      adapters: [{
        id: 'gemini',
        execute: async () => {
          terminalCalls += 1;
          throw new Error('schema validation failed');
        },
      }],
      validateOutput: value => value,
      environment: { AI_CLOUD_FALLBACK: 'ACTIVE' },
    });
    assert.equal(terminalCalls, 1);
    assert.equal(terminal.finalFailureCode, 'SCHEMA_VALIDATION_FAILED');

    const started = Date.now();
    const timedOut = await fallback.executeBoundedProviderFallback({
      capability: 'EDITORIAL_REVIEW',
      input: {},
      providerOrder: ['gemini'],
      adapters: [{ id: 'gemini', execute: async () => new Promise(() => {}) }],
      validateOutput: value => value,
      environment: { AI_CLOUD_FALLBACK: 'ACTIVE' },
      deadlineMs: 15,
    });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.finalFailureCode, 'TIMEOUT');
    assert.ok(Date.now() - started < 500);
  });

  await test('Strict canonical AI contract rejects unknown fields and unknown evidence before writes', async () => {
    const allowed = new Set(['fact:one']);
    const parsed = contracts.parseAiCanonicalProposal(canonicalPayload(), allowed);
    assert.match(parsed.outputHash, /^[a-f0-9]{64}$/);
    assert.throws(
      () => contracts.parseAiCanonicalProposal(canonicalPayload({
        suggestions: { category: 'x', price: 1 },
      }), allowed),
      /SUGGESTIONS_INVALID/,
    );
    assert.throws(
      () => contracts.parseAiCanonicalProposal(canonicalPayload({
        evidenceFactIds: ['fact:unknown'],
      }), allowed),
      /EVIDENCE_INVALID/,
    );
    assert.throws(
      () => contracts.canonicalPatchFromAiProposal(parsed),
      /WRITE_SCOPE_EMPTY/,
    );
    assert.deepEqual(
      contracts.canonicalPatchFromAiProposal(parsed, { allowCategory: true }),
      { category: 'dien-tu-cong-nghe' },
    );
  });

  await test('Strict editorial contract requires evidence for factual claims and exact keys', async () => {
    const allowed = new Set(['fact:one']);
    const parsed = contracts.parseStrictEditorialProposal(editorialPayload(), allowed);
    assert.equal(parsed.factualClaims[0].evidenceFactIds[0], 'fact:one');
    assert.throws(
      () => contracts.parseStrictEditorialProposal(editorialPayload({
        factualClaims: [{
          id: 'claim:factual:one',
          text: 'Tuyên bố không có bằng chứng.',
          claimType: 'factual',
          evidenceFactIds: [],
          confidence: 'high',
        }],
      }), allowed),
      /FACT_EVIDENCE_REQUIRED/,
    );
    assert.throws(
      () => contracts.parseStrictEditorialProposal({ ...editorialPayload(), affiliateUrl: 'https://unsafe.example' }, allowed),
      /ROOT_INVALID/,
    );
  });

  await test('Local AI adapter is feature-off, loopback-only, and resource-gated without transport calls', async () => {
    let calls = 0;
    const off = new LocalAiAdapter({
      baseUrl: 'http://127.0.0.1:11434',
      environment: {},
      fetchImpl: async () => { calls += 1; return localResponse({}); },
    });
    assert.equal((await off.readiness()).reasonCode, 'FEATURE_DISABLED');
    const remote = new LocalAiAdapter({
      baseUrl: 'https://remote.example:443',
      environment: { AI_LOCAL_FALLBACK: 'ACTIVE' },
      fetchImpl: async () => { calls += 1; return localResponse({}); },
      resourceSnapshot: () => ({ freeMemoryBytes: 2 ** 31, eventLoopDelayMs: 1 }),
    });
    assert.equal((await remote.readiness()).reasonCode, 'CONFIGURATION_INVALID');
    const blocked = new LocalAiAdapter({
      baseUrl: 'http://localhost:11434',
      environment: { AI_LOCAL_FALLBACK: 'ACTIVE' },
      fetchImpl: async () => { calls += 1; return localResponse({}); },
      resourceSnapshot: () => ({ freeMemoryBytes: 1, eventLoopDelayMs: 1_000 }),
    });
    assert.equal((await blocked.readiness()).reasonCode, 'RESOURCE_GATE_BLOCKED');
    assert.equal(calls, 0);
  });

  await test('Local AI adapter validates health and generation contracts through injected loopback transport', async () => {
    const paths = [];
    const adapter = new LocalAiAdapter({
      baseUrl: 'http://localhost:11434',
      environment: { AI_LOCAL_FALLBACK: 'ACTIVE' },
      resourceSnapshot: () => ({ freeMemoryBytes: 2 ** 31, eventLoopDelayMs: 5 }),
      fetchImpl: async url => {
        paths.push(String(url));
        return String(url).endsWith('/v1/health')
          ? localResponse({ ready: true, contractVersion: 'ai-canonical-proposal-v1' })
          : localResponse(canonicalPayload());
      },
    });
    assert.equal((await adapter.readiness()).reasonCode, 'READY');
    const proposal = await adapter.generateCanonicalProposal(
      { evidenceFactIds: ['fact:one'] },
      new Set(['fact:one']),
    );
    assert.equal(proposal.providerId, 'local-ai');
    assert.equal(paths.filter(item => item.endsWith('/v1/health')).length, 2);
    assert.equal(paths.filter(item => item.endsWith('/v1/generate')).length, 1);
  });

  await test('Local AI adapter enforces concurrency and queue bounds', async () => {
    let releaseFirst;
    let generationCalls = 0;
    const adapter = new LocalAiAdapter({
      baseUrl: 'http://localhost:11434',
      environment: { AI_LOCAL_FALLBACK: 'ACTIVE' },
      maximumConcurrency: 1,
      maximumQueueDepth: 0,
      resourceSnapshot: () => ({ freeMemoryBytes: 2 ** 31, eventLoopDelayMs: 5 }),
      fetchImpl: async url => {
        if (String(url).endsWith('/v1/health')) {
          return localResponse({ ready: true, contractVersion: 'ai-canonical-proposal-v1' });
        }
        generationCalls += 1;
        if (generationCalls === 1) {
          return new Promise(resolve => {
            releaseFirst = () => resolve(localResponse(canonicalPayload()));
          });
        }
        return localResponse(canonicalPayload());
      },
    });
    const first = adapter.generateCanonicalProposal({}, new Set(['fact:one']));
    while (generationCalls === 0) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(
      adapter.generateCanonicalProposal({}, new Set(['fact:one'])),
      /LOCAL_AI_QUEUE_FULL/,
    );
    releaseFirst();
    await first;
    assert.equal(generationCalls, 1);
  });

  await test('Local AI benchmark enforces success, latency, process-resource, and Guardian pickup gates', async () => {
    const good = Array.from({ length: 20 }, (_, index) => ({
      ok: true,
      responseMs: 100 + index,
      eventLoopDelayMs: 10,
      rssDeltaBytes: 10 * 1024 * 1024,
      guardianPickupMs: 5_000,
    }));
    assert.equal(evaluateLocalAiBenchmark(good).eligible, true);
    const bad = good.slice(0, 19);
    bad[0] = {
      ok: false,
      responseMs: 6_000,
      eventLoopDelayMs: 101,
      rssDeltaBytes: 513 * 1024 * 1024,
      guardianPickupMs: 30_000,
    };
    const result = evaluateLocalAiBenchmark(bad);
    assert.equal(result.eligible, false);
    assert.ok(result.reasonCodes.includes('INSUFFICIENT_SAMPLE_SIZE'));
    assert.ok(result.reasonCodes.includes('GUARDIAN_PICKUP_ABOVE_GATE'));
  });

  await test('Operator alerting defaults OFF and performs no external delivery', async () => {
    let calls = 0;
    const result = await alerting.dispatchOperatorAlert({
      eventType: 'health.transition',
      entityType: 'system',
      entityId: 'fixture-system',
      transitionId: 'transition-1',
      severity: 'IMPORTANT',
      title: 'Fixture transition',
      message: 'No transport should run while the feature remains off.',
      occurredAt: '2026-01-01T00:00:00.000Z',
    }, [{ id: 'fixture', deliver: async () => { calls += 1; return {}; } }], {});
    assert.equal(result.status, 'SUPPRESSED');
    assert.equal(calls, 0);
  });

  await test('Operator alert delivery is durable, deduplicated, and stores only hashed sensitive identifiers', async () => {
    await storage.writeCollection('operator-alert-deliveries', []);
    let calls = 0;
    const input = {
      eventType: 'health.transition',
      entityType: 'product',
      entityId: 'operator-private-product-id',
      transitionId: 'transition-stable-1',
      severity: 'CRITICAL',
      title: 'A verified transition needs attention',
      message: 'Fixture delivery through an injected adapter only.',
      occurredAt: '2026-01-01T00:00:00.000Z',
      metadata: { reasonCode: 'FIXTURE' },
    };
    const adapter = {
      id: 'fixture-adapter',
      deliver: async alert => {
        calls += 1;
        assert.equal(alert.entityId, input.entityId);
        return { receiptId: 'operator-private-receipt' };
      },
    };
    const first = await alerting.dispatchOperatorAlert(input, [adapter], { OPERATOR_ALERTING: 'ACTIVE' });
    const second = await alerting.dispatchOperatorAlert(input, [adapter], { OPERATOR_ALERTING: 'ACTIVE' });
    assert.equal(first.status, 'DELIVERED');
    assert.equal(second.status, 'DUPLICATE');
    assert.equal(calls, 1);
    const records = await storage.readCollection('operator-alert-deliveries');
    assert.equal(records.length, 1);
    assert.match(records[0].entityHash, /^[a-f0-9]{64}$/);
    assert.match(records[0].receiptHash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(records).includes(input.entityId), false);
    assert.equal(JSON.stringify(records).includes('operator-private-receipt'), false);
  });

  await test('Smart categorization is accent-stable, evidence-based, deterministic, and shadow-safe', async () => {
    assert.equal(
      categorization.normalizeVietnameseCategoryText('ĐiỆn thoại – Chính hãng'),
      'dien thoai chinh hang',
    );
    const first = categorization.categorizeVietnameseProduct({
      title: 'Điện thoại smartphone 5G',
      tags: ['điện thoại'],
    }, Date.UTC(2026, 0, 1));
    const second = categorization.categorizeVietnameseProduct({
      title: 'Điện thoại smartphone 5G',
      tags: ['điện thoại'],
    }, Date.UTC(2026, 0, 1));
    assert.deepEqual(first, second);
    assert.equal(first.category, 'dien-tu-cong-nghe');
    assert.ok(first.evidence.length > 0);
    assert.match(first.inputHash, /^[a-f0-9]{64}$/);
    assert.equal(first.evidence.every(item => /^[a-f0-9]{64}$/.test(item.valueHash)), true);

    const product = {
      id: 'fixture',
      title: 'Điện thoại smartphone 5G',
      category: 'operator-owned-category',
      tags: ['điện thoại'],
    };
    const shadow = categorization.applySmartCategoryPolicy(product, {}, Date.UTC(2026, 0, 1));
    assert.equal(shadow.mode, 'SHADOW');
    assert.equal(shadow.applied, false);
    assert.equal(shadow.product.category, 'operator-owned-category');
    assert.equal(shadow.product.categorySuggestion.applied, false);
    const active = categorization.applySmartCategoryPolicy(
      product,
      { SMART_CATEGORIZATION_V2: 'ACTIVE' },
      Date.UTC(2026, 0, 1),
    );
    assert.equal(active.applied, true);
    assert.equal(active.product.category, 'dien-tu-cong-nghe');
  });

  await test('Vietnamese golden evaluator meets fixed coverage and accuracy gates', async () => {
    const result = categorization.evaluateSmartCategoryGoldenDataset(golden);
    assert.equal(result.total, 30);
    assert.equal(result.coverage, 1);
    assert.ok(result.accuracy >= 0.95, JSON.stringify(result.failures));
  });

  const evidence = {
    schemaVersion: 1,
    gate: 'master-m4-intelligence',
    passed,
    failed,
    total: passed + failed,
    isolatedDataDir: path.relative(root, dataDir).replaceAll('\\', '/'),
    externalNetworkCalls: 0,
    liveNotifications: 0,
    localRuntimeInstalls: 0,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(testRoot, 'results.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nM4 intelligence tests: ${passed} passed, ${failed} failed`);
  console.log(`Evidence: ${path.relative(root, path.join(testRoot, 'results.json'))}`);
  if (failed > 0) process.exitCode = 1;
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
