/* eslint-disable @typescript-eslint/no-require-imports */
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COMMAND_OPTIONS = Object.freeze({
  inventory: Object.freeze({
    flags: new Set(),
    values: new Set([
      '--data-dir',
    ]),
  }),
  plan: Object.freeze({
    flags: new Set([
      '--source-only',
      '--no-output',
    ]),
    values: new Set([
      '--data-dir',
      '--database',
      '--output-dir',
      '--batch-size',
      '--created-at',
      '--migration-id',
    ]),
  }),
  'dry-run': Object.freeze({
    flags: new Set([
      '--source-only',
      '--no-output',
    ]),
    values: new Set([
      '--data-dir',
      '--database',
      '--output-dir',
      '--batch-size',
      '--created-at',
      '--migration-id',
    ]),
  }),
});

const APPROVED_OUTPUT_ROOT_NAMES = Object.freeze([
  '.test-tmp',
  '.release',
  '.backups',
]);

let executeMigration;
let inventoryFileCollections;
let createMigrationManifest;
let validateMigrationManifest;
let normalizeCollectionPayload;
let MONGO_LOGICAL_COLLECTIONS;
let mongoClientPath;

function loadStorageModules() {
  require('./register-typescript.cjs');

  ({
    executeMigration,
  } = require('../src/lib/storage/migrationExecutor.ts'));
  ({
    inventoryFileCollections,
  } = require('../src/lib/storage/migrationInventory.ts'));
  ({
    createMigrationManifest,
    validateMigrationManifest,
  } = require('../src/lib/storage/migrationManifest.ts'));
  ({
    normalizeCollectionPayload,
  } = require('../src/lib/storage/mongoSerialization.ts'));
  ({
    MONGO_LOGICAL_COLLECTIONS,
  } = require('../src/lib/storage/mongoSchema.ts'));

  mongoClientPath = require.resolve(
      '../src/lib/storage/mongoClient.ts',
  );
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

  return 'MIGRATION_TOOL_FAILED';
}

function parseArguments(argv) {
  const command = argv[0];
  const options = COMMAND_OPTIONS[command];
  if (!options) throw new Error('MIGRATION_COMMAND_INVALID');

  const flags = new Set();
  const values = new Map();

  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];

    if (options.flags.has(item)) {
      if (flags.has(item)) {
        throw new Error('MIGRATION_ARGUMENT_DUPLICATE');
      }
      flags.add(item);
      continue;
    }

    if (options.values.has(item)) {
      if (values.has(item)) {
        throw new Error('MIGRATION_ARGUMENT_DUPLICATE');
      }
      if (
          index + 1 >= argv.length
          || argv[index + 1].startsWith('--')
      ) {
        throw new Error('MIGRATION_ARGUMENT_VALUE_REQUIRED');
      }

      values.set(item, argv[index + 1]);
      index += 1;
      continue;
    }

    throw new Error('MIGRATION_ARGUMENT_UNKNOWN');
  }

  return { command, flags, values };
}

function requiredValue(values, key) {
  const value = values.get(key);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
        `MIGRATION_REQUIRED_${key
            .slice(2)
            .replaceAll('-', '_')
            .toUpperCase()}`,
    );
  }
  return value;
}

function optionalPositiveInteger(values, key) {
  if (!values.has(key)) return undefined;

  const parsed = Number(values.get(key));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('MIGRATION_NUMERIC_ARGUMENT_INVALID');
  }
  return parsed;
}

function safeRelative(target) {
  const relative = path.relative(
      process.cwd(),
      path.resolve(target),
  );
  return relative.startsWith('..') || path.isAbsolute(relative)
      ? '[external-temp]'
      : relative.replaceAll('\\', '/');
}

function isInside(parent, target) {
  const relative = path.relative(
      path.resolve(parent),
      path.resolve(target),
  );
  return relative === ''
      || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function approvedOutputRoots() {
  return [
    ...APPROVED_OUTPUT_ROOT_NAMES.map(name =>
        path.resolve(process.cwd(), name)),
    path.resolve(os.tmpdir()),
  ];
}

function assertSafeOutputDirectory(outputDir) {
  const resolved = path.resolve(outputDir);
  const lexicalRoot = approvedOutputRoots()
      .find(root => isInside(root, resolved));

  if (!lexicalRoot) {
    throw new Error('MIGRATION_OUTPUT_DIRECTORY_NOT_IGNORED');
  }

  fs.mkdirSync(lexicalRoot, { recursive: true });
  fs.mkdirSync(resolved, { recursive: true });

  const realRoot = fs.realpathSync(lexicalRoot);
  const realDirectory = fs.realpathSync(resolved);
  if (!isInside(realRoot, realDirectory)) {
    throw new Error('MIGRATION_OUTPUT_DIRECTORY_NOT_IGNORED');
  }

  return realDirectory;
}

function writeManifestAtomic(manifest, outputDir) {
  const directory = assertSafeOutputDirectory(outputDir);
  const timestamp = manifest.createdAt
      .replace(/[^0-9A-Za-z]/g, '');
  const fileName = [
    timestamp,
    manifest.manifestChecksum.slice(0, 16),
  ].join('-') + '.manifest.json';
  const destination = path.join(directory, fileName);

  if (fs.existsSync(destination)) {
    throw new Error('MIGRATION_MANIFEST_ALREADY_EXISTS');
  }

  const temporary = [
    destination,
    '.tmp.',
    randomBytes(8).toString('hex'),
  ].join('');
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  let handle;

  try {
    handle = fs.openSync(
        temporary,
        fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_WRONLY,
        0o600,
    );
    fs.writeFileSync(handle, content, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }

  try {
    const verified = JSON.parse(
        fs.readFileSync(temporary, 'utf8'),
    );
    const validation = validateMigrationManifest(verified);
    if (
        !validation.valid
        || verified.manifestChecksum
        !== manifest.manifestChecksum
        || JSON.stringify(verified) !== JSON.stringify(manifest)
    ) {
      throw new Error(
          'MIGRATION_MANIFEST_WRITE_VERIFY_FAILED',
      );
    }

    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }

  return destination;
}

function assertContainedSource(dataDir, sourceFile) {
  if (
      typeof sourceFile !== 'string'
      || sourceFile.trim() === ''
      || path.isAbsolute(sourceFile)
  ) {
    throw new Error('MIGRATION_SOURCE_FILE_INVALID');
  }

  const root = path.resolve(dataDir);
  const source = path.resolve(root, sourceFile);
  if (!isInside(root, source)) {
    throw new Error('MIGRATION_SOURCE_FILE_INVALID');
  }
  return source;
}

function loadIncludedCollections(dataDir, manifest) {
  return Object.fromEntries(
      manifest.collections
          .filter(collection =>
              collection.migrationPolicy === 'include')
          .map(collection => {
            const source = assertContainedSource(
                dataDir,
                collection.sourceFile,
            );
            const parsed = JSON.parse(
                fs.readFileSync(source, 'utf8'),
            );
            const items = normalizeCollectionPayload(parsed);
            return [collection.logicalName, items];
          }),
  );
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

function assertMongoClientNotInitialized() {
  if (mongoClientPath && require.cache[mongoClientPath]) {
    throw new Error(
        'MIGRATION_SOURCE_ONLY_MONGO_CLIENT_INITIALIZED',
    );
  }
}

async function main() {
  // Invalid CLI input is rejected before TypeScript or storage modules load.
  const parsed = parseArguments(process.argv.slice(2));
  loadStorageModules();

  const configuredDataDir = parsed.values.get('--data-dir')
      || process.env.SANDEAL_DATA_DIR;
  if (
      typeof configuredDataDir !== 'string'
      || configuredDataDir.trim() === ''
  ) {
    throw new Error('MIGRATION_DATA_DIR_REQUIRED');
  }

  if (
      parsed.command !== 'inventory'
      && !parsed.flags.has('--source-only')
  ) {
    throw new Error('MIGRATION_SOURCE_ONLY_FLAG_REQUIRED');
  }

  const dataDir = path.resolve(configuredDataDir);
  const inventory = await inventoryFileCollections({
    dataDir,
    sourceRoot: path.join(process.cwd(), 'src'),
    schemaCollections: MONGO_LOGICAL_COLLECTIONS,
  });

  assertMongoClientNotInitialized();

  if (parsed.command === 'inventory') {
    writeJson(process.stdout, {
      command: 'inventory',
      sourceMode: 'file-explicit',
      mongoClientInitialized: false,
      mongoWrites: 0,
      sourceWrites: 0,
      ...publicInventorySummary(inventory),
    });

    if (inventory.blockers.length > 0) {
      process.exitCode = 2;
    }
    return;
  }

  const manifest = createMigrationManifest(inventory, {
    database: parsed.values.get('--database') || 'sandeal',
    batchSize: optionalPositiveInteger(
        parsed.values,
        '--batch-size',
    ),
    createdAt: parsed.values.get('--created-at'),
  });
  const validation = validateMigrationManifest(manifest);

  let manifestPath = null;
  if (!parsed.flags.has('--no-output')) {
    manifestPath = writeManifestAtomic(
        manifest,
        parsed.values.get('--output-dir')
        || path.join(
            process.cwd(),
            '.test-tmp',
            'storage-migration',
        ),
    );
  }

  let execution = null;
  if (validation.safeToApply) {
    execution = await executeMigration({
      mode: parsed.command === 'plan'
          ? 'plan'
          : 'dry-run',
      manifest,
      migrationId: parsed.values.get('--migration-id')
          || `dry-${manifest.manifestChecksum.slice(0, 16)}`,
      sourceCollections: loadIncludedCollections(
          dataDir,
          manifest,
      ),
    });
  }

  assertMongoClientNotInitialized();

  writeJson(process.stdout, {
    command: parsed.command,
    sourceMode: 'source-only',
    mongoClientInitialized: false,
    mongoWrites: 0,
    sourceWrites: 0,
    manifestPath: manifestPath
        ? safeRelative(manifestPath)
        : null,
    manifestChecksum: manifest.manifestChecksum,
    manifestValid: validation.valid,
    safeToApply: validation.safeToApply,
    execution,
    ...publicInventorySummary(inventory),
  });

  if (!validation.safeToApply) {
    process.exitCode = 2;
  }
}

main().catch(error => {
  writeJson(process.stderr, {
    status: 'BLOCKED',
    errorCode: safeErrorCode(error),
  });
  process.exitCode = 1;
});
