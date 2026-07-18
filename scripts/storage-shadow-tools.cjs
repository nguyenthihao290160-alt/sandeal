/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');

require('./register-typescript.cjs');

const { checksumCollection } = require('../src/lib/storage/migrationChecksum.ts');
const { createMongoLogicalBackup, readMongoLogicalBackup } = require('../src/lib/storage/mongoLogicalBackup.ts');
const { restoreMongoLogicalBackup } = require('../src/lib/storage/mongoRestore.ts');
const { validateCollectionName } = require('../src/lib/storage/mongoSerialization.ts');
const { evaluateRollbackReadiness } = require('../src/lib/storage/rollbackReadiness.ts');
const { normalizeMongoDomainItems, validateShadow } = require('../src/lib/storage/shadowValidation.ts');

function isSensitiveCollection(collection) {
  return new Set(['token-vault', 'credentials', 'credential-store', 'secrets']).has(collection.toLowerCase())
    || /(?:^|[-_.])(?:secret|secrets|credential|credentials)(?:[-_.]|$)/i.test(collection);
}

function parseArguments(argv) {
  const command = argv[0];
  if (!['shadow', 'rollback', 'backup', 'restore'].includes(command)) throw new Error('STORAGE_SHADOW_COMMAND_INVALID');
  const flags = new Set();
  const values = new Map();
  const allowedFlags = new Set([
    '--fake-target', '--allow-isolated-write', '--allow-backup-write', '--mongo-write-detected', '--dry-run',
  ]);
  const allowedValues = new Set([
    '--source-dir', '--target-dir', '--data-dir', '--collections', '--collection', '--snapshot-checksum',
    '--driver', '--max-differences', '--timeout-ms', '--schema-version', '--output-dir', '--database',
    '--created-at', '--backup-id', '--snapshot', '--restore-id', '--batch-size',
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];
    if (allowedFlags.has(item)) {
      flags.add(item);
      continue;
    }
    if (allowedValues.has(item)) {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error('STORAGE_SHADOW_ARGUMENT_VALUE_REQUIRED');
      values.set(item, argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error('STORAGE_SHADOW_ARGUMENT_UNKNOWN');
  }
  return { command, flags, values };
}

function required(values, key) {
  const value = values.get(key);
  if (!value) throw new Error(`STORAGE_SHADOW_REQUIRED_${key.slice(2).replaceAll('-', '_').toUpperCase()}`);
  return value;
}

function collectionsArgument(values) {
  const collections = required(values, '--collections').split(',').map(value => validateCollectionName(value.trim()));
  if (collections.length === 0 || new Set(collections).size !== collections.length) throw new Error('STORAGE_SHADOW_COLLECTIONS_INVALID');
  return collections;
}

function safeRelative(target) {
  const relative = path.relative(process.cwd(), target);
  return relative.startsWith('..') || path.isAbsolute(relative) ? '[external-temp]' : relative.replaceAll('\\', '/');
}

function directoryReader(directory, schemaVersion = 1) {
  const root = path.resolve(directory);
  return {
    async inspectCollection(collection) {
      const safeCollection = validateCollectionName(collection);
      const filePath = path.join(root, `${safeCollection}.json`);
      if (!fs.existsSync(filePath)) return { exists: false, items: [] };
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('SHADOW_COLLECTION_ROOT_INVALID');
      return { exists: true, items: parsed };
    },
    async inspectSchema() {
      return {
        version: schemaVersion,
        expectedVersion: 1,
        ready: schemaVersion === 1,
        indexReady: schemaVersion === 1,
        missingIndexes: schemaVersion === 1 ? [] : [{ collection: 'fixture', name: 'fixture-index' }],
      };
    },
  };
}

class InMemoryRestoreTarget {
  constructor(database) {
    this.database = database;
    this.collections = new Map();
    this.batchKeys = new Set();
  }
  async inspectCollection(collection) {
    return { exists: this.collections.has(collection), count: (this.collections.get(collection) || []).length };
  }
  async readCollection(collection) {
    return structuredClone(this.collections.get(collection) || []);
  }
  async writeBatch(batch) {
    if (this.batchKeys.has(batch.batchKey)) return 'already_applied';
    const items = this.collections.get(batch.collection) || [];
    if (items.length !== batch.startIndex) throw new Error('FAKE_RESTORE_CURSOR_CONFLICT');
    items.push(...structuredClone(batch.items));
    this.collections.set(batch.collection, items);
    this.batchKeys.add(batch.batchKey);
    return 'written';
  }
}

async function runShadow(parsed) {
  const source = directoryReader(required(parsed.values, '--source-dir'));
  const schemaVersion = parsed.values.has('--schema-version') ? Number(parsed.values.get('--schema-version')) : 1;
  const target = directoryReader(required(parsed.values, '--target-dir'), schemaVersion);
  const report = await validateShadow({
    source,
    target,
    collections: collectionsArgument(parsed.values).map(collection => ({ collection })),
    maxDifferences: parsed.values.has('--max-differences') ? Number(parsed.values.get('--max-differences')) : undefined,
    timeoutMs: parsed.values.has('--timeout-ms') ? Number(parsed.values.get('--timeout-ms')) : undefined,
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'MATCH' ? 0 : report.status === 'MISMATCH' ? 2 : report.status === 'BLOCKED' ? 3 : 4;
}

async function runRollback(parsed) {
  const dataDir = required(parsed.values, '--data-dir');
  const collection = validateCollectionName(required(parsed.values, '--collection'));
  const reader = directoryReader(dataDir);
  let currentSourceChecksum = '';
  let fileReachable = false;
  try {
    const snapshot = await reader.inspectCollection(collection);
    if (!snapshot.exists) throw new Error('ROLLBACK_SOURCE_MISSING');
    currentSourceChecksum = checksumCollection(snapshot.items);
    fileReachable = true;
  } catch {
    fileReachable = false;
  }
  const report = evaluateRollbackReadiness({
    configuredDriver: parsed.values.get('--driver'),
    fileReachable,
    snapshotSourceChecksum: required(parsed.values, '--snapshot-checksum'),
    currentSourceChecksum,
    mongoWriteDetectedAfterSnapshot: parsed.flags.has('--mongo-write-detected'),
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.rollbackSafe ? 0 : 2;
}

async function runBackup(parsed) {
  if (!parsed.flags.has('--fake-target')) throw new Error('MONGO_BACKUP_FAKE_TARGET_FLAG_REQUIRED');
  const reader = directoryReader(required(parsed.values, '--data-dir'));
  const collections = collectionsArgument(parsed.values);
  const sourceDatabase = required(parsed.values, '--database');
  if (parsed.flags.has('--dry-run')) {
    const included = collections.filter(collection => !isSensitiveCollection(collection));
    const summaries = [];
    for (const collection of included) {
      const snapshot = await reader.inspectCollection(collection);
      const items = normalizeMongoDomainItems(snapshot.items);
      summaries.push({
        collection,
        existed: snapshot.exists,
        recordCount: items.length,
        checksum: checksumCollection(items),
      });
    }
    console.log(JSON.stringify({
      mode: 'dry-run-fake-injected',
      sourceDatabase,
      collections: summaries,
      excludedCollections: collections.filter(isSensitiveCollection),
      writesPerformed: 0,
      mongoUriPrinted: false,
    }, null, 2));
    return;
  }
  if (!parsed.flags.has('--allow-backup-write')) throw new Error('MONGO_BACKUP_WRITE_FLAG_REQUIRED');
  const result = await createMongoLogicalBackup({
    reader,
    sourceDatabase,
    collections,
    outputDir: required(parsed.values, '--output-dir'),
    createdAt: parsed.values.get('--created-at'),
    backupId: parsed.values.get('--backup-id'),
  });
  console.log(JSON.stringify({
    mode: 'fake-injected',
    sourceDatabase: result.backup.sourceDatabase,
    backupId: result.backup.backupId,
    manifestChecksum: result.backup.manifestChecksum,
    snapshotChecksum: result.backup.snapshotChecksum,
    collectionCount: result.backup.collections.length,
    excludedCollections: result.backup.excludedCollections,
    byteSize: result.byteSize,
    filePath: safeRelative(result.filePath),
    mongoUriPrinted: false,
  }, null, 2));
}

async function runRestore(parsed) {
  if (!parsed.flags.has('--fake-target')) throw new Error('MONGO_RESTORE_FAKE_TARGET_FLAG_REQUIRED');
  const backup = await readMongoLogicalBackup(required(parsed.values, '--snapshot'));
  const target = new InMemoryRestoreTarget(required(parsed.values, '--database'));
  const summary = await restoreMongoLogicalBackup({
    mode: parsed.flags.has('--dry-run') ? 'dry-run' : 'apply-isolated',
    backup,
    target,
    restoreId: required(parsed.values, '--restore-id'),
    allowIsolatedWrite: parsed.flags.has('--allow-isolated-write'),
    batchSize: parsed.values.has('--batch-size') ? Number(parsed.values.get('--batch-size')) : undefined,
  });
  console.log(JSON.stringify({ ...summary, targetMode: 'fake-injected', mongoUriPrinted: false }, null, 2));
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === 'shadow') await runShadow(parsed);
  else if (parsed.command === 'rollback') await runRollback(parsed);
  else if (parsed.command === 'backup') await runBackup(parsed);
  else await runRestore(parsed);
}

main().catch(error => {
  const candidate = error && typeof error.code === 'string' ? error.code : error && typeof error.message === 'string' ? error.message : '';
  const safeCode = /^[A-Z0-9_:.-]+$/.test(candidate) ? candidate : 'STORAGE_SHADOW_TOOL_FAILED';
  console.error(JSON.stringify({ status: 'BLOCKED', errorCode: safeCode }));
  process.exitCode = 1;
});
