import { dealFingerprint } from '../../deal-intelligence/evaluate';
import { buildDecisionContext } from '../../decision-os/context';
import { evaluateDecisionPolicy } from '../../decision-os/policy';
import { planDecision } from '../../decision-os/planner';
import { emptyAiResult, reasonDecision, modelRoleFingerprint, validateModelRoles, type DecisionAiBatchBudget } from '../../decision-os/reasoner';
import { DECISION_CONFIG, validateDecisionConfig, type DecisionConfig } from '../../decision-os/config';
import { AI_ROLES, DECISION_REASONS, type DecisionAuditRecord, type DecisionConstraints, type DecisionContext, type DecisionModelRoles } from '../../decision-os/types';
import { parseDecisionAdvice, normalizedAiResult } from '../../decision-os/prompts';
import { EventJobError, validTime, type EventJob } from '../../platform/cloudflareContracts';
import { D1DealStore, type PreparedDeal } from './d1DealStore';
import { D1DecisionAiStore } from './d1DecisionAiStore';
import { safePayload } from './d1StorageAdapter';
import type { D1Database, SqlValue } from './database';

type Row = Record<string, string | number | null>;
export type DecisionFilter = { kind: 'LATEST'; productId: string } | { kind: 'HIGH_PRIORITY' } | { kind: 'REVIEW' }
  | { kind: 'BLOCKED' } | { kind: 'STALE' } | { kind: 'AI_FAILURES' }
  | { kind: 'PROVIDER'; provider: 'accesstrade' | 'tiktok'; platform?: 'shopee' | 'tiktok_shop' | 'other' };
export class D1DecisionStore {
  readonly configVersion: string;
  private readonly origin: string;
  constructor(private readonly db: D1Database, private readonly constraints: DecisionConstraints,
    private readonly testOnly = false, private readonly config: DecisionConfig = DECISION_CONFIG, private readonly roles: DecisionModelRoles = {},
    private readonly batchBudget?: DecisionAiBatchBudget) {
    validateDecisionConfig(config);
    if (!constraints || Object.keys(constraints).sort().join(',') !== 'executionMode,quarantined,runtimeValid,securityRisk,systemHealth,systemVersion'
      || constraints.executionMode !== 'SHADOW' || !['AVAILABLE', 'DEGRADED', 'UNAVAILABLE', 'COOLDOWN'].includes(constraints.systemHealth)
      || !/^[a-z0-9_-]{1,80}$/i.test(constraints.systemVersion)
      || [constraints.quarantined, constraints.runtimeValid, constraints.securityRisk].some(value => typeof value !== 'boolean'))
      throw new EventJobError('INVALID_DECISION_CONSTRAINTS', 'QUARANTINE');
    if (!validateModelRoles(roles) || (!testOnly && AI_ROLES.some(role => roles[role]?.some(binding => binding.origin === 'TEST_FIXTURE'))))
      throw new EventJobError('INVALID_DECISION_MODEL_ROLES', 'QUARANTINE');
    this.origin = testOnly ? 'TEST_FIXTURE' : 'AUTHENTICATED_PROVIDER_API';
    this.configVersion = dealFingerprint({ config, constraints, models: modelRoleFingerprint(roles) });
  }
  private statement(sql: string, values: SqlValue[] = []) { return this.db.prepare(sql).bind(...values); }
  private async query(sql: string, values: SqlValue[] = []): Promise<Row[]> {
    try { const result = await this.statement(sql, values).all<Row>(); if (!result.success) throw new Error(); return result.results; }
    catch { throw new EventJobError('D1_DECISION_UNAVAILABLE', 'RETRYABLE'); }
  }
  context(prepared: PreparedDeal): DecisionContext {
    const context = buildDecisionContext({ product: prepared.input.product, deal: prepared.evaluation, providers: prepared.input.providers,
      allowedHosts: prepared.input.allowedHosts, now: prepared.input.now, evidenceRevision: prepared.revision, constraints: this.constraints,
      testOnly: this.testOnly }, this.config);
    const fingerprint = dealFingerprint([context.origin, context.evidenceFingerprint, this.configVersion]);
    return { ...context, evidenceFingerprint: fingerprint, decisionId: `decision-${fingerprint}` };
  }
  async prepare(prepared: PreparedDeal): Promise<DecisionAuditRecord> {
    const context = this.context(prepared), policy = evaluateDecisionPolicy(context);
    const [existing] = await this.query('SELECT payload FROM decision_records WHERE id=? AND origin=? AND valid_until>? LIMIT 1',
      [context.decisionId, this.origin, prepared.input.now]);
    if (existing) return JSON.parse(String(existing.payload)) as DecisionAuditRecord;
    let ai = emptyAiResult('UNAVAILABLE', 'AI_UNAVAILABLE');
    try { ai = await reasonDecision(context, policy, new D1DecisionAiStore(this.db, this.testOnly), this.roles, this.config, 'REASONER', prepared.input.now, this.batchBudget); }
    catch { ai = emptyAiResult('UNAVAILABLE', 'AI_UNAVAILABLE'); }
    const plan = planDecision(context, policy, ai.advice);
    return { decisionId: context.decisionId, productId: context.productId, origin: context.origin,
      evidenceFingerprint: context.evidenceFingerprint, dealEvaluationId: context.dealEvaluationId,
      dealScore: context.dealScore, dealConfidence: context.dealConfidence, dealPriority: context.dealPriority,
      provider: context.money.provider, platform: context.money.platform, policyVersion: context.decisionPolicyVersion,
      dealAlgorithmVersion: context.dealAlgorithmVersion, promptVersion: context.promptVersion, policy, ai,
      plan: { ...plan, reasonCodes: [...new Set([...plan.reasonCodes, ...ai.reasonCodes])].sort() },
      createdAt: context.decisionTimestamp, validUntil: context.validUntil };
  }
  async commit(prepared: PreparedDeal, record: DecisionAuditRecord, now: number, job?: EventJob) {
    validTime(now);
    if (record.validUntil <= now) throw new EventJobError('DECISION_EVIDENCE_EXPIRED', 'RETRYABLE');
    const context = this.context(prepared);
    if (!normalizedAiResult(record.ai) || Object.keys(record).sort().join(',') !==
      'ai,createdAt,dealAlgorithmVersion,dealConfidence,dealEvaluationId,dealPriority,dealScore,decisionId,evidenceFingerprint,origin,plan,platform,policy,policyVersion,productId,promptVersion,provider,validUntil')
      throw new EventJobError('DECISION_COMMIT_REJECTED', 'QUARANTINE');
    const policy = evaluateDecisionPolicy(context), advice = record.ai.advice ? parseDecisionAdvice(JSON.stringify(record.ai.advice)) : null;
    const plan = planDecision(context, policy, advice);
    plan.reasonCodes = [...new Set([...plan.reasonCodes, ...record.ai.reasonCodes])].sort();
    if (record.decisionId !== context.decisionId || record.dealEvaluationId !== prepared.evaluation.evidenceFingerprint
      || record.validUntil <= now || record.plan.executionMode !== 'SHADOW' || record.origin !== this.origin
      || record.dealScore !== prepared.evaluation.dealScore || record.dealConfidence !== prepared.evaluation.confidence
      || record.productId !== context.productId || record.evidenceFingerprint !== context.evidenceFingerprint || record.validUntil !== context.validUntil
      || record.policyVersion !== context.decisionPolicyVersion || record.promptVersion !== context.promptVersion
      || record.dealAlgorithmVersion !== context.dealAlgorithmVersion || record.dealPriority !== context.dealPriority
      || record.provider !== context.money.provider || record.platform !== context.money.platform || !Number.isFinite(Date.parse(record.createdAt)) || Date.parse(record.createdAt) > now
      || record.ai.reasonCodes.some(code => !DECISION_REASONS.includes(code)) || (!!record.ai.advice && !advice)
      || dealFingerprint(record.policy) !== dealFingerprint(policy) || dealFingerprint(record.plan) !== dealFingerprint(plan))
      throw new EventJobError('DECISION_COMMIT_REJECTED', 'QUARANTINE');
    const statements = [this.statement(`INSERT INTO decision_records(id,product_id,origin,fingerprint,deal_fingerprint,policy_version,config_version,
      outcome,review_required,ai_status,ai_failed,provider,platform,score,created_at,valid_until,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(origin,product_id,fingerprint) DO NOTHING`, [record.decisionId, record.productId, this.origin, record.evidenceFingerprint,
      record.dealEvaluationId, record.policyVersion, this.configVersion, record.plan.outcome, record.plan.reviewRequired ? 1 : 0,
      record.ai.status, ['UNAVAILABLE', 'INVALID'].includes(record.ai.status) ? 1 : 0, record.provider, record.platform, record.dealScore, Date.parse(record.createdAt), record.validUntil, safePayload(record, 16384)]),
    this.statement('UPDATE deal_work SET due_at=min(due_at,?) WHERE product_id=? AND revision=?', [record.validUntil, record.productId, prepared.revision])];
    await new D1DealStore(this.db, this.testOnly).commit(prepared, now, job, statements);
    const [stored] = await this.query('SELECT payload FROM decision_records WHERE id=? AND origin=? LIMIT 1', [record.decisionId, this.origin]);
    if (!stored) throw new EventJobError('DECISION_COMMIT_MISSING', 'RETRYABLE');
    return JSON.parse(String(stored.payload)) as DecisionAuditRecord;
  }
  async evaluate(productId: string, allowedHosts: readonly string[], now: number) {
    const prepared = await new D1DealStore(this.db, this.testOnly).prepare(productId, allowedHosts, now);
    return this.commit(prepared, await this.prepare(prepared), now);
  }
  async latest(productId: string, now: number): Promise<DecisionAuditRecord | null> {
    validTime(now);
    const current = await new D1DealStore(this.db, this.testOnly).latest(productId, now);
    if (!current) return null;
    const [row] = await this.query(`SELECT payload FROM decision_records WHERE origin=? AND product_id=? AND config_version=? AND deal_fingerprint=?
      ORDER BY created_at DESC,id LIMIT 1`, [this.origin, productId, this.configVersion, current.evidenceFingerprint]);
    if (!row) return null;
    const record = JSON.parse(String(row.payload)) as DecisionAuditRecord;
    return record.validUntil > now && record.dealEvaluationId === current.evidenceFingerprint ? record : null;
  }
  rankingQuery(filter: DecisionFilter, limit: number, now: number) {
    validTime(now);
    if (!Number.isInteger(limit) || limit < 1 || limit > this.config.readLimit) throw new EventJobError('DECISION_QUERY_BOUND', 'QUARANTINE');
    const values: SqlValue[] = [this.origin]; let predicate = '', order = 'created_at DESC,id';
    if (filter.kind === 'LATEST') { predicate = ' AND product_id=?'; values.push(filter.productId); }
    else if (filter.kind === 'HIGH_PRIORITY') { order = 'score DESC,id'; }
    else if (filter.kind === 'REVIEW') predicate = ' AND review_required=1';
    else if (filter.kind === 'BLOCKED') predicate = " AND outcome='BLOCK'";
    else if (filter.kind === 'AI_FAILURES') predicate = ' AND ai_failed=1';
    else if (filter.kind === 'STALE') { predicate = ' AND valid_until<=?'; values.push(now); order = 'valid_until,id'; }
    else if (filter.kind === 'PROVIDER') {
      if (!['accesstrade', 'tiktok'].includes(filter.provider) || (filter.platform && !['shopee', 'tiktok_shop', 'other'].includes(filter.platform)))
        throw new EventJobError('DECISION_QUERY_FILTER', 'QUARANTINE');
      predicate = ' AND provider=?'; values.push(filter.provider);
      if (filter.platform) { predicate += ' AND platform=?'; values.push(filter.platform); }
    } else throw new EventJobError('DECISION_QUERY_FILTER', 'QUARANTINE');
    values.push(limit);
    return { sql: `SELECT payload FROM decision_records WHERE origin=?${predicate} ORDER BY ${order} LIMIT ?`, values };
  }
  async list(filter: DecisionFilter, limit: number, now: number) {
    const query = this.rankingQuery(filter, limit, now), rows = await this.query(query.sql, query.values);
    return { records: rows.map(row => JSON.parse(String(row.payload)) as DecisionAuditRecord), inspected: rows.length, limit, journalOnly: true };
  }
  async summary(filter: DecisionFilter, limit: number, now: number) {
    const sample = await this.list(filter, limit, now), records = sample.records;
    return { sampled: records.length, boundedSample: true, evaluated: records.length,
      allowed: records.filter(record => record.plan.outcome === 'ALLOW').length,
      held: records.filter(record => record.plan.outcome === 'HOLD').length,
      blocked: records.filter(record => ['BLOCK', 'QUARANTINE'].includes(record.plan.outcome)).length,
      reviewRequired: records.filter(record => record.plan.reviewRequired).length,
      aiCallsAttempted: records.reduce((total, record) => total + (record.ai.cacheHit ? 0 : record.ai.attempts.length), 0),
      aiCallsAvoided: records.filter(record => record.ai.cacheHit || ['DISABLED', 'AVOIDED'].includes(record.ai.status)).length,
      aiFailures: records.filter(record => ['UNAVAILABLE', 'INVALID'].includes(record.ai.status)).length,
      fallbackCount: records.filter(record => record.ai.reasonCodes.includes('AI_FALLBACK_USED')).length,
      policyOverridesOfAi: records.filter(record => record.plan.reasonCodes.includes('AI_ADVICE_REJECTED_BY_POLICY')).length, cost: 'UNKNOWN' };
  }
  async cleanup(now: number) {
    validTime(now);
    await this.query('DELETE FROM decision_records WHERE id IN (SELECT id FROM decision_records WHERE origin=? AND valid_until<? ORDER BY valid_until,id LIMIT ?)',
      [this.origin, now - this.config.retentionMs, this.config.workLimit]);
    await new D1DecisionAiStore(this.db, this.testOnly).cleanup(now, this.config.workLimit);
  }
}
