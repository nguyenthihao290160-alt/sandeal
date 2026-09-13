import { EventJobError } from '../../platform/cloudflareContracts';
import type { DecisionAiJournal } from '../../decision-os/reasoner';
import type { DecisionConfig } from '../../decision-os/config';
import type { DecisionAiResult } from '../../decision-os/types';
import { safePayload } from './d1StorageAdapter';
import type { D1Database, D1Statement, SqlValue } from './database';
import { getProviderDeclaration, type ProviderId } from '../../automation/providerRegistry';

type Row = Record<string, string | number | null>;
export class D1DecisionAiStore implements DecisionAiJournal {
  private readonly origin: string;
  constructor(private readonly db: D1Database, testOnly = false) { this.origin = testOnly ? 'TEST_FIXTURE' : 'AUTHENTICATED_PROVIDER_API'; }
  private statement(sql: string, values: SqlValue[] = []) { return this.db.prepare(sql).bind(...values); }
  private async query(sql: string, values: SqlValue[] = []): Promise<Row[]> {
    try { const result = await this.statement(sql, values).all<Row>(); if (!result.success) throw new Error(); return result.results; }
    catch { throw new EventJobError('D1_DECISION_AI_UNAVAILABLE', 'RETRYABLE'); }
  }
  private async batch(statements: D1Statement[]) {
    const results = await this.db.batch<Row>(statements); if (results.some(result => !result.success)) throw new Error(); return results;
  }
  async cached(key: string, now: number): Promise<DecisionAiResult | null> {
    const [row] = await this.query("SELECT payload FROM decision_ai_advice WHERE id=? AND origin=? AND state='COMPLETE' AND valid_until>? LIMIT 1", [key, this.origin, now]);
    return row ? JSON.parse(String(row.payload)) as DecisionAiResult : null;
  }
  async reserve(key: string, productId: string, now: number, validUntil: number) {
    const rows = await this.query(`INSERT INTO decision_ai_advice(id,product_id,origin,state,created_at,valid_until)
      VALUES(?,?,?,'RESERVED',?,?) ON CONFLICT(id) DO NOTHING RETURNING id`, [key, productId, this.origin, now, validUntil]);
    return rows.length === 1;
  }
  async acquireCall(key: string, providerKey: string, productId: string, now: number, config: DecisionConfig): Promise<'ACQUIRED' | 'BUDGET' | 'COOLDOWN'> {
    try {
      if (!['CLOUD_AI', 'LOCAL_AI'].includes(getProviderDeclaration(providerKey as ProviderId).kind)) return 'COOLDOWN';
    } catch { return 'COOLDOWN'; }
    const window = Math.floor(now / config.ai.budgetWindowMs) * config.ai.budgetWindowMs;
    const [budget] = await this.query('SELECT calls FROM decision_ai_budget WHERE origin=? AND window=? LIMIT 1', [this.origin, window]);
    if (Number(budget?.calls || 0) >= config.ai.maxCallsPerBatch) return 'BUDGET';
    const [health] = await this.query('SELECT retry_at FROM decision_ai_health WHERE origin=? AND provider_key=? LIMIT 1', [this.origin, providerKey]);
    if (Number(health?.retry_at || 0) > now) return 'COOLDOWN';
    const [recent] = await this.query(`SELECT id,created_at FROM decision_ai_advice WHERE origin=? AND product_id=? AND created_at>? AND id<>?
      ORDER BY created_at DESC,id LIMIT 1`, [this.origin, productId, now - config.ai.cooldownMs, key]);
    if (recent) return 'COOLDOWN';
    try {
      await this.batch([
        this.statement('INSERT INTO decision_ai_budget(origin,window,calls) VALUES(?,?,0) ON CONFLICT(origin,window) DO NOTHING', [this.origin, window]),
        this.statement('INSERT INTO decision_ai_health(origin,provider_key) VALUES(?,?) ON CONFLICT(origin,provider_key) DO NOTHING', [this.origin, providerKey]),
        this.statement(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM decision_ai_budget WHERE origin=? AND window=? AND calls<?)
          AND EXISTS(SELECT 1 FROM decision_ai_advice WHERE id=? AND origin=? AND state='RESERVED' AND calls<? AND valid_until>?)
          AND EXISTS(SELECT 1 FROM decision_ai_health WHERE origin=? AND provider_key=? AND retry_at<=?)
          THEN '{}' ELSE 'AI_RESERVATION_CONFLICT' END)`, [this.origin, window, config.ai.maxCallsPerBatch, key, this.origin, config.ai.maxAttempts, now, this.origin, providerKey, now]),
        this.statement('UPDATE decision_ai_budget SET calls=calls+1 WHERE origin=? AND window=?', [this.origin, window]),
        this.statement('UPDATE decision_ai_advice SET calls=calls+1 WHERE id=? AND origin=?', [key, this.origin]),
        this.statement('UPDATE decision_ai_health SET retry_at=? WHERE origin=? AND provider_key=?', [now + config.ai.timeoutMs + 1000, this.origin, providerKey]),
      ]);
      return 'ACQUIRED';
    } catch { return 'BUDGET'; }
  }
  async finishCall(providerKey: string, success: boolean, now: number, config: DecisionConfig): Promise<void> {
    await this.query(`UPDATE decision_ai_health SET failures=CASE WHEN ?=1 THEN 0 ELSE min(failures+1,3) END,
      retry_at=CASE WHEN ?=1 THEN 0 ELSE ?+CASE WHEN failures+1>=? THEN ? ELSE min(?,?*(1<<failures)) END END
      WHERE origin=? AND provider_key=?`, [success ? 1 : 0, success ? 1 : 0, now, config.ai.failureThreshold,
      config.ai.maxBackoffMs, config.ai.maxBackoffMs, config.ai.backoffMs, this.origin, providerKey]);
  }
  async complete(key: string, result: DecisionAiResult): Promise<void> {
    await this.query("UPDATE decision_ai_advice SET state='COMPLETE',payload=? WHERE id=? AND origin=? AND state='RESERVED'",
      [safePayload(result, 8192), key, this.origin]);
  }
  async cleanup(now: number, limit: number): Promise<void> {
    await this.query('DELETE FROM decision_ai_advice WHERE id IN (SELECT id FROM decision_ai_advice WHERE origin=? AND valid_until<? ORDER BY valid_until,id LIMIT ?)', [this.origin, now, limit]);
    await this.query('DELETE FROM decision_ai_budget WHERE origin=? AND window IN (SELECT window FROM decision_ai_budget WHERE origin=? AND window<? ORDER BY window LIMIT ?)',
      [this.origin, this.origin, now - 86_400_000, limit]);
  }
}
