/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const tempDir = path.join(process.cwd(), '.test-tmp', `source-discovery-identity-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = path.join(tempDir, 'data');
process.env.NODE_ENV = 'test';
process.env.ACCESS_TRADE_API_KEY = 'test-key';
require('./register-typescript.cjs');

let passed = 0;
let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const pipeline = require('../src/lib/bots/productPipeline.ts');
  const { createAccessTradeSourceAdapter } = require('../src/lib/autonomous/sourceAdapterPlatform.ts');
  const circuits = require('../src/lib/bots/domainCircuitBreaker.ts');

  const originalInfo = console.info;
  const events = [];
  console.info = (...args) => {
    try {
      const parsed = JSON.parse(args[0]);
      if (parsed.event) events.push(parsed);
    } catch { }
  };

  const { SourceAdapterRegistry } = require('../src/lib/autonomous/sourceAdapterPlatform.ts');

  const mockAdapter = createAccessTradeSourceAdapter({
    configured: async () => true,
    discover: async () => {
      return {
        items: [
          { id: '1', name: 'Item 1 longer title', kind: 'product', originalUrl: 'https://30shinestore.com/item1', campaignName: '30shine_store', merchantDomain: '30shinestore.com', price: 1000, affiliateUrl: 'https://go.isclix.com/deep/1', imageUrl: 'https://img.example/1.jpg', imageCandidates: [] },
          { id: '2', name: 'Item 2 longer title', kind: 'product', originalUrl: 'https://lazada.vn/item2', campaignName: 'lazada', merchantDomain: 'lazada.vn', price: 2000, affiliateUrl: 'https://go.isclix.com/deep/2', imageUrl: 'https://img.example/2.jpg', imageCandidates: [] },
          { id: '3', name: 'Item 3 longer title', kind: 'product', originalUrl: 'https://tiki.vn/item3', campaignName: 'tiki', merchantDomain: 'tiki.vn', price: 3000, affiliateUrl: 'https://go.isclix.com/deep/3', imageUrl: 'https://img.example/3.jpg', imageCandidates: [] },
        ],
        requests: [{ attempts: 1, resultType: 'success' }]
      };
    }
  });

  const mockRegistry = new SourceAdapterRegistry();
  mockRegistry.register(mockAdapter);

  await test('Pipeline discovers and preserves multi-campaign identity', async () => {
    events.length = 0;
    const result = await pipeline.scanSourcesToQueue('bootstrap', Date.now() + 60000, { runId: 'test-multi-campaign', registry: mockRegistry });
    if (result.discoveredCampaignCount !== 3) console.log('TEST 1 RESULT:', result);
    assert.equal(result.discoveredCampaignCount, 3);
    assert.equal(result.discoveredMerchantCount, 3);
    assert.equal(result.healthyMerchantCount, 3);
    
    const summaryEvent = events.find(e => e.event === 'auto_pilot_source_discovery_summary');
    assert.ok(summaryEvent, 'Missing auto_pilot_source_discovery_summary event');
    assert.match(summaryEvent.reasonCode, /campaigns:3/);
    assert.match(summaryEvent.reasonCode, /merchants:3/);
  });

  await test('Pipeline safely skips open merchant and logs aggregate skip', async () => {
    events.length = 0;

    // Three consecutive transient failures are required to trip the circuit
    // (DEFAULT_THRESHOLD = 3 in domainCircuitBreaker.ts).
    await circuits.recordDomainHealth('https://30shinestore.com', 'timeout');
    await circuits.recordDomainHealth('https://30shinestore.com', 'timeout');
    await circuits.recordDomainHealth('https://30shinestore.com', 'timeout');

    // Confirm the circuit is actually OPEN before running the pipeline.
    const circuitStates = await circuits.listDomainCircuitStates();
    const openCircuit = circuitStates.find(s => s.domain === '30shinestore.com' && s.role === 'MERCHANT');
    assert.ok(openCircuit, 'Circuit state for 30shinestore.com must exist');
    assert.equal(openCircuit.state, 'OPEN', 'Circuit must be OPEN after 3 transient failures');
    assert.equal(openCircuit.consecutiveFailures, 3);

    // Clear events captured during circuit recording so we only see pipeline events.
    events.length = 0;

    const result = await pipeline.scanSourcesToQueue('bootstrap', Date.now() + 60000, { runId: 'test-merchant-circuit', registry: mockRegistry });

    // --- Source diversity: 3 discovered, but only 2 eligible (30shinestore.com is OPEN) ---
    assert.equal(result.discoveredCampaignCount, 3, 'All 3 campaigns must be discovered');
    assert.equal(result.discoveredMerchantCount, 3, 'All 3 merchants must be discovered');
    assert.equal(result.eligibleMerchantCount, 2, 'Only lazada.vn and tiki.vn are eligible');
    assert.equal(result.healthyMerchantCount, 2, 'Only lazada.vn and tiki.vn are healthy');

    // --- Exclusion counts ---
    assert.ok(result.excludedByMerchantCircuit > 0, 'At least one candidate must be excluded by MERCHANT_CIRCUIT_OPEN');
    assert.equal(typeof result.excludedByPolicy, 'number');

    // --- Aggregate skip event: one bounded event per reason|campaign|merchant, not per-candidate ---
    const skipEvents = events.filter(e => e.event === 'source_candidates_skipped');
    assert.ok(skipEvents.length > 0, 'At least one aggregate source_candidates_skipped event must be emitted');
    const openSkip = skipEvents.find(e => e.domain === '30shinestore.com');
    assert.ok(openSkip, 'Aggregate skip for 30shinestore.com must exist');
    assert.match(openSkip.reasonCode, /^MERCHANT_CIRCUIT_OPEN:\d+$/, 'Reason must include count');

    // --- Per-candidate logs must NOT appear by default (only with SANDEAL_DEBUG_CANDIDATE_SKIP=true) ---
    const perCandidateLogs = events.filter(e => e.event === 'candidate_skipped_unhealthy_source');
    assert.equal(perCandidateLogs.length, 0, 'Per-candidate skip logs must not be emitted by default');

    // --- Discovery summary: one aggregate event with structured metric fields ---
    const summaryEvent = events.find(e => e.event === 'auto_pilot_source_discovery_summary');
    assert.ok(summaryEvent, 'Discovery summary event must exist');
    assert.match(summaryEvent.reasonCode, /campaigns:3/, 'Summary must report 3 campaigns');
    assert.match(summaryEvent.reasonCode, /excluded_circuit:\d+/, 'Summary must report excluded_circuit count');

    // --- Aggregate summaries are structured log events, not candidate objects ---
    // The result object's candidate counts (found, normalized) must not include summary objects.
    assert.equal(typeof result.normalized, 'number');
    assert.ok(result.normalized > 0, 'Normalized candidates must be positive');
  });

  console.info = originalInfo;
  console.log(`\nTests passed: ${passed}, failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
