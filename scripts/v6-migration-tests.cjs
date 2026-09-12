/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
require('./register-typescript.cjs');
const { fixture } = require('./fixtures/v6-domain-contract.cjs');
const { checksumJson } = require('../src/lib/storage/migrationChecksum.ts');
const { domainJson } = require('../src/lib/storage/domainSerialization.ts');
const { planV6Migration, summarizeV6Plan, applyV6Migration, verifyV6Migration } = require('../src/lib/storage/v6MigrationEngine.ts');
const { createFileMigrationSource, createMongoMigrationSource } = require('../src/lib/storage/v6MigrationSources.ts');
const { createD1MigrationTarget } = require('../src/lib/storage/d1/d1MigrationTarget.ts');
const { openLocalD1, applyLocalMigrations, localMigrationTarget } = require('./lib/local-d1.cjs');
const { argumentsFor, checkpointStore } = require('./v6-migrate-storage.cjs');
const sourceFor = records => ({ driver: 'file', shadow: true, async scan(visit) { for (const row of records) await visit(structuredClone(row)); } });
const product = id => ({ domain: 'products', value: domainJson(fixture(id)) });
const history = (id, price = 100) => ({ domain: 'price-history', value: { id: `history-${id}`, productId: 'one', source: 'accesstrade', price, currency: 'VND', availability: 'unknown', capturedAt: '2026-09-01T00:00:00.000Z', operationId: 'fixture', sourceHash: 'same-fact' } });
const memoryCheckpoint = () => { let value = null; return { async read() { return structuredClone(value); }, async write(next) { value = structuredClone(next); } }; };
let passed = 0, failed = 0;
async function test(name, work) { try { await work(); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); } }
async function local(work) {
  const handle = await openLocalD1({ testOnly: true });
  try { await applyLocalMigrations(handle); await work(localMigrationTarget(handle), handle); }
  finally { await handle.dispose(); }
}
async function main() {
  await test('default CLI inventory has no destination or write flag; unsafe arguments reject', () => {
    assert.equal(argumentsFor([]).command, 'inventory');
    for (const args of [['apply'],['apply','--apply','--remote'],['plan','--apply'],['dry-run','--token','test-only'],['inventory','--source','a','--source','b']]) assert.throws(() => argumentsFor(args));
    const result = spawnSync(process.execPath, ['scripts/v6-migrate-storage.cjs','apply','--apply','--run-id','unsafe','--source','.data'], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /MIGRATION_SHADOW_SOURCE_REQUIRED/);
  });
  await test('forged remote destination and foreign local handles are refused', async () => {
    assert.throws(() => localMigrationTarget({ db: {}, localOnly: true, testOnly: true }), /LOCAL_MIGRATION_TARGET_REQUIRED/);
    await assert.rejects(() => planV6Migration(sourceFor([]), { locality: 'LOCAL_SHADOW', remote: true, production: false }), /MIGRATION_LOCAL_TARGET_REQUIRED/);
    await assert.rejects(() => planV6Migration(createFileMigrationSource(path.join(process.cwd(),'.data'), true)), /MIGRATION_SOURCE_READ_FAILED/);
    await assert.rejects(() => checkpointStore(path.join(process.cwd(),'.data','forbidden-output')), /MIGRATION_OUTPUT_PATH_INVALID/);
  });
  await test('File source scan reads primary only and checkpoints live outside source', async () => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-tmp','v6-migration-file-'));
    fs.writeFileSync(path.join(directory,'products.json'), JSON.stringify([fixture('file-source')]));
    fs.writeFileSync(path.join(directory,'products.json.bak'), JSON.stringify([fixture('must-not-read-backup')]));
    fs.writeFileSync(path.join(directory,'automation-settings.json'), JSON.stringify({ enabled: false, freeOnly: true }));
    const before = fs.readFileSync(path.join(directory,'products.json'));
    const plan = await planV6Migration(createFileMigrationSource(directory, true));
    assert.equal(plan.rows.length, 2); assert.equal(plan.rows.filter(row => row.classification === 'MIGRATABLE').length, 2);
    assert.deepEqual(fs.readFileSync(path.join(directory,'products.json')), before);
    const checkpointDirectory = fs.mkdtempSync(path.join(process.cwd(),'.test-tmp','v6-checkpoint-'));
    const store = await checkpointStore(checkpointDirectory); await store.write({ migrationId:'fixture' }); assert.deepEqual(await store.read(), { migrationId:'fixture' });
  });
  await test('malformed collection syntax and oversized members fail closed without repair', async () => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-tmp','v6-migration-malformed-'));
    for (const raw of ['[{} {}]', '[{},]', '[{"value":"' + 'x'.repeat(1048577) + '"}]']) {
      fs.writeFileSync(path.join(directory, 'products.json'), raw);
      await assert.rejects(() => planV6Migration(createFileMigrationSource(directory)), /MIGRATION_SOURCE_READ_FAILED/);
      assert.equal(fs.readFileSync(path.join(directory,'products.json'),'utf8'), raw);
    }
  });
  await test('Mongo planning uses only the existing scan contract and never writes', async () => {
    const visited = [];
    const source = createMongoMigrationSource({ driver:'mongo', async scanCollection(name, visit) { visited.push(name); await visit(fixture('mongo-source'), 0); }, writeCollection() { assert.fail('write forbidden'); } }, ['products']);
    const plan = await planV6Migration(source); assert.equal(plan.sourceDriver,'mongo'); assert.equal(plan.rows[0].classification,'MIGRATABLE'); assert.deepEqual(visited,['products']);
  });
  await test('malformed, unsupported and unsafe publication records are explicitly classified', async () => {
    const secret = { ...fixture('secret'), secret: 'test-only-not-a-real-credential' };
    const plan = await planV6Migration(sourceFor([product('valid'), {domain:'products',value:{id:'bad'}}, {domain:'products',value:secret}, {domain:'jobs',value:null}, {domain:'products',value:{...fixture('unsafe'),status:'published',publicHidden:true}}]));
    assert.deepEqual(plan.rows.map(row=>row.classification), ['MIGRATABLE','QUARANTINE_MALFORMED','QUARANTINE_MALFORMED','UNSUPPORTED','QUARANTINE_MALFORMED']);
    assert.equal(JSON.stringify(plan).includes('test-only-not-a-real-credential'), false); assert.equal(plan.safeToApply,false);
  });
  await test('duplicate equivalence and conflicting source identity never amplify records', async () => local(async target => {
    const a = product('one');
    const equivalent = await planV6Migration(sourceFor([a,structuredClone(a)]),target);
    assert.deepEqual(equivalent.rows.map(row=>row.classification),['MIGRATABLE','DUPLICATE_EQUIVALENT']);
    const distinct = {domain:'products',value:fixture('other-id','one')};
    const conflict = await planV6Migration(sourceFor([a,distinct]),target);
    assert.deepEqual(conflict.rows.map(row=>row.classification),['QUARANTINE_CONFLICT','QUARANTINE_CONFLICT']);
    assert.equal(conflict.safeToApply,false);
  }));
  await test('similar titles with distinct stable identities stay distinct', async () => local(async target => {
    const records = [product('one'),product('two')]; records[1].value.title = records[0].value.title;
    const plan = await planV6Migration(sourceFor(records),target); assert.equal(plan.rows.filter(row=>row.classification==='MIGRATABLE').length,2);
  }));
  await test('plan/source fingerprints are deterministic and dry-run performs zero D1 writes', async () => local(async (target, handle) => {
    let writes = 0;
    const binding = { prepare(sql) { if (!/^\s*(SELECT|EXPLAIN)\b/i.test(sql)) writes++; return handle.db.prepare(sql); }, batch(statements) { writes++; return handle.db.batch(statements); } };
    const observedTarget = createD1MigrationTarget(binding,'LOCAL_TEST');
    const source = sourceFor([product('one'),history('a')]);
    const a = await planV6Migration(source, observedTarget), b = await planV6Migration(source, observedTarget);
    assert.equal(a.sourceFingerprint,b.sourceFingerprint); assert.equal(a.planFingerprint,b.planFingerprint); assert.equal(writes,0);
    assert.deepEqual(await target.counts(), { products:0,'price-history':0,'system-settings':0 });
    assert.equal(summarizeV6Plan(a).ROWS_PLANNED,2);
  }));
  await test('explicit apply and source shadow flags are required', async () => local(async target => {
    const source = sourceFor([product('one')]); const plan = await planV6Migration(source,target);
    await assert.rejects(() => applyV6Migration(source,target,plan,memoryCheckpoint()), /MIGRATION_EXPLICIT_APPLY_REQUIRED/);
    await assert.rejects(() => applyV6Migration({...source,shadow:false},target,plan,memoryCheckpoint(),{apply:true}), /MIGRATION_SHADOW_SOURCE_REQUIRED/);
    assert.equal((await target.counts()).products,0);
  }));
  await test('changed source or tampered plan aborts before any destination write', async () => local(async target => {
    const records = [product('one')], source = sourceFor(records); const plan = await planV6Migration(source,target);
    records[0].value.price = 999;
    await assert.rejects(() => applyV6Migration(source,target,plan,memoryCheckpoint(),{apply:true}), /MIGRATION_SOURCE_CHANGED/);
    await assert.rejects(() => applyV6Migration(source,target,{...plan,batchSize:100},memoryCheckpoint(),{apply:true}), /MIGRATION_PLAN_UNSAFE/);
    assert.equal((await target.counts()).products,0);
  }));
  await test('deterministic missing IDs converge without losing source identities', async () => local(async target => {
    const record = product('one'); delete record.value.id;
    const source = sourceFor([record]), plan = await planV6Migration(source,target);
    assert.match(plan.rows[0].targetId,/^migrated-[a-f0-9]{40}$/);
    await applyV6Migration(source,target,plan,memoryCheckpoint(),{apply:true});
    const replay = await applyV6Migration(source,target,plan,memoryCheckpoint(),{apply:true}); assert.equal(replay.rowsApplied,0); assert.equal((await target.counts()).products,1);
  }));
  await test('migration preserves repeated historical facts and settings; second apply is no-op', async () => local(async target => {
    const records = [product('one'),history('a'),history('b'),{domain:'system-settings',value:{id:'automation',value:{enabled:false,freeOnly:true}}}];
    const original = checksumJson(records), source = sourceFor(records), plan = await planV6Migration(source,target,{batchSize:1}), store = memoryCheckpoint();
    const first = await applyV6Migration(source,target,plan,store,{apply:true}); assert.equal(first.rowsApplied,4);
    const second = await applyV6Migration(source,target,plan,store,{apply:true}); assert.equal(second.rowsApplied,0); assert.equal(second.rowsSkipped,4);
    assert.deepEqual(await verifyV6Migration(source,target,plan),{SOURCE_VALID:4,DESTINATION_VALID:4,MATCHED:4,MISSING:0,EXTRA:0,CONFLICTS:0,RESULT:'PASS'});
    assert.equal(checksumJson(records), original); assert.equal((await target.counts())['price-history'],2);
  }));
  for (const injection of ['afterCommit','beforeCheckpoint','afterBatch']) await test(`interruption ${injection} resumes without duplicate amplification`, async () => local(async target => {
    const records = [product('one'),product('two'),product('three')], source = sourceFor(records), original = checksumJson(records);
    const plan = await planV6Migration(source,target,{batchSize:1}), store = memoryCheckpoint();
    await assert.rejects(() => applyV6Migration(source,target,plan,store,{apply:true,[injection]() { throw new Error('injected interruption'); }}), /MIGRATION_APPLY_FAILED/);
    const result = await applyV6Migration(source,target,plan,store,{apply:true}); assert.equal(result.status,'COMPLETED');
    assert.equal((await target.counts()).products,3); assert.equal((await verifyV6Migration(source,target,plan)).RESULT,'PASS'); assert.equal(checksumJson(records),original);
  }));
  await test('failed checkpoint after committed effect can resume with no checkpoint', async () => local(async target => {
    const source = sourceFor([product('one'),product('two')]), plan = await planV6Migration(source,target,{batchSize:1});
    await assert.rejects(() => applyV6Migration(source,target,plan,{async read(){return null;},async write(){throw new Error('checkpoint unavailable');}},{apply:true}), /MIGRATION_CHECKPOINT_WRITE_FAILED/);
    assert.equal((await target.counts()).products,1);
    await applyV6Migration(source,target,plan,memoryCheckpoint(),{apply:true}); assert.equal((await verifyV6Migration(source,target,plan)).RESULT,'PASS');
  }));
  await test('destination identity conflict introduced after plan aborts without overwrite', async () => local(async target => {
    const source = sourceFor([product('one')]), plan = await planV6Migration(source,target);
    await target.insert('products','different',fixture('different','one'));
    await assert.rejects(() => applyV6Migration(source,target,plan,memoryCheckpoint(),{apply:true}), /MIGRATION_DESTINATION_CONFLICT/);
    assert.equal(await target.read('products','one'),null); assert.equal((await target.counts()).products,1);
  }));
  await test('D1 failure after one insert surfaces safely and second successful apply converges', async () => local(async target => {
    const source = sourceFor([product('one'),product('two')]), plan = await planV6Migration(source,target,{batchSize:1}); let attempts = 0;
    const faulty = {...target, async insert(...args){if(++attempts === 2) throw new Error('test-only-driver-detail'); return target.insert(...args);}};
    const store = memoryCheckpoint(); await assert.rejects(() => applyV6Migration(source,faulty,plan,store,{apply:true}), error=>error.code==='MIGRATION_APPLY_FAILED' && error.cause===undefined);
    assert.equal((await target.counts()).products,1); await applyV6Migration(source,target,plan,store,{apply:true}); assert.equal((await verifyV6Migration(source,target,plan)).RESULT,'PASS');
  }));
  await test('verification detects missing, extra and conflicting domain data', async () => local(async target => {
    const source = sourceFor([product('one')]), plan = await planV6Migration(source,target);
    assert.equal((await verifyV6Migration(source,target,plan)).MISSING,1);
    await target.insert('products','extra',fixture('extra')); assert.equal((await verifyV6Migration(source,target,plan)).EXTRA,1);
    await target.insert('products','one',{...fixture('one'),price:999}); assert.equal((await verifyV6Migration(source,target,plan)).CONFLICTS,1);
  }));
  await test('history retention requires explicit deterministic cutoff; default skips nothing', async () => local(async target => {
    const source = sourceFor([product('one'),history('old')]);
    assert.equal((await planV6Migration(source,target)).rows[1].classification,'MIGRATABLE');
    assert.equal((await planV6Migration(source,target,{staleHistoryBefore:'2026-09-02T00:00:00.000Z'})).rows[1].classification,'SKIP_STALE');
  }));
  await test('batch and total-record ceilings fail closed without lowering test workload', async () => {
    const source = sourceFor([]);
    for (const batchSize of [0,101,1.5]) await assert.rejects(()=>planV6Migration(source,undefined,{batchSize}),/MIGRATION_BATCH_SIZE_INVALID/);
    const huge = {driver:'file',shadow:true,async scan(visit){for(let index=0;index<10001;index++)await visit({domain:'deferred',value:null});}};
    await assert.rejects(()=>planV6Migration(huge),/MIGRATION_SNAPSHOT_LIMIT/);
  });
}
main().catch(error=>{failed++;console.error('FAIL setup',error);}).finally(()=>{console.log(`V6 migration: ${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;});
