import { promises as fs } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { ensureDataDir, getDataDir } from './adapter';

function getSettingsFile() { return path.join(getDataDir(), 'automation-settings.json'); }

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
  sourceKeywords: string[];
  bootstrapKeywordCount: number;
  steadyKeywordCount: number;
  bootstrapCandidateLimit: number;
  steadyCandidateLimit: number;
  bootstrapReviewBatch: number;
  steadyReviewBatch: number;
  maxConcurrency: number;
  maxRunDurationMs: number;
  sourceRequestBudgetPerDay: number;
  networkCheckBudgetPerDay: number;

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
  sourceKeywords: ['chăm sóc da', 'serum', 'sữa tắm', 'dầu gội', 'đồ gia dụng', 'máy hút bụi', 'máy xay', 'bàn phím', 'chuột không dây', 'sạc dự phòng', 'phụ kiện điện thoại', 'thời trang', 'đồng hồ', 'đồ dùng mẹ và bé'],
  bootstrapKeywordCount: 10,
  steadyKeywordCount: 5,
  bootstrapCandidateLimit: 80,
  steadyCandidateLimit: 40,
  bootstrapReviewBatch: 15,
  steadyReviewBatch: 10,
  maxConcurrency: 4,
  maxRunDurationMs: 240_000,
  sourceRequestBudgetPerDay: 300,
  networkCheckBudgetPerDay: 900,
  
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
function sanitizeSettings(settings: Record<string, unknown>): AutomationSettings {
  const sanitized = {
    ...DEFAULT_SETTINGS,
    ...settings,
    
    // Clamp limits
    maxItemsPerRun: Math.max(1, Math.min(Number(settings.maxItemsPerRun) || 10, 50)),
    maxItemsPerDay: Math.max(1, Math.min(Number(settings.maxItemsPerDay) || 30, 200)),
    intervalHours: [3, 6, 12, 24].includes(Number(settings.intervalHours)) 
      ? Number(settings.intervalHours) 
      : 6,
    sourceKeywords: Array.isArray(settings.sourceKeywords)
      ? settings.sourceKeywords.map((item: unknown) => String(item).trim()).filter(Boolean).slice(0, 100)
      : DEFAULT_SETTINGS.sourceKeywords,
    bootstrapKeywordCount: Math.max(8, Math.min(Number(settings.bootstrapKeywordCount) || 10, 12)),
    steadyKeywordCount: Math.max(4, Math.min(Number(settings.steadyKeywordCount) || 5, 6)),
    bootstrapCandidateLimit: Math.max(50, Math.min(Number(settings.bootstrapCandidateLimit) || 80, 100)),
    steadyCandidateLimit: Math.max(10, Math.min(Number(settings.steadyCandidateLimit) || 40, 50)),
    bootstrapReviewBatch: Math.max(10, Math.min(Number(settings.bootstrapReviewBatch) || 15, 20)),
    steadyReviewBatch: Math.max(5, Math.min(Number(settings.steadyReviewBatch) || 10, 15)),
    maxConcurrency: Math.max(1, Math.min(Number(settings.maxConcurrency) || 4, 4)),
    maxRunDurationMs: Math.max(60_000, Math.min(Number(settings.maxRunDurationMs) || 240_000, 10 * 60_000)),
    sourceRequestBudgetPerDay: Math.max(10, Math.min(Number(settings.sourceRequestBudgetPerDay) || 300, 2_000)),
    networkCheckBudgetPerDay: Math.max(30, Math.min(Number(settings.networkCheckBudgetPerDay) || 900, 5_000)),
      
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
    const raw = await fs.readFile(getSettingsFile(), 'utf-8');
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

  const settingsFile = getSettingsFile();
  const tmpPath = settingsFile + '.tmp.' + randomBytes(4).toString('hex');
  await fs.writeFile(tmpPath, JSON.stringify(next, null, 2), 'utf-8');
  await fs.rename(tmpPath, settingsFile);

  return next;
}
