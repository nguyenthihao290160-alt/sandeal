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
    await circuits.recordDomainHealth('https://30shinestore.com', 'timeout'); // Trip circuit

    const result = await pipeline.scanSourcesToQueue('bootstrap', Date.now() + 60000, { runId: 'test-merchant-circuit', registry: mockRegistry });
    if (result.discoveredCampaignCount !== 3) console.log('TEST 2 RESULT:', result);
    assert.equal(result.discoveredCampaignCount, 3);
    assert.equal(result.eligibleMerchantCount, 2);
    assert.equal(result.healthyMerchantCount, 2);
    assert.ok(result.excludedByMerchantCircuit > 0);
    
    const skipEvent = events.find(e => e.event === 'source_candidates_skipped');
    assert.ok(skipEvent, 'Missing source_candidates_skipped event');
    assert.equal(skipEvent.domain, '30shinestore.com');
    assert.match(skipEvent.reasonCode, /^MERCHANT_CIRCUIT_OPEN:\d+$/);
    
    const summaryEvent = events.find(e => e.event === 'auto_pilot_source_discovery_summary');
    assert.match(summaryEvent.reasonCode, /excluded_circuit:\d+/);
  });

  console.info = originalInfo;
  console.log(`\nTests passed: ${passed}, failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
