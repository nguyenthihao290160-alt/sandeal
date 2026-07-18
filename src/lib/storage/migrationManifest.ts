import { checksumJson } from './migrationChecksum';
import type {
  FileCollectionInventory,
  InventoryClassification,
  InventoryComparison,
} from './migrationInventory';
import { validateCollectionName } from './mongoSerialization';

export type MigrationPolicy = 'include' | 'exclude';

export interface MigrationManifestCollection {
  readonly logicalName: string;
  readonly sourceFile: string;
  readonly classification: InventoryClassification;
  readonly sourceCount: number | null;
  readonly sourceChecksum: string | null;
  readonly sensitive: boolean;
  readonly migrationPolicy: MigrationPolicy;
  readonly batchSize: number;
  readonly expectedTargetCollection: string;
  readonly reasonCode: string | null;
}

export interface MigrationManifest {
  readonly manifestVersion: 1;
  readonly sourceDriver: 'file';
  readonly targetDriver: 'mongo';
  readonly database: string;
  readonly createdAt: string;
  readonly mode: 'dry_run';
  readonly collections: MigrationManifestCollection[];
  readonly comparison: InventoryComparison;
  readonly blockers: string[];
  readonly warnings: string[];
  readonly manifestChecksum: string;
}

export interface CreateMigrationManifestOptions {
  readonly database?: string;
  readonly batchSize?: number;
  readonly createdAt?: string;
}

export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly safeToApply: boolean;
  readonly errors: string[];
}

function validateDatabaseName(database: string): string {
  if (
    database === ''
    || Buffer.byteLength(database, 'utf8') > 63
    || /[\x00/\\."$*<>:|?]/.test(database)
  ) throw new Error('MIGRATION_DATABASE_INVALID');
  return database;
}

function logicalManifestValue(manifest: Omit<MigrationManifest, 'manifestChecksum'> | MigrationManifest): unknown {
  const mutable = { ...manifest } as Record<string, unknown>;
  delete mutable.createdAt;
  delete mutable.manifestChecksum;
  return mutable;
}

export function checksumMigrationManifest(
  manifest: Omit<MigrationManifest, 'manifestChecksum'> | MigrationManifest
): string {
  return checksumJson(logicalManifestValue(manifest));
}

function policyFor(classification: InventoryClassification): MigrationPolicy {
  return classification === 'migratable' || classification === 'empty' ? 'include' : 'exclude';
}

export function createMigrationManifest(
  inventory: FileCollectionInventory,
  options: CreateMigrationManifestOptions = {}
): MigrationManifest {
  const database = validateDatabaseName((options.database ?? 'sandeal').trim());
  const batchSize = options.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error('MIGRATION_BATCH_SIZE_INVALID');
  }
  const createdAt = options.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('MIGRATION_CREATED_AT_INVALID');

  const collections = inventory.records
    .filter(record => record.logicalCollection !== null)
    .flatMap<MigrationManifestCollection>(record => {
      try {
        const logicalName = validateCollectionName(record.logicalCollection as string);
        const migrationPolicy = policyFor(record.classification);
        return [{
          logicalName,
          sourceFile: record.sourceFile,
          classification: record.classification,
          sourceCount: record.recordCount,
          sourceChecksum: record.checksum,
          sensitive: record.classification === 'sensitive_excluded',
          migrationPolicy,
          batchSize,
          expectedTargetCollection: logicalName,
          reasonCode: record.reasonCode,
        }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.logicalName.localeCompare(right.logicalName));

  const withoutChecksum: Omit<MigrationManifest, 'manifestChecksum'> = {
    manifestVersion: 1,
    sourceDriver: 'file',
    targetDriver: 'mongo',
    database,
    createdAt,
    mode: 'dry_run',
    collections,
    comparison: {
      fileWithoutSchema: [...inventory.comparison.fileWithoutSchema],
      schemaWithoutFile: [...inventory.comparison.schemaWithoutFile],
      sourceWithoutSchema: [...inventory.comparison.sourceWithoutSchema],
      schemaWithoutSource: [...inventory.comparison.schemaWithoutSource],
    },
    blockers: [...inventory.blockers],
    warnings: [...inventory.warnings],
  };
  const manifest: MigrationManifest = {
    ...withoutChecksum,
    manifestChecksum: checksumMigrationManifest(withoutChecksum),
  };
  const validation = validateMigrationManifest(manifest);
  if (!validation.valid) throw new Error(`MIGRATION_MANIFEST_INVALID:${validation.errors.join(',')}`);
  return manifest;
}

function sorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1].localeCompare(value) <= 0);
}

function hasSecretMaterial(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  if (/mongodb(?:\+srv)?:\/\//i.test(serialized)) return true;
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasSecretMaterial);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:uri|password|secret|apiKey|accessKey|authorization|cookie|session|credential|encryptedPayload)$/i.test(key)) {
      return true;
    }
    if (hasSecretMaterial(item)) return true;
  }
  return false;
}

export function validateMigrationManifest(manifest: MigrationManifest): ManifestValidationResult {
  const errors: string[] = [];
  if (manifest.manifestVersion !== 1) errors.push('MANIFEST_VERSION_UNSUPPORTED');
  if (manifest.sourceDriver !== 'file' || manifest.targetDriver !== 'mongo') errors.push('MANIFEST_DRIVER_INVALID');
  if (manifest.mode !== 'dry_run') errors.push('MANIFEST_MODE_INVALID');
  try { validateDatabaseName(manifest.database); } catch { errors.push('MANIFEST_DATABASE_INVALID'); }
  if (!Number.isFinite(Date.parse(manifest.createdAt))) errors.push('MANIFEST_CREATED_AT_INVALID');
  if (!sorted(manifest.collections.map(collection => collection.logicalName))) errors.push('MANIFEST_COLLECTION_ORDER_INVALID');
  if (new Set(manifest.collections.map(collection => collection.logicalName)).size !== manifest.collections.length) {
    errors.push('MANIFEST_COLLECTION_DUPLICATE');
  }

  for (const collection of manifest.collections) {
    try {
      validateCollectionName(collection.logicalName);
      validateCollectionName(collection.expectedTargetCollection);
    } catch {
      errors.push(`MANIFEST_COLLECTION_NAME_INVALID:${collection.logicalName}`);
    }
    if (collection.logicalName !== collection.expectedTargetCollection) {
      errors.push(`MANIFEST_TARGET_NAME_MISMATCH:${collection.logicalName}`);
    }
    if (!Number.isSafeInteger(collection.batchSize) || collection.batchSize < 1 || collection.batchSize > 1_000) {
      errors.push(`MANIFEST_BATCH_SIZE_INVALID:${collection.logicalName}`);
    }
    if (collection.migrationPolicy === 'include') {
      if (collection.sensitive) errors.push(`MANIFEST_SENSITIVE_INCLUDED:${collection.logicalName}`);
      if (collection.sourceCount === null || collection.sourceChecksum === null) {
        errors.push(`MANIFEST_SOURCE_PROOF_MISSING:${collection.logicalName}`);
      }
    }
    if (collection.sensitive && collection.migrationPolicy !== 'exclude') {
      errors.push(`MANIFEST_SENSITIVE_POLICY_INVALID:${collection.logicalName}`);
    }
  }

  if (!sorted(manifest.blockers) || !sorted(manifest.warnings)) errors.push('MANIFEST_DIAGNOSTIC_ORDER_INVALID');
  if (hasSecretMaterial(manifest)) errors.push('MANIFEST_SECRET_MATERIAL');
  if (checksumMigrationManifest(manifest) !== manifest.manifestChecksum) errors.push('MANIFEST_CHECKSUM_MISMATCH');
  return {
    valid: errors.length === 0,
    safeToApply: errors.length === 0 && manifest.blockers.length === 0,
    errors,
  };
}
