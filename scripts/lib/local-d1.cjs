/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const handles = new WeakSet();
const configPath = path.join(root, 'config/cloudflare/wrangler.local.jsonc');
const migrationDirectory = path.join(root, 'src/lib/storage/d1/migrations');

async function openLocalD1({ testOnly = true, shadowId } = {}) {
  if (shadowId !== undefined && (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(shadowId) || testOnly)) throw new Error('LOCAL_D1_SHADOW_ID_INVALID');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('LOCAL_D1_REQUIRES_NODE_22_OR_NEWER');
  process.env.WRANGLER_SEND_METRICS = 'false';
  const { getPlatformProxy } = require('wrangler');
  const platform = await getPlatformProxy({ configPath, envFiles: [], remoteBindings: false,
    persist: testOnly ? false : { path: shadowId ? path.join(root, '.wrangler/sandeal-shadow', shadowId) : path.join(root, '.wrangler/sandeal-local/v3') } });
  if (!platform.env.DB) { await platform.dispose(); throw new Error('LOCAL_D1_BINDING_REQUIRED'); }
  const handle = { db: platform.env.DB, dispose: platform.dispose, testOnly, localOnly: true, shadowId };
  handles.add(handle); return handle;
}

async function applyLocalMigrations(handle, { dryRun = false } = {}) {
  if (!handles.has(handle)) throw new Error('LOCAL_MIGRATION_HANDLE_REQUIRED');
  const db = handle.db;
  const ledger = await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='d1_migrations' LIMIT 1").first();
  const applied = new Set(ledger ? (await db.prepare('SELECT name FROM d1_migrations ORDER BY id LIMIT 1000').all()).results.map(row => row.name) : []);
  const files = fs.readdirSync(migrationDirectory).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (files.length > 50) throw new Error('LOCAL_MIGRATION_PLAN_LIMIT');
  const plan = files.map(name => {
    const sql = fs.readFileSync(path.join(migrationDirectory, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex'), applied: applied.has(name) };
  });
  if (!dryRun && !ledger) await db.prepare('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)').run();
  if (!dryRun) for (const migration of plan.filter(item => !item.applied)) {
    // Explicit markers keep whole SQLite trigger bodies together. No runtime SQL parser.
    const statements = migration.sql.split('-- statement-breakpoint').map(sql => sql.trim()).filter(sql => sql && !/^--[^\n]*$/.test(sql));
    await db.batch([...statements.map(sql => db.prepare(sql)), db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(migration.name)]);
  }
  return plan.map(({ name, checksum, applied }) => ({ name, checksum, action: applied ? 'ALREADY_APPLIED' : dryRun ? 'PENDING' : 'APPLIED' }));
}
function localMigrationTarget(handle) {
  if (!handles.has(handle) || (!handle.testOnly && !handle.shadowId)) throw new Error('LOCAL_MIGRATION_TARGET_REQUIRED');
  const { createD1MigrationTarget } = require('../../src/lib/storage/d1/d1MigrationTarget.ts');
  return createD1MigrationTarget(handle.db, handle.testOnly ? 'LOCAL_TEST' : 'LOCAL_SHADOW');
}
module.exports = { openLocalD1, applyLocalMigrations, configPath, localMigrationTarget };
