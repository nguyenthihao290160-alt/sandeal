import { getStorageAdapter } from './storageFactory';
import type { AutomationSettings } from './automationSettings';
import type { SchedulerConfig } from '../bots/schedulerConfig';

/** Mutable, non-secret application state. Runtime selection/bindings stay outside this store. */
export type SettingsKey = 'automation' | 'scheduler';

export interface SettingsStore {
  read(key: SettingsKey): Promise<unknown | null>;
  write(key: SettingsKey, value: unknown): Promise<void>;
}

export class SettingsStoreError extends Error {
  constructor(readonly code: 'SETTINGS_STORE_UNSUPPORTED' | 'SETTINGS_VALUE_INVALID' | 'SETTINGS_SECRET_FORBIDDEN') {
    super(code);
    this.name = 'SettingsStoreError';
  }
}

export function getSettingsStore(): SettingsStore {
  const store = getStorageAdapter().settingsStore;
  if (!store) throw new SettingsStoreError('SETTINGS_STORE_UNSUPPORTED');
  return store;
}

// These are the existing domain fields, not an open-ended configuration bag.
// Adding an operational setting requires updating its domain type and this allowlist.
const automationKeys: Record<keyof AutomationSettings, true> = {
  schemaVersion: true, enabled: true, sourceScanEnabled: true, source: true,
  intervalHours: true, mode: true, maxItemsPerRun: true, maxItemsPerDay: true,
  autoClassify: true, autoCheckPrice: true, autoCheckLink: true, autoCheckImage: true,
  autoScore: true, duplicateProtection: true, sourceKeywords: true,
  bootstrapKeywordCount: true, steadyKeywordCount: true, bootstrapCandidateLimit: true,
  steadyCandidateLimit: true, bootstrapReviewBatch: true, steadyReviewBatch: true,
  maxConcurrency: true, maxRunDurationMs: true, sourceRequestBudgetPerDay: true,
  networkCheckBudgetPerDay: true, sourceMaxPerMerchant: true, sourceMaxPerCampaign: true,
  sourceDiscoveryPoolMultiplier: true, pausedSourceDomains: true, pausedSourceCampaigns: true,
  generationConcurrency: true, bulkBudgetPercent: true, editorialBudgetPercent: true,
  adjudicationBudgetPercent: true, launchEnabled: true, publishWaveSize: true,
  publishWaveDelayMinutes: true, maximumLaunchPublishes: true, minimumHealthPassRate: true,
  maximumErrorRate: true, maximumRollbackRate: true, safePublish: true, freeOnly: true,
  allowPaidAi: true, costMode: true, createdAt: true, updatedAt: true,
};
const schedulerKeys: Record<keyof Required<SchedulerConfig>, true> = {
  enabled: true, intervalMinutes: true, mode: true, lastRunAt: true,
  nextRunAt: true, updatedAt: true,
};

const secretKey = /(?:api[_-]?key|app[_-]?id|secret|token|password|passwd|cookie|authorization|private[_-]?key|credential)/i;
const secretValue = /(?:-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----|\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+|\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}))/i;

function validateLeaf(value: unknown, depth: number, seen: Set<object>): void {
  if (depth > 8) throw new SettingsStoreError('SETTINGS_VALUE_INVALID');
  if (value === undefined || value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SettingsStoreError('SETTINGS_VALUE_INVALID');
    return;
  }
  if (typeof value === 'string') {
    if (secretValue.test(value)) throw new SettingsStoreError('SETTINGS_SECRET_FORBIDDEN');
    for (const candidate of value.match(/https?:\/\/[^\s]+/gi) || []) {
      let url: URL;
      try { url = new URL(candidate); } catch { continue; }
      if (url.username || url.password || [...url.searchParams.keys()].some(key => secretKey.test(key))) {
        throw new SettingsStoreError('SETTINGS_SECRET_FORBIDDEN');
      }
    }
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) throw new SettingsStoreError('SETTINGS_VALUE_INVALID');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validateLeaf(item, depth + 1, seen);
  } else {
    // Existing settings contain scalar values and string lists only. Nested
    // objects would introduce unowned configuration/credential namespaces.
    throw new SettingsStoreError('SETTINGS_VALUE_INVALID');
  }
  seen.delete(value);
}

export function validateSettingsValue(key: SettingsKey, value: unknown): asserts value is Record<string, unknown> {
  if (key !== 'automation' && key !== 'scheduler') throw new SettingsStoreError('SETTINGS_VALUE_INVALID');
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new SettingsStoreError('SETTINGS_VALUE_INVALID');
  }
  const allowed = key === 'automation' ? automationKeys : schedulerKeys;
  for (const [field, item] of Object.entries(value)) {
    if (secretKey.test(field)) throw new SettingsStoreError('SETTINGS_SECRET_FORBIDDEN');
    if (!Object.hasOwn(allowed, field)) throw new SettingsStoreError('SETTINGS_VALUE_INVALID');
    validateLeaf(item, 0, new Set());
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 65_536) {
    throw new SettingsStoreError('SETTINGS_VALUE_INVALID');
  }
}
