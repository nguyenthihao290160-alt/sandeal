import { dealFingerprint } from '../../deal-intelligence/evaluate';
import { planContent } from '../../content/planner';
import { CONTENT_INTELLIGENCE_VERSION } from '../../content/config';
import { evaluateLifecycle, validateLifecycleTransition } from '../../content/lifecycle/evaluate';
import { projectLifecycleEvidence } from '../../content/lifecycle/evidence';
import { LIFECYCLE_CONFIG, lifecycleId, fingerprintToken, validateLifecycleConfig, type LifecycleConfig } from '../../content/lifecycle/config';
import type { ContentEntity, ContentPlan, ContentRelationship } from '../../content/types';
import type { LifecycleInput, ContentLifecycleEvaluation, LifecycleEvidence, RefreshOutcome } from '../../content/lifecycle/types';
import { EVENT_LIMITS, EventJobError, jobId, validTime, type EventJob } from '../../platform/cloudflareContracts';
import { D1DealStore, providerVersionsSql, type PreparedDeal } from './d1DealStore';
import type { D1DecisionStore } from './d1DecisionStore';
import type { D1OpportunityStore } from './d1OpportunityStore';
import { D1ContentValueStore } from './d1ContentValueStore';
import { safePayload } from './d1StorageAdapter';
import type { D1Database, D1Statement, SqlValue } from './database';

type Row = Record<string, string | number | null>;
type PreparedLifecycle = { input: LifecycleInput; evaluation: ContentLifecycleEvaluation; source: Row; work: Row; deal: PreparedDeal };
export type LifecyclePortfolio = 'P0' | 'P1' | 'HIGH_VALUE_STALE' | 'LOW_CONFIDENCE_STALE' | 'MERGE' | 'SUPERSEDE' | 'ARCHIVE' | 'RECENT' | 'ACCESSTRADE_SHOPEE' | 'SAMPLE';
export class D1ContentLifecycleStore {
  readonly origin: 'TEST_FIXTURE' | 'AUTHENTICATED_PROVIDER_API';
  readonly configVersion: string;
  readonly values: D1ContentValueStore;
  constructor(private readonly db: D1Database, private readonly decisions: D1DecisionStore, private readonly opportunities: D1OpportunityStore,
    private readonly allowedHosts: readonly string[], private readonly testOnly = false, private readonly config: LifecycleConfig = LIFECYCLE_CONFIG) {
    validateLifecycleConfig(config);
    if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function' || !decisions || decisions.aiEnabled || !opportunities)
      throw new EventJobError('LIFECYCLE_SHADOW_DEPENDENCY_REQUIRED', 'QUARANTINE');
    this.origin = testOnly ? 'TEST_FIXTURE' : 'AUTHENTICATED_PROVIDER_API';
    this.configVersion = dealFingerprint({ config, decision: decisions.configVersion, opportunity: opportunities.configVersion });
    this.values = new D1ContentValueStore(db, testOnly);
  }
  private statement(sql: string, values: SqlValue[] = []) { return this.db.prepare(sql).bind(...values); }
  private async query(sql: string, values: SqlValue[] = []): Promise<Row[]> {
    try { const result = await this.statement(sql, values).all<Row>(); if (!result.success) throw new Error(); return result.results; }
    catch { throw new EventJobError('D1_LIFECYCLE_UNAVAILABLE', 'RETRYABLE'); }
  }
  private async batch(statements: D1Statement[]) {
    try { const results = await this.db.batch<Row>(statements); if (results.some(result => !result.success)) throw new Error(); return results; }
    catch { throw new EventJobError('LIFECYCLE_ATOMIC_CONFLICT', 'RETRYABLE'); }
  }
  private validateContent(content: ContentEntity, plan: ContentPlan | null, now: number) {
    lifecycleId(content?.id); lifecycleId(content.canonicalTarget?.entityId); validTime(now);
    if (content.canonicalTarget?.entityType !== 'PRODUCT' || !/^\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\/?$/.test(content.canonicalTarget.url)
      || !['PRODUCT', 'DEAL', 'CATEGORY', 'COMPARISON', 'BUYING_GUIDE', 'PRICE_HISTORY', 'HOW_TO', 'INFORMATIONAL', 'BRAND', 'TRANSACTIONAL', 'UNKNOWN'].includes(content.intent)
      || !Number.isFinite(Date.parse(content.createdAt)) || !Number.isFinite(Date.parse(content.updatedAt))
      || Date.parse(content.createdAt) > Date.parse(content.updatedAt) || Date.parse(content.updatedAt) > now)
      throw new EventJobError('CONTENT_REGISTRATION_INVALID', 'QUARANTINE');
    if (plan && (plan.algorithmVersion !== CONTENT_INTELLIGENCE_VERSION || (plan.contentId && plan.contentId !== content.id) || plan.intent !== content.intent))
      throw new EventJobError('CONTENT_PLAN_INVALID', 'QUARANTINE');
    if (plan) fingerprintToken(plan.evidenceFingerprint);
  }
  private async current(content: ContentEntity, storedPlan: ContentPlan | null, relationship: ContentRelationship | null, now: number) {
    const deals = new D1DealStore(this.db, this.testOnly), productId = content.canonicalTarget!.entityId;
    const prepared = await deals.prepare(productId, this.allowedHosts, now), latestDeal = await deals.latest(productId, now);
    if (latestDeal) prepared.evaluation = latestDeal;
    const decision = await this.decisions.prepare(prepared), context = this.decisions.context(prepared);
    let opportunity = await this.opportunities.latest(productId, now);
    if (opportunity && (opportunity.dealEvaluationId !== prepared.evaluation.evidenceFingerprint || opportunity.decisionId !== decision.decisionId)) opportunity = null;
    const fallbackPlan = storedPlan ?? planContent({ opportunityId: opportunity?.opportunityId ?? 'missing-opportunity',
      policyState: 'BLOCK', existingContent: [content], candidateIntent: content.intent,
      candidateSlug: content.canonicalTarget!.url.split('/').filter(Boolean).at(-1)!, candidateCanonicalEntityId: productId,
      materialChangeDetected: false, opportunityFingerprint: opportunity?.evidenceFingerprint ?? dealFingerprint(null) });
    const evidence = projectLifecycleEvidence(prepared, decision, context, opportunity, content, fallbackPlan, relationship);
    return { prepared, evidence };
  }
  async register(content: ContentEntity, plan: ContentPlan | null, now: number) {
    this.validateContent(content, plan, now);
    const [existing] = await this.query('SELECT entity,plan FROM content_lifecycle_sources WHERE origin=? AND content_id=? LIMIT 1', [this.origin, content.id]);
    if (existing) {
      if (existing.entity !== safePayload(content, 4096) || existing.plan !== (plan ? safePayload(plan, 8192) : null))
        throw new EventJobError('CONTENT_IDENTITY_ALREADY_REGISTERED', 'QUARANTINE');
      return { created: false };
    }
    const { evidence, prepared } = await this.current(content, plan, null, now);
    const token = dealFingerprint({ content, plan, evidence });
    const result = await this.batch([this.statement(`SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM content_lifecycle_sources WHERE origin=? AND content_id=?)
      OR EXISTS(SELECT 1 FROM content_lifecycle_sources WHERE origin=? AND content_id=? AND entity=? AND plan IS ?) THEN '{}' ELSE 'CONTENT_IDENTITY_CONFLICT' END)`,
    [this.origin, content.id, this.origin, content.id, safePayload(content, 4096), plan ? safePayload(plan, 8192) : null]),
    this.statement(`SELECT json(CASE WHEN (SELECT count(*) FROM
      (SELECT content_id FROM content_lifecycle_sources WHERE product_id=? LIMIT ?))<? THEN '{}' ELSE 'CONTENT_PRODUCT_CAP' END)`,
    [content.canonicalTarget!.entityId, this.config.contentsPerProduct, this.config.contentsPerProduct]),
    this.statement(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM deal_work WHERE product_id=? AND revision=?) AND (${providerVersionsSql('?')})=? THEN '{}' ELSE 'CONTENT_SOURCE_CHANGED' END)`,
      [content.canonicalTarget!.entityId, prepared.revision, content.canonicalTarget!.entityId, prepared.providerVersions]),
    this.statement(`INSERT INTO content_lifecycle_sources(origin,content_id,product_id,intent,token,entity,plan,baseline)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(origin,content_id) DO NOTHING RETURNING content_id`,
    [this.origin, content.id, content.canonicalTarget!.entityId, content.intent, token, safePayload(content, 4096), plan ? safePayload(plan, 8192) : null, safePayload(evidence, 16384)])]);
    return { created: result.at(-1)!.results.length === 1 };
  }
  async setRelationship(contentId: string, relationship: ContentRelationship, expectedToken: string) {
    lifecycleId(contentId); fingerprintToken(expectedToken); lifecycleId(relationship.sourceId); lifecycleId(relationship.targetId);
    const targetId = relationship.relationship === 'SUPERSEDES_CONTENT' ? relationship.sourceId : relationship.targetId;
    const ownerId = relationship.relationship === 'SUPERSEDES_CONTENT' ? relationship.targetId : relationship.sourceId;
    if (ownerId !== contentId || targetId === contentId || !['MERGED_INTO', 'DUPLICATES_CONTENT', 'SUPERSEDES_CONTENT'].includes(relationship.relationship)
      || relationship.reasonCodes.some(reason => !['CONTENT_DUPLICATION_FOUND', 'CANONICAL_RELATIONSHIP_CHANGED'].includes(reason)))
      throw new EventJobError('CONTENT_RELATIONSHIP_INVALID', 'QUARANTINE');
    await this.batch([this.statement(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM content_lifecycle_sources source
      JOIN content_lifecycle_sources target ON target.origin=source.origin AND target.product_id=source.product_id
      WHERE source.origin=? AND source.content_id=? AND source.token=? AND target.content_id=?) THEN '{}' ELSE 'CONTENT_RELATIONSHIP_TARGET_INVALID' END)`,
    [this.origin, contentId, expectedToken, targetId]),
    this.statement('UPDATE content_lifecycle_sources SET relationship=?,token=? WHERE origin=? AND content_id=? AND token=?',
      [safePayload(relationship, 2048), dealFingerprint([expectedToken, relationship]), this.origin, contentId, expectedToken])]);
  }
  async observePlan(contentId: string, plan: ContentPlan, expectedToken: string, now: number) {
    lifecycleId(contentId); fingerprintToken(expectedToken);
    const [source] = await this.query('SELECT entity,plan,token FROM content_lifecycle_sources WHERE origin=? AND content_id=? LIMIT 1', [this.origin, contentId]);
    if (!source) throw new EventJobError('CONTENT_LIFECYCLE_RECORD_MISSING', 'FINAL');
    this.validateContent(JSON.parse(String(source.entity)) as ContentEntity, plan, now);
    const payload = safePayload(plan, 8192);
    if (source.plan === payload) return { changed: false };
    if (source.token !== expectedToken) throw new EventJobError('CONTENT_PLAN_REVISION_MISMATCH', 'QUARANTINE');
    await this.batch([this.statement(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM content_lifecycle_sources WHERE origin=? AND content_id=? AND token=?)
      THEN '{}' ELSE 'CONTENT_PLAN_CHANGED' END)`, [this.origin, contentId, expectedToken]),
      this.statement('UPDATE content_lifecycle_sources SET plan=?,token=? WHERE origin=? AND content_id=? AND token=?',
        [payload, dealFingerprint([expectedToken, plan]), this.origin, contentId, expectedToken])]);
    return { changed: true };
  }
  async prepare(contentId: string, now: number): Promise<PreparedLifecycle> {
    lifecycleId(contentId); validTime(now);
    const [source] = await this.query('SELECT * FROM content_lifecycle_sources WHERE origin=? AND content_id=? LIMIT 1', [this.origin, contentId]);
    const [work] = await this.query('SELECT * FROM content_lifecycle_work WHERE origin=? AND content_id=? LIMIT 1', [this.origin, contentId]);
    if (!source || !work) throw new EventJobError('CONTENT_LIFECYCLE_RECORD_MISSING', 'FINAL');
    const content = JSON.parse(String(source.entity)) as ContentEntity, plan = source.plan ? JSON.parse(String(source.plan)) as ContentPlan : null;
    this.validateContent(content, plan, now);
    const { evidence, prepared } = await this.current(content, plan, source.relationship ? JSON.parse(String(source.relationship)) : null, now);
    const input: LifecycleInput = { content, contentPlan: plan, current: evidence,
      baseline: source.baseline ? JSON.parse(String(source.baseline)) as LifecycleEvidence : null,
      value: await this.values.snapshot(contentId, now, undefined, undefined, false), now };
    return { input, evaluation: evaluateLifecycle(input, this.config), source, work, deal: prepared };
  }
  private fence(prepared: PreparedLifecycle) {
    return this.statement(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM content_lifecycle_sources source
      JOIN content_lifecycle_work work ON work.origin=source.origin AND work.content_id=source.content_id
      JOIN deal_work deal ON deal.product_id=source.product_id WHERE source.origin=? AND source.content_id=? AND source.token=?
      AND work.revision=? AND deal.revision=? AND (${providerVersionsSql('source.product_id')})=?) THEN '{}' ELSE 'LIFECYCLE_EVIDENCE_CHANGED' END)`,
    [this.origin, prepared.input.content.id, String(prepared.source.token), Number(prepared.work.revision), prepared.deal.revision, prepared.deal.providerVersions]);
  }
  private async expandConfiguration() {
    const [current] = await this.query('SELECT config_version,pending FROM content_lifecycle_config WHERE origin=? LIMIT 1', [this.origin]);
    if (current?.config_version === this.configVersion && current.pending === 0) return;
    if (current?.config_version !== this.configVersion) await this.query(`INSERT INTO content_lifecycle_config(origin,config_version) VALUES(?,?) ON CONFLICT(origin) DO UPDATE SET
      config_version=excluded.config_version,cursor='',pending=1 WHERE content_lifecycle_config.config_version<>excluded.config_version`, [this.origin, this.configVersion]);
    const [version] = await this.query('SELECT cursor,pending FROM content_lifecycle_config WHERE origin=? AND config_version=? LIMIT 1', [this.origin, this.configVersion]);
    if (!version?.pending) return;
    const rows = await this.query('SELECT content_id FROM content_lifecycle_sources WHERE origin=? AND content_id>? ORDER BY content_id LIMIT ?',
      [this.origin, String(version.cursor), this.config.batch]);
    await this.batch([this.statement(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM content_lifecycle_config WHERE origin=? AND config_version=? AND cursor=? AND pending=1)
      THEN '{}' ELSE 'LIFECYCLE_CONFIG_CHANGED' END)`, [this.origin, this.configVersion, String(version.cursor)]),
      ...rows.map(row => this.statement('UPDATE content_lifecycle_work SET revision=revision+1,pending=1,due_at=0 WHERE origin=? AND content_id=?', [this.origin, String(row.content_id)])),
      this.statement('UPDATE content_lifecycle_config SET cursor=?,pending=? WHERE origin=? AND config_version=?',
        [String(rows.at(-1)?.content_id ?? version.cursor), Number(rows.length === this.config.batch), this.origin, this.configVersion])]);
  }
  async materializeDue(now: number) {
    validTime(now); await this.expandConfiguration(); await this.values.reconcileDue(now, this.config.batch);
    const urgent = await this.query(`SELECT content_id FROM content_lifecycle_work WHERE origin=? AND pending=1 AND urgency=0 AND due_at<=? ORDER BY due_at,content_id LIMIT ?`,
      [this.origin, now, this.config.read]);
    const due = urgent.length < this.config.read ? [...urgent, ...await this.query(`SELECT content_id FROM content_lifecycle_work WHERE origin=? AND pending=1 AND urgency=1 AND due_at<=? ORDER BY due_at,content_id LIMIT ?`,
      [this.origin, now, this.config.read - urgent.length])] : urgent;
    const candidates: PreparedLifecycle[] = [];
    for (const row of due) candidates.push(await this.prepare(String(row.content_id), now));
    candidates.sort((left, right) => this.urgency(left.evaluation) - this.urgency(right.evaluation) || left.input.content.id.localeCompare(right.input.content.id));
    let created = 0, coalesced = 0, duplicates = 0, mergeReviews = 0;
    for (const prepared of candidates) {
      if (created >= this.config.batch) break;
      const { evaluation, work } = prepared, critical = evaluation.severity === 'CRITICAL';
      const [active] = await this.query(`SELECT refresh.job_id,refresh.fingerprint FROM content_refresh_jobs refresh
        JOIN automation_jobs job ON job.id=refresh.job_id WHERE refresh.origin=? AND refresh.content_id=? AND refresh.outcome IS NULL
        AND job.status IN ('PENDING','RUNNING','RETRY_SCHEDULED') ORDER BY refresh.job_id LIMIT 1`, [this.origin, evaluation.contentEntityId]);
      if (active && (!critical || active.fingerprint === evaluation.evidenceFingerprint)) {
        await this.batch([this.fence(prepared), this.statement('UPDATE content_lifecycle_work SET due_at=? WHERE origin=? AND content_id=? AND revision=?',
          [now + this.config.coalesceMs, this.origin, evaluation.contentEntityId, Number(work.revision)])]);
        coalesced++; continue;
      }
      if (work.evaluated_fingerprint === evaluation.evidenceFingerprint) {
        await this.batch([this.fence(prepared), this.statement('UPDATE content_lifecycle_work SET pending=0,coalesce_until=NULL WHERE origin=? AND content_id=? AND revision=?',
          [this.origin, evaluation.contentEntityId, Number(work.revision)])]); duplicates++; continue;
      }
      if (!critical && work.coalesce_until === null) {
        await this.batch([this.fence(prepared), this.statement('UPDATE content_lifecycle_work SET coalesce_until=?,due_at=? WHERE origin=? AND content_id=? AND revision=?',
          [now + this.config.coalesceMs, now + this.config.coalesceMs, this.origin, evaluation.contentEntityId, Number(work.revision)])]); coalesced++; continue;
      }
      if (!critical && Number(work.coalesce_until) > now) { coalesced++; continue; }
      if (!critical && work.evaluated_config_version === this.configVersion && work.material_fingerprint === evaluation.materialFingerprint && Number(work.cooldown_until) > now) {
        await this.batch([this.fence(prepared), this.statement('UPDATE content_lifecycle_work SET due_at=? WHERE origin=? AND content_id=? AND revision=?',
          [Number(work.cooldown_until), this.origin, evaluation.contentEntityId, Number(work.revision)])]); coalesced++; continue;
      }
      if (['MERGE_RECOMMENDED', 'SUPERSEDE_RECOMMENDED'].includes(evaluation.plan.action) && ++mergeReviews > this.config.maxMergeReviews) continue;
      const key = `lifecycle:${dealFingerprint([this.origin, evaluation.contentEntityId, evaluation.evidenceFingerprint, this.configVersion])}`, id = jobId(key);
      const cancellation = active ? [this.statement("UPDATE content_refresh_jobs SET outcome='STALE_JOB_NOOP' WHERE job_id=?", [String(active.job_id)]),
        this.statement("UPDATE automation_jobs SET status='BLOCKED',dispatch_pending=0,claim_token=NULL,lease_expires_at=0,last_error_code='STALE_JOB_NOOP' WHERE id=?", [String(active.job_id)])] : [];
      const result = await this.batch([this.fence(prepared), ...cancellation,
        this.statement(`SELECT json(CASE WHEN (SELECT count(*) FROM (SELECT job_id FROM content_refresh_jobs WHERE origin=? AND content_id=? LIMIT ?))<?
          OR EXISTS(SELECT 1 FROM content_refresh_jobs WHERE job_id=?) THEN '{}' ELSE 'CONTENT_REFRESH_JOB_CAP' END)`,
        [this.origin, evaluation.contentEntityId, this.config.auditPerContent, this.config.auditPerContent, id]),
        this.statement(`INSERT INTO automation_jobs(id,job_type,idempotency_key,payload_version,payload,status,created_at,available_at,expires_at,dispatch_at)
          VALUES(?,'CONTENT_LIFECYCLE_EVALUATE',?,1,?,'PENDING',?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
        [id, key, JSON.stringify({ productId: evaluation.canonicalProductId, contentEntityId: evaluation.contentEntityId }), new Date(now).toISOString(), now, now + EVENT_LIMITS.lifetimeMs, critical ? 0 : now]),
        this.statement(`INSERT INTO content_refresh_jobs(job_id,origin,content_id,fingerprint,algorithm_version,config_version,revision)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, [id, this.origin, evaluation.contentEntityId, evaluation.evidenceFingerprint,
          this.config.algorithmVersion, this.configVersion, Number(work.revision)]),
        this.statement(`UPDATE automation_jobs SET status='PENDING',dispatch_pending=1,dispatch_at=?,available_at=?,last_error_code=NULL
          WHERE id=? AND status='SUCCEEDED' AND last_error_code='STALE_JOB_NOOP' AND attempt_count<? AND expires_at>?`,
          [now, now, id, EVENT_LIMITS.attempts, now]),
        this.statement(`UPDATE content_refresh_jobs SET outcome=NULL,revision=? WHERE job_id=? AND outcome='STALE_JOB_NOOP'
          AND EXISTS(SELECT 1 FROM automation_jobs WHERE id=? AND status='PENDING')`, [Number(work.revision), id, id]),
        this.statement('UPDATE content_lifecycle_work SET pending=0,coalesce_until=NULL WHERE origin=? AND content_id=? AND revision=?',
          [this.origin, evaluation.contentEntityId, Number(work.revision)])]);
      created += result[2 + cancellation.length].results.length;
      if (!result[2 + cancellation.length].results.length) duplicates++;
    }
    return { inspected: due.length, created, coalesced, duplicates };
  }
  private urgency(evaluation: ContentLifecycleEvaluation) {
    return evaluation.severity === 'CRITICAL' ? 0 : ({ P0: 0, P1: 1, P2: 2, P3: 3, NONE: 4, BLOCKED: 0 })[evaluation.priority];
  }
  private claimFence(job: EventJob, now: number) {
    return this.statement(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM automation_jobs WHERE id=? AND status='RUNNING' AND claim_token=? AND lease_expires_at>? AND expires_at>?)
      THEN '{}' ELSE 'STALE_LIFECYCLE_CLAIM' END)`, [job.id, job.claimToken, now, now]);
  }
  async execute(job: EventJob, now: number): Promise<RefreshOutcome> {
    validTime(now);
    if (job.type !== 'CONTENT_LIFECYCLE_EVALUATE') throw new EventJobError('LIFECYCLE_JOB_TYPE_MISMATCH', 'QUARANTINE');
    const [queued] = await this.query('SELECT * FROM content_refresh_jobs WHERE job_id=? AND origin=? LIMIT 1', [job.id, this.origin]);
    if (!queued || queued.content_id !== job.payload.contentEntityId) throw new EventJobError('LIFECYCLE_JOB_MISMATCH', 'QUARANTINE');
    if (queued.outcome) return queued.outcome as RefreshOutcome;
    const prepared = await this.prepare(job.payload.contentEntityId!, now), { evaluation } = prepared;
    if (evaluation.canonicalProductId !== job.payload.productId) throw new EventJobError('LIFECYCLE_JOB_PRODUCT_MISMATCH', 'QUARANTINE');
    if (queued.fingerprint !== evaluation.evidenceFingerprint || queued.config_version !== this.configVersion || queued.algorithm_version !== this.config.algorithmVersion) {
      await this.batch([this.claimFence(job, now),
        this.statement("UPDATE content_refresh_jobs SET outcome='STALE_JOB_NOOP' WHERE job_id=?", [job.id]),
        this.statement("UPDATE automation_jobs SET status='SUCCEEDED',dispatch_pending=0,claim_token=NULL,lease_expires_at=0,last_error_code='STALE_JOB_NOOP' WHERE id=?", [job.id]),
        this.statement('UPDATE content_lifecycle_work SET pending=1,due_at=0 WHERE origin=? AND content_id=?', [this.origin, evaluation.contentEntityId])]);
      return 'STALE_JOB_NOOP';
    }
    const previous = await this.latest(evaluation.contentEntityId);
    if (previous) validateLifecycleTransition(previous.state, evaluation.state, true, previous.evidenceFingerprint !== evaluation.evidenceFingerprint);
    const result = await this.batch([this.claimFence(job, now), this.fence(prepared),
      this.statement(`INSERT INTO content_lifecycle_audit(id,origin,content_id,fingerprint,algorithm_version,created_at,execution_mode,payload)
        VALUES(?,?,?,?,?,?,'SHADOW',?) ON CONFLICT DO NOTHING RETURNING id`, [evaluation.id, this.origin, evaluation.contentEntityId,
        evaluation.evidenceFingerprint, evaluation.algorithmVersion, now, safePayload(evaluation, 32768)]),
      this.statement(`INSERT INTO content_lifecycle(origin,content_id,evaluation_id,state,priority,urgency,action,provider,platform,material,high_value_stale,low_confidence_stale,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(origin,content_id) DO UPDATE SET evaluation_id=excluded.evaluation_id,state=excluded.state,priority=excluded.priority,
        urgency=excluded.urgency,action=excluded.action,provider=excluded.provider,platform=excluded.platform,material=excluded.material,
        high_value_stale=excluded.high_value_stale,low_confidence_stale=excluded.low_confidence_stale,created_at=excluded.created_at`,
      [this.origin, evaluation.contentEntityId, evaluation.id, evaluation.state, evaluation.priority, this.urgency(evaluation), evaluation.plan.action,
        prepared.input.current.provider, prepared.input.current.platform, Number(evaluation.materialChange),
        Number(evaluation.materialChange && evaluation.value?.businessValue === 'HIGH_VALUE'),
        Number(evaluation.materialChange && prepared.input.current.contentConfidence < this.config.minimumEvidenceConfidence), now]),
      this.statement('UPDATE content_lifecycle_work SET evaluated_fingerprint=?,evaluated_config_version=?,material_fingerprint=?,cooldown_until=?,pending=0,coalesce_until=NULL,urgency=1 WHERE origin=? AND content_id=? AND revision=?',
        [evaluation.evidenceFingerprint, this.configVersion, evaluation.materialFingerprint, now + this.config.cooldownMs, this.origin, evaluation.contentEntityId, Number(prepared.work.revision)]),
      this.statement("UPDATE content_refresh_jobs SET outcome='SHADOW_RECORDED' WHERE job_id=?", [job.id]),
      this.statement("UPDATE automation_jobs SET status='SUCCEEDED',result=?,dispatch_pending=0,claim_token=NULL,lease_expires_at=0,last_error_code=NULL WHERE id=?",
        [JSON.stringify({ evidenceFingerprint: evaluation.evidenceFingerprint }), job.id]),
      ...(evaluation.value ? [this.values.snapshotStatement(evaluation.value)] : [])]);
    return result[2].results.length ? 'SHADOW_RECORDED' : 'DUPLICATE_SAFE';
  }
  async latest(contentId: string): Promise<ContentLifecycleEvaluation | null> {
    lifecycleId(contentId);
    const [row] = await this.query(`SELECT audit.payload FROM content_lifecycle current JOIN content_lifecycle_audit audit ON audit.id=current.evaluation_id
      WHERE current.origin=? AND current.content_id=? LIMIT 1`, [this.origin, contentId]);
    return row ? JSON.parse(String(row.payload)) as ContentLifecycleEvaluation : null;
  }
  portfolioQuery(kind: LifecyclePortfolio, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > this.config.read) throw new EventJobError('CONTENT_PORTFOLIO_BOUND', 'QUARANTINE');
    const filters = { P0: "priority='P0'", P1: "priority='P1'", HIGH_VALUE_STALE: 'high_value_stale=1', LOW_CONFIDENCE_STALE: 'low_confidence_stale=1',
      MERGE: "state='MERGE_CANDIDATE'", SUPERSEDE: "state='SUPERSEDE_CANDIDATE'", ARCHIVE: "state='ARCHIVE_CANDIDATE'", RECENT: 'material=1',
      ACCESSTRADE_SHOPEE: "provider='accesstrade' AND platform='shopee'", SAMPLE: '1=1' };
    if (!Object.hasOwn(filters, kind)) throw new EventJobError('CONTENT_PORTFOLIO_FILTER', 'QUARANTINE');
    return { sql: `SELECT content_id FROM content_lifecycle WHERE origin=? AND ${filters[kind]} ORDER BY ${kind === 'RECENT' ? 'created_at DESC' : 'urgency'},content_id LIMIT ?`, values: [this.origin, limit] as SqlValue[] };
  }
  async portfolio(kind: LifecyclePortfolio, limit: number) {
    const query = this.portfolioQuery(kind, limit), rows = await this.query(query.sql, query.values), records: ContentLifecycleEvaluation[] = [];
    for (const row of rows) { const record = await this.latest(String(row.content_id)); if (record) records.push(record); }
    return { boundedSample: true, journalOnly: true, inspected: rows.length, records };
  }
  async summary(limit: number) {
    const sample = await this.portfolio('SAMPLE', limit), records = sample.records;
    const outcomes = await this.query(`SELECT job_id,outcome FROM content_refresh_jobs WHERE origin=? AND content_id=? ORDER BY job_id LIMIT ?`,
      [this.origin, records[0]?.contentEntityId ?? '', this.config.read]);
    return { boundedSample: true, lifecycleEvaluations: records.length, refreshCandidates: records.filter(record => record.plan.action === 'REFRESH_CONTENT').length,
      p0: records.filter(record => record.severity === 'CRITICAL').length, p1: records.filter(record => record.priority === 'P1').length,
      merges: records.filter(record => record.state === 'MERGE_CANDIDATE').length, archiveReviews: records.filter(record => record.state === 'ARCHIVE_CANDIDATE').length,
      materialChanges: records.filter(record => record.materialChange).length, aiReviewsAvoided: records.filter(record => record.ai.attempts.length === 0).length,
      unknownValue: records.filter(record => !record.value || record.value.businessValue === 'UNKNOWN').length,
      attributedClicks: records.reduce((total, record) => total + (record.value?.attributedClicks ?? 0), 0),
      attributedConversions: records.reduce((total, record) => total + (record.value?.attributedConversions ?? 0), 0),
      revenueEvidenceContent: records.filter(record => record.value?.revenueEvidence !== null && record.value?.revenueEvidence !== undefined).length,
      sampledJobContentId: records[0]?.contentEntityId ?? null, sampledJobs: outcomes.length,
      staleJobsDropped: outcomes.filter(row => row.outcome === 'STALE_JOB_NOOP').length, productionMutations: 0 };
  }
}
