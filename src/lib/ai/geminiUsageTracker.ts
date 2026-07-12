import { readCollection, runTransaction } from '../storage/adapter';

const COLLECTION = 'gemini-daily-usage';
export interface GeminiDailyUsage { id: string; quotaGroupId: string; requests: number; inputTokens: number; outputTokens: number; tasks: Record<string, number>; updatedAt: string; }

function dayKey(now = Date.now()): string { return new Date(now + 7 * 60 * 60_000).toISOString().slice(0, 10); }

export async function getGeminiUsage(quotaGroupId: string, now = Date.now()): Promise<GeminiDailyUsage> {
  const id = `${dayKey(now)}:${quotaGroupId}`;
  return (await readCollection<GeminiDailyUsage>(COLLECTION)).find((item) => item.id === id)
    || { id, quotaGroupId, requests: 0, inputTokens: 0, outputTokens: 0, tasks: {}, updatedAt: new Date(now).toISOString() };
}

export async function recordGeminiUsage(quotaGroupId: string, taskType: string, inputTokens: number, outputTokens: number, now = Date.now()): Promise<GeminiDailyUsage> {
  const id = `${dayKey(now)}:${quotaGroupId}`;
  let result!: GeminiDailyUsage;
  await runTransaction<GeminiDailyUsage>(COLLECTION, (all) => {
    let usage = all.find((item) => item.id === id);
    if (!usage) { usage = { id, quotaGroupId, requests: 0, inputTokens: 0, outputTokens: 0, tasks: {}, updatedAt: new Date(now).toISOString() }; all.push(usage); }
    usage.requests += 1; usage.inputTokens += Math.max(0, inputTokens); usage.outputTokens += Math.max(0, outputTokens);
    usage.tasks[taskType] = (usage.tasks[taskType] || 0) + 1; usage.updatedAt = new Date(now).toISOString();
    result = usage;
    return all.filter((item) => item.id >= dayKey(now - 7 * 86_400_000));
  });
  return result;
}
