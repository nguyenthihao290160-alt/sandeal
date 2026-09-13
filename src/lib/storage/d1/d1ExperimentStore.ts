import { EventJobError, validTime } from '../../platform/cloudflareContracts';
import { experimentIdentity, validateTransition, assignVariant, subjectKey, summarizeExperiment, EXPERIMENT_LIMITS } from '../../experiments/model';
import type { Experiment, ExperimentSpec, ExperimentState, ExperimentAssignment, ExperimentMetric, ExperimentResultSummary } from '../../experiments/types';
import type { D1OpportunityStore } from './d1OpportunityStore';
import { safePayload } from './d1StorageAdapter';
import type { D1Database, D1Statement, SqlValue } from './database';

type Row = Record<string, string | number | null>;
export class D1ExperimentStore {
  private readonly origin: string;
  constructor(private readonly db: D1Database, private readonly opportunities: D1OpportunityStore, private readonly testOnly = false) {
    if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') throw new EventJobError('EXPERIMENT_D1_REQUIRED', 'QUARANTINE');
    this.origin = testOnly ? 'TEST_FIXTURE' : 'AUTHENTICATED_PROVIDER_API';
  }
  private statement(sql: string, values: SqlValue[] = []) { return this.db.prepare(sql).bind(...values); }
  private async query(sql: string, values: SqlValue[] = []): Promise<Row[]> {
    try { const result = await this.statement(sql, values).all<Row>(); if (!result.success) throw new Error(); return result.results; }
    catch { throw new EventJobError('D1_EXPERIMENT_UNAVAILABLE', 'RETRYABLE'); }
  }
  private async batch(statements: D1Statement[]) {
    try { const results = await this.db.batch<Row>(statements); if (results.some(result => !result.success)) throw new Error(); return results; }
    catch { throw new EventJobError('EXPERIMENT_ATOMIC_CONFLICT', 'RETRYABLE'); }
  }
  private fixtureOnly() { if (!this.testOnly) throw new EventJobError('EXPERIMENT_ASSIGNMENTS_FIXTURE_ONLY', 'QUARANTINE'); }
  private async eligible(productId: string, now: number) {
    validTime(now);
    const record = await this.opportunities.latest(productId, now);
    if (!record || record.experimentEligibility.state !== 'ELIGIBLE_SHADOW' || record.origin !== this.origin)
      throw new EventJobError('EXPERIMENT_POLICY_INELIGIBLE', 'QUARANTINE');
    return record;
  }
  async get(experimentId: string): Promise<Experiment | null> {
    const [row] = await this.query('SELECT payload,state FROM experiments WHERE id=? AND origin=? LIMIT 1', [experimentId, this.origin]);
    return row ? { ...JSON.parse(String(row.payload)), state: row.state } as Experiment : null;
  }
  async create(spec: ExperimentSpec, now: number): Promise<Experiment> {
    validTime(now);
    const identity = experimentIdentity(spec);
    const opportunity = await this.eligible(spec.productId, now), existing = await this.get(identity.experimentId);
    if (existing) return existing;
    if (spec.startsAt < now || spec.startsAt > now + EXPERIMENT_LIMITS.maximumRuntimeMs) throw new EventJobError('EXPERIMENT_START_REJECTED', 'QUARANTINE');
    const [version] = await this.query('SELECT fingerprint FROM experiments WHERE origin=? AND product_id=? AND experiment_type=? AND version=? LIMIT 1',
      [this.origin, spec.productId, spec.type, spec.version]);
    if (version && version.fingerprint !== identity.fingerprint) throw new EventJobError('EXPERIMENT_VERSION_IMMUTABLE', 'QUARANTINE');
    const experiment: Experiment = { ...identity.normalized, experimentId: identity.experimentId, definitionFingerprint: identity.fingerprint,
      opportunityId: opportunity.opportunityId, state: 'DRAFT', executionMode: 'SHADOW', origin: opportunity.origin,
      guardrails: [{ metric: 'PUBLICATION_SAFETY_FAILURE', maximumFailures: 0, basis: 'CURRENT_POLICY_EVIDENCE' },
        { metric: 'PROVIDER_UNAVAILABLE', maximumFailures: 0, basis: 'CURRENT_POLICY_EVIDENCE' }] };
    await this.batch([this.opportunities.eligibilityFence(opportunity, now),
      this.statement(`SELECT json(CASE WHEN (SELECT count(*) FROM (SELECT id FROM experiments WHERE origin=? AND product_id=? LIMIT 20))<20
        THEN '{}' ELSE 'EXPERIMENT_DEFINITION_CAP' END)`, [this.origin, spec.productId]),
      this.statement(`INSERT INTO experiments(id,origin,product_id,fingerprint,opportunity_id,experiment_type,version,state,execution_mode,starts_at,expires_at,retain_until,payload)
        VALUES(?,?,?,?,?,?,?,'DRAFT','SHADOW',?,?,?,?) ON CONFLICT(id) DO NOTHING`, [experiment.experimentId, this.origin, spec.productId, identity.fingerprint,
        opportunity.opportunityId, spec.type, spec.version, spec.startsAt, spec.expiresAt, spec.expiresAt + EXPERIMENT_LIMITS.retentionMs, safePayload(experiment, 8192)]),
      ...spec.variants.map(variant => this.statement('INSERT INTO experiment_variants(experiment_id,id,weight) VALUES(?,?,?) ON CONFLICT(experiment_id,id) DO NOTHING',
        [experiment.experimentId, variant.id, variant.weight]))]);
    return (await this.get(experiment.experimentId))!;
  }
  async transition(experimentId: string, next: ExperimentState, now: number) {
    const experiment = await this.get(experimentId);
    if (!experiment) throw new EventJobError('EXPERIMENT_NOT_FOUND', 'FINAL');
    validateTransition(experiment.state, next); validTime(now);
    const statements: D1Statement[] = [];
    if (['ELIGIBLE', 'SHADOW', 'READY_FOR_REVIEW'].includes(next)) {
      const opportunity = await this.eligible(experiment.productId, now);
      if (now >= experiment.expiresAt) throw new EventJobError('EXPERIMENT_EXPIRED', 'FINAL');
      statements.push(this.opportunities.eligibilityFence(opportunity, now));
    }
    if (next === 'COMPLETED') {
      const summary = await this.summary(experimentId, now);
      if (!summary.minimumEvidenceMet || !summary.runtimeMet || now < experiment.expiresAt) throw new EventJobError('EXPERIMENT_COMPLETION_INSUFFICIENT', 'FINAL');
    }
    statements.push(this.statement("SELECT json(CASE WHEN EXISTS(SELECT 1 FROM experiments WHERE id=? AND origin=? AND state=?) THEN '{}' ELSE 'EXPERIMENT_STATE_CHANGED' END)",
      [experimentId, this.origin, experiment.state]));
    statements.push(this.statement('UPDATE experiments SET state=? WHERE id=? AND origin=? AND state=?', [next, experimentId, this.origin, experiment.state]));
    await this.batch(statements);
    return (await this.get(experimentId))!;
  }
  private shadowFence(experimentId: string, now: number) {
    return this.statement(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM experiments WHERE id=? AND origin='TEST_FIXTURE' AND state='SHADOW'
      AND execution_mode='SHADOW' AND starts_at<=? AND expires_at>?) THEN '{}' ELSE 'EXPERIMENT_NOT_SHADOW_OR_EXPIRED' END)`, [experimentId, now, now]);
  }
  async assign(experimentId: string, subjectId: string, now: number): Promise<ExperimentAssignment> {
    this.fixtureOnly(); validTime(now);
    const experiment = await this.get(experimentId), key = subjectKey(subjectId);
    if (!experiment || experiment.state !== 'SHADOW' || now < experiment.startsAt || now >= experiment.expiresAt)
      throw new EventJobError('EXPERIMENT_NOT_SHADOW_OR_EXPIRED', 'QUARANTINE');
    const opportunity = await this.eligible(experiment.productId, now), variantId = assignVariant(experiment, subjectId);
    await this.batch([this.opportunities.eligibilityFence(opportunity, now), this.shadowFence(experimentId, now),
      this.statement(`INSERT INTO experiment_assignments(experiment_id,subject_key,variant_id,assigned_at,retain_until,origin,click_id)
        SELECT ?,?,?,?,?, 'TEST_FIXTURE',? FROM experiments WHERE id=? AND assignment_count<? ON CONFLICT(experiment_id,subject_key) DO NOTHING`,
      [experimentId, key, variantId, now, experiment.expiresAt + EXPERIMENT_LIMITS.retentionMs, subjectId, experimentId, EXPERIMENT_LIMITS.assignments])]);
    const [row] = await this.query('SELECT variant_id,assigned_at FROM experiment_assignments WHERE experiment_id=? AND subject_key=? LIMIT 1', [experimentId, key]);
    if (!row || row.variant_id !== variantId) throw new EventJobError('EXPERIMENT_ASSIGNMENT_CAP_OR_CONFLICT', 'QUARANTINE');
    return { experimentId, subjectKey: key, variantId, version: experiment.version, assignedAt: Number(row.assigned_at), origin: 'TEST_FIXTURE', exposureKind: 'SHADOW_ASSIGNMENT_NOT_PRODUCTION_EXPOSURE' };
  }
  async recordMetric(experimentId: string, subjectId: string, metric: ExperimentMetric, eventKey: string, now: number) {
    this.fixtureOnly(); validTime(now);
    if (!['CLICK', 'CONVERSION'].includes(metric) || typeof eventKey !== 'string' || eventKey.length > 300) throw new EventJobError('EXPERIMENT_METRIC_UNSUPPORTED', 'QUARANTINE');
    const experiment = await this.get(experimentId), key = subjectKey(subjectId);
    if (!experiment || now >= experiment.expiresAt || now < experiment.startsAt || experiment.state !== 'SHADOW') throw new EventJobError('EXPERIMENT_NOT_SHADOW_OR_EXPIRED', 'QUARANTINE');
    const opportunity = await this.eligible(experiment.productId, now);
    const [assignment] = await this.query('SELECT variant_id,assigned_at,click_id FROM experiment_assignments WHERE experiment_id=? AND subject_key=? LIMIT 1', [experimentId, key]);
    const [event] = await this.query('SELECT clicks,conversions,product_id,origin FROM affiliate_money_events WHERE effect_key=? LIMIT 1', [eventKey]);
    const [click] = await this.query('SELECT created_at,product_id,origin FROM affiliate_clicks WHERE id=? LIMIT 1', [subjectId]);
    let occurredAt = Date.parse(String(click?.created_at));
    if (metric === 'CONVERSION') {
      const match = /^conversion:(accesstrade|tiktok):(.{1,160})$/.exec(eventKey);
      if (!match) throw new EventJobError('EXPERIMENT_METRIC_SOURCE_INVALID', 'QUARANTINE');
      const [conversion] = await this.query('SELECT click_id,occurred_at FROM affiliate_conversions WHERE provider=? AND external_id=? LIMIT 1', [match[1], match[2]]);
      if (conversion?.click_id !== subjectId) throw new EventJobError('EXPERIMENT_METRIC_SUBJECT_MISMATCH', 'QUARANTINE');
      occurredAt = Date.parse(String(conversion.occurred_at));
    }
    if (!assignment || !event || !click || assignment.click_id !== subjectId || event.origin !== 'TEST_FIXTURE' || click.origin !== 'TEST_FIXTURE'
      || event.product_id !== experiment.productId || click.product_id !== experiment.productId || !Number.isSafeInteger(occurredAt)
      || occurredAt < Number(assignment.assigned_at) || occurredAt > now || occurredAt >= experiment.expiresAt
      || (metric === 'CLICK' ? eventKey !== `click:${subjectId}` || event.clicks !== 1 : event.conversions !== 1))
      throw new EventJobError('EXPERIMENT_METRIC_SOURCE_INVALID', 'QUARANTINE');
    const results = await this.batch([this.opportunities.eligibilityFence(opportunity, now), this.shadowFence(experimentId, now),
      this.statement(`INSERT INTO experiment_metric_events(experiment_id,event_key,subject_key,variant_id,metric,origin,retain_until)
        SELECT ?,?,?,?,?,'TEST_FIXTURE',? FROM experiments WHERE id=? AND metric_count<? ON CONFLICT DO NOTHING RETURNING event_key`,
      [experimentId, eventKey, key, String(assignment.variant_id), metric, experiment.expiresAt + EXPERIMENT_LIMITS.retentionMs, experimentId, EXPERIMENT_LIMITS.metricEvents])]);
    const [stored] = await this.query('SELECT subject_key,metric FROM experiment_metric_events WHERE experiment_id=? AND event_key=? LIMIT 1', [experimentId, eventKey]);
    if (!stored || stored.subject_key !== key || stored.metric !== metric) throw new EventJobError('EXPERIMENT_METRIC_CONFLICT_OR_CAP', 'QUARANTINE');
    return { status: results.at(-1)!.results.length === 1 ? 'APPLIED' : 'DUPLICATE', effect: results.at(-1)!.results.length };
  }
  async summary(experimentId: string, now: number): Promise<ExperimentResultSummary> {
    const experiment = await this.get(experimentId);
    if (!experiment) throw new EventJobError('EXPERIMENT_NOT_FOUND', 'FINAL');
    const rows = await this.query('SELECT id,subjects,clicks,conversions FROM experiment_variants WHERE experiment_id=? ORDER BY id LIMIT ?', [experimentId, EXPERIMENT_LIMITS.variants]);
    return summarizeExperiment(experiment, rows.map(row => ({ variantId: String(row.id), subjects: Number(row.subjects), clicks: Number(row.clicks), conversions: Number(row.conversions), revenue: 'UNKNOWN' })), now);
  }
  async observability(state: ExperimentState, limit: number, now: number) {
    if (!['DRAFT', 'ELIGIBLE', 'SHADOW', 'READY_FOR_REVIEW', 'PAUSED', 'COMPLETED', 'REJECTED'].includes(state)
      || !Number.isInteger(limit) || limit < 1 || limit > EXPERIMENT_LIMITS.read) throw new EventJobError('EXPERIMENT_QUERY_BOUND', 'QUARANTINE');
    validTime(now);
    const rows = await this.query('SELECT id,assignment_count,metric_count FROM experiments WHERE origin=? AND state=? ORDER BY expires_at,id LIMIT ?', [this.origin, state, limit]);
    let inconclusive = 0;
    for (const row of rows) { const experiment = await this.get(String(row.id)); if (experiment && now >= experiment.startsAt && (await this.summary(experiment.experimentId, now)).outcome === 'INCONCLUSIVE') inconclusive++; }
    return { boundedSample: true, sampled: rows.length, state, shadowAssignments: rows.reduce((total, row) => total + Number(row.assignment_count), 0),
      metricEvents: rows.reduce((total, row) => total + Number(row.metric_count), 0), inconclusive, productionTraffic: 0, activeProductionExperiments: 0 };
  }
  async cleanup(now: number) {
    this.fixtureOnly(); validTime(now);
    await this.query(`DELETE FROM experiment_metric_events WHERE (experiment_id,event_key) IN
      (SELECT experiment_id,event_key FROM experiment_metric_events WHERE retain_until<? ORDER BY retain_until,experiment_id,event_key LIMIT ?)`, [now, EXPERIMENT_LIMITS.cleanup]);
    const candidates = await this.query(`SELECT experiment_id,subject_key FROM experiment_assignments WHERE retain_until<?
      ORDER BY retain_until,experiment_id,subject_key LIMIT ?`, [now, EXPERIMENT_LIMITS.cleanup]);
    for (const candidate of candidates) await this.query(`DELETE FROM experiment_assignments WHERE experiment_id=? AND subject_key=?
      AND NOT EXISTS(SELECT 1 FROM experiment_metric_events WHERE experiment_id=? AND subject_key=? LIMIT 1)`,
    [String(candidate.experiment_id), String(candidate.subject_key), String(candidate.experiment_id), String(candidate.subject_key)]);
  }
}
