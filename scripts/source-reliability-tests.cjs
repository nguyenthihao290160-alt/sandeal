/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tempDir = path.join(process.cwd(), '.test-tmp', `source-reliability-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = path.join(tempDir, 'data');
process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = '';
process.env.ACCESS_TRADE_API_KEY = '';
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

let passed = 0;
let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
}

function response(status, headers = {}, body = '') {
  return new Response([204, 205, 304].includes(status) ? null : body, { status, headers });
}

function networkError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function candidate(id, fixture = 'healthy', overrides = {}) {
  const now = new Date().toISOString();
  const payload = {
    title: `Orbit Audio ${id} wireless over-ear headphones Bluetooth 5.3`,
    description: `Verified product record ${id} includes stable identity, observed price, exact links, image, and technical specifications.`,
    kind: 'product', platform: 'website',
    originalUrl: `https://merchant-${id}.example/products/orbit-${id}`,
    canonicalProductUrl: `https://merchant-${id}.example/products/orbit-${id}`,
    canonicalUrlSource: 'provider_api', canonicalUrlProvider: 'accesstrade',
    canonicalUrlSourceEndpoint: 'datafeed', canonicalUrlSourceField: 'product_url',
    canonicalUrlFetchedAt: now, canonicalUrlStatus: 'available',
    affiliateUrl: `https://go.isclix.com/deep/${id}?aff=fixture`,
    affiliateUrlSource: 'provider_api', affiliateUrlProvider: 'accesstrade',
    affiliateUrlSourceEndpoint: 'datafeed', affiliateUrlSourceField: 'affiliate_url',
    affiliateUrlFetchedAt: now, affiliateUrlStatus: 'available',
    imageUrl: `https://cdn-${id}.example/images/orbit-${id}.jpg`, imageCandidates: [],
    price: 2490000, salePrice: 1990000, currency: 'VND', category: 'Consumer audio',
    brand: `Orbit ${id}`, model: `OA-${id}`, sku: `SKU-${id}`,
    gtin: `893850${String(id.length).padStart(7, '0')}`,
    specifications: { connection: 'Bluetooth 5.3', batteryHours: 42, warrantyMonths: 24 },
    merchant: `Merchant ${id}`, merchantDomain: `merchant-${id}.example`, campaignName: `Campaign ${id}`,
    sourceItemId: id, sourceEndpoint: 'datafeed', sourceFetchedAt: now,
    rawSourceKind: 'product', verifiedSource: true, autoPublishEligible: false,
    sourceQualityScore: 98, isolatedHealthFixture: fixture,
    ...overrides,
  };
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { source: 'accesstrade', sourceId: id, priority: 95, contentHash: sourceHash, sourceHash, keyword: 'reliability', payload };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const { probeCommerceUrl } = require('../src/lib/commerce/urlProbe.ts');
  const circuits = require('../src/lib/bots/domainCircuitBreaker.ts');
  const selection = require('../src/lib/commerce/sourceSelection.ts');
  const reliability = require('../src/lib/commerce/sourceReliability.ts');
  const queue = require('../src/lib/storage/candidateQueue.ts');
  const bridge = require('../src/lib/automation/candidateBridge.ts');
  const store = require('../src/lib/automation/store.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const products = require('../src/lib/storage/products.ts');
  const settings = require('../src/lib/storage/automationSettings.ts');
  const backups = require('../src/lib/autonomous/backupManager.ts');
  const reconciliation = require('../src/lib/commerce/sourceReconciliation.ts');

  const originalInfo = console.info;
  console.info = () => undefined;
  global.fetch = async () => { throw new Error('LIVE_NETWORK_FORBIDDEN_IN_SOURCE_RELIABILITY_TESTS'); };

  await test('1 exact affiliate 404 is permanent and preserves the exact requested path', async () => {
    const requested = [];
    const exact = 'https://go.isclix.com/deep/product-1?click=abc&sub=one';
    const result = await probeCommerceUrl(exact, {
      role: 'AFFILIATE', resolveDns: false, logger: () => undefined,
      fetchImpl: async url => { requested.push(String(url)); return response(404); },
    });
    assert.equal(result.classification, 'AFFILIATE_LINK_NOT_FOUND');
    assert.equal(result.retryable, false);
    assert.deepEqual(requested, [exact]);
  });

  await test('2 affiliate redirect chain resolves a healthy merchant independently', async () => {
    const calls = [];
    const result = await probeCommerceUrl('https://go.isclix.com/deep/healthy?click=abc', {
      role: 'AFFILIATE', resolveDns: false, logger: () => undefined,
      fetchImpl: async url => {
        calls.push(String(url));
        return String(url).includes('go.isclix.com')
          ? response(302, { location: 'https://merchant.example/products/healthy' })
          : response(200, { 'content-type': 'text/html' }, '<html>ok</html>');
      },
    });
    assert.equal(result.classification, 'HEALTHY');
    assert.equal(result.affiliateGatewayDomain, 'go.isclix.com');
    assert.equal(result.merchantDomain, 'merchant.example');
    assert.equal(result.redirectCount, 1);
    assert.equal(calls.length, 2);
  });

  await test('3 every redirect target is checked by the SSRF guard', async () => {
    let calls = 0;
    const result = await probeCommerceUrl('https://go.isclix.com/deep/private-target', {
      role: 'AFFILIATE', resolveDns: false, logger: () => undefined,
      fetchImpl: async () => { calls += 1; return response(302, { location: 'http://127.0.0.1/internal' }); },
    });
    assert.equal(result.classification, 'UNSAFE_URL');
    assert.equal(result.retryable, false);
    assert.equal(calls, 1);
  });

  await test('4 merchant ECONNRESET is a retryable connection reset', async () => {
    const result = await probeCommerceUrl('https://reset.example/product', {
      role: 'MERCHANT', resolveDns: false, logger: () => undefined,
      fetchImpl: async () => { throw networkError('socket hang up', 'ECONNRESET'); },
    });
    assert.equal(result.classification, 'CONNECTION_RESET');
    assert.equal(result.retryable, true);
  });

  await test('5 merchant connect timeout is bounded and retryable', async () => {
    const result = await probeCommerceUrl('https://timeout.example/product', {
      role: 'MERCHANT', resolveDns: false, timeoutMs: 750, logger: () => undefined,
      fetchImpl: async () => { throw networkError('connect timeout', 'UND_ERR_CONNECT_TIMEOUT'); },
    });
    assert.equal(result.classification, 'CONNECT_TIMEOUT');
    assert.equal(result.retryable, true);
    assert.ok(result.elapsedTimeMs < 750);
  });

  await test('6 merchant 404 is a permanent missing product', async () => {
    const result = await probeCommerceUrl('https://merchant.example/missing', {
      role: 'MERCHANT', resolveDns: false, logger: () => undefined, fetchImpl: async () => response(404),
    });
    assert.equal(result.classification, 'MERCHANT_NOT_FOUND');
    assert.equal(result.retryable, false);
  });

  await test('7 HTTP 429 honors a valid bounded Retry-After', async () => {
    const now = 1_700_000_000_000;
    const result = await probeCommerceUrl('https://merchant.example/limited', {
      role: 'MERCHANT', resolveDns: false, now: () => now, logger: () => undefined,
      fetchImpl: async () => response(429, { 'retry-after': '120' }),
    });
    assert.equal(result.classification, 'RATE_LIMITED');
    assert.equal(result.retryAfter, new Date(now + 120_000).toISOString());
  });

  await test('8 redirect loops are detected before the configured bound is exceeded', async () => {
    const result = await probeCommerceUrl('https://loop.example/a', {
      role: 'MERCHANT', resolveDns: false, maxRedirects: 4, logger: () => undefined,
      fetchImpl: async url => response(302, { location: String(url).endsWith('/a') ? '/b' : '/a' }),
    });
    assert.equal(result.classification, 'REDIRECT_LOOP');
    assert.equal(result.retryable, false);
  });

  await test('9 query values never enter events or serialized diagnostics', async () => {
    const sensitiveValue = ['private', 'value', 'do', 'not', 'emit'].join('-');
    const events = [];
    const result = await probeCommerceUrl(`https://go.isclix.com/deep/redacted?click=${sensitiveValue}&sub=campaign`, {
      role: 'AFFILIATE', resolveDns: false, logger: event => events.push(event), fetchImpl: async () => response(404),
    });
    const serialized = JSON.stringify({ events, result });
    assert.equal(serialized.includes(sensitiveValue), false);
    assert.deepEqual(result.diagnostics.requested.queryParameterNames, ['click', 'sub']);
    assert.ok(result.normalizedFinalUrl.includes('click='));
  });

  async function resetCircuits() { await adapter.writeCollection('domain-circuit-breakers', []); }

  await test('10 CLOSED transitions to OPEN after the configured temporary threshold', async () => {
    await resetCircuits();
    const url = 'https://merchant-a.example/product';
    const first = await circuits.recordDomainHealth(url, 'connect_timeout', 10_000, { threshold: 2, baseDelayMs: 1_000, jitterRatio: 0, role: 'MERCHANT' });
    const second = await circuits.recordDomainHealth(url, 'connection_reset', 11_000, { threshold: 2, baseDelayMs: 1_000, jitterRatio: 0, role: 'MERCHANT' });
    assert.equal(first.state, 'CLOSED');
    assert.equal(second.state, 'OPEN');
  });

  await test('11 OPEN skips only the affected merchant', async () => {
    const affected = await circuits.peekDomainCircuitDecision('https://merchant-a.example/another', 11_500, { role: 'MERCHANT' });
    const healthy = await circuits.peekDomainCircuitDecision('https://merchant-b.example/product', 11_500, { role: 'MERCHANT' });
    assert.equal(affected.allowed, false);
    assert.equal(healthy.allowed, true);
  });

  await test('12 HALF_OPEN atomically grants only one bounded probe', async () => {
    const url = 'https://merchant-a.example/product';
    const [left, right] = await Promise.all([
      circuits.getDomainCircuitDecision(url, 20_000, { role: 'MERCHANT', halfOpenLeaseMs: 10_000 }),
      circuits.getDomainCircuitDecision(url, 20_000, { role: 'MERCHANT', halfOpenLeaseMs: 10_000 }),
    ]);
    assert.equal([left, right].filter(result => result.allowed && result.halfOpenProbe).length, 1);
    assert.equal([left, right].filter(result => !result.allowed && result.reason === 'half_open_probe_in_flight').length, 1);
  });

  await test('13 successful half-open probe closes the circuit', async () => {
    const state = await circuits.recordDomainHealth('https://merchant-a.example/product', 'healthy', 20_100, { role: 'MERCHANT' });
    assert.equal(state.state, 'CLOSED');
    assert.equal(state.consecutiveFailures, 0);
  });

  await test('14 affiliate deep-link 404 never opens the gateway circuit', async () => {
    await resetCircuits();
    const state = await circuits.recordDomainHealth('https://go.isclix.com/deep/missing', 'affiliate_link_not_found', 30_000, { threshold: 1, role: 'AFFILIATE_GATEWAY' });
    assert.equal(state.state, 'CLOSED');
    assert.equal(state.consecutiveFailures, 0);
  });

  await test('15 merchant failure does not poison the affiliate gateway circuit', async () => {
    await circuits.recordDomainHealth('https://merchant-c.example/product', 'connect_timeout', 31_000, { threshold: 1, role: 'MERCHANT', baseDelayMs: 1_000, jitterRatio: 0 });
    const merchant = await circuits.peekDomainCircuitDecision('https://merchant-c.example/other', 31_100, { role: 'MERCHANT' });
    const gateway = await circuits.peekDomainCircuitDecision('https://go.isclix.com/deep/healthy', 31_100, { role: 'AFFILIATE_GATEWAY' });
    assert.equal(merchant.allowed, false);
    assert.equal(gateway.allowed, true);
  });

  function source(id, merchant, eligible = true, campaign = 'campaign-a') {
    return {
      value: id, provider: 'accesstrade', sourceId: id, sourceHash: `hash-${id}`,
      merchantUrl: `https://${merchant}/products/${id}`, merchantDomain: merchant,
      campaign, category: id.includes('audio') ? 'audio' : 'home', keyword: id, eligible,
      skipReason: eligible ? undefined : 'MERCHANT_CIRCUIT_OPEN',
    };
  }

  await test('16 mixed intake deterministically chooses multiple healthy merchants', async () => {
    const input = [
      ...Array.from({ length: 8 }, (_, index) => source(`bad-${index}`, 'bad.example', false)),
      source('audio-a', 'one.example'), source('audio-b', 'two.example'), source('home-c', 'three.example'),
    ];
    const selected = selection.selectDiversifiedSources(input, { limit: 3, scheduleBucket: 'bucket-1', maximumPerMerchant: 1, maximumPerCampaign: 3 });
    assert.equal(selected.selected.length, 3);
    assert.equal(new Set(selected.selected.map(item => item.merchantDomain)).size, 3);
  });

  await test('17 one merchant cannot consume the entire batch', async () => {
    const input = [...Array.from({ length: 10 }, (_, index) => source(`dominant-${index}`, 'dominant.example')), source('other-a', 'other-a.example'), source('other-b', 'other-b.example')];
    const result = selection.selectDiversifiedSources(input, { limit: 6, scheduleBucket: 'bucket-2', maximumPerMerchant: 2, maximumPerCampaign: 10 });
    assert.ok(result.selected.filter(item => item.merchantDomain === 'dominant.example').length <= 2);
    assert.ok(result.selected.some(item => item.merchantDomain === 'other-a.example'));
  });

  await test('18 selection is stable for the same input and schedule bucket', async () => {
    const input = Array.from({ length: 12 }, (_, index) => source(`stable-${index}`, `merchant-${index % 4}.example`, true, `campaign-${index % 3}`));
    const options = { limit: 8, scheduleBucket: '2026-08-05T07', maximumPerMerchant: 2, maximumPerCampaign: 4 };
    const first = selection.selectDiversifiedSources(input, options).selected.map(item => item.sourceId);
    const second = selection.selectDiversifiedSources([...input].reverse(), options).selected.map(item => item.sourceId);
    assert.deepEqual(first, second);
  });

  await test('19 no healthy source selects nothing and creates no work', async () => {
    await adapter.writeCollection('source-reliability-state', []);
    await adapter.writeCollection('candidate-queue', []);
    await adapter.writeCollection('products', []);
    const result = selection.selectDiversifiedSources([source('bad-a', 'bad.example', false), source('bad-b', 'bad.example', false)], {
      limit: 10, scheduleBucket: 'none', maximumPerMerchant: 2, maximumPerCampaign: 4,
    });
    assert.equal(result.selected.length, 0);
    assert.equal(result.skipped.length, 2);
    await reliability.recordSourceIngestionState({
      provider: 'accesstrade', ingestionSkipped: true, reasonCode: 'NO_HEALTHY_PRODUCT_SOURCE',
      observed: 2, selected: 0, skipped: 2,
    });
    const report = await reliability.getSourceReliabilityReport();
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].ingestionSkipped, true);
    assert.equal(report.rows[0].ingestionSkipReason, 'NO_HEALTHY_PRODUCT_SOURCE');
  });

  await test('20 source identity and canonical merchant URL dedupe are idempotent', async () => {
    const first = source('same', 'merchant.example');
    const duplicateSource = { ...first };
    const duplicateUrl = { ...source('different', 'merchant.example'), merchantUrl: `${first.merchantUrl}?utm_source=x` };
    const result = selection.selectDiversifiedSources([first, duplicateSource, duplicateUrl], {
      limit: 10, scheduleBucket: 'dedupe', maximumPerMerchant: 10, maximumPerCampaign: 10,
    });
    assert.equal(result.selected.length, 1);
    assert.equal(result.skipped.filter(item => item.reason === 'DUPLICATE_SOURCE_OR_MERCHANT_URL').length, 2);
  });

  const flowCollections = [
    'candidate-queue', 'products', 'automation-jobs', 'automation-control', 'automation-settings',
    'automation-audit', 'automation-circuits', 'automation-ai-usage', 'automation-manual-tasks',
    'automation-outbound-events', 'operation-journal', 'product-lifecycle-events', 'evidence-facts',
    'publication-audit', 'domain-circuit-breakers', 'source-keyword-state', 'source-quality', 'source-reliability-state',
  ];
  async function resetFlow(mode = 'SHADOW') {
    for (const collection of flowCollections) await adapter.writeCollection(collection, []);
    await settings.updateAutomationSettings({ enabled: true, safePublish: true, launchEnabled: mode === 'CANARY' || mode === 'AUTONOMOUS' });
    await store.updateAutomationControl({
      mode, effectiveMode: mode, publishPaused: false, ingestionPaused: false,
      workerPaused: false, schedulerPaused: false, killSwitch: false,
    }, 'source-reliability-test');
  }
  async function processInput(input, workerId) {
    const enqueued = await queue.enqueueCandidate(input);
    const bridged = await bridge.bridgeCandidatesToDurableJobs({ requestedBy: 'source-reliability-test', limit: 10 });
    assert.equal(bridged.created, 1);
    await worker.processAutomationBatch(workerId, 1);
    return {
      candidate: await queue.getCandidateById(enqueued.item.id),
      job: await store.getAutomationJob(bridged.jobs[0].jobId),
      product: (await products.getAllProducts()).find(product => product.sourceId === input.sourceId),
    };
  }

  await test('21 permanently invalid affiliate candidate creates no canonical product', async () => {
    await resetFlow();
    const result = await processInput(candidate('affiliate-missing', 'confirmed_broken'), 'source-affiliate-missing-worker');
    assert.equal(result.candidate.status, 'discarded');
    assert.equal(result.candidate.terminalReason, 'AFFILIATE_LINK_NOT_FOUND');
    assert.equal(result.job.status, 'SUCCEEDED');
    assert.equal(result.product, undefined);
  });

  await test('22 temporary merchant failure has one delayed candidate and one retry path', async () => {
    await resetFlow();
    const input = candidate('merchant-timeout', 'temporary_failure');
    const result = await processInput(input, 'source-timeout-worker');
    assert.equal(result.candidate.status, 'delayed');
    assert.equal(result.candidate.retryable, true);
    assert.equal(result.candidate.delayReason, 'MERCHANT_CONNECT_TIMEOUT');
    assert.equal(result.job.status, 'RETRY_SCHEDULED');
    assert.equal(result.product, undefined);
    const replay = await bridge.bridgeCandidatesToDurableJobs({ requestedBy: 'source-reliability-test', limit: 10 });
    assert.equal(replay.created, 0);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'PROCESS_CANDIDATE').length, 1);
  });

  await test('23 healthy candidate creates exactly one canonical product', async () => {
    await resetFlow();
    const input = candidate('healthy-canonical', 'healthy');
    const first = await processInput(input, 'source-healthy-worker');
    assert.equal(first.candidate.status, 'completed');
    assert.ok(first.product);
    assert.equal(first.product.sourceEvidence.affiliate.classification, 'HEALTHY');
    assert.equal(first.product.sourceEvidence.merchant.classification, 'HEALTHY');
    const duplicate = await queue.enqueueCandidate(input);
    assert.equal(duplicate.queued, false);
    assert.equal((await products.getAllProducts()).filter(product => product.sourceId === input.sourceId).length, 1);
  });

  await test('24 now-unhealthy canonical product is quarantined with explicit source blockers', async () => {
    const changed = candidate('healthy-canonical', 'temporary_failure', { providerUpdatedAt: new Date(Date.now() + 1_000).toISOString() });
    const result = await processInput(changed, 'source-quarantine-worker');
    assert.equal(result.candidate.status, 'delayed');
    assert.equal(result.product.lifecycleState, 'QUARANTINED');
    assert.ok(result.product.quarantineReasons.includes('MERCHANT_CONNECT_TIMEOUT'));
    assert.equal(result.product.publicHidden, true);
    assert.equal(result.product.lastEligibilityDecision.eligible, false);
  });

  await test('25 reconciliation dry-run and apply never mutate protected collections', async () => {
    await resetFlow();
    const gitRoot = path.join(tempDir, 'clean-repository');
    fs.mkdirSync(gitRoot, { recursive: true });
    fs.writeFileSync(path.join(gitRoot, 'README.md'), 'isolated source reconciliation fixture\n', 'utf8');
    execFileSync('git', ['init'], { cwd: gitRoot, stdio: 'ignore' });
    execFileSync('git', ['add', 'README.md'], { cwd: gitRoot, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit', '-m', 'fixture'], { cwd: gitRoot, stdio: 'ignore' });
    const releaseId = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitRoot, encoding: 'utf8' }).trim();
    const input = candidate('reconcile-permanent', 'confirmed_broken');
    const enqueued = await queue.enqueueCandidate(input);
    const checkedAt = new Date().toISOString();
    await queue.finishCandidate(enqueued.item.id, {
      status: 'failed', terminalReason: 'AFFILIATE_LINK_NOT_FOUND', retryable: false, lastProbeAt: checkedAt,
      sourceEvidence: {
        version: 'commerce-source-v1', checkedAt, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        affiliate: {
          classification: 'AFFILIATE_LINK_NOT_FOUND', httpStatus: 404, affiliateGatewayDomain: 'go.isclix.com',
          redirectCount: 0, elapsedTimeMs: 1, retryable: false, reasonCode: 'AFFILIATE_HTTP_404', checkedAt,
        },
      },
    });
    const protectedBefore = {};
    for (const collection of reconciliation.SOURCE_RECONCILIATION_PROTECTED_COLLECTIONS) {
      const fixture = [{ id: `${collection}-sentinel`, preserved: true }];
      await adapter.writeCollection(collection, fixture);
      protectedBefore[collection] = JSON.stringify(fixture);
    }
    const dryRun = await reconciliation.reconcileUnhealthySources({ expectedReleaseId: releaseId, repositoryRoot: gitRoot, now: Date.now() });
    assert.equal(dryRun.mode, 'dry-run');
    assert.equal(dryRun.mutations.candidatesDiscarded, 0);
    assert.equal((await queue.getCandidateById(enqueued.item.id)).status, 'failed');
    const applied = await reconciliation.reconcileUnhealthySources({
      apply: true, expectedReleaseId: releaseId, repositoryRoot: gitRoot,
      backupDir: path.join(tempDir, 'reconciliation-backups'), now: Date.now(),
    });
    assert.ok(applied.backup);
    const manifest = await backups.verifyStorageSnapshot(applied.backup.directory);
    assert.ok(manifest.files.every(file => !reconciliation.SOURCE_RECONCILIATION_PROTECTED_COLLECTIONS.includes(file.name.replace(/\.json$/, ''))));
    assert.equal((await queue.getCandidateById(enqueued.item.id)).status, 'discarded');
    for (const collection of reconciliation.SOURCE_RECONCILIATION_PROTECTED_COLLECTIONS) {
      assert.equal(JSON.stringify(await adapter.readCollection(collection)), protectedBefore[collection], collection);
    }
  });

  console.info = originalInfo;
  console.log(`\nSource reliability regression suite: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), tempDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
