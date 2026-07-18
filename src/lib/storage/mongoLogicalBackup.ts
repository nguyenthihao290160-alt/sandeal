import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { checksumCollection, checksumJson } from './migrationChecksum';
import { assertIsolatedDatabase } from './migrationExecutor';
import type { ShadowCollectionReader } from './shadowValidation';
import { normalizeMongoDomainItems } from './shadowValidation';

export interface MongoLogicalBackupCollection {
  readonly logicalName: string;
  readonly existed: boolean;
  readonly recordCount: number;
  readonly checksum: string;
  readonly records: unknown[];
}

export interface MongoLogicalBackup {
  readonly backupVersion: 1;
  readonly sourceDriver: 'mongo';
  readonly sourceDatabase: string;
  readonly backupId: string;
  readonly createdAt: string;
  readonly collections: MongoLogicalBackupCollection[];
  readonly excludedCollections: ReadonlyArray<{ logicalName: string; reasonCode: 'SENSITIVE_COLLECTION_EXCLUDED' }>;
  readonly manifestChecksum: string;
  readonly snapshotChecksum: string;
}

export interface CreateMongoLogicalBackupOptions {
  readonly reader: ShadowCollectionReader;
  readonly sourceDatabase: string;
  readonly collections: readonly string[];
  readonly outputDir: string;
  readonly createdAt?: string;
  readonly backupId?: string;
  readonly sensitiveCollections?: readonly string[];
  readonly maxBytes?: number;
  readonly maxCollections?: number;
  readonly forbiddenDataDir?: string;
}

export interface MongoLogicalBackupResult {
  readonly filePath: string;
  readonly backup: MongoLogicalBackup;
  readonly byteSize: number;
}

const DEFAULT_MAX_BACKUP_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_COLLECTIONS = 100;
const DEFAULT_SENSITIVE_COLLECTIONS = new Set(['token-vault', 'credentials', 'credential-store', 'secrets']);

function isWithin(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertOutputDirectory(outputDir: string, forbiddenDataDir: string): string {
  const resolved = path.resolve(outputDir);
  if (isWithin(forbiddenDataDir, resolved) || isWithin(resolved, forbiddenDataDir)) {
    throw new Error('MONGO_BACKUP_DATA_DIR_FORBIDDEN');
  }
  const approvedRoots = [
    path.resolve(process.cwd(), '.test-tmp'),
    path.resolve(process.cwd(), '.backups'),
    path.resolve(process.cwd(), '.release'),
    path.resolve(os.tmpdir()),
  ];
  if (!approvedRoots.some(root => isWithin(root, resolved))) {
    throw new Error('MONGO_BACKUP_OUTPUT_NOT_IGNORED');
  }
  return resolved;
}

function safeIdentifier(value: string, code: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) throw new Error(code);
  return value;
}

function manifestValue(backup: Omit<MongoLogicalBackup, 'manifestChecksum' | 'snapshotChecksum'> | MongoLogicalBackup): unknown {
  return {
    backupVersion: backup.backupVersion,
    sourceDriver: backup.sourceDriver,
    sourceDatabase: backup.sourceDatabase,
    collections: backup.collections.map(collection => ({
      logicalName: collection.logicalName,
      existed: collection.existed,
      recordCount: collection.recordCount,
      checksum: collection.checksum,
    })),
    excludedCollections: backup.excludedCollections,
  };
}

function snapshotValue(backup: Omit<MongoLogicalBackup, 'manifestChecksum' | 'snapshotChecksum'> | MongoLogicalBackup): unknown {
  return {
    ...manifestValue(backup) as Record<string, unknown>,
    collections: backup.collections.map(collection => ({
      logicalName: collection.logicalName,
      existed: collection.existed,
      recordCount: collection.recordCount,
      checksum: collection.checksum,
      records: collection.records,
    })),
  };
}

export function verifyMongoLogicalBackup(value: unknown): MongoLogicalBackup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MONGO_BACKUP_INVALID');
  const backup = value as MongoLogicalBackup;
  if (backup.backupVersion !== 1 || backup.sourceDriver !== 'mongo') throw new Error('MONGO_BACKUP_VERSION_INVALID');
  safeIdentifier(backup.backupId, 'MONGO_BACKUP_ID_INVALID');
  safeIdentifier(backup.sourceDatabase, 'MONGO_BACKUP_DATABASE_INVALID');
  if (!Number.isFinite(Date.parse(backup.createdAt))) throw new Error('MONGO_BACKUP_CREATED_AT_INVALID');
  if (!Array.isArray(backup.collections) || !Array.isArray(backup.excludedCollections)) throw new Error('MONGO_BACKUP_INVALID');
  const names = backup.collections.map(collection => collection.logicalName);
  if (new Set(names).size !== names.length || !names.every((name, index) => index === 0 || names[index - 1].localeCompare(name) <= 0)) {
    throw new Error('MONGO_BACKUP_COLLECTION_ORDER_INVALID');
  }
  for (const collection of backup.collections) {
    if (!Array.isArray(collection.records) || collection.recordCount !== collection.records.length) {
      throw new Error('MONGO_BACKUP_COUNT_MISMATCH');
    }
    if (checksumCollection(collection.records) !== collection.checksum) throw new Error('MONGO_BACKUP_CHECKSUM_MISMATCH');
  }
  if (checksumJson(manifestValue(backup)) !== backup.manifestChecksum) throw new Error('MONGO_BACKUP_MANIFEST_CHECKSUM_MISMATCH');
  if (checksumJson(snapshotValue(backup)) !== backup.snapshotChecksum) throw new Error('MONGO_BACKUP_SNAPSHOT_CHECKSUM_MISMATCH');
  const serialized = JSON.stringify(backup);
  if (
    /mongodb(?:\+srv)?:\/\//i.test(serialized)
    || /"(?:uri|password|secret|token|apiKey|accessKey|refreshToken|authorization|cookie|session|credential|encryptedPayload)"\s*:/i.test(serialized)
  ) {
    throw new Error('MONGO_BACKUP_SECRET_MATERIAL');
  }
  return backup;
}

export async function readMongoLogicalBackup(filePath: string): Promise<MongoLogicalBackup> {
  const raw = await fs.readFile(path.resolve(filePath), 'utf8');
  return verifyMongoLogicalBackup(JSON.parse(raw) as unknown);
}

export async function createMongoLogicalBackup(
  options: CreateMongoLogicalBackupOptions
): Promise<MongoLogicalBackupResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BACKUP_BYTES;
  const maxCollections = options.maxCollections ?? DEFAULT_MAX_COLLECTIONS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024 || maxBytes > 256 * 1024 * 1024) {
    throw new Error('MONGO_BACKUP_SIZE_LIMIT_INVALID');
  }
  if (!Number.isSafeInteger(maxCollections) || maxCollections < 1 || maxCollections > 500) {
    throw new Error('MONGO_BACKUP_COLLECTION_LIMIT_INVALID');
  }
  assertIsolatedDatabase(options.sourceDatabase);
  const collectionNames = [...new Set(options.collections)].sort((left, right) => left.localeCompare(right));
  if (collectionNames.length > maxCollections) throw new Error('MONGO_BACKUP_COLLECTION_LIMIT_EXCEEDED');
  const sensitive = new Set([
    ...DEFAULT_SENSITIVE_COLLECTIONS,
    ...(options.sensitiveCollections ?? []).map(name => name.toLowerCase()),
  ]);
  const excludedCollections = collectionNames
    .filter(name => sensitive.has(name.toLowerCase()))
    .map(logicalName => ({ logicalName, reasonCode: 'SENSITIVE_COLLECTION_EXCLUDED' as const }));
  const included = collectionNames.filter(name => !sensitive.has(name.toLowerCase()));
  const collections: MongoLogicalBackupCollection[] = [];
  for (const logicalName of included) {
    const snapshot = await options.reader.inspectCollection(logicalName);
    const records = normalizeMongoDomainItems(snapshot.items);
    collections.push({
      logicalName,
      existed: snapshot.exists,
      recordCount: records.length,
      checksum: checksumCollection(records),
      records,
    });
  }

  const createdAt = options.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('MONGO_BACKUP_CREATED_AT_INVALID');
  const sourceDatabase = safeIdentifier(options.sourceDatabase, 'MONGO_BACKUP_DATABASE_INVALID');
  const checksumSeed = {
    backupVersion: 1 as const,
    sourceDriver: 'mongo' as const,
    sourceDatabase,
    backupId: 'pending',
    createdAt,
    collections,
    excludedCollections,
  };
  const manifestChecksum = checksumJson(manifestValue(checksumSeed));
  const backupId = safeIdentifier(
    options.backupId ?? `mongo-${createdAt.replace(/[^0-9A-Za-z]/g, '')}-${manifestChecksum.slice(0, 12)}`,
    'MONGO_BACKUP_ID_INVALID'
  );
  const withoutChecksums = { ...checksumSeed, backupId };
  const backup: MongoLogicalBackup = {
    ...withoutChecksums,
    manifestChecksum,
    snapshotChecksum: checksumJson(snapshotValue(withoutChecksums)),
  };
  verifyMongoLogicalBackup(backup);
  const content = `${JSON.stringify(backup, null, 2)}\n`;
  const byteSize = Buffer.byteLength(content, 'utf8');
  if (byteSize > maxBytes) throw new Error('MONGO_BACKUP_SIZE_LIMIT_EXCEEDED');

  const outputDir = assertOutputDirectory(
    options.outputDir,
    path.resolve(options.forbiddenDataDir ?? path.join(process.cwd(), '.data'))
  );
  await fs.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${backupId}.mongo-logical-backup.json`);
  const temporary = `${filePath}.tmp.${randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    verifyMongoLogicalBackup(JSON.parse(await fs.readFile(temporary, 'utf8')) as unknown);
    await fs.link(temporary, filePath);
    await fs.unlink(temporary);
    verifyMongoLogicalBackup(JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('MONGO_BACKUP_ALREADY_EXISTS');
    throw error;
  }
  return { filePath, backup, byteSize };
}
