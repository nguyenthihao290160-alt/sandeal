import { readCollection, writeCollection } from '../storage/adapter';
import type { AutomationSettings } from '../storage/automationSettings';

const COLLECTION = 'launch-state';
export interface LaunchState { id: 'launch'; phase: 'bootstrap' | 'steady' | 'halted'; published: number; waves: number; failed: number; rolledBack: number; lastWaveAt?: string; haltReasons: string[]; updatedAt: string; }
export async function getLaunchState(): Promise<LaunchState> { return (await readCollection<LaunchState>(COLLECTION))[0] || { id: 'launch', phase: 'bootstrap', published: 0, waves: 0, failed: 0, rolledBack: 0, haltReasons: [], updatedAt: new Date().toISOString() }; }
export async function canRunLaunchWave(settings: AutomationSettings, now = Date.now()): Promise<boolean> {
  if (!settings.launchEnabled) return false; const state = await getLaunchState();
  return state.phase !== 'halted' && state.published < settings.maximumLaunchPublishes && (!state.lastWaveAt || Date.parse(state.lastWaveAt) + settings.publishWaveDelayMinutes * 60_000 <= now);
}
export async function recordLaunchWave(settings: AutomationSettings, result: { processed: number; published: number; failed: number; rolledBack?: number }, now = Date.now()): Promise<LaunchState> {
  const state = await getLaunchState(); const processed = Math.max(1, result.processed); const healthPassRate = result.published / processed; const errorRate = result.failed / processed; const rollbackRate = Number(result.rolledBack || 0) / processed; const reasons: string[] = [];
  if (healthPassRate < settings.minimumHealthPassRate) reasons.push('minimum_health_pass_rate'); if (errorRate > settings.maximumErrorRate) reasons.push('maximum_error_rate'); if (rollbackRate > settings.maximumRollbackRate) reasons.push('maximum_rollback_rate');
  state.published += result.published; state.failed += result.failed; state.rolledBack += Number(result.rolledBack || 0); state.waves += 1; state.lastWaveAt = new Date(now).toISOString(); state.haltReasons = reasons;
  state.phase = reasons.length ? 'halted' : state.published >= settings.maximumLaunchPublishes ? 'steady' : 'bootstrap'; state.updatedAt = new Date(now).toISOString(); await writeCollection(COLLECTION, [state]); return state;
}
