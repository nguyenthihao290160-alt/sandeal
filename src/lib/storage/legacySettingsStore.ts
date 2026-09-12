import { promises as fs } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { validateSettingsValue, type SettingsKey, type SettingsStore } from './settingsStore';
import type { StorageAdapter } from './types';

const files: Record<SettingsKey, string> = {
  automation: 'automation-settings.json',
  scheduler: 'scheduler-config.json',
};

/** Only the legacy infrastructure knows the historical singleton file paths. */
export function createLegacySettingsStore(
  adapter: Pick<StorageAdapter, 'getDataDir' | 'ensureDataDir'>,
): SettingsStore {
  return {
    async read(key) {
      const filename = files[key];
      if (!filename) throw new Error('SETTINGS_VALUE_INVALID');
      if (key === 'scheduler') await adapter.ensureDataDir();
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.readFile(path.join(adapter.getDataDir(), filename), 'utf-8'));
      } catch {
        // Preserve legacy absent/corrupt/unreadable-file defaults here only.
        // Other drivers must surface storage failures to their callers.
        return null;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      validateSettingsValue(key, parsed);
      return parsed;
    },
    async write(key, value) {
      validateSettingsValue(key, value);
      await adapter.ensureDataDir();
      const filename = path.join(adapter.getDataDir(), files[key]);
      const temporary = `${filename}.tmp.${randomBytes(4).toString('hex')}`;
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf-8');
      // Both domains now retain the same existing automation atomic replacement
      // boundary; a failed write cannot expose a partially written singleton.
      await fs.rename(temporary, filename);
    },
  };
}
