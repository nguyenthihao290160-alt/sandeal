import { dealFingerprint } from '../../deal-intelligence/evaluate';
import { evaluateOpportunity } from '../../opportunity/evaluate';
import { OPPORTUNITY_CONFIG, validateOpportunityConfig, type OpportunityConfig } from '../../opportunity/config';
import { OPPORTUNITY_PRIORITIES, type OpportunityEvaluation } from '../../opportunity/types';
import type { DecisionAuditRecord } from '../../decision-os/types';
import { EventJobError, validTime, type EventJob } from '../../platform/cloudflareContracts';
import { D1DealStore, providerVersionsSql, type PreparedDeal } from './d1DealStore';
import type { D1DecisionStore } from './d1DecisionStore';
import { safePayload } from './d1StorageAdapter';
import type { D1Database, SqlValue } from './database';

export type OpportunityFilter = { kind: 'TOP' | 'NEW' | 'LOW_CONFIDENCE' | 'CONTENT' | 'EXPERIMENT' | 'REFRESH' | 'REVIEW' | 'BLOCKED' | 'STALE' }
  | { kind: 'PRIORITY'; priority: typeof OPPORTUNITY_PRIORITIES[number] }
  | { kind: 'PROVIDER'; provider: 'accesstrade' | 'tiktok'; platform?: 'shopee' | 'tiktok_shop' | 'other' };
type Row = Record<string, string | number | null>;
export class D1OpportunityStore {
  readonly configVersion: string;
  private readonly origin: string;
  constructor(private readonly db: D1Database, private readonly decisions: D1DecisionStore, private readonly testOnly = false,
    private readonly config: OpportunityConfig = OPPORTUNITY_CONFIG) {
    validateOpportunityConfig(config);
    if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function' || decisions.aiEnabled)
      throw new EventJobError('OPPORTUNITY_SHADOW_DEPENDENCY_REQUIRED', 'QUARANTINE');
    this.origin = testOnly ? 'TEST_FIXTURE' : 'AUTHENTICATED_PROVIDER_API';
    this.configVersion = dealFingerprint({ config, decision: decisions.configVersion });
  }
  private statement(sql: string, values: SqlValue[] = []) { return this.db.prepare(sql).bind(...values); }
  private async query(sql: string, values: SqlValue[] = []): Promise<Row[]> {
    try { const result = await this.statement(sql, values).all<Row>(); if (!result.success) throw new Error(); return result.results; }
    catch { throw new EventJobError('D1_OPPORTUNITY_UNAVAILABLE', 'RETRYABLE'); }
  }
  prepare(prepared: PreparedDeal, decision: DecisionAuditRecord): OpportunityEvaluation {
    return evaluateOpportunity({ source: prepared.input, deal: prepared.evaluation, decision, context: this.decisions.context(prepared) }, this.config);
  }
  async commit(prepared: PreparedDeal, decision: DecisionAuditRecord, opportunity: OpportunityEvaluation, now: number, job?: EventJob) {
    validTime(now);
    if (opportunity.validUntil <= now || dealFingerprint(opportunity) !== dealFingerprint(this.prepare(prepared, decision)))
      throw new EventJobError('OPPORTUNITY_COMMIT_REJECTED', 'QUARANTINE');
    const current = this.prepare({ ...prepared, input: { ...prepared.input, now } }, decision);
    if (current.evidenceFingerprint !== opportunity.evidenceFingerprint) throw new EventJobError('OPPORTUNITY_EVIDENCE_CHANGED', 'RETRYABLE');
    const actions = opportunity.resourceRecommendation.actions;
    const statements = [this.statement(`INSERT INTO opportunity_evaluations(origin,product_id,id,fingerprint,config_version,algorithm_version,decision_id,
      provider,platform,priority,rankable,score,confidence,new_opportunity,low_confidence,content_candidate,experiment_candidate,refresh_candidate,review_required,valid_until,payload)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(origin,product_id) DO UPDATE SET id=excluded.id,fingerprint=excluded.fingerprint,
      config_version=excluded.config_version,algorithm_version=excluded.algorithm_version,decision_id=excluded.decision_id,provider=excluded.provider,platform=excluded.platform,
      priority=excluded.priority,rankable=excluded.rankable,score=excluded.score,confidence=excluded.confidence,new_opportunity=excluded.new_opportunity,low_confidence=excluded.low_confidence,
      content_candidate=excluded.content_candidate,experiment_candidate=excluded.experiment_candidate,refresh_candidate=excluded.refresh_candidate,
      review_required=excluded.review_required,valid_until=excluded.valid_until,payload=excluded.payload WHERE opportunity_evaluations.fingerprint<>excluded.fingerprint`,
    [this.origin, opportunity.productId, opportunity.opportunityId, opportunity.evidenceFingerprint, this.configVersion, opportunity.algorithmVersion, opportunity.decisionId,
      opportunity.provider, opportunity.platform, opportunity.opportunityPriority, Number(opportunity.opportunityPriority !== 'BLOCKED'), opportunity.opportunityScore, opportunity.opportunityConfidence,
      Number(opportunity.newOpportunity), Number(opportunity.opportunityConfidence < this.config.highConfidence), Number(actions.includes('CONTENT_REVIEW_CANDIDATE')),
      Number(opportunity.experimentEligibility.state === 'ELIGIBLE_SHADOW'), Number(actions.some(action => ['REFRESH_PRICE', 'REFRESH_OFFER', 'REQUEST_REEVALUATION'].includes(action))),
      Number(actions.includes('HUMAN_REVIEW')), opportunity.validUntil, safePayload(opportunity, 16384)]),
    this.statement('UPDATE deal_work SET due_at=? WHERE product_id=? AND revision=?',
      [Math.min(opportunity.validUntil, decision.validUntil, Date.parse(prepared.evaluation.validUntil)), opportunity.productId, prepared.revision])];
    await this.decisions.commit(prepared, decision, now, job, statements);
    const [row] = await this.query('SELECT payload FROM opportunity_evaluations WHERE origin=? AND product_id=? AND fingerprint=? LIMIT 1',
      [this.origin, opportunity.productId, opportunity.evidenceFingerprint]);
    if (!row) throw new EventJobError('OPPORTUNITY_COMMIT_MISSING', 'RETRYABLE');
    return JSON.parse(String(row.payload)) as OpportunityEvaluation;
  }
  async evaluate(productId: string, allowedHosts: readonly string[], now: number) {
    const prepared = await new D1DealStore(this.db, this.testOnly).prepare(productId, allowedHosts, now);
    const decision = await this.decisions.prepare(prepared);
    return this.commit(prepared, decision, this.prepare(prepared, decision), now);
  }
  async latest(productId: string, now: number): Promise<OpportunityEvaluation | null> {
    validTime(now);
    const [row] = await this.query('SELECT payload,decision_id FROM opportunity_evaluations WHERE origin=? AND product_id=? AND config_version=? AND valid_until>? LIMIT 1',
      [this.origin, productId, this.configVersion, now]);
    if (!row) return null;
    const decision = await this.decisions.latest(productId, now);
    return decision?.decisionId === row.decision_id && Date.parse(decision.createdAt) <= now ? JSON.parse(String(row.payload)) as OpportunityEvaluation : null;
  }
  eligibilityFence(record: OpportunityEvaluation, now: number) {
    return this.statement(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM opportunity_evaluations opportunity
      JOIN deal_work work ON work.product_id=opportunity.product_id
      JOIN deal_evaluations deal ON deal.product_id=opportunity.product_id AND deal.origin=opportunity.origin
      WHERE opportunity.origin=? AND opportunity.product_id=? AND opportunity.fingerprint=? AND opportunity.config_version=?
      AND opportunity.experiment_candidate=1 AND opportunity.valid_until>? AND deal.valid_until>?
      AND work.revision=work.evaluated_revision AND deal.fingerprint=?
      AND opportunity.decision_id=(SELECT id FROM decision_records WHERE origin=opportunity.origin AND product_id=opportunity.product_id
        AND config_version=? AND deal_fingerprint=deal.fingerprint ORDER BY created_at DESC,id LIMIT 1)
      AND deal.provider_versions=(${providerVersionsSql('opportunity.product_id')})) THEN '{}' ELSE 'EXPERIMENT_POLICY_CHANGED' END)`,
    [this.origin, record.productId, record.evidenceFingerprint, this.configVersion, now, now, record.dealEvaluationId, this.decisions.configVersion]);
  }
  rankingQuery(filter: OpportunityFilter, limit: number, now: number) {
    validTime(now);
    if (!Number.isInteger(limit) || limit < 1 || limit > this.config.readLimit) throw new EventJobError('OPPORTUNITY_QUERY_BOUND', 'QUARANTINE');
    const values: SqlValue[] = [this.origin]; let predicate = '', order = 'score DESC,product_id';
    const columns = { NEW: 'new_opportunity', LOW_CONFIDENCE: 'low_confidence', CONTENT: 'content_candidate', EXPERIMENT: 'experiment_candidate', REFRESH: 'refresh_candidate', REVIEW: 'review_required' };
    if (Object.hasOwn(columns, filter.kind)) predicate = ` AND ${columns[filter.kind as keyof typeof columns]}=1`;
    else if (filter.kind === 'BLOCKED') predicate = " AND priority='BLOCKED'";
    else if (filter.kind === 'PRIORITY') {
      if (!OPPORTUNITY_PRIORITIES.includes(filter.priority)) throw new EventJobError('OPPORTUNITY_QUERY_FILTER', 'QUARANTINE');
      predicate = ' AND priority=?'; values.push(filter.priority);
    } else if (filter.kind === 'PROVIDER') {
      if (!['accesstrade', 'tiktok'].includes(filter.provider) || (filter.platform && !['shopee', 'tiktok_shop', 'other'].includes(filter.platform)))
        throw new EventJobError('OPPORTUNITY_QUERY_FILTER', 'QUARANTINE');
      predicate = ' AND provider=?'; values.push(filter.provider);
      if (filter.platform) { predicate += ' AND platform=?'; values.push(filter.platform); }
    } else if (filter.kind === 'STALE') { predicate = ' AND valid_until<=?'; values.push(now); order = 'valid_until,product_id'; }
    else if (filter.kind !== 'TOP') throw new EventJobError('OPPORTUNITY_QUERY_FILTER', 'QUARANTINE');
    if (!['BLOCKED', 'PRIORITY', 'STALE'].includes(filter.kind)) predicate = ` AND rankable=1${predicate}`;
    values.push(limit);
    return { sql: `SELECT product_id,payload FROM opportunity_evaluations WHERE origin=?${predicate} ORDER BY ${order} LIMIT ?`, values };
  }
  async rank(filter: OpportunityFilter, limit: number, now: number) {
    const query = this.rankingQuery(filter, limit, now), rows = await this.query(query.sql, query.values), data: OpportunityEvaluation[] = [];
    for (const row of rows) {
      const record = filter.kind === 'STALE' ? JSON.parse(String(row.payload)) as OpportunityEvaluation : await this.latest(String(row.product_id), now);
      if (record && (filter.kind === 'BLOCKED' || filter.kind === 'PRIORITY' || filter.kind === 'STALE' || record.opportunityPriority !== 'BLOCKED')) data.push(record);
    }
    return { data, inspected: rows.length, limit, partialPagePossible: true, shadowOnly: true };
  }
  async summary(limit: number, now: number) {
    this.rankingQuery({ kind: 'TOP' }, limit, now);
    const rows = await this.query('SELECT product_id FROM opportunity_evaluations WHERE origin=? ORDER BY score DESC,product_id LIMIT ?', [this.origin, limit]), records: OpportunityEvaluation[] = [];
    for (const row of rows) { const record = await this.latest(String(row.product_id), now); if (record) records.push(record); }
    return { boundedSample: true, inspected: rows.length, evaluated: records.length,
      priorities: Object.fromEntries(OPPORTUNITY_PRIORITIES.map(priority => [priority, records.filter(record => record.opportunityPriority === priority).length])),
      newOpportunities: records.filter(record => record.newOpportunity).length,
      aiReviewCandidates: records.filter(record => record.resourceRecommendation.actions.includes('AI_REVIEW_CANDIDATE')).length,
      contentCandidates: records.filter(record => record.resourceRecommendation.actions.includes('CONTENT_REVIEW_CANDIDATE')).length,
      experimentCandidates: records.filter(record => record.experimentEligibility.state === 'ELIGIBLE_SHADOW').length };
  }
}
