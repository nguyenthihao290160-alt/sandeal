/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');

const COMMAND_OPTIONS = Object.freeze({
  shadow: Object.freeze({
    flags: new Set(),
    values: new Set([
      '--source-dir',
      '--target-dir',
      '--collections',
      '--max-differences',
      '--timeout-ms',
      '--schema-version',
    ]),
  }),
  rollback: Object.freeze({
    flags: new Set([
      '--mongo-write-detected',
    ]),
    values: new Set([
      '--data-dir',
      '--collection',
      '--snapshot-checksum',
      '--driver',
    ]),
  }),
  backup: Object.freeze({
    flags: new Set([
      '--fake-target',
      '--allow-backup-write',
      '--dry-run',
    ]),
    values: new Set([
      '--data-dir',
      '--collections',
      '--output-dir',
      '--database',
      '--created-at',
      '--backup-id',
    ]),
  }),
  restore: Object.freeze({
    flags: new Set([
      '--fake-target',
      '--allow-isolated-write',
      '--dry-run',
    ]),
    values: new Set([
      '--snapshot',
      '--database',
      '--restore-id',
      '--batch-size',
    ]),
  }),
});

const SENSITIVE_COLLECTIONS = new Set([
  'token-vault',
  'credentials',
  'credential-store',
  'secrets',
]);

let checksumCollection;
let createMongoLogicalBackup;
let readMongoLogicalBackup;
let restoreMongoLogicalBackup;
let validateCollectionName;
let normalizeCollectionPayload;
let assertIsolatedDatabase;
let evaluateRollbackReadiness;
let normalizeMongoDomainItems;
let validateShadow;

function loadStorageModules() {
  require('./register-typescript.cjs');

  ({
    checksumCollection,
  } = require('../src/lib/storage/migrationChecksum.ts'));
  ({
    createMongoLogicalBackup,
    readMongoLogicalBackup,
  } = require('../src/lib/storage/mongoLogicalBackup.ts'));
  ({
    restoreMongoLogicalBackup,
  } = require('../src/lib/storage/mongoRestore.ts'));
  ({
    normalizeCollectionPayload,
    validateCollectionName,
  } = require('../src/lib/storage/mongoSerialization.ts'));
  ({
    assertIsolatedDatabase,
  } = require('../src/lib/storage/migrationExecutor.ts'));
  ({
    evaluateRollbackReadiness,
  } = require('../src/lib/storage/rollbackReadiness.ts'));
  ({
    normalizeMongoDomainItems,
    validateShadow,
  } = require('../src/lib/storage/shadowValidation.ts'));
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function safeErrorCode(error) {
  if (
      error
      && typeof error === 'object'
      && typeof error.code === 'string'
      && /^[A-Z0-9_]{1,96}$/.test(error.code)
  ) {
    return error.code;
  }

  if (
      error instanceof Error
      && /^[A-Z0-9_]{1,96}$/.test(error.message)
  ) {
    return error.message;
  }

  return 'STORAGE_SHADOW_TOOL_FAILED';
}

function parseArguments(argv) {
  const command = argv[0];
  const options = COMMAND_OPTIONS[command];
  if (!options) throw new Error('STORAGE_SHADOW_COMMAND_INVALID');

  const flags = new Set();
  const values = new Map();

  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];

    if (options.flags.has(item)) {
      if (flags.has(item)) {
        throw new Error('STORAGE_SHADOW_ARGUMENT_DUPLICATE');
      }
      flags.add(item);
      continue;
    }

    if (options.values.has(item)) {
      if (values.has(item)) {
        throw new Error('STORAGE_SHADOW_ARGUMENT_DUPLICATE');
      }
      if (
          index + 1 >= argv.length
          || argv[index + 1].startsWith('--')
      ) {
        throw new Error('STORAGE_SHADOW_ARGUMENT_VALUE_REQUIRED');
      }

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
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
        `STORAGE_SHADOW_REQUIRED_${key
            .slice(2)
            .replaceAll('-', '_')
            .toUpperCase()}`,
    );
  }
  return value;
}

function optionalFiniteNumber(values, key) {
  if (!values.has(key)) return undefined;

  const parsed = Number(values.get(key));
  if (!Number.isFinite(parsed)) {
    throw new Error('STORAGE_SHADOW_NUMERIC_ARGUMENT_INVALID');
  }
  return parsed;
}

function optionalPositiveInteger(values, key) {
  const parsed = optionalFiniteNumber(values, key);
  if (parsed === undefined) return undefined;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('STORAGE_SHADOW_NUMERIC_ARGUMENT_INVALID');
  }
  return parsed;
}

function collectionsArgument(values) {
  const rawCollections = required(values, '--collections')
      .split(',')
      .map(value => value.trim());

  if (
      rawCollections.length === 0
      || rawCollections.some(value => value === '')
  ) {
    throw new Error('STORAGE_SHADOW_COLLECTIONS_INVALID');
  }

  const collections = rawCollections.map(value =>
      validateCollectionName(value));

  if (new Set(collections).size !== collections.length) {
    throw new Error('STORAGE_SHADOW_COLLECTIONS_INVALID');
  }
  return collections;
}

function isSensitiveCollection(collection) {
  return SENSITIVE_COLLECTIONS.has(collection.toLowerCase())
      || /(?:^|[-_.])(?:secret|secrets|credential|credentials)(?:[-_.]|$)/i
          .test(collection);
}

function safeRelative(target) {
  const relative = path.relative(process.cwd(), path.resolve(target));
  return relative.startsWith('..') || path.isAbsolute(relative)
      ? '[external-temp]'
      : relative.replaceAll('\\', '/');
}

function directoryReader(directory, schemaVersion = 1) {
  const root = path.resolve(directory);

  return {
    async inspectCollection(collection) {
      const safeCollection = validateCollectionName(collection);
      const filePath = path.resolve(root, `${safeCollection}.json`);
      const relative = path.relative(root, filePath);

      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('SHADOW_COLLECTION_PATH_INVALID');
      }
      if (!fs.existsSync(filePath)) {
        return { exists: false, items: [] };
      }

      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return {
        exists: true,
        items: normalizeCollectionPayload(parsed),
      };
    },

    async inspectSchema() {
      return {
        version: schemaVersion,
        expectedVersion: 1,
        ready: schemaVersion === 1,
        indexReady: schemaVersion === 1,
        missingIndexes: schemaVersion === 1
            ? []
            : [{ collection: 'fixture', name: 'fixture-index' }],
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
    return {
      exists: this.collections.has(collection),
      count: (this.collections.get(collection) || []).length,
    };
  }

  async readCollection(collection) {
    return structuredClone(this.collections.get(collection) || []);
  }

  async writeBatch(batch) {
    if (this.batchKeys.has(batch.batchKey)) return 'already_applied';

    const items = this.collections.get(batch.collection) || [];
    if (items.length !== batch.startIndex) {
      throw new Error('FAKE_RESTORE_CURSOR_CONFLICT');
    }

    items.push(...structuredClone(batch.items));
    this.collections.set(batch.collection, items);
    this.batchKeys.add(batch.batchKey);
    return 'written';
  }
}

async function runShadow(parsed) {
  const source = directoryReader(
      required(parsed.values, '--source-dir'),
  );
  const schemaVersion = optionalPositiveInteger(
      parsed.values,
      '--schema-version',
  ) ?? 1;
  const target = directoryReader(
      required(parsed.values, '--target-dir'),
      schemaVersion,
  );

  const report = await validateShadow({
    source,
    target,
    collections: collectionsArgument(parsed.values)
        .map(collection => ({ collection })),
    maxDifferences: optionalFiniteNumber(
        parsed.values,
        '--max-differences',
    ),
    timeoutMs: optionalFiniteNumber(
        parsed.values,
        '--timeout-ms',
    ),
  });

  writeJson(process.stdout, report);
  process.exitCode = report.status === 'MATCH'
      ? 0
      : report.status === 'MISMATCH'
          ? 2
          : report.status === 'BLOCKED'
              ? 3
              : 4;
}

async function runRollback(parsed) {
  const dataDir = required(parsed.values, '--data-dir');
  const collection = validateCollectionName(
      required(parsed.values, '--collection'),
  );
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
    snapshotSourceChecksum: required(
        parsed.values,
        '--snapshot-checksum',
    ),
    currentSourceChecksum,
    mongoWriteDetectedAfterSnapshot:
        parsed.flags.has('--mongo-write-detected'),
  });

  writeJson(process.stdout, report);
  process.exitCode = report.rollbackSafe ? 0 : 2;
}

async function runBackup(parsed) {
  if (!parsed.flags.has('--fake-target')) {
    throw new Error('MONGO_BACKUP_FAKE_TARGET_FLAG_REQUIRED');
  }

  const sourceDatabase = required(parsed.values, '--database');
  assertIsolatedDatabase(sourceDatabase);

  const reader = directoryReader(
      required(parsed.values, '--data-dir'),
  );
  const collections = collectionsArgument(parsed.values);

  if (parsed.flags.has('--dry-run')) {
    const included = collections.filter(
        collection => !isSensitiveCollection(collection),
    );
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

    writeJson(process.stdout, {
      mode: 'dry-run-fake-injected',
      sourceDatabase,
      collections: summaries,
      excludedCollections: collections.filter(isSensitiveCollection),
      writesPerformed: 0,
      mongoUriPrinted: false,
    });
    return;
  }

  if (!parsed.flags.has('--allow-backup-write')) {
    throw new Error('MONGO_BACKUP_WRITE_FLAG_REQUIRED');
  }

  const result = await createMongoLogicalBackup({
    reader,
    sourceDatabase,
    collections,
    outputDir: required(parsed.values, '--output-dir'),
    createdAt: parsed.values.get('--created-at'),
    backupId: parsed.values.get('--backup-id'),
  });

  writeJson(process.stdout, {
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
  });
}

async function runRestore(parsed) {
  if (!parsed.flags.has('--fake-target')) {
    throw new Error('MONGO_RESTORE_FAKE_TARGET_FLAG_REQUIRED');
  }

  const targetDatabase = required(parsed.values, '--database');
  assertIsolatedDatabase(targetDatabase);

  const backup = await readMongoLogicalBackup(
      required(parsed.values, '--snapshot'),
  );
  const target = new InMemoryRestoreTarget(targetDatabase);

  const summary = await restoreMongoLogicalBackup({
    mode: parsed.flags.has('--dry-run')
        ? 'dry-run'
        : 'apply-isolated',
    backup,
    target,
    restoreId: required(parsed.values, '--restore-id'),
    allowIsolatedWrite:
        parsed.flags.has('--allow-isolated-write'),
    batchSize: optionalPositiveInteger(
        parsed.values,
        '--batch-size',
    ),
  });

  writeJson(process.stdout, {
    ...summary,
    targetMode: 'fake-injected',
    mongoUriPrinted: false,
  });
}

async function main() {
  // Parse and reject invalid CLI input before loading TypeScript modules.
  const parsed = parseArguments(process.argv.slice(2));
  loadStorageModules();

  if (parsed.command === 'shadow') {
    await runShadow(parsed);
  } else if (parsed.command === 'rollback') {
    await runRollback(parsed);
  } else if (parsed.command === 'backup') {
    await runBackup(parsed);
  } else {
    await runRestore(parsed);
  }
}

main().catch(error => {
  writeJson(process.stderr, {
    status: 'BLOCKED',
    errorCode: safeErrorCode(error),
  });
  process.exitCode = 1;
});
