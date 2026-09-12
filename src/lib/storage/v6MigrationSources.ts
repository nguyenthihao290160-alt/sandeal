import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StorageAdapter } from './types';
import { scanJsonArrayFile } from './fileStorageAdapter';

export interface MigrationInput { domain: string; value: unknown; malformed?: boolean; countUnknown?: boolean }
export interface V6MigrationSource {
  readonly driver: 'file' | 'mongo';
  readonly shadow: boolean;
  readonly directory?: string;
  scan(visitor: (record: MigrationInput) => Promise<void>): Promise<void>;
}
const singletonFiles: Record<string, string> = { 'automation-settings.json': 'automation', 'scheduler-config.json': 'scheduler' };
const supported = new Set(['products', 'price-history', 'system-settings']);

/** Read primary source bytes only. Never invoke recovery, mkdir, locks or repair. */
export function createFileMigrationSource(directory: string, shadow = false): V6MigrationSource {
  const resolved = path.resolve(directory);
  return { driver: 'file', directory: resolved, shadow, async scan(visitor) {
    const stat = await fs.lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('MIGRATION_SOURCE_PATH_INVALID');
    if (shadow) {
      const approved = await fs.realpath(path.join(process.cwd(), '.test-tmp'));
      const actual = await fs.realpath(resolved);
      if (!actual.startsWith(approved + path.sep)) throw new Error('MIGRATION_SHADOW_PATH_REQUIRED');
    }
    const entries = (await fs.readdir(resolved, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > 1000) throw new Error('MIGRATION_SOURCE_FILE_LIMIT');
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      const domain = singletonFiles[entry.name] ? 'system-settings' : entry.name.slice(0, -5);
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('MIGRATION_SOURCE_PATH_INVALID');
      // Excluded domains are represented without reading possible secret payloads.
      if (!supported.has(domain)) { await visitor({ domain, value: null, countUnknown: true }); continue; }
      const filename = path.join(resolved, entry.name);
      if (singletonFiles[entry.name]) {
        if ((await fs.stat(filename)).size > 65536) { await visitor({ domain, value: null, malformed: true }); continue; }
        let value: unknown;
        try { value = JSON.parse(await fs.readFile(filename, 'utf8')); }
        catch { await visitor({ domain, value: null, malformed: true }); continue; }
        await visitor({ domain, value: { id: singletonFiles[entry.name], value } });
      } else {
        // Callback failures must propagate; invalid JSON is a blocking source error.
        await scanJsonArrayFile<unknown>(filename, value => visitor({ domain, value }),
          { maximumMemberBytes: 1048576, strictDelimiters: true });
      }
    }
  } };
}

/** Existing revision-envelope Mongo cursor API; no new Mongo schema or writes. */
export function createMongoMigrationSource(adapter: Pick<StorageAdapter, 'driver' | 'scanCollection'>, collections: readonly string[], shadow = false): V6MigrationSource {
  if (adapter.driver !== 'mongo' || collections.length > 1000) throw new Error('MIGRATION_SOURCE_DRIVER_INVALID');
  return { driver: 'mongo', shadow, async scan(visitor) {
    for (const domain of [...new Set(collections)].sort()) {
      if (!supported.has(domain)) { await visitor({ domain, value: null, countUnknown: true }); continue; }
      await adapter.scanCollection(domain, value => visitor({ domain, value }));
    }
  } };
}
