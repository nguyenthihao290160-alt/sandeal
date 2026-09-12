/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
require('./register-typescript.cjs');
const { getStorageAdapter } = require('../src/lib/storage/storageFactory.ts');
const { fileStorageAdapter } = require('../src/lib/storage/fileStorageAdapter.ts');
const previous = { SANDEAL_RUNTIME: process.env.SANDEAL_RUNTIME, SANDEAL_STORAGE_DRIVER: process.env.SANDEAL_STORAGE_DRIVER };
let passed = 0;
let failed = 0;
function test(name, work) {
  try { work(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
try {
  process.env.SANDEAL_STORAGE_DRIVER = 'file';
  test('absent runtime retains exact legacy file adapter', () => {
    delete process.env.SANDEAL_RUNTIME;
    assert.equal(getStorageAdapter(), fileStorageAdapter);
  });
  test('explicit legacy retains exact legacy file adapter', () => {
    process.env.SANDEAL_RUNTIME = 'legacy';
    assert.equal(getStorageAdapter(), fileStorageAdapter);
  });
  test('cloudflare cannot fall back to either legacy storage driver', () => {
    process.env.SANDEAL_RUNTIME = 'cloudflare';
    for (const driver of ['file', 'mongo', 'd1', '']) {
      process.env.SANDEAL_STORAGE_DRIVER = driver;
      assert.throws(getStorageAdapter, /^Error: CLOUDFLARE_STORAGE_BINDING_UNAVAILABLE$/);
    }
  });
  test('unknown runtime rejects before selecting or configuring storage', () => {
    process.env.SANDEAL_RUNTIME = 'unknown-fixture';
    process.env.SANDEAL_STORAGE_DRIVER = 'file';
    assert.throws(getStorageAdapter, error => error.code === 'SANDEAL_RUNTIME_UNSUPPORTED');
  });
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
console.log(`V6 storage architecture: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
