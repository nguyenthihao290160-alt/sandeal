/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
require('./register-typescript.cjs');
const { shadowFixture } = require('./fixtures/v6-migration-shadow.cjs');
const { productIdentityKeys } = require('../src/lib/storage/productIdentity.ts');
const { createD1StorageAdapter } = require('../src/lib/storage/d1/d1StorageAdapter.ts');
const { openLocalD1, applyLocalMigrations, localMigrationTarget } = require('./lib/local-d1.cjs');
const { createFileMigrationSource } = require('../src/lib/storage/v6MigrationSources.ts');
const { planV6Migration, applyV6Migration, verifyV6Migration } = require('../src/lib/storage/v6MigrationEngine.ts');
let passed = 0, failed = 0;
async function test(name, work) { try { await work(); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); } }
function fingerprint(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map(name=>[name,{hash:createHash('sha256').update(fs.readFileSync(path.join(directory,name))).digest('hex'),mtime:fs.statSync(path.join(directory,name)).mtimeMs}]));
}
async function main() {
  const runId = `proof-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const directory = fs.mkdtempSync(path.join(process.cwd(),'.test-tmp','v6-shadow-proof-'));
  const original = path.join(directory,'fixture-original'), input = path.join(directory,'shadow-input');
  fs.mkdirSync(original); fs.mkdirSync(input);
  const data = shadowFixture();
  for (const [name, value] of Object.entries(data)) { fs.writeFileSync(path.join(original,name),JSON.stringify(value)); fs.copyFileSync(path.join(original,name),path.join(input,name)); }
  const originalBefore = fingerprint(original), inputBefore = fingerprint(input), commands = [];
  fs.writeFileSync(path.join(directory,'source-hashes-before.json'),JSON.stringify({sourceType:'PRODUCTION_SHAPED_FIXTURE',original:originalBefore,input:inputBefore},null,2));
  function command(mode, extra = []) {
    const args = ['scripts/v6-migrate-storage.cjs',mode,'--source',input,...(mode==='inventory'?[]:['--shadow-source','--run-id',runId]),...extra];
    const result = spawnSync(process.execPath,args,{cwd:process.cwd(),encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
    fs.writeFileSync(path.join(directory,`command-${commands.length}-${mode}.log`),`${result.stdout || ''}${result.stderr || ''}`);
    assert.equal(result.status,0,result.stderr); const report=JSON.parse(result.stdout);
    commands.push({mode,exit:result.status,report}); return report;
  }
  let plan, first, second, parity;
  await test('shadow input is a separate byte-equivalent fixture copy', () => {
    assert.notEqual(original,input); assert.equal(Object.keys(inputBefore).length,4);
    for (const name of Object.keys(originalBefore)) assert.equal(originalBefore[name].hash,inputBefore[name].hash);
  });
  await test('CLI inventory classifies 99 observations with one explicit equivalent duplicate', () => {
    const inventory=command('inventory'); assert.equal(inventory.ROWS_READ,99); assert.equal(inventory.ROWS_PLANNED,98); assert.equal(inventory.domains.products.DUPLICATE,1); assert.equal(inventory.D1_WRITES,0);
  });
  await test('shadow schema initialization is explicitly local and never production', () => {
    const initialized=command('init-shadow',['--apply']); assert.equal(initialized.REMOTE,false); assert.equal(initialized.PRODUCTION,false); assert.equal(initialized.LOCAL_ONLY,true);
  });
  await test('CLI plan and dry-run agree and perform zero D1 writes', () => {
    plan=command('plan',['--batch-size','10']); const dry=command('dry-run',['--batch-size','10']);
    assert.equal(plan.SAFE_TO_APPLY,'YES'); assert.equal(dry.SOURCE_FINGERPRINT,plan.SOURCE_FINGERPRINT); assert.equal(dry.PLAN_FINGERPRINT,plan.PLAN_FINGERPRINT); assert.equal(dry.D1_WRITES,0);
  });
  await test('first CLI apply migrates exactly 98 unique domain records in bounded batches', () => {
    first=command('apply',['--apply']); assert.equal(first.status,'COMPLETED'); assert.equal(first.rowsApplied,98); assert.equal(first.rowsSkipped,1); assert.equal(first.lastBatch,10);
  });
  await test('CLI verification finds no unexplained missing, extra or conflicting data', () => {
    parity=command('verify'); assert.deepEqual(parity,{SOURCE_VALID:98,DESTINATION_VALID:98,MATCHED:98,MISSING:0,EXTRA:0,CONFLICTS:0,RESULT:'PASS'});
  });
  await test('second CLI apply converges with zero changes', () => {
    second=command('apply',['--apply']); assert.equal(second.rowsApplied,0); assert.equal(second.rowsSkipped,99); assert.equal(second.status,'COMPLETED');
    assert.deepEqual(command('verify'),parity);
  });
  const local = await openLocalD1({testOnly:false,shadowId:runId});
  try {
    const target=localMigrationTarget(local), adapter=createD1StorageAdapter(local.db);
    await test('all canonical source mappings and offer projections match domain truth', async () => {
      for (const value of data['products.json'].slice(0,32)) {
        assert.deepEqual(await target.identityOwners(value),[value.id]);
        const identities=(await local.db.prepare("SELECT identity_key FROM product_identities WHERE namespace='SOURCE' AND product_id=? ORDER BY identity_key LIMIT 256").bind(value.id).all()).results.map(row=>row.identity_key);
        assert.deepEqual(identities,productIdentityKeys(value).sort());
        const offers=(await local.db.prepare('SELECT payload FROM product_offers WHERE product_id=? ORDER BY id LIMIT 50').bind(value.id).all()).results.map(row=>JSON.parse(row.payload));
        assert.deepEqual(offers,value.offers);
      }
    });
    await test('publication states, bounded history and non-secret settings preserve source facts', async () => {
      for (const value of data['products.json'].slice(0,32)) {
        const migrated=(await adapter.domain.getProduct(value.id)).value;
        assert.equal(migrated.status,value.status); assert.equal(migrated.publicHidden,value.publicHidden); assert.equal(migrated.needsVerification,value.needsVerification);
        const recent=await adapter.domain.getPriceHistory({productId:value.id,limit:1}); assert.equal(recent.length,1); assert.equal(recent[0].capturedAt,'2026-09-02T00:00:00.000Z'); assert.equal(recent[0].price,value.price);
      }
      assert.deepEqual(await adapter.settingsStore.read('automation'),data['automation-settings.json']);
      assert.deepEqual(await adapter.settingsStore.read('scheduler'),data['scheduler-config.json']);
    });
  } finally { await local.dispose(); }
  await test('actual CLI rejects remote and authoritative-source apply before writes', () => {
    for (const [args, code] of [
      [['apply','--apply','--run-id',runId,'--source',input,'--shadow-source','--remote'], 'MIGRATION_ARGUMENT_UNKNOWN'],
      [['apply','--apply','--run-id',runId,'--source','.data'], 'MIGRATION_SHADOW_SOURCE_REQUIRED'],
      [['apply','--apply','--run-id',runId,'--source','.data','--shadow-source'], 'MIGRATION_SHADOW_PATH_REQUIRED'],
    ]) {
      const result=spawnSync(process.execPath,['scripts/v6-migrate-storage.cjs',...args],{encoding:'utf8',timeout:30000});
      assert.equal(result.status,1); assert.match(result.stderr,new RegExp(code));
    }
  });
  const failureLocal = await openLocalD1({testOnly:true});
  try {
    await applyLocalMigrations(failureLocal);
    const target=localMigrationTarget(failureLocal), source=createFileMigrationSource(input,true);
    const safePlan=await planV6Migration(source,target,{batchSize:10});
    const checkpoint=()=>{let value=null;return {async read(){return value;},async write(next){value=structuredClone(next);}};};
    await test('stale plan and separately changed source reject without destination effects',async()=>{
      await assert.rejects(()=>applyV6Migration(source,target,{...safePlan,batchSize:11},checkpoint(),{apply:true}),/MIGRATION_PLAN_UNSAFE/);
      // Deliberately altered negative input is separate from the immutable parity source.
      const changed=path.join(directory,'negative-changed-source'); fs.mkdirSync(changed);
      for(const name of Object.keys(data))fs.copyFileSync(path.join(input,name),path.join(changed,name));
      const rows=structuredClone(data['products.json']); rows[0].price++;
      fs.writeFileSync(path.join(changed,'products.json'),JSON.stringify(rows));
      await assert.rejects(()=>applyV6Migration(createFileMigrationSource(changed,true),target,safePlan,checkpoint(),{apply:true}),/MIGRATION_SOURCE_CHANGED/);
      assert.deepEqual(await target.counts(),{products:0,'price-history':0,'system-settings':0});
    });
    await test('malformed and identity-conflicting fixtures quarantine and block apply',async()=>{
      const negative=path.join(directory,'negative-quarantine');fs.mkdirSync(negative);
      const conflict=structuredClone(data['products.json'][0]); conflict.id='conflicting-canonical-id'; conflict.slug='conflicting-slug';
      fs.writeFileSync(path.join(negative,'products.json'),JSON.stringify([data['products.json'][0],conflict,{id:'malformed-fixture'}]));
      const inputSource=createFileMigrationSource(negative,true), blocked=await planV6Migration(inputSource,target);
      assert.deepEqual(blocked.rows.map(row=>row.classification),['QUARANTINE_CONFLICT','QUARANTINE_CONFLICT','QUARANTINE_MALFORMED']);
      await assert.rejects(()=>applyV6Migration(inputSource,target,blocked,checkpoint(),{apply:true}),/MIGRATION_PLAN_UNSAFE/);
      assert.equal((await target.counts()).products,0);
    });
    await test('interrupted production-shaped apply resumes and converges after committed effect',async()=>{
      const store=checkpoint();
      await assert.rejects(()=>applyV6Migration(source,target,safePlan,store,{apply:true,afterCommit(){throw new Error('fixture-interruption');}}),/MIGRATION_APPLY_FAILED/);
      assert.equal((await target.counts()).products,1);
      const resumed=await applyV6Migration(source,target,safePlan,store,{apply:true}); assert.equal(resumed.status,'COMPLETED');
      assert.equal((await verifyV6Migration(source,target,safePlan)).RESULT,'PASS');
      assert.equal((await applyV6Migration(source,target,safePlan,store,{apply:true})).rowsApplied,0);
    });
  } finally { await failureLocal.dispose(); }
  await test('source fixture and shadow-copy bytes and mtimes remain unchanged', () => {
    assert.deepEqual(fingerprint(original),originalBefore); assert.deepEqual(fingerprint(input),inputBefore);
    assert.equal(fs.readdirSync(path.join(process.cwd(),'.data')).length,0);
  });
  const originalAfter=fingerprint(original), inputAfter=fingerprint(input);
  fs.writeFileSync(path.join(directory,'source-hashes-after.json'),JSON.stringify({original:originalAfter,input:inputAfter},null,2));
  fs.writeFileSync(path.join(directory,'evidence.json'),JSON.stringify({runId,sourceType:'PRODUCTION_SHAPED_FIXTURE',sourceIsShadowCopy:true,remote:false,production:false,
    originalBefore,inputBefore,originalAfter,inputAfter,sourceChanged:JSON.stringify(inputBefore)!==JSON.stringify(inputAfter),commands,firstApply:first,secondApply:second,parity,passed,failed},null,2));
  console.log(`EVIDENCE_DIRECTORY=${directory}`);
}
main().catch(error=>{failed++;console.error('FAIL setup',error);}).finally(()=>{console.log(`V6 shadow migration: ${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;});
