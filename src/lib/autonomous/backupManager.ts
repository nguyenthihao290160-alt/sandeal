import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/lib/storage/adapter';

export const BACKUP_FORMAT_VERSION = 1;
export const CRITICAL_AUTONOMOUS_COLLECTIONS = [
  'products',
  'automation-jobs',
  'automation-control',
  'candidate-queue',
  'operation-journal',
  'publication-audit',
  'automation-outbound-events',
  'evidence-facts',
  'automation-canary',
] as const;

export type CollectionRecoveryStatus = 'HEALTHY' | 'FRESH_EMPTY' | 'RECOVERABLE_FROM_BACKUP' | 'BLOCKED';

export interface CollectionRecoveryInspection {
  collection: string;
  status: CollectionRecoveryStatus;
  main: 'VALID' | 'MISSING' | 'INVALID';
  backup: 'VALID' | 'MISSING' | 'INVALID' | 'NOT_CHECKED';
}

export interface CriticalStorageInspection {
  status: 'healthy' | 'degraded' | 'blocked';
  collections: CollectionRecoveryInspection[];
  healthy: string[];
  freshEmpty: string[];
  recoverable: string[];
  blocked: string[];
  checkedAt: string;
}

export interface BackupManifest {
  schemaVersion: number;
  format: 'sandeal-autonomous-snapshot';
  id: string;
  reason: 'migration' | 'canary' | 'scheduled' | 'manual' | 'test';
  sourceSchemaVersion: number;
  createdAt: string;
  files: Array<{ name: string; bytes: number; records: number | null; checksum: string }>;
  excluded: string[];
  checksum: string;
}

export interface BackupRetentionIndex {
  schemaVersion: number;
  keep: string[];
  expiredCandidates: string[];
  generatedAt: string;
  note: string;
}

interface PreCanarySnapshotIndex {
  schemaVersion: number;
  entries: Array<{
    targetMode: 'CANARY' | 'AUTONOMOUS';
    sourceStateHash: string;
    snapshotId: string;
    snapshotDirectory: string;
    manifestChecksum: string;
    createdAt: string;
  }>;
  updatedAt: string;
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function snapshotId(now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
}

function isSensitiveStorageFile(name: string): boolean {
  return /token-vault|credential|secret/i.test(name);
}

function assertSafeJsonName(name: string): void {
  if (path.basename(name) !== name || !/^[a-z0-9][a-z0-9._-]*\.json$/i.test(name)) throw new Error('BACKUP_FILE_NAME_INVALID');
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function parseJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

async function inspectArrayFile(file: string): Promise<'VALID' | 'MISSING' | 'INVALID'> {
  try {
    const parsed = await parseJsonFile(file);
    return Array.isArray(parsed) ? 'VALID' : 'INVALID';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING' : 'INVALID';
  }
}

export async function inspectCollectionRecovery(collection: string, dataDir = getDataDir()): Promise<CollectionRecoveryInspection> {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(collection)) throw new Error('COLLECTION_NAME_INVALID');
  const mainFile = path.join(path.resolve(dataDir), `${collection}.json`);
  const backupFile = `${mainFile}.bak`;
  const main = await inspectArrayFile(mainFile);
  if (main === 'VALID') return { collection, status: 'HEALTHY', main, backup: 'NOT_CHECKED' };
  const backup = await inspectArrayFile(backupFile);
  if (main === 'MISSING' && backup === 'MISSING') return { collection, status: 'FRESH_EMPTY', main, backup };
  if (backup === 'VALID') return { collection, status: 'RECOVERABLE_FROM_BACKUP', main, backup };
  return { collection, status: 'BLOCKED', main, backup };
}

export async function verifyCollectionRecovery(collection: string, dataDir = getDataDir()): Promise<CollectionRecoveryStatus> {
  return (await inspectCollectionRecovery(collection, dataDir)).status;
}

export async function inspectCriticalStorage(
  dataDir = getDataDir(),
  collections: readonly string[] = CRITICAL_AUTONOMOUS_COLLECTIONS,
  now = Date.now(),
): Promise<CriticalStorageInspection> {
  const inspections = await Promise.all(collections.map(collection => inspectCollectionRecovery(collection, dataDir)));
  const healthy = inspections.filter(item => item.status === 'HEALTHY').map(item => item.collection);
  const freshEmpty = inspections.filter(item => item.status === 'FRESH_EMPTY').map(item => item.collection);
  const recoverable = inspections.filter(item => item.status === 'RECOVERABLE_FROM_BACKUP').map(item => item.collection);
  const blocked = inspections.filter(item => item.status === 'BLOCKED').map(item => item.collection);
  return {
    status: blocked.length ? 'blocked' : recoverable.length ? 'degraded' : 'healthy',
    collections: inspections,
    healthy,
    freshEmpty,
    recoverable,
    blocked,
    checkedAt: new Date(now).toISOString(),
  };
}

export async function createStorageSnapshot(options: {
  sourceDir?: string;
  outputDir?: string;
  reason: BackupManifest['reason'];
  retention?: number;
  now?: number;
}): Promise<{ directory: string; manifest: BackupManifest; retentionCandidates: string[] }> {
  const sourceDir = path.resolve(options.sourceDir || getDataDir());
  const outputDir = path.resolve(options.outputDir || path.join(sourceDir, '..', 'sandeal-backups'));
  if (isInside(sourceDir, outputDir)) throw new Error('BACKUP_OUTPUT_MUST_BE_OUTSIDE_SOURCE');
  const sourceStat = await fs.stat(sourceDir).catch(() => null);
  if (!sourceStat?.isDirectory()) throw new Error('BACKUP_SOURCE_MISSING');
  await fs.mkdir(outputDir, { recursive: true });
  const now = options.now ?? Date.now();
  const id = snapshotId(new Date(now));
  const finalDirectory = path.join(outputDir, `snapshot-${id}`);
  const pendingDirectory = path.join(outputDir, `.pending-snapshot-${id}`);
  const dataDir = path.join(pendingDirectory, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  const files: BackupManifest['files'] = [];
  const excluded: string[] = [];
  const entries = (await fs.readdir(sourceDir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    assertSafeJsonName(entry.name);
    if (isSensitiveStorageFile(entry.name)) { excluded.push(entry.name); continue; }
    const source = path.join(sourceDir, entry.name);
    const parsed = await parseJsonFile(source);
    const content = await fs.readFile(source);
    const destination = path.join(dataDir, entry.name);
    await fs.writeFile(`${destination}.tmp`, content);
    await fs.rename(`${destination}.tmp`, destination);
    files.push({
      name: entry.name,
      bytes: content.byteLength,
      records: Array.isArray(parsed) ? parsed.length : null,
      checksum: hash(content),
    });
  }
  const withoutChecksum = {
    schemaVersion: BACKUP_FORMAT_VERSION,
    format: 'sandeal-autonomous-snapshot' as const,
    id,
    reason: options.reason,
    sourceSchemaVersion: 2,
    createdAt: new Date(now).toISOString(),
    files,
    excluded,
  };
  const manifest: BackupManifest = { ...withoutChecksum, checksum: hash(JSON.stringify(withoutChecksum)) };
  await writeJsonAtomic(path.join(pendingDirectory, 'manifest.json'), manifest);
  await verifyStorageSnapshot(pendingDirectory);
  await fs.rename(pendingDirectory, finalDirectory);
  await verifyStorageSnapshot(finalDirectory);

  const retention = Math.max(1, Math.min(365, Math.floor(options.retention || 30)));
  const snapshots = (await fs.readdir(outputDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith('snapshot-'))
    .map(entry => entry.name)
    .sort()
    .reverse();
  const retentionCandidates = snapshots.slice(retention);
  const retentionIndex: BackupRetentionIndex = {
    schemaVersion: 1,
    keep: snapshots.slice(0, retention),
    expiredCandidates: retentionCandidates,
    generatedAt: new Date(now).toISOString(),
    note: 'Deletion requires an explicit owner-approved maintenance action.',
  };
  await writeJsonAtomic(path.join(outputDir, 'retention-index.json'), retentionIndex);
  return { directory: finalDirectory, manifest, retentionCandidates };
}

export async function verifyStorageSnapshot(directory: string): Promise<BackupManifest> {
  const snapshotDirectory = path.resolve(directory);
  const manifest = await parseJsonFile(path.join(snapshotDirectory, 'manifest.json')) as BackupManifest;
  if (manifest.schemaVersion !== BACKUP_FORMAT_VERSION || manifest.format !== 'sandeal-autonomous-snapshot' || !Array.isArray(manifest.files) || !Array.isArray(manifest.excluded)) {
    throw new Error('BACKUP_MANIFEST_INVALID');
  }
  const { checksum, ...withoutChecksum } = manifest;
  if (hash(JSON.stringify(withoutChecksum)) !== checksum) throw new Error('BACKUP_MANIFEST_CHECKSUM_MISMATCH');
  const names = new Set<string>();
  for (const item of manifest.files) {
    assertSafeJsonName(item.name);
    if (names.has(item.name)) throw new Error(`BACKUP_FILE_DUPLICATE:${item.name}`);
    names.add(item.name);
    const file = path.join(snapshotDirectory, 'data', item.name);
    const content = await fs.readFile(file);
    if (content.byteLength !== item.bytes || hash(content) !== item.checksum) throw new Error(`BACKUP_FILE_CHECKSUM_MISMATCH:${item.name}`);
    const parsed = JSON.parse(content.toString('utf8'));
    if (item.records !== null && (!Array.isArray(parsed) || parsed.length !== item.records)) throw new Error(`BACKUP_RECORD_COUNT_MISMATCH:${item.name}`);
  }
  return manifest;
}

export async function restoreSnapshotToIsolatedDirectory(snapshotDirectory: string, targetDirectory: string): Promise<{ restored: number; manifest: BackupManifest }> {
  const snapshot = path.resolve(snapshotDirectory);
  const manifest = await verifyStorageSnapshot(snapshot);
  const target = path.resolve(targetDirectory);
  if (isInside(snapshot, target) || isInside(target, snapshot)) throw new Error('RESTORE_TARGET_OVERLAPS_SNAPSHOT');
  await fs.mkdir(target, { recursive: true });
  if ((await fs.readdir(target)).length) throw new Error('RESTORE_TARGET_NOT_EMPTY');
  for (const item of manifest.files) {
    assertSafeJsonName(item.name);
    const source = path.join(snapshot, 'data', item.name);
    const destination = path.join(target, item.name);
    await fs.copyFile(source, `${destination}.tmp`);
    await fs.rename(`${destination}.tmp`, destination);
    const restored = await fs.readFile(destination);
    if (hash(restored) !== item.checksum) throw new Error(`RESTORE_CHECKSUM_MISMATCH:${item.name}`);
    const parsed = JSON.parse(restored.toString('utf8'));
    if (item.records !== null && (!Array.isArray(parsed) || parsed.length !== item.records)) throw new Error(`RESTORE_RECORD_COUNT_MISMATCH:${item.name}`);
  }
  return { restored: manifest.files.length, manifest };
}

async function sourceStateHash(sourceDir: string): Promise<string> {
  const critical = await inspectCriticalStorage(sourceDir);
  if (critical.status !== 'healthy') throw new Error(`PRE_CANARY_STORAGE_${critical.status.toUpperCase()}`);
  const entries = (await fs.readdir(sourceDir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const state: Array<[string, string]> = [];
  for (const entry of entries) {
    assertSafeJsonName(entry.name);
    if (isSensitiveStorageFile(entry.name)) { state.push([entry.name, 'EXCLUDED']); continue; }
    const content = await fs.readFile(path.join(sourceDir, entry.name));
    const parsed = JSON.parse(content.toString('utf8'));
    if (!Array.isArray(parsed)) throw new Error(`PRE_CANARY_COLLECTION_INVALID:${entry.name}`);
    state.push([entry.name, hash(content)]);
  }
  state.push(['critical-collection-state', hash(JSON.stringify(critical.collections.map(item => [item.collection, item.status]))) ]);
  return hash(JSON.stringify(state));
}

async function readPreCanaryIndex(file: string): Promise<PreCanarySnapshotIndex> {
  try {
    const parsed = await parseJsonFile(file) as PreCanarySnapshotIndex;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) throw new Error('invalid_index');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, entries: [], updatedAt: new Date(0).toISOString() };
    throw new Error('PRE_CANARY_INDEX_INVALID');
  }
}

const preCanaryLocks = new Map<string, Promise<void>>();

async function ensurePreCanarySnapshotInternal(options: {
  sourceDir?: string;
  outputDir?: string;
  targetMode: 'CANARY' | 'AUTONOMOUS';
  retention?: number;
  now?: number;
}): Promise<{ created: boolean; directory: string; manifest: BackupManifest; sourceStateHash: string }> {
  const sourceDir = path.resolve(options.sourceDir || getDataDir());
  const outputDir = path.resolve(options.outputDir || process.env.SANDEAL_BACKUP_DIR || path.join(sourceDir, '..', 'sandeal-backups'));
  if (isInside(sourceDir, outputDir)) throw new Error('BACKUP_OUTPUT_MUST_BE_OUTSIDE_SOURCE');
  await fs.mkdir(outputDir, { recursive: true });
  const stateHash = await sourceStateHash(sourceDir);
  const indexFile = path.join(outputDir, 'pre-canary-index.json');
  const index = await readPreCanaryIndex(indexFile);
  const existing = [...index.entries].reverse().find(entry => entry.targetMode === options.targetMode && entry.sourceStateHash === stateHash);
  if (existing) {
    const directory = path.resolve(existing.snapshotDirectory);
    if (isInside(outputDir, directory) && directory !== outputDir) {
      try {
        const manifest = await verifyStorageSnapshot(directory);
        if (manifest.id === existing.snapshotId && manifest.checksum === existing.manifestChecksum) {
          return { created: false, directory, manifest, sourceStateHash: stateHash };
        }
      } catch {
        // Retain the invalid index entry as evidence and create a new verified snapshot.
      }
    }
  }
  const snapshot = await createStorageSnapshot({
    sourceDir,
    outputDir,
    reason: 'canary',
    retention: options.retention,
    now: options.now,
  });
  const now = new Date(options.now ?? Date.now()).toISOString();
  const next: PreCanarySnapshotIndex = {
    schemaVersion: 1,
    entries: [...index.entries, {
      targetMode: options.targetMode,
      sourceStateHash: stateHash,
      snapshotId: snapshot.manifest.id,
      snapshotDirectory: snapshot.directory,
      manifestChecksum: snapshot.manifest.checksum,
      createdAt: now,
    }],
    updatedAt: now,
  };
  await writeJsonAtomic(indexFile, next);
  return { created: true, directory: snapshot.directory, manifest: snapshot.manifest, sourceStateHash: stateHash };
}

export async function ensurePreCanarySnapshot(options: {
  sourceDir?: string;
  outputDir?: string;
  targetMode: 'CANARY' | 'AUTONOMOUS';
  retention?: number;
  now?: number;
}): Promise<{ created: boolean; directory: string; manifest: BackupManifest; sourceStateHash: string }> {
  const sourceDir = path.resolve(options.sourceDir || getDataDir());
  const outputDir = path.resolve(options.outputDir || process.env.SANDEAL_BACKUP_DIR || path.join(sourceDir, '..', 'sandeal-backups'));
  const lockKey = `${sourceDir}:${outputDir}`;
  const previous = preCanaryLocks.get(lockKey) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => current);
  preCanaryLocks.set(lockKey, queued);
  try {
    await previous;
    return await ensurePreCanarySnapshotInternal({ ...options, sourceDir, outputDir });
  } finally {
    release();
    if (preCanaryLocks.get(lockKey) === queued) preCanaryLocks.delete(lockKey);
  }
}
