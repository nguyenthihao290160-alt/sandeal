/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('./register-typescript.cjs');
const { createLegacySettingsStore } = require('../src/lib/storage/legacySettingsStore.ts');
const { getSettingsStore, validateSettingsValue } = require('../src/lib/storage/settingsStore.ts');
const automation = require('../src/lib/storage/automationSettings.ts');
const scheduler = require('../src/lib/bots/schedulerConfig.ts');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sandeal-v6-settings-'));
const previousRuntime = process.env.SANDEAL_RUNTIME;
let passed = 0;
let failed = 0;
async function test(name, work) {
  try { await work(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
function memorySettings() {
  const values = new Map();
  return {
    values,
    async read(key) { return values.has(key) ? structuredClone(values.get(key)) : null; },
    async write(key, value) {
      validateSettingsValue(key, value);
      values.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

async function main() {
  await test('settings domain modules contain no filesystem paths or imports', async () => {
    for (const filename of ['src/lib/storage/automationSettings.ts', 'src/lib/bots/schedulerConfig.ts']) {
      const source = await fs.promises.readFile(path.join(process.cwd(), filename), 'utf8');
      assert.doesNotMatch(source, /(?:from\s+['"](?:node:)?(?:fs|path)['"]|getDataDir|ensureDataDir|automation-settings\.json|scheduler-config\.json)/);
    }
  });
  await test('explicit application settings operate with filesystem access forbidden', async () => {
    process.env.SANDEAL_RUNTIME = 'cloudflare';
    const store = memorySettings();
    const original = {};
    let calls = 0;
    for (const method of ['readFile', 'writeFile', 'mkdir', 'rename', 'open', 'stat', 'access']) {
      original[method] = fs.promises[method];
      fs.promises[method] = async () => { calls++; throw new Error('FORBIDDEN_FILESYSTEM'); };
    }
    try {
      const initial = await automation.getAutomationSettings(store);
      assert.equal(initial.enabled, false);
      assert.equal(initial.allowPaidAi, false);
      const saved = await automation.updateAutomationSettings({ enabled: true, maxItemsPerRun: 20 }, store);
      assert.equal(saved.maxItemsPerRun, 20);
      assert.equal((await automation.getAutomationSettings(store)).enabled, true);
      const updated = await scheduler.updateSchedulerConfig({ enabled: true, intervalMinutes: 30 }, store);
      assert.equal(updated.error, undefined);
      assert.equal(updated.config.intervalMinutes, 30);
      assert.equal(typeof updated.config.nextRunAt, 'string');
      const completed = await scheduler.markSchedulerRunCompleted(store);
      assert.equal(new Date(completed.nextRunAt).getTime() - new Date(completed.lastRunAt).getTime(), 30 * 60_000);
      assert.equal(calls, 0);
    } finally {
      Object.assign(fs.promises, original);
    }
  });
  await test('automation safety policies cannot be enabled through the settings seam', async () => {
    const store = memorySettings();
    for (const update of [{ allowPaidAi: true }, { freeOnly: false }, { safePublish: false }, { costMode: 'paid' }]) {
      await assert.rejects(automation.updateAutomationSettings(update, store), /Policy violation/);
    }
    assert.equal(store.values.size, 0);
  });
  await test('automation clamps and daily/run relationship stay equivalent', async () => {
    const result = await automation.updateAutomationSettings({ maxItemsPerRun: 500, maxItemsPerDay: 2, maxConcurrency: 20 }, memorySettings());
    assert.equal(result.maxItemsPerRun, 50);
    assert.equal(result.maxItemsPerDay, 50);
    assert.equal(result.maxConcurrency, 4);
    assert.equal(result.freeOnly, true);
  });
  await test('scheduler rejects too-small interval without persisting an update', async () => {
    const store = memorySettings();
    const result = await scheduler.updateSchedulerConfig({ intervalMinutes: 1, enabled: true }, store);
    assert.equal(typeof result.error, 'string');
    assert.equal(result.config.enabled, false);
    assert.equal(result.config.intervalMinutes, 60);
    assert.equal(store.values.size, 0);
  });
  await test('scheduler disabled state removes next run and retains existing last run', async () => {
    const store = memorySettings();
    await store.write('scheduler', { enabled: true, intervalMinutes: 60, mode: 'full_safe_run', lastRunAt: '2026-09-08T00:00:00.000Z', nextRunAt: '2026-09-08T01:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z' });
    const result = await scheduler.updateSchedulerConfig({ enabled: false }, store);
    assert.equal(result.config.nextRunAt, undefined);
    assert.equal(result.config.lastRunAt, '2026-09-08T00:00:00.000Z');
    assert.equal(Object.hasOwn(store.values.get('scheduler'), 'nextRunAt'), false);
  });
  await test('injected read and write failures propagate without synthetic defaults', async () => {
    const readFailure = new Error('TEST_SETTINGS_READ_FAILED');
    const writeFailure = new Error('TEST_SETTINGS_WRITE_FAILED');
    const brokenRead = { read: async () => { throw readFailure; }, write: async () => {} };
    const brokenWrite = { read: async () => null, write: async () => { throw writeFailure; } };
    await assert.rejects(automation.getAutomationSettings(brokenRead), error => error === readFailure);
    await assert.rejects(scheduler.getSchedulerConfig(brokenRead), error => error === readFailure);
    await assert.rejects(automation.updateAutomationSettings({ enabled: true }, brokenWrite), error => error === writeFailure);
    await assert.rejects(scheduler.updateSchedulerConfig({ enabled: true }, brokenWrite), error => error === writeFailure);
  });
  await test('legacy absent and corrupt singleton files retain safe defaults', async () => {
    const adapter = { getDataDir: () => temporary, ensureDataDir: () => fs.promises.mkdir(temporary, { recursive: true }) };
    const store = createLegacySettingsStore(adapter);
    assert.equal((await automation.getAutomationSettings(store)).enabled, false);
    assert.equal((await scheduler.getSchedulerConfig(store)).enabled, false);
    for (const filename of ['automation-settings.json', 'scheduler-config.json']) {
      await fs.promises.writeFile(path.join(temporary, filename), '{invalid fixture');
    }
    assert.equal((await automation.getAutomationSettings(store)).enabled, false);
    assert.equal((await scheduler.getSchedulerConfig(store)).enabled, false);
  });
  await test('legacy preserves singleton filenames and writes by atomic replacement', async () => {
    const store = createLegacySettingsStore({ getDataDir: () => temporary, ensureDataDir: () => fs.promises.mkdir(temporary, { recursive: true }) });
    const originalRename = fs.promises.rename;
    const renames = [];
    fs.promises.rename = async (from, to) => { renames.push({ from, to }); await originalRename(from, to); };
    try {
      await automation.updateAutomationSettings({ enabled: true }, store);
      await scheduler.updateSchedulerConfig({ enabled: true, intervalMinutes: 45 }, store);
    } finally { fs.promises.rename = originalRename; }
    assert.equal(renames.length, 2);
    assert.deepEqual(renames.map(entry => path.basename(entry.to)), ['automation-settings.json', 'scheduler-config.json']);
    for (const entry of renames) assert.equal(entry.from.startsWith(`${entry.to}.tmp.`), true);
    assert.equal((await automation.getAutomationSettings(store)).enabled, true);
    assert.equal((await scheduler.getSchedulerConfig(store)).intervalMinutes, 45);
    assert.equal((await fs.promises.readdir(temporary)).filter(name => name.includes('.tmp.')).length, 0);
  });
  await test('credential keys and credential-shaped values never reach settings rows', async () => {
    const store = memorySettings();
    const forbidden = [
      { apiKey: 'fixture-only' }, { token: 'fixture-only' }, { password: 'fixture-only' },
      { source: 'Bearer fixture-only' }, { source: 'https://fixture:example@example.invalid/' },
      { source: 'https://example.invalid/?api_key=fixture-only' },
    ];
    for (const value of forbidden) {
      await assert.rejects(store.write('automation', value), error => error.code === 'SETTINGS_SECRET_FORBIDDEN');
    }
    assert.equal(store.values.size, 0);
    await assert.rejects(automation.updateAutomationSettings({ token: 'fixture-only' }, store), error => error.code === 'SETTINGS_SECRET_FORBIDDEN');
  });
  await test('runtime configuration and unowned nested settings are rejected', async () => {
    for (const value of [{ runtime: 'cloudflare' }, { bindings: {} }, { source: { nested: 'value' } }]) {
      assert.throws(() => validateSettingsValue('automation', value), error => error.code === 'SETTINGS_VALUE_INVALID');
    }
    assert.throws(() => validateSettingsValue('unknown', {}), error => error.code === 'SETTINGS_VALUE_INVALID');
    assert.throws(() => validateSettingsValue('automation', { source: 'x'.repeat(65_537) }), error => error.code === 'SETTINGS_VALUE_INVALID');
    assert.doesNotThrow(() => validateSettingsValue('automation', { allowPaidAi: false, freeOnly: true, safePublish: true }));
  });
  await test('Cloudflare default settings lookup rejects missing storage binding', async () => {
    process.env.SANDEAL_RUNTIME = 'cloudflare';
    assert.throws(getSettingsStore, /CLOUDFLARE_STORAGE_BINDING_UNAVAILABLE/);
    await assert.rejects(automation.getAutomationSettings(), /CLOUDFLARE_STORAGE_BINDING_UNAVAILABLE/);
    await assert.rejects(scheduler.getSchedulerConfig(), /CLOUDFLARE_STORAGE_BINDING_UNAVAILABLE/);
  });
}

main().catch(error => { failed++; console.error(error); }).finally(() => {
  if (previousRuntime === undefined) delete process.env.SANDEAL_RUNTIME; else process.env.SANDEAL_RUNTIME = previousRuntime;
  // This exact directory is test-owned and was created with mkdtemp above.
  assert.equal(path.dirname(temporary), os.tmpdir());
  assert.equal(path.basename(temporary).startsWith('sandeal-v6-settings-'), true);
  fs.rmSync(temporary, { recursive: true, force: true });
  console.log(`V6 settings seam: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
});
