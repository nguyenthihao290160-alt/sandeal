// ===========================================
// Scheduler Config — AutoPilot scheduler settings
// Default OFF. Min interval 30 min. No in-memory loops.
// ===========================================

import { promises as fs } from 'fs';
import path from 'path';
import { ensureDataDir, getDataDir } from '../storage/adapter';

function getConfigFile() { return path.join(getDataDir(), 'scheduler-config.json'); }

export type SchedulerMode =
  | 'full_safe_run'
  | 'source_scan'
  | 'health_check'
  | 'cleanup_broken_products';

export type SchedulerInterval = 30 | 45 | 60 | 120;

const VALID_INTERVALS: SchedulerInterval[] = [30, 45, 60, 120];
const VALID_MODES: SchedulerMode[] = [
  'full_safe_run',
  'source_scan',
  'health_check',
  'cleanup_broken_products',
];

export interface SchedulerConfig {
  enabled: boolean;
  intervalMinutes: SchedulerInterval;
  mode: SchedulerMode;
  lastRunAt?: string;
  nextRunAt?: string;
  updatedAt: string;
}

function getDefaultConfig(): SchedulerConfig {
  return {
    enabled: false,
    intervalMinutes: 60,
    mode: 'full_safe_run',
    updatedAt: new Date().toISOString(),
  };
}

export async function getSchedulerConfig(): Promise<SchedulerConfig> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(getConfigFile(), 'utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      return {
        ...getDefaultConfig(),
        ...data,
      };
    }
    return getDefaultConfig();
  } catch {
    return getDefaultConfig();
  }
}

async function saveConfig(config: SchedulerConfig): Promise<void> {
  await ensureDataDir();
  const content = JSON.stringify(config, null, 2);
  await fs.writeFile(getConfigFile(), content, 'utf-8');
}

export function isValidInterval(value: unknown): value is SchedulerInterval {
  return typeof value === 'number' && VALID_INTERVALS.includes(value as SchedulerInterval);
}

export function isValidSchedulerMode(value: unknown): value is SchedulerMode {
  return typeof value === 'string' && VALID_MODES.includes(value as SchedulerMode);
}

export interface SchedulerConfigUpdate {
  enabled?: boolean;
  intervalMinutes?: number;
  mode?: string;
}

/**
 * Update scheduler config with validation.
 * Rejects intervals below 30 minutes.
 */
export async function updateSchedulerConfig(
  input: SchedulerConfigUpdate,
): Promise<{ config: SchedulerConfig; error?: string }> {
  const current = await getSchedulerConfig();

  if (input.intervalMinutes !== undefined) {
    if (!isValidInterval(input.intervalMinutes)) {
      return {
        config: current,
        error: `Chu kỳ không hợp lệ. Chỉ chấp nhận: ${VALID_INTERVALS.join(', ')} phút.`,
      };
    }
    current.intervalMinutes = input.intervalMinutes;
  }

  if (input.mode !== undefined) {
    if (!isValidSchedulerMode(input.mode)) {
      return {
        config: current,
        error: `Chế độ không hợp lệ. Chỉ chấp nhận: ${VALID_MODES.join(', ')}.`,
      };
    }
    current.mode = input.mode;
  }

  if (input.enabled !== undefined) {
    current.enabled = Boolean(input.enabled);
  }

  // Recalculate nextRunAt
  if (current.enabled && current.lastRunAt) {
    current.nextRunAt = calculateNextRunAt(current.lastRunAt, current.intervalMinutes);
  } else if (current.enabled && !current.lastRunAt) {
    // First run — schedule immediately
    current.nextRunAt = new Date().toISOString();
  } else {
    current.nextRunAt = undefined;
  }

  current.updatedAt = new Date().toISOString();
  await saveConfig(current);

  return { config: current };
}

/**
 * Mark that the scheduler has completed a run.
 * Updates lastRunAt and calculates nextRunAt.
 */
export async function markSchedulerRunCompleted(): Promise<SchedulerConfig> {
  const config = await getSchedulerConfig();
  const now = new Date();

  config.lastRunAt = now.toISOString();
  config.nextRunAt = calculateNextRunAt(now.toISOString(), config.intervalMinutes);
  config.updatedAt = now.toISOString();

  await saveConfig(config);
  return config;
}

/**
 * Check if the scheduler should trigger now.
 */
export function shouldRunNow(config: SchedulerConfig): {
  shouldRun: boolean;
  reason: string;
} {
  if (!config.enabled) {
    return { shouldRun: false, reason: 'Lịch tự động đang tắt.' };
  }

  if (!config.nextRunAt) {
    // No nextRunAt means first run
    return { shouldRun: true, reason: 'Chưa có lần chạy nào — chạy ngay.' };
  }

  const nextRunTime = new Date(config.nextRunAt).getTime();
  const now = Date.now();

  if (now >= nextRunTime) {
    return { shouldRun: true, reason: 'Đã đến lịch chạy.' };
  }

  return {
    shouldRun: false,
    reason: `Chưa đến lịch. Lần tiếp theo: ${config.nextRunAt}`,
  };
}

function calculateNextRunAt(lastRunAt: string, intervalMinutes: number): string {
  const lastTime = new Date(lastRunAt).getTime();
  const nextTime = lastTime + intervalMinutes * 60 * 1000;
  return new Date(nextTime).toISOString();
}
