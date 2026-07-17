/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt10-zero-touch-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = '';
process.env.ACCESS_TRADE_API_KEY = '';
process.env.ALLOW_PAID_AI = 'false';
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'prompt10-zero-touch';
process.env.BASIC_AUTH_PASSWORD = 'isolated-zero-touch-password';
process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
require('./register-typescript.cjs');

const auth = `Basic ${Buffer.from('prompt10-zero-touch:isolated-zero-touch-password').toString('base64')}`;
const testFilter = String(process.env.PROMPT10_ZERO_TOUCH_FILTER || '').trim().toLowerCase();
let passed = 0;
let failed = 0;

async function test(name, work) {
  if (testFilter && !name.toLowerCase().includes(testFilter)) return;
  try {
    await work();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`);
  }
}

function candidate(id, overrides = {}) {
  const payload = {
    title: `Orbit Audio ${id} wireless over-ear headphones Bluetooth 5.3`,
    description: `Source record ${id} includes model identity, observed prices, merchant links, image, and technical specifications for deterministic editorial validation.`,
    kind: 'product',
    platform: 'website',
    originalUrl: `https://merchant-${id}.example/products/orbit-audio-${id}`,
    affiliateUrl: `https://merchant-${id}.example/products/orbit-audio-${id}?affiliate=isolated-fixture`,
    imageUrl: `https://cdn-${id}.example/images/orbit-audio-${id}.jpg`,
    imageCandidates: [],
    price: 2490000,
    salePrice: 1990000,
    currency: 'VND',
    category: 'Consumer audio headphones',
    brand: `Orbit Audio ${id}`,
    model: `OA-${id}`,
    sku: `SKU-${id}`,
    gtin: `893850000${String(id.length).padStart(3, '0')}`,
    mpn: `MPN-${id}`,
    specifications: {
      connection: 'Bluetooth 5.3',
      batteryHours: 42,
      driverSizeMm: 40,
      chargingPort: 'USB-C',
      weightGrams: 265,
      warrantyMonths: 24,
    },
    merchant: `Fixture Merchant ${id}`,
    rawSourceKind: 'product',
    verifiedSource: true,
    // This staging hint is deliberately false. Eligibility must be computed by the worker.
    autoPublishEligible: false,
    sourceQualityScore: 98,
    isolatedHealthFixture: 'healthy',
    ...overrides,
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return {
    source: 'accesstrade',
    sourceId: id,
    priority: 95,
    contentHash: hash,
    sourceHash: hash,
    keyword: 'isolated-zero-touch',
    payload,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const queue = require('../src/lib/storage/candidateQueue.ts');
  const bridge = require('../src/lib/automation/candidateBridge.ts');
  const store = require('../src/lib/automation/store.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const canary = require('../src/lib/automation/canaryController.ts');
  const products = require('../src/lib/storage/products.ts');
  const lifecycle = require('../src/lib/autonomous/lifecycleStore.ts');
  const evidence = require('../src/lib/autonomous/evidenceGraph.ts');
  const productRoute = require('../src/app/api/products/route.ts');
  const { NextRequest } = require('next/server');

  global.fetch = async () => {
    throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_ZERO_TOUCH');
  };

  const collections = [
    'candidate-queue',
    'products',
    'automation-jobs',
    'automation-control',
    'automation-audit',
    'automation-canary',
    'automation-circuits',
    'automation-ai-usage',
    'automation-manual-tasks',
    'automation-outbound-events',
    'operation-journal',
    'product-lifecycle-events',
    'evidence-facts',
    'publication-audit',
    'domain-circuit-breakers',
  ];

  async function reset(mode = 'CANARY') {
    for (const collection of collections) await adapter.writeCollection(collection, []);
    await store.updateAutomationControl({
      mode,
      effectiveMode: mode,
      publishPaused: false,
      ingestionPaused: false,
      workerPaused: false,
      schedulerPaused: false,
      killSwitch: false,
    }, 'zero-touch-test');
    if (mode === 'CANARY') {
      const state = await canary.recordSuccessfulShadowCycle();
      assert.equal(state.wave, 1, 'CANARY fixture must start in bounded wave 1');
    }
  }

  async function bridgeAndProcess(input, workerId) {
    const queued = await queue.enqueueCandidate(input);
    assert.equal(queued.queued, true);
    const bridged = await bridge.bridgeCandidatesToDurableJobs({ requestedBy: 'autopilot-worker', limit: 10 });
    assert.equal(bridged.created, 1);
    assert.equal(bridged.jobs[0].candidateId, queued.item.id);
    const processJob = await store.getAutomationJob(bridged.jobs[0].jobId);
    assert.equal(processJob.type, 'PROCESS_CANDIDATE');
    assert.equal(processJob.status, 'PENDING');
    assert.equal(processJob.approvalStatus, 'NOT_REQUIRED');
    const run = await worker.processAutomationBatch(workerId, 1);
    assert.equal(run.succeeded, 1, JSON.stringify({ run, job: await store.getAutomationJob(processJob.id) }));
    const product = (await products.getAllProducts()).find(item => item.sourceId === input.sourceId);
    assert.ok(product, 'durable candidate worker must create a canonical product');
    return { queued: queued.item, processJob, product };
  }

  function assertNoHumanGate(jobs) {
    assert.equal(jobs.some(job => job.status === 'WAITING_APPROVAL'), false);
    assert.equal(jobs.some(job => job.status === 'WAITING_FOR_MANUAL_INPUT'), false);
    assert.equal(jobs.some(job => job.type === 'SAFE_PUBLISH'), false);
  }

  await test('rich CANARY candidate reaches public zero-touch through durable child jobs', async () => {
    await reset('CANARY');
    const input = candidate('happy-path');
    const processed = await bridgeAndProcess(input, 'zero-touch-candidate-worker');
    let canonical = await products.getProductById(processed.product.id);
    assert.equal(canonical.lifecycleState, 'READY_FOR_PUBLISH');
    assert.equal(canonical.autoPublishEligible, true, 'worker must compute eligibility despite false staging hint');
    assert.equal(canonical.claimValidationStatus, 'VERIFIED');
    assert.ok(canonical.evidenceCoverage >= 0.8);
    assert.ok(canonical.confidences.publish >= 0.85);
    assert.equal(canonical.reviewContent.reviewStatus, 'approved');
    assert.equal(canonical.reviewGeneration.provider, 'local');
    assert.equal(canonical.publicHidden, true);

    const facts = await evidence.listProductEvidence(canonical.id);
    assert.ok(facts.length >= 12, `expected rich evidence graph, received ${facts.length} facts`);
    assert.ok(facts.every(fact => fact.productId === canonical.id && fact.status === 'ACTIVE'));
    const transitions = await lifecycle.listLifecycleTransitionEvents(canonical.id);
    assert.deepEqual(transitions.map(event => event.nextState), [
      'STAGED',
      'CLASSIFIED',
      'NORMALIZED',
      'VERIFYING',
      'CONTENT_PREPARING',
      'READY_FOR_PUBLISH',
    ]);
    assert.ok(transitions.every(event => event.status === 'APPLIED' && event.actor.type === 'worker'));

    const beforePublish = await store.getAllAutomationJobs();
    const publishJobs = beforePublish.filter(job => job.type === 'AUTO_SAFE_PUBLISH');
    assert.equal(publishJobs.length, 1);
    assert.equal(publishJobs[0].parentJobId, processed.processJob.id);
    assert.equal(publishJobs[0].status, 'PENDING');
    assert.equal(publishJobs[0].approvalStatus, 'NOT_REQUIRED');
    assertNoHumanGate(beforePublish);
    assert.equal((await adapter.readCollection('automation-manual-tasks')).length, 0);

    const publishRun = await worker.processAutomationBatch('zero-touch-publish-worker', 1);
    assert.equal(publishRun.succeeded, 1, JSON.stringify({ publishRun, job: await store.getAutomationJob(publishJobs[0].id) }));
    canonical = await products.getProductById(canonical.id);
    assert.equal(canonical.status, 'published');
    assert.equal(canonical.lifecycleState, 'PUBLISHED');
    assert.equal(canonical.publicHidden, false);
    assert.equal(canonical.autoPublished, true);
    assert.ok(canonical.publishedAt);
    assert.equal((await products.getPublicProducts()).some(item => item.id === canonical.id), true);
    const finalTransitions = await lifecycle.listLifecycleTransitionEvents(canonical.id);
    assert.deepEqual(finalTransitions.map(event => event.nextState), [
      'STAGED',
      'CLASSIFIED',
      'NORMALIZED',
      'VERIFYING',
      'CONTENT_PREPARING',
      'READY_FOR_PUBLISH',
      'PUBLISHING',
      'PUBLISHED',
    ]);
    assert.ok(finalTransitions.every(event => event.status === 'APPLIED' && event.actor.type === 'worker'));
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 1);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR').length, 1);
    assertNoHumanGate(await store.getAllAutomationJobs());
    assert.equal((await adapter.readCollection('automation-manual-tasks')).length, 0);
  });

  await test('non-product staging record is quarantined without a publish job', async () => {
    await reset('CANARY');
    const input = candidate('voucher-record', {
      title: 'Voucher freeship for orders from fixture merchant',
      description: 'Promotion code applies to a store order and is not a sellable product.',
      rawSourceKind: 'voucher',
      autoPublishEligible: true,
    });
    const processed = await bridgeAndProcess(input, 'zero-touch-non-product-worker');
    const canonical = await products.getProductById(processed.product.id);
    assert.equal(canonical.recordType, 'VOUCHER');
    assert.equal(canonical.lifecycleState, 'QUARANTINED');
    assert.equal(canonical.publicHidden, true);
    assert.equal(canonical.autoPublishEligible, false);
    assert.ok(canonical.quarantineReasons.some(reason => reason.includes('record_type_voucher')));
    assert.equal((await queue.getCandidateById(processed.queued.id)).status, 'discarded');
    const jobs = await store.getAllAutomationJobs();
    assert.equal(jobs.some(job => job.type === 'AUTO_SAFE_PUBLISH'), false);
    assert.equal((await products.getPublicProducts()).length, 0);
    assertNoHumanGate(jobs);
  });

  await test('high-risk product is quarantined and cannot enter the publish lane', async () => {
    await reset('CANARY');
    const input = candidate('high-risk', {
      title: 'Nicotine device high-risk isolated catalog product',
      description: 'Source record contains nicotine and must be restricted by deterministic policy.',
      autoPublishEligible: true,
    });
    const processed = await bridgeAndProcess(input, 'zero-touch-high-risk-worker');
    const canonical = await products.getProductById(processed.product.id);
    assert.equal(canonical.recordType, 'PRODUCT');
    assert.equal(canonical.riskLevel, 'high');
    assert.equal(canonical.lifecycleState, 'QUARANTINED');
    assert.equal(canonical.publicHidden, true);
    assert.equal(canonical.autoPublishEligible, false);
    assert.ok(canonical.quarantineReasons.includes('risk_not_low'));
    const jobs = await store.getAllAutomationJobs();
    assert.equal(jobs.some(job => job.type === 'AUTO_SAFE_PUBLISH'), false);
    assert.equal((await products.getPublicProducts()).length, 0);
    assertNoHumanGate(jobs);
  });

  await test('missing trusted source evidence cannot be overridden by candidate eligibility hint', async () => {
    await reset('CANARY');
    const input = candidate('missing-evidence', {
      verifiedSource: false,
      autoPublishEligible: true,
      sourceQualityScore: 20,
    });
    const processed = await bridgeAndProcess(input, 'zero-touch-evidence-worker');
    const canonical = await products.getProductById(processed.product.id);
    assert.equal(canonical.recordType, 'PRODUCT');
    assert.equal(canonical.lifecycleState, 'QUARANTINED');
    assert.equal(canonical.autoPublishEligible, false);
    assert.equal(canonical.publicHidden, true);
    assert.ok(canonical.quarantineReasons.includes('source_not_verified'));
    assert.ok(canonical.quarantineReasons.includes('publish_confidence_low'));
    assert.ok(canonical.confidences.source < 0.85);
    const facts = await evidence.listProductEvidence(canonical.id);
    const titleFact = facts.find(fact => fact.field === 'title');
    assert.ok(titleFact && titleFact.confidence < 0.8, 'unverified source title must not count as trusted evidence');
    const jobs = await store.getAllAutomationJobs();
    assert.equal(jobs.some(job => job.type === 'AUTO_SAFE_PUBLISH'), false);
    assert.equal((await products.getPublicProducts()).length, 0);
    assertNoHumanGate(jobs);
  });

  await test('authenticated client payload cannot forge publication eligibility', async () => {
    await reset('CANARY');
    const request = new NextRequest('http://localhost/api/products', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Client-forged publication fixture',
        platform: 'website',
        kind: 'product',
        source: 'manual',
        originalUrl: 'https://owner-fixture.example/product/client-forge',
        affiliateUrl: 'https://owner-fixture.example/go/client-forge',
        imageUrl: 'https://owner-fixture.example/image/client-forge.jpg',
        price: 1000000,
        salePrice: 900000,
        riskLevel: 'low',
        verifiedSource: true,
        sourceVerified: true,
        autoPublishEligible: true,
        status: 'published',
        publicHidden: false,
        lifecycleState: 'PUBLISHED',
        evidenceCoverage: 1,
      }),
    });
    const response = await productRoute.POST(request);
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.data.status, 'needs_review');
    assert.equal(body.data.publicHidden, true);
    assert.equal(body.data.verifiedSource, false);
    assert.notEqual(body.data.autoPublishEligible, true);
    assert.notEqual(body.data.lifecycleState, 'PUBLISHED');
    assert.equal((await products.getPublicProducts()).length, 0);
    assert.equal((await store.getAllAutomationJobs()).length, 0);
  });

  console.log(`\nPROMPT10 Gate 5 zero-touch: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), tempDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
