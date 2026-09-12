import { validateSettingsValue, type SettingsStore } from './settingsStore';
import type { StorageAdapter } from './types';
import { domainJson } from './domainSerialization';

/** Legacy Mongo singleton settings; never calls filesystem compatibility methods. */
export function createCollectionSettingsStore(adapter: Pick<StorageAdapter, 'readBoundedCollection' | 'runTransaction'>): SettingsStore {
  type Row = { id: 'automation' | 'scheduler'; value: unknown };
  return {
    async read(key) {
      const rows = await adapter.readBoundedCollection<Row>('system-settings', { maximumItems: 2, maximumBytes: 140_000 });
      const value = rows.find(row => row.id === key)?.value ?? null;
      if (value !== null) validateSettingsValue(key, value);
      return value;
    },
    async write(key, value) {
      validateSettingsValue(key, value);
      await adapter.runTransaction<Row>('system-settings', rows => [...rows.filter(row => row.id !== key), { id: key, value: domainJson(value) }]);
    },
  };
}
