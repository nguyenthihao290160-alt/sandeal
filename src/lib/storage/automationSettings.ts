import { promises as fs } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { ensureDataDir } from './adapter';

const DATA_DIR = path.join(process.cwd(), '.data');
const SETTINGS_FILE = path.join(DATA_DIR, 'automation-settings.json');

export interface AutomationSettings {
  schemaVersion: number;
  enabled: boolean;
  sourceScanEnabled: boolean;
  source: string;
  intervalHours: number;
  mode: string;
  maxItemsPerRun: number;
  maxItemsPerDay: number;
  autoClassify: boolean;
  autoCheckPrice: boolean;
  autoCheckLink: boolean;
  autoCheckImage: boolean;
  autoScore: boolean;
  duplicateProtection: boolean;

  // Immutables / System policies
  safePublish: boolean;
  freeOnly: boolean;
  allowPaidAi: boolean;
  costMode: string;

  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_SETTINGS: AutomationSettings = {
  schemaVersion: 1,
  enabled: false,
  sourceScanEnabled: true,
  source: 'accesstrade',
  intervalHours: 6,
  mode: 'full_safe_run',
  maxItemsPerRun: 10,
  maxItemsPerDay: 30,
  autoClassify: true,
  autoCheckPrice: true,
  autoCheckLink: true,
  autoCheckImage: true,
  autoScore: true,
  duplicateProtection: true,
  
  // Immutables - Must NEVER be overridden by frontend
  safePublish: true,
  freeOnly: true,
  allowPaidAi: false,
  costMode: 'safe_free',

  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/**
 * Ensures limits are within safe bounds and immutables are enforced.
 */
function sanitizeSettings(settings: any): AutomationSettings {
  const sanitized = {
    ...DEFAULT_SETTINGS,
    ...settings,
    
    // Clamp limits
    maxItemsPerRun: Math.max(1, Math.min(Number(settings.maxItemsPerRun) || 10, 50)),
    maxItemsPerDay: Math.max(1, Math.min(Number(settings.maxItemsPerDay) || 30, 200)),
    intervalHours: [3, 6, 12, 24].includes(Number(settings.intervalHours)) 
      ? Number(settings.intervalHours) 
      : 6,
      
    // Enforce Immutables
    safePublish: true,
    freeOnly: true,
    allowPaidAi: false,
    costMode: 'safe_free',
  };

  // Ensure daily cap is not smaller than run cap
  if (sanitized.maxItemsPerDay < sanitized.maxItemsPerRun) {
    sanitized.maxItemsPerDay = sanitized.maxItemsPerRun;
  }

  return sanitized as AutomationSettings;
}

export async function getAutomationSettings(): Promise<AutomationSettings> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return DEFAULT_SETTINGS;
    }
    return sanitizeSettings(parsed);
  } catch {
    // If file doesn't exist or is corrupt, return defaults
    return DEFAULT_SETTINGS;
  }
}

export async function updateAutomationSettings(
  updates: Partial<AutomationSettings>
): Promise<AutomationSettings> {
  await ensureDataDir();
  
  // Prevent passing unsafe overrides in updates
  if (
    updates.safePublish === false ||
    updates.freeOnly === false ||
    updates.allowPaidAi === true ||
    (updates.costMode && updates.costMode !== 'safe_free')
  ) {
    throw new Error('Policy violation: Cannot override safety immutables.');
  }

  const current = await getAutomationSettings();
  const next = sanitizeSettings({
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  });

  const tmpPath = SETTINGS_FILE + '.tmp.' + randomBytes(4).toString('hex');
  await fs.writeFile(tmpPath, JSON.stringify(next, null, 2), 'utf-8');
  await fs.rename(tmpPath, SETTINGS_FILE);

  return next;
}
