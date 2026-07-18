import { promises as fs } from 'fs';
import path from 'path';

import { checksumCollection } from './migrationChecksum';
import { validateCollectionName } from './mongoSerialization';

export type InventoryClassification =
  | 'migratable'
  | 'sensitive_excluded'
  | 'unsupported'
  | 'invalid_json'
  | 'invalid_root'
  | 'empty'
  | 'ignored_artifact';

export interface InventoryRecord {
  readonly logicalCollection: string | null;
  readonly sourceFile: string;
  readonly classification: InventoryClassification;
  readonly recordCount: number | null;
  readonly byteSize: number;
  readonly checksum: string | null;
  readonly reasonCode: string | null;
  readonly blocking: boolean;
}

export interface InventoryComparison {
  readonly fileWithoutSchema: string[];
  readonly schemaWithoutFile: string[];
  readonly sourceWithoutSchema: string[];
  readonly schemaWithoutSource: string[];
}

export interface FileCollectionInventory {
  readonly dataDirectory: string;
  readonly records: InventoryRecord[];
  readonly sourceCollections: string[];
  readonly schemaCollections: string[];
  readonly comparison: InventoryComparison;
  readonly blockers: string[];
  readonly warnings: string[];
}

export interface InventoryOptions {
  readonly dataDir: string;
  readonly schemaCollections: readonly string[];
  readonly sourceRoot?: string;
  readonly sourceCollections?: readonly string[];
}

const SENSITIVE_COLLECTIONS = new Set([
  'token-vault',
  'credentials',
  'credential-store',
  'secrets',
  'secret-config',
]);

const SOURCE_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.cjs', '.mts', '.cts']);

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isSensitiveCollection(logicalName: string): boolean {
  return SENSITIVE_COLLECTIONS.has(logicalName.toLowerCase())
    || /(?:^|[-_.])(?:secret|secrets|credential|credentials|config)(?:[-_.]|$)/i.test(logicalName);
}

function ignoredArtifactReason(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.lock')) return 'FILE_LOCK';
  if (lower.endsWith('.bak')) return 'TECHNICAL_BACKUP';
  if (/(?:^|\.)tmp(?:\.|$)/i.test(fileName)) return 'TEMP_FILE';
  if (
    lower.startsWith('migration-')
    || lower.startsWith('inventory-')
    || lower.startsWith('snapshot-')
    || lower.startsWith('backup-')
    || lower.endsWith('.manifest.json')
    || lower.endsWith('.report.json')
  ) return 'GENERATED_REPORT';
  return null;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const discovered: string[] = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.data' || entry.name === '.test-tmp') continue;
      discovered.push(...await sourceFiles(target));
      continue;
    }
    if (entry.isFile() && SOURCE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      discovered.push(target);
    }
  }
  return discovered;
}

export async function discoverStorageCollections(sourceRoot: string): Promise<string[]> {
  const root = path.resolve(sourceRoot);
  const names = new Set<string>();
  for (const file of await sourceFiles(root)) {
    const source = await fs.readFile(file, 'utf8');
    const constantPattern = /\b(?:[A-Z_]*COLLECTION[A-Z_]*|JOBS|CONTROL|AUDIT|USAGE|CIRCUITS|EVENTS|DAILY|ALERTS|ACTIONS|CHECKPOINTS)\s*=\s*['"]([^'"]+)['"]/g;
    const callPattern = /\b(?:readCollection|writeCollection|runTransaction|findById|insertOne|updateOne|deleteOne)\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]/g;
    for (const pattern of [constantPattern, callPattern]) {
      for (const match of source.matchAll(pattern)) {
        try {
          names.add(validateCollectionName(match[1]));
        } catch {
          // Invalid literals are reported by the existing M2 validator tests.
        }
      }
    }
  }
  names.delete('sandeal_storage_metadata');
  return sortedUnique(names);
}

async function inventoryRecord(dataDir: string, entry: import('fs').Dirent): Promise<InventoryRecord> {
  const sourceFile = entry.name;
  const target = path.join(dataDir, sourceFile);

  if (entry.isSymbolicLink()) {
    return {
      logicalCollection: null,
      sourceFile,
      classification: 'unsupported',
      recordCount: null,
      byteSize: 0,
      checksum: null,
      reasonCode: 'SYMLINK_NOT_ALLOWED',
      blocking: true,
    };
  }
  if (!entry.isFile()) {
    return {
      logicalCollection: null,
      sourceFile,
      classification: 'unsupported',
      recordCount: null,
      byteSize: 0,
      checksum: null,
      reasonCode: 'NOT_A_REGULAR_FILE',
      blocking: false,
    };
  }

  const stat = await fs.stat(target);
  const artifactReason = ignoredArtifactReason(sourceFile);
  if (artifactReason) {
    return {
      logicalCollection: null,
      sourceFile,
      classification: 'ignored_artifact',
      recordCount: null,
      byteSize: stat.size,
      checksum: null,
      reasonCode: artifactReason,
      blocking: false,
    };
  }

  if (path.extname(sourceFile).toLowerCase() !== '.json') {
    return {
      logicalCollection: null,
      sourceFile,
      classification: 'unsupported',
      recordCount: null,
      byteSize: stat.size,
      checksum: null,
      reasonCode: 'UNSUPPORTED_EXTENSION',
      blocking: false,
    };
  }

  const logicalName = sourceFile.slice(0, -'.json'.length);
  try {
    validateCollectionName(logicalName);
  } catch {
    return {
      logicalCollection: logicalName,
      sourceFile,
      classification: 'unsupported',
      recordCount: null,
      byteSize: stat.size,
      checksum: null,
      reasonCode: 'INVALID_COLLECTION_NAME',
      blocking: true,
    };
  }

  // Sensitive files are classified using metadata only. Their bytes are never opened here.
  if (isSensitiveCollection(logicalName)) {
    return {
      logicalCollection: logicalName,
      sourceFile,
      classification: 'sensitive_excluded',
      recordCount: null,
      byteSize: stat.size,
      checksum: null,
      reasonCode: 'SENSITIVE_COLLECTION_EXCLUDED',
      blocking: false,
    };
  }

  const raw = await fs.readFile(target);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return {
      logicalCollection: logicalName,
      sourceFile,
      classification: 'invalid_json',
      recordCount: null,
      byteSize: raw.byteLength,
      checksum: null,
      reasonCode: 'INVALID_JSON',
      blocking: true,
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      logicalCollection: logicalName,
      sourceFile,
      classification: 'invalid_root',
      recordCount: null,
      byteSize: raw.byteLength,
      checksum: null,
      reasonCode: 'COLLECTION_ROOT_MUST_BE_ARRAY',
      blocking: true,
    };
  }

  return {
    logicalCollection: logicalName,
    sourceFile,
    classification: parsed.length === 0 ? 'empty' : 'migratable',
    recordCount: parsed.length,
    byteSize: raw.byteLength,
    checksum: checksumCollection(parsed),
    reasonCode: parsed.length === 0 ? 'EMPTY_COLLECTION' : null,
    blocking: false,
  };
}

export async function inventoryFileCollections(options: InventoryOptions): Promise<FileCollectionInventory> {
  const dataDirectory = path.resolve(options.dataDir);
  const stat = await fs.stat(dataDirectory).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('MIGRATION_DATA_DIR_NOT_FOUND');

  const entries = await fs.readdir(dataDirectory, { withFileTypes: true });
  const records: InventoryRecord[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    records.push(await inventoryRecord(dataDirectory, entry));
  }

  const schemaCollections = sortedUnique(options.schemaCollections.map(validateCollectionName));
  const sourceCollections = options.sourceCollections
    ? sortedUnique(options.sourceCollections.map(validateCollectionName))
    : options.sourceRoot
      ? await discoverStorageCollections(options.sourceRoot)
      : [];
  const schemaSet = new Set(schemaCollections);
  const sourceSet = new Set(sourceCollections);
  const fileCollections = sortedUnique(records
    .filter(record => record.logicalCollection !== null && record.classification !== 'ignored_artifact')
    .map(record => record.logicalCollection as string));
  const eligibleFileCollections = sortedUnique(records
    .filter(record => record.classification === 'migratable' || record.classification === 'empty')
    .map(record => record.logicalCollection as string));
  const fileSet = new Set(fileCollections);

  const comparison: InventoryComparison = {
    fileWithoutSchema: eligibleFileCollections.filter(name => !schemaSet.has(name)),
    schemaWithoutFile: schemaCollections.filter(name => !fileSet.has(name)),
    sourceWithoutSchema: sourceCollections.filter(name => !schemaSet.has(name)),
    schemaWithoutSource: schemaCollections.filter(name => !sourceSet.has(name)),
  };

  const blockers = sortedUnique([
    ...records.filter(record => record.blocking).map(record => `${record.sourceFile}:${record.reasonCode}`),
    ...comparison.fileWithoutSchema.map(name => `${name}:FILE_COLLECTION_NOT_IN_SCHEMA`),
    ...comparison.sourceWithoutSchema.map(name => `${name}:SOURCE_COLLECTION_NOT_IN_SCHEMA`),
  ]);
  const warnings = sortedUnique([
    ...comparison.schemaWithoutFile.map(name => `${name}:SCHEMA_COLLECTION_HAS_NO_SOURCE_FILE`),
    ...comparison.schemaWithoutSource.map(name => `${name}:SCHEMA_COLLECTION_NOT_DISCOVERED_IN_SOURCE`),
  ]);

  return {
    dataDirectory,
    records,
    sourceCollections,
    schemaCollections,
    comparison,
    blockers,
    warnings,
  };
}

