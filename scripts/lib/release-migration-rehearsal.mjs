import assert from 'node:assert/strict';
import { load, domain, executionFingerprint, migrationFiles } from './release-rehearsal.mjs';
import { executionFixture, FIXTURE_NOW } from './release-rehearsal-fixtures.mjs';

const { openLocalD1, applyLocalMigrations } = load('./local-d1.cjs');
const { D1ExecutionStore } = load('../../src/lib/storage/d1/d1ExecutionStore.ts');
const origin = 'TEST_FIXTURE', productId = 'rehearsal-product', timestamp = new Date(FIXTURE_NOW).toISOString();
export async function seedHistoricalFixtures(db) {
  const offer = { id: 'rehearsal-offer', source: 'accesstrade', merchant: 'fixture-merchant', price: 1000, originalPrice: 1200,
    affiliateUrl: 'https://shopee.vn/fixture-only', health: 'HEALTHY', observedAt: timestamp };
  const payload = JSON.stringify({ id: productId, status: 'draft', title: 'Synthetic rehearsal product', offers: [offer], origin });
  await db.prepare('INSERT INTO products(id,slug,status,revision,token,created_at,updated_at,payload,identities) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(productId, productId, 'draft', 1, 'a'.repeat(64), timestamp, timestamp, payload, '[]').run();
  await db.prepare(`INSERT INTO affiliate_clicks(id,product_id,offer_id,provider,merchant_id,currency,created_at,attribution_reference,attribution_transport,origin,payload,platform)
    VALUES('rehearsal-click',?,'rehearsal-offer','accesstrade','fixture-merchant','VND',?,'rehearsal-click','UNAVAILABLE',?,'{}','shopee')`).bind(productId, timestamp, origin).run();
  await db.prepare(`INSERT INTO affiliate_conversions(provider,external_id,event_id,click_id,occurred_at,fingerprint,origin)
    VALUES('accesstrade','rehearsal-conversion','rehearsal-conversion-event','rehearsal-click',?, ?,?)`).bind(timestamp, 'b'.repeat(64), origin).run();
  await db.prepare(`INSERT INTO affiliate_commission_events(provider,event_id,external_id,conversion_id,revision,state,amount_minor,currency,occurred_at,fingerprint,origin)
    VALUES('accesstrade','rehearsal-commission-event','rehearsal-commission','rehearsal-conversion',1,'PENDING',100,'VND',?,?,?)`).bind(timestamp, 'c'.repeat(64), origin).run();
  await db.prepare(`INSERT INTO affiliate_revenue_snapshots(origin,scope,scope_id,day,currency,clicks,conversions,pending_minor,last_sequence)
    VALUES(?,'PRODUCT',?,?,'VND',1,1,100,3)`).bind(origin, productId, timestamp.slice(0, 10)).run();
  await db.prepare(`INSERT INTO deal_evaluations(product_id,origin,fingerprint,algorithm_version,provider,platform,priority,recommendation,monetization_state,score,confidence,valid_until,provider_versions,payload)
    VALUES(?, ?,?,'deal-intelligence-v1','accesstrade','shopee','HIGH','HOLD','SAFE',80,0.9,?,'{}','{}')`).bind(productId, origin, 'd'.repeat(64), FIXTURE_NOW + 300000).run();
  await db.prepare(`INSERT INTO decision_records(id,product_id,origin,fingerprint,deal_fingerprint,policy_version,config_version,outcome,review_required,ai_status,ai_failed,provider,platform,score,created_at,valid_until,payload)
    VALUES('rehearsal-decision',?,?,?,?,'decision-policy-v1','fixture','ALLOW',1,'DISABLED',0,'accesstrade','shopee',80,?,?,'{}')`)
    .bind(productId, origin, 'e'.repeat(64), 'd'.repeat(64), FIXTURE_NOW, FIXTURE_NOW + 300000).run();
  await db.prepare(`INSERT INTO opportunity_evaluations(origin,product_id,id,fingerprint,config_version,algorithm_version,decision_id,provider,platform,priority,rankable,score,confidence,
    new_opportunity,low_confidence,content_candidate,experiment_candidate,refresh_candidate,review_required,valid_until,payload)
    VALUES(?,?,'rehearsal-opportunity',?,'fixture','opportunity-engine-v1','rehearsal-decision','accesstrade','shopee','P1',1,80,0.9,1,0,1,0,1,1,?,?)`)
    .bind(origin, productId, 'f'.repeat(64), FIXTURE_NOW + 300000, JSON.stringify({ executionMode: 'SHADOW', origin })).run();
  await db.prepare('INSERT INTO content_lifecycle_sources(origin,content_id,product_id,intent,token,entity) VALUES(?,?,?,?,?,?)')
    .bind(origin, 'rehearsal-content', productId, 'PRODUCT', 'fixture', JSON.stringify({ id: 'rehearsal-content', origin, content: 'Synthetic local content' })).run();
}
export const fixtureQueries = [
  ['product', 'SELECT * FROM products WHERE id=? LIMIT 1', [productId]],
  ['offer', 'SELECT * FROM product_offers WHERE product_id=? AND id=? LIMIT 1', [productId, 'rehearsal-offer']],
  ['click', 'SELECT * FROM affiliate_clicks WHERE id=? LIMIT 1', ['rehearsal-click']],
  ['conversion', 'SELECT * FROM affiliate_conversions WHERE provider=? AND external_id=? LIMIT 1', ['accesstrade', 'rehearsal-conversion']],
  ['commissionEvent', 'SELECT * FROM affiliate_commission_events WHERE provider=? AND event_id=? LIMIT 1', ['accesstrade', 'rehearsal-commission-event']],
  ['commission', 'SELECT * FROM affiliate_commissions WHERE provider=? AND external_id=? LIMIT 1', ['accesstrade', 'rehearsal-commission']],
  ['clickLedger', 'SELECT * FROM affiliate_money_events WHERE effect_key=? LIMIT 1', ['click:rehearsal-click']],
  ['conversionLedger', 'SELECT * FROM affiliate_money_events WHERE effect_key=? LIMIT 1', ['conversion:accesstrade:rehearsal-conversion']],
  ['commissionLedger', 'SELECT * FROM affiliate_money_events WHERE effect_key=? LIMIT 1', ['commission:accesstrade:rehearsal-commission:1:new']],
  ['revenue', 'SELECT * FROM affiliate_revenue_snapshots WHERE origin=? AND scope=? AND scope_id=? AND day=? AND currency=? LIMIT 1', [origin, 'PRODUCT', productId, timestamp.slice(0, 10), 'VND']],
  ['deal', 'SELECT * FROM deal_evaluations WHERE origin=? AND product_id=? LIMIT 1', [origin, productId]],
  ['decision', 'SELECT * FROM decision_records WHERE id=? LIMIT 1', ['rehearsal-decision']],
  ['opportunity', 'SELECT * FROM opportunity_evaluations WHERE origin=? AND product_id=? LIMIT 1', [origin, productId]],
  ['content', 'SELECT * FROM content_lifecycle_sources WHERE origin=? AND content_id=? LIMIT 1', [origin, 'rehearsal-content']],
];
export async function snapshotFixtures(db) {
  const result = {};
  for (const [name, sql, values] of fixtureQueries) {
    const row = await db.prepare(sql).bind(...values).first(); assert.ok(row, `FIXTURE_MISSING_${name}`); result[name] = row;
  }
  return result;
}
export async function persistExecutionFixture(db, context = executionFixture()) {
  const store = new D1ExecutionStore(db, { environment: 'LOCAL', testOnly: true,
    allowedApproverIds: context.allowedApproverIds, allowedHosts: context.allowedHosts });
  await store.initializeTestControls(context.now); await store.createProposal(context.proposal);
  const { currentEvidenceFingerprint, currentPolicy, target, priorState, changeWindow } = context;
  await store.putEvidence(context.proposal.id, { currentEvidenceFingerprint, currentPolicy, target, priorState, changeWindow });
  await store.createApproval(context.approval);
  const jobId = await store.enqueue(context.proposal.id, context.now), claim = await store.claim(jobId, context.now);
  assert.ok(claim); const receipt = await store.completeClaim(claim, context.now, true);
  assert.equal(receipt.preflightResult, 'PASS'); assert.equal(receipt.rollbackAvailable, true);
  const rollback = await db.prepare('SELECT payload FROM rollback_plans WHERE receipt_id=? LIMIT 1').bind(receipt.id).first();
  assert.ok(rollback); const plan = JSON.parse(rollback.payload);
  assert.equal(domain('plans').rollbackDrill(context, plan).passed, true);
  return { store, jobId, receipt, plan, context };
}
export async function migrationRehearsal(test, exercise) {
  const clean = await openLocalD1(), upgrade = await openLocalD1();
  const report = { inventoryFingerprint: executionFingerprint(domain('migrations').migrationInventory(migrationFiles())),
    target: 'EPHEMERAL_LOCAL_D1_ONLY', baseline: '0009_content_lifecycle.sql', pending: ['0010_execution_control_plane.sql'],
    idempotency: 'MIGRATION_LEDGER_SKIPS_APPLIED_ONE_SHOT_SQL', fixtureHashes: {} };
  try {
    await test('F clean local D1 install and actual schema', async () => {
      const plan = await applyLocalMigrations(clean); assert.equal(plan.length, 10); assert.ok(plan.every(item => item.action === 'APPLIED'));
      for (const name of ['products', 'affiliate_commission_events', 'content_lifecycle_sources', 'execution_proposals', 'rollback_plans']) {
        assert.ok(await clean.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name=? LIMIT 1").bind(name).first());
      }
    });
    await test('migration prefix validates before mutation', async () => {
      await assert.rejects(applyLocalMigrations(upgrade, { through: 'missing.sql' }), /BASELINE_INVALID/);
      assert.equal(await upgrade.db.prepare("SELECT name FROM sqlite_schema WHERE name='d1_migrations' LIMIT 1").first(), null);
      const plan = await applyLocalMigrations(upgrade, { through: report.baseline }); assert.equal(plan.length, 9);
      assert.equal(await upgrade.db.prepare("SELECT name FROM sqlite_schema WHERE name='execution_proposals' LIMIT 1").first(), null);
    });
    await seedHistoricalFixtures(upgrade.db);
    const before = await snapshotFixtures(upgrade.db);
    await test('migration 0009 to 0010 preserves all fourteen historical fixtures', async () => {
      const plan = await applyLocalMigrations(upgrade); assert.equal(plan.filter(item => item.action === 'APPLIED').length, 1);
      assert.equal(plan.at(-1).name, report.pending[0]); assert.deepEqual(await snapshotFixtures(upgrade.db), before);
      report.fixtureHashes.before = executionFingerprint(before); report.fixtureHashes.after = executionFingerprint(await snapshotFixtures(upgrade.db));
    });
    const execution = await persistExecutionFixture(upgrade.db);
    await test('migration ledger repeat preserves execution receipt and inline rollback', async () => {
      const receiptBefore = await execution.store.getReceipt(execution.jobId);
      const plan = await applyLocalMigrations(upgrade); assert.ok(plan.every(item => item.action === 'ALREADY_APPLIED'));
      assert.deepEqual(await execution.store.getReceipt(execution.jobId), receiptBefore);
      const stored = await upgrade.db.prepare('SELECT payload FROM rollback_plans WHERE receipt_id=? LIMIT 1').bind(execution.receipt.id).first();
      assert.deepEqual(JSON.parse(stored.payload), execution.plan); assert.deepEqual(await snapshotFixtures(upgrade.db), before);
      await assert.rejects(applyLocalMigrations(upgrade, { through: report.baseline }), /BASELINE_INVALID/);
    });
    await test('real D1 migration batch failure rolls back schema and ledger', async () => {
      await assert.rejects(clean.db.batch([clean.db.prepare('CREATE TABLE rehearsal_failure_probe(id TEXT PRIMARY KEY)'),
        clean.db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind('fixture-failed-migration'),
        clean.db.prepare('INSERT INTO rehearsal_missing_table(id) VALUES(1)')]));
      assert.equal(await clean.db.prepare("SELECT name FROM sqlite_schema WHERE name='rehearsal_failure_probe' LIMIT 1").first(), null);
      assert.equal(await clean.db.prepare('SELECT name FROM d1_migrations WHERE name=? LIMIT 1').bind('fixture-failed-migration').first(), null);
    });
    await test('real D1 foreign keys uniqueness and immutable money', async () => {
      const database = upgrade.db;
      await assert.rejects(database.prepare('INSERT INTO execution_contexts(proposal_id,payload) VALUES(?,?)').bind('missing-proposal', '{}').run());
      await assert.rejects(database.prepare('INSERT INTO execution_approvals SELECT * FROM execution_approvals WHERE id=?').bind(execution.context.approval.id).run());
      await assert.rejects(database.prepare('UPDATE affiliate_commission_events SET amount_minor=0 WHERE provider=? AND event_id=?')
        .bind('accesstrade', 'rehearsal-commission-event').run(), /IMMUTABLE_MONEY_EVIDENCE/);
      assert.deepEqual(await snapshotFixtures(database), before);
    });
    await test('D1 audit and due work use indexed bounded lookups', async () => {
      const queries = [
        ['SELECT id FROM execution_jobs WHERE environment=? AND status=? AND available_at<=? ORDER BY available_at,id LIMIT ?', ['LOCAL', 'PENDING', FIXTURE_NOW, 10]],
        ['SELECT id FROM rollback_plans WHERE receipt_id=? LIMIT 1', [execution.receipt.id]],
        ['SELECT id FROM execution_approvals WHERE proposal_id=? AND proposal_fingerprint=? AND environment=? AND capability=? AND risk_level=? AND status=? AND expires_at>? LIMIT 1',
          [execution.context.proposal.id, execution.context.approval.proposalFingerprint, 'LOCAL', 'PROPOSE_CONTENT_REFRESH', 'LOW', 'APPROVED', FIXTURE_NOW]],
      ];
      for (const [sql, values] of queries) {
        const plans = (await upgrade.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values).all()).results;
        assert.ok(plans.some(row => /SEARCH.*INDEX/.test(row.detail)), sql); assert.ok(plans.every(row => !/\bSCAN\b/.test(row.detail)), sql);
      }
    });
    if (exercise) await exercise(upgrade, execution, before);
    await test('rehearsal leaves fixture money and content unchanged', async () => assert.deepEqual(await snapshotFixtures(upgrade.db), before));
    return report;
  } finally { await clean.dispose(); await upgrade.dispose(); }
}
