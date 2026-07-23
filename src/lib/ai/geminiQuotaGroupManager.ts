import { readCollection, runTransaction } from '../storage/adapter';

const COLLECTION = 'gemini-pool-state';
export type GeminiPoolStateName = 'ACTIVE' | 'DEGRADED' | 'LOCAL_ONLY' | 'RECOVERING' | 'DISABLED';
export interface GeminiQuotaGroupState { quotaGroupId: string; cooldownUntil?: string; quotaExhaustedUntil?: string; failureStreak: number; concurrency: number; updatedAt: string; }
export interface GeminiPoolState { id: 'pool'; state: GeminiPoolStateName; groups: Record<string, GeminiQuotaGroupState>; updatedAt: string; }

export async function getGeminiPoolState(): Promise<GeminiPoolState> {
  return (await readCollection<GeminiPoolState>(COLLECTION))[0] || { id: 'pool', state: 'LOCAL_ONLY', groups: {}, updatedAt: new Date().toISOString() };
}
export async function setGeminiPoolState(state: GeminiPoolStateName): Promise<GeminiPoolState> {
  let result!: GeminiPoolState;
  await runTransaction<GeminiPoolState>(COLLECTION, items => {
    const current = items[0] || { id: 'pool', state: 'LOCAL_ONLY', groups: {}, updatedAt: new Date().toISOString() };
    current.state = state;
    current.updatedAt = new Date().toISOString();
    result = current;
    return [current];
  });
  return result;
}

export async function updateQuotaGroup(quotaGroupId: string, patch: Partial<GeminiQuotaGroupState>, poolState?: GeminiPoolStateName): Promise<GeminiPoolState> {
  let result!: GeminiPoolState;
  await runTransaction<GeminiPoolState>(COLLECTION, items => {
    const current = items[0] || { id: 'pool', state: 'LOCAL_ONLY', groups: {}, updatedAt: new Date().toISOString() };
    current.groups[quotaGroupId] = { ...current.groups[quotaGroupId], ...patch, quotaGroupId, failureStreak: patch.failureStreak ?? current.groups[quotaGroupId]?.failureStreak ?? 0, concurrency: patch.concurrency ?? current.groups[quotaGroupId]?.concurrency ?? 1, updatedAt: new Date().toISOString() };
    if (poolState) current.state = poolState;
    current.updatedAt = new Date().toISOString();
    result = current;
    return [current];
  });
  return result;
}

export function quotaGroupAvailable(group: GeminiQuotaGroupState | undefined, now = Date.now()): boolean {
  if (!group) return true;
  return (!group.cooldownUntil || Date.parse(group.cooldownUntil) <= now) && (!group.quotaExhaustedUntil || Date.parse(group.quotaExhaustedUntil) <= now);
}
