/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./lib/cloudflare-autopilot-test.cjs');
const { makeMessage, jobId } = require('../src/lib/platform/cloudflareContracts.ts');
const { recordEvidence } = require('./v6-run-state.cjs');
let passed = 0, failed = 0;
async function test(name, work) { try { await work(); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); } }
async function main() {
  await fixture(async f => {
    const worker = await f.runtime.mf.getWorker();
    await f.store.createTask({ id: 'autopilot-smoke', type: f.input.type, payload: f.input.payload, enabled: true, nextRunAt: f.now, intervalMs: 3600000 });
    const id = jobId(`cron:autopilot-smoke:${f.now}`);
    await test('actual workerd Cron event sends to local Queue and consumer commits D1 effect', async () => {
      assert.equal((await worker.scheduled({ scheduledTime: new Date(f.now), cron: '*/5 * * * *' })).outcome, 'ok');
      // Bounded test observation of emulator delivery; no polling exists in runtime code.
      for (let i = 0; i < 80; i++) { if ((await f.store.get(id))?.status === 'SUCCEEDED') break; await new Promise(resolve => setTimeout(resolve, 100)); }
      const job = await f.store.get(id); assert.equal(job.status, 'SUCCEEDED'); assert.equal(job.attemptCount, 1); assert.deepEqual(job.result, { snapshotCreated: true });
      assert.equal((await f.history()).length, 1);
    });
    await test('duplicate native Cron event leaves one scheduled job and one effect', async () => {
      assert.equal((await worker.scheduled({ scheduledTime: new Date(f.now), cron: '*/5 * * * *' })).outcome, 'ok');
      assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM automation_jobs').first()).n, 1); assert.equal((await f.history()).length, 1);
    });
    await test('duplicate message through native workerd queue handler acknowledges completed effect', async () => {
      const job = await f.store.get(id);
      const result = await worker.queue('sandeal-local-jobs', [{ id: 'native-duplicate', timestamp: new Date(), attempts: 1, body: makeMessage(job) }]);
      assert.equal(result.outcome, 'ok'); assert.deepEqual(result.explicitAcks, ['native-duplicate']); assert.deepEqual(result.retryMessages, []);
      assert.equal((await f.store.get(id)).status, 'SUCCEEDED'); assert.equal((await f.store.get(id)).attemptCount, 1); assert.equal((await f.history()).length, 1);
    });
    await test('compiled event runtime has no filesystem, legacy process or continuous timer dependency', () => {
      const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(f.runtime.built.file), 'metafile.json')));
      assert.equal(Object.keys(meta.inputs).some(name => /fileStorageAdapter|mongoStorageAdapter|legacySettingsStore|automation-worker|automation-scheduler/.test(name)), false);
      const imports = Object.values(meta.outputs).flatMap(row => row.imports.map(item => item.path));
      assert.deepEqual([...new Set(imports)].sort(), ['node:async_hooks','node:crypto']);
      for (const filename of ['src/lib/platform/cloudflareAdapters.ts','src/lib/runtime/cloudflare/autopilot.ts','src/lib/storage/d1/d1JobStore.ts']) {
        assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /while\s*\(\s*true\s*\)|setInterval\s*\(|setTimeout\s*\(|process\.(?:pid|uptime|cwd)|heartbeatAt\s*[:=]/);
      }
    });
    if (!failed) {
      const proof = { CRON: 'PASS', QUEUE: 'PASS', D1: 'PASS', JOB_STATE: 'SUCCEEDED', DUPLICATE_DELIVERY: 'SAFE', DUPLICATE_DOMAIN_EFFECT: 0,
        FILE_STORAGE_CALLS: 0, FILESYSTEM_SETTINGS_CALLS: 0, PM2_REQUIRED: 'NO', VPS_REQUIRED: 'NO', LONG_RUNNING_PROCESS_REQUIRED: 'NO',
        PRODUCTION_QUEUE_CREATED: 'NO', PRODUCTION_CRON_CREATED: 'NO', DEPLOYED: 'NO' };
      recordEvidence('autopilot-local-smoke', proof); console.log(JSON.stringify(proof));
    }
  }, { queue: true });
}
main().catch(error => { failed++; console.error('FAIL setup', error); }).finally(() => { console.log(`V6 Cloudflare autopilot: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0; });
