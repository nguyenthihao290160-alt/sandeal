/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

require('./register-typescript.cjs');

const { executeMigration } = require('../src/lib/storage/migrationExecutor.ts');
const { inventoryFileCollections } = require('../src/lib/storage/migrationInventory.ts');
const { createMigrationManifest, validateMigrationManifest } = require('../src/lib/storage/migrationManifest.ts');
const { MONGO_LOGICAL_COLLECTIONS } = require('../src/lib/storage/mongoSchema.ts');

function parseArguments(argv) {
  const command = argv[0];
  if (!['inventory', 'plan', 'dry-run'].includes(command)) throw new Error('MIGRATION_COMMAND_INVALID');
  const flags = new Set();
  const values = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];
    if (['--source-only', '--no-output'].includes(item)) {
      flags.add(item);
      continue;
    }
    if (['--data-dir', '--database', '--output-dir', '--batch-size', '--created-at', '--migration-id'].includes(item)) {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error('MIGRATION_ARGUMENT_VALUE_REQUIRED');
      values.set(item, argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error('MIGRATION_ARGUMENT_UNKNOWN');
  }
  return { command, flags, values };
}

function safeRelative(target) {
  const relative = path.relative(process.cwd(), target);
  return relative.startsWith('..') || path.isAbsolute(relative) ? '[external-temp]' : relative.replaceAll('\\', '/');
}

function isInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertSafeOutputDirectory(outputDir) {
  const resolved = path.resolve(outputDir);
  const approvedRoots = ['.test-tmp', '.release', '.backups'].map(name => path.resolve(process.cwd(), name));
  const externalTemp = path.resolve(require('node:os').tmpdir());
  if (![...approvedRoots, externalTemp].some(root => isInside(root, resolved))) {
    throw new Error('MIGRATION_OUTPUT_DIRECTORY_NOT_IGNORED');
  }
  return resolved;
}

function writeManifestAtomic(manifest, outputDir) {
  const directory = assertSafeOutputDirectory(outputDir);
  fs.mkdirSync(directory, { recursive: true });
  const timestamp = manifest.createdAt.replace(/[^0-9A-Za-z]/g, '');
  const fileName = `${timestamp}-${manifest.manifestChecksum.slice(0, 16)}.manifest.json`;
  const destination = path.join(directory, fileName);
  if (fs.existsSync(destination)) throw new Error('MIGRATION_MANIFEST_ALREADY_EXISTS');
  const temporary = `${destination}.tmp.${randomBytes(4).toString('hex')}`;
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  const handle = fs.openSync(temporary, 'wx');
  try {
    fs.writeFileSync(handle, content, 'utf8');
  } finally {
    fs.closeSync(handle);
  }
  try {
    const verified = JSON.parse(fs.readFileSync(temporary, 'utf8'));
    if (verified.manifestChecksum !== manifest.manifestChecksum) throw new Error('MIGRATION_MANIFEST_WRITE_VERIFY_FAILED');
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return destination;
}

function loadIncludedCollections(dataDir, manifest) {
  return Object.fromEntries(manifest.collections
    .filter(collection => collection.migrationPolicy === 'include')
    .map(collection => {
      const source = path.join(dataDir, collection.sourceFile);
      const items = JSON.parse(fs.readFileSync(source, 'utf8'));
      return [collection.logicalName, items];
    }));
}

function publicInventorySummary(inventory) {
  return {
    records: inventory.records.map(record => ({
      logicalCollection: record.logicalCollection,
      sourceFile: record.sourceFile,
      classification: record.classification,
      recordCount: record.recordCount,
      byteSize: record.byteSize,
      checksum: record.checksum,
      reasonCode: record.reasonCode,
    })),
    comparison: inventory.comparison,
    blockerCount: inventory.blockers.length,
    blockers: inventory.blockers,
    warningCount: inventory.warnings.length,
    warnings: inventory.warnings,
  };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const configuredDataDir = parsed.values.get('--data-dir') || process.env.SANDEAL_DATA_DIR;
  if (!configuredDataDir) throw new Error('MIGRATION_DATA_DIR_REQUIRED');
  if (parsed.command !== 'inventory' && !parsed.flags.has('--source-only')) {
    throw new Error('MIGRATION_SOURCE_ONLY_FLAG_REQUIRED');
  }
  const dataDir = path.resolve(configuredDataDir);
  const inventory = await inventoryFileCollections({
    dataDir,
    sourceRoot: path.join(process.cwd(), 'src'),
    schemaCollections: MONGO_LOGICAL_COLLECTIONS,
  });

  if (parsed.command === 'inventory') {
    console.log(JSON.stringify({
      command: 'inventory',
      sourceMode: 'file-explicit',
      ...publicInventorySummary(inventory),
    }, null, 2));
    if (inventory.blockers.length > 0) process.exitCode = 2;
    return;
  }

  const batchSize = parsed.values.has('--batch-size') ? Number(parsed.values.get('--batch-size')) : undefined;
  const manifest = createMigrationManifest(inventory, {
    database: parsed.values.get('--database') || 'sandeal',
    batchSize,
    createdAt: parsed.values.get('--created-at'),
  });
  const validation = validateMigrationManifest(manifest);
  let manifestPath = null;
  if (!parsed.flags.has('--no-output')) {
    manifestPath = writeManifestAtomic(
      manifest,
      parsed.values.get('--output-dir') || path.join(process.cwd(), '.test-tmp', 'storage-migration')
    );
  }

  let execution = null;
  if (validation.safeToApply) {
    execution = await executeMigration({
      mode: parsed.command === 'plan' ? 'plan' : 'dry-run',
      manifest,
      migrationId: parsed.values.get('--migration-id') || `dry-${manifest.manifestChecksum.slice(0, 16)}`,
      sourceCollections: loadIncludedCollections(dataDir, manifest),
    });
  }
  console.log(JSON.stringify({
    command: parsed.command,
    sourceMode: 'source-only',
    mongoClientInitialized: false,
    mongoWrites: 0,
    sourceWrites: 0,
    manifestPath: manifestPath ? safeRelative(manifestPath) : null,
    manifestChecksum: manifest.manifestChecksum,
    manifestValid: validation.valid,
    safeToApply: validation.safeToApply,
    execution,
    ...publicInventorySummary(inventory),
  }, null, 2));
  if (!validation.safeToApply) process.exitCode = 2;
}

main().catch(error => {
  const candidate = error && typeof error.code === 'string' ? error.code : error && typeof error.message === 'string' ? error.message : '';
  const safeCode = /^[A-Z0-9_:.-]+$/.test(candidate) ? candidate : 'MIGRATION_TOOL_FAILED';
  console.error(JSON.stringify({ status: 'BLOCKED', errorCode: safeCode }));
  process.exitCode = 1;
});

