/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs/promises');
const path = require('node:path');
require('./register-typescript.cjs');
const { createFileMigrationSource, createMongoMigrationSource } = require('../src/lib/storage/v6MigrationSources.ts');
const { planV6Migration, summarizeV6Plan, applyV6Migration, verifyV6Migration } = require('../src/lib/storage/v6MigrationEngine.ts');
const { openLocalD1, applyLocalMigrations, localMigrationTarget } = require('./lib/local-d1.cjs');
const root = path.resolve(__dirname, '..');

function argumentsFor(argv) {
  const command = argv[0] || 'inventory';
  if (!['inventory','plan','dry-run','apply','verify','init-shadow'].includes(command)) throw new Error('MIGRATION_COMMAND_INVALID');
  const values = new Map(), flags = new Set();
  for (let index = 1; index < argv.length; index++) {
    const key = argv[index];
    if (['--apply','--shadow-source'].includes(key)) {
      if (flags.has(key)) throw new Error('MIGRATION_ARGUMENT_DUPLICATE'); flags.add(key);
    } else if (['--source','--source-driver','--run-id','--batch-size'].includes(key)) {
      if (values.has(key) || !argv[index+1] || argv[index+1].startsWith('--')) throw new Error('MIGRATION_ARGUMENT_INVALID');
      values.set(key, argv[++index]);
    } else throw new Error('MIGRATION_ARGUMENT_UNKNOWN');
  }
  if (['apply','init-shadow'].includes(command) !== flags.has('--apply')) throw new Error('MIGRATION_EXPLICIT_APPLY_REQUIRED');
  return { command, values, flags };
}
async function containedPath(parent, child) {
  const resolvedParent = await fs.realpath(parent), resolvedChild = await fs.realpath(child);
  if (!resolvedChild.startsWith(resolvedParent + path.sep)) throw new Error('MIGRATION_SHADOW_PATH_REQUIRED');
  return resolvedChild;
}
async function checkpointStore(directory) {
  await ensureOutputDirectory(directory);
  const filename = path.join(directory, 'checkpoint.json');
  return {
    async read() {
      try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw new Error('MIGRATION_CHECKPOINT_INVALID'); }
    },
    async write(value) {
      const temporary = path.join(directory, `checkpoint-${process.pid}.tmp`);
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
      await fs.rename(temporary, filename);
    },
  };
}
async function ensureOutputDirectory(directory) {
  const approved = path.join(root, '.test-tmp');
  if (!directory.startsWith(approved + path.sep)) throw new Error('MIGRATION_OUTPUT_PATH_INVALID');
  if (await fs.realpath(approved) !== approved) throw new Error('MIGRATION_OUTPUT_PATH_INVALID');
  let current = approved;
  for (const part of path.relative(approved, directory).split(path.sep)) {
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('MIGRATION_OUTPUT_PATH_INVALID');
  }
}
async function main(argv = process.argv.slice(2)) {
  const { command, values, flags } = argumentsFor(argv);
  const runId = values.get('--run-id');
  if (command !== 'inventory' && (!runId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId))) throw new Error('MIGRATION_RUN_ID_REQUIRED');
  let sourceDirectory = path.resolve(values.get('--source') || path.join(root, '.data'));
  const driver = values.get('--source-driver') || 'file';
  if (!['file','mongo'].includes(driver)) throw new Error('MIGRATION_SOURCE_DRIVER_INVALID');
  if (driver === 'file' && command !== 'init-shadow') sourceDirectory = await fs.realpath(sourceDirectory);
  if (flags.has('--shadow-source')) sourceDirectory = await containedPath(path.join(root, '.test-tmp'), sourceDirectory);
  if (command === 'apply' && (driver !== 'file' || !flags.has('--shadow-source'))) throw new Error('MIGRATION_SHADOW_SOURCE_REQUIRED');
  let source;
  if (driver === 'mongo') {
    // Planning only against explicitly configured local Mongo; never accept a
    // connection URI on the command line or initialize a Mongo schema.
    const uri = new URL(process.env.MONGODB_URI || 'invalid:');
    if (uri.protocol !== 'mongodb:' || !['127.0.0.1','localhost','[::1]'].includes(uri.hostname)) throw new Error('MIGRATION_LOCAL_MONGO_REQUIRED');
    const { createMongoStorageAdapter } = require('../src/lib/storage/mongoStorageAdapter.ts');
    const { MONGO_LOGICAL_COLLECTIONS } = require('../src/lib/storage/mongoSchema.ts');
    source = createMongoMigrationSource(createMongoStorageAdapter({ driver: 'mongo', database: process.env.MONGODB_DATABASE || 'sandeal' }), [...MONGO_LOGICAL_COLLECTIONS, 'system-settings']);
  } else source = createFileMigrationSource(sourceDirectory, flags.has('--shadow-source'));
  if (command === 'inventory') {
    const plan = await planV6Migration(source); console.log(JSON.stringify({ ...summarizeV6Plan(plan), D1_WRITES: 0 }, null, 2)); return;
  }
  const local = await openLocalD1({ testOnly: false, shadowId: runId });
  const directory = path.join(root, '.test-tmp/v6-migrations', runId);
  try {
    if (command === 'init-shadow') {
      console.log(JSON.stringify({ LOCAL_ONLY: true, REMOTE: false, PRODUCTION: false, migrations: await applyLocalMigrations(local) })); return;
    }
    const target = localMigrationTarget(local);
    if (command === 'plan' || command === 'dry-run') {
      const plan = await planV6Migration(source, target, { batchSize: values.has('--batch-size') ? Number(values.get('--batch-size')) : undefined });
      if (command === 'plan') {
        if (source.directory && (directory === source.directory || directory.startsWith(source.directory + path.sep))) throw new Error('MIGRATION_OUTPUT_INSIDE_SOURCE');
        await ensureOutputDirectory(directory);
        await fs.writeFile(path.join(directory, 'plan.json'), JSON.stringify(plan, null, 2), { flag: 'wx' });
      }
      console.log(JSON.stringify({ ...summarizeV6Plan(plan), D1_WRITES: 0, ESTIMATE_KIND: 'LOGICAL_ROW_UPPER_BOUND_NOT_BILLING' }, null, 2)); return;
    }
    await containedPath(path.join(root, '.test-tmp'), directory);
    const planFile = path.join(directory, 'plan.json');
    if ((await fs.stat(planFile)).size > 8 * 1024 * 1024) throw new Error('MIGRATION_PLAN_LIMIT');
    const plan = JSON.parse(await fs.readFile(planFile, 'utf8'));
    if (command === 'verify') {
      const result = await verifyV6Migration(source, target, plan); console.log(JSON.stringify(result, null, 2));
      if (result.RESULT !== 'PASS') process.exitCode = 1;
    }
    else {
      if (directory === source.directory || directory.startsWith(source.directory + path.sep)) throw new Error('MIGRATION_OUTPUT_INSIDE_SOURCE');
      console.log(JSON.stringify(await applyV6Migration(source, target, plan, await checkpointStore(directory), { apply: true }), null, 2));
    }
  } finally { await local.dispose(); }
}
if (require.main === module) main().catch(error => {
  const code = typeof error.code === 'string' && /^MIGRATION_[A-Z0-9_]+$/.test(error.code) ? error.code : /^MIGRATION_[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'MIGRATION_TOOL_FAILED';
  console.error(code); process.exitCode = 1;
});
module.exports = { main, argumentsFor, checkpointStore };
