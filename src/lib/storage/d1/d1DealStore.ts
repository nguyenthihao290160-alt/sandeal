import type { Product } from '../../types';
import type { PriceSnapshot } from '../../product-intelligence/types';
import { evaluateDeal } from '../../deal-intelligence/evaluate';
import { DEAL_CONFIG, validateDealConfig, type DealConfig } from '../../deal-intelligence/config';
import type { DealEvaluation, DealInput, DealPriority, PublishRecommendation } from '../../deal-intelligence/types';
import { EVENT_LIMITS, EventJobError, digest, jobId, validTime, validateInput, type EventJob } from '../../platform/cloudflareContracts';
import { D1AffiliateStore } from './d1AffiliateStore';
import { safePayload } from './d1StorageAdapter';
import type { D1Database, D1Statement, SqlValue } from './database';

type Row = Record<string, string | number | null>;
export const providerVersionsSql = (owner: string) => `SELECT json_group_array(json_array(provider,revision)) FROM
  (SELECT refresh.provider,refresh.revision FROM deal_provider_products membership JOIN deal_provider_refresh refresh ON refresh.provider=membership.provider
    WHERE membership.product_id=${owner} ORDER BY refresh.provider LIMIT 2)`;
export interface PreparedDeal { evaluation: DealEvaluation; revision: number; providerVersions: string; input: DealInput; }
export type DealRanking = { kind: 'TOP' } | { kind: 'PROVIDER'; provider: 'accesstrade' | 'tiktok'; platform?: 'shopee' | 'tiktok_shop' | 'other' }
  | { kind: 'RECOMMENDATION'; recommendation: PublishRecommendation } | { kind: 'PRIORITY'; priority: DealPriority }
  | { kind: 'WEAK_CONFIDENCE' } | { kind: 'NO_SAFE_PATH' } | { kind: 'STALE' };

export class D1DealStore {
  constructor(private readonly db: D1Database, private readonly testOnly = false, private readonly config: DealConfig = DEAL_CONFIG) { validateDealConfig(config); }
  private statement(sql: string, values: SqlValue[] = []) { return this.db.prepare(sql).bind(...values); }
  private async query(sql: string, values: SqlValue[] = []): Promise<Row[]> {
    try { const result = await this.statement(sql, values).all<Row>(); if (!result.success) throw new Error(); return result.results; }
    catch { throw new EventJobError('D1_DEAL_UNAVAILABLE', 'RETRYABLE'); }
  }
  private async batch(statements: D1Statement[]) {
    try { const results = await this.db.batch<Row>(statements); if (results.some(result => !result.success)) throw new Error(); return results; }
    catch { throw new EventJobError('D1_DEAL_COMMIT_RETRY', 'RETRYABLE'); }
  }
  private origin() { return this.testOnly ? 'TEST_FIXTURE' : 'AUTHENTICATED_PROVIDER_API'; }
  private async versions(productId: string) { const [row] = await this.query(`SELECT (${providerVersionsSql('?')}) AS versions`, [productId]); return String(row.versions); }
  async prepare(productId: string, allowedHosts: readonly string[], now: number): Promise<PreparedDeal> {
    validTime(now); validateInput({ type: 'DEAL_EVALUATE', payload: { productId }, idempotencyKey: productId });
    const providerVersions = await this.versions(productId);
    const [work] = await this.query('SELECT revision FROM deal_work WHERE product_id=? LIMIT 1', [productId]);
    const [record] = await this.query('SELECT payload FROM products WHERE id=? LIMIT 1', [productId]);
    if (!work || !record) throw new EventJobError('DEAL_PRODUCT_NOT_FOUND', 'FINAL');
    const history = await this.query(`SELECT id,captured_at,price,sale_price,payload FROM price_history WHERE product_id=? AND captured_at>=?
      ORDER BY captured_at DESC,id DESC LIMIT ?`, [productId, new Date(Math.max(0, now - this.config.windows.referenceDays * Number(this.config.dayMs))).toISOString(), this.config.limits.samples + 1]);
    const money = new D1AffiliateStore(this.db, this.testOnly);
    const input: DealInput = { product: JSON.parse(String(record.payload)) as Product,
      history: history.map(row => {
        const value = JSON.parse(String(row.payload)) as PriceSnapshot;
        if (value.id !== row.id || value.capturedAt !== row.captured_at || (value.price ?? null) !== row.price || (value.salePrice ?? null) !== row.sale_price)
          throw new EventJobError('DEAL_PRICE_ROW_INCONSISTENT', 'QUARANTINE');
        return value;
      }), providers: await money.providers(),
      revenue: await money.revenue({ scope: 'PRODUCT', scopeId: productId, currency: String(this.config.currency),
        from: new Date(Math.max(0, now - 30 * Number(this.config.dayMs))).toISOString().slice(0, 10), to: new Date(now).toISOString().slice(0, 10) }),
      allowedHosts, now, testOnly: this.testOnly, evidenceRevision: Number(work.revision) };
    const evaluation = evaluateDeal(input, this.config);
    return { evaluation, revision: Number(work.revision), providerVersions, input };
  }
  async commit(prepared: PreparedDeal, now: number, job?: EventJob, additionalStatements: D1Statement[] = []) {
    validTime(now);
    const { evaluation, revision, providerVersions } = prepared;
    if (evaluation.origin !== this.origin() || Date.parse(evaluation.validUntil) <= now
      || evaluation.algorithmVersion !== this.config.algorithmVersion) throw new EventJobError('DEAL_EVALUATION_EXPIRED', 'RETRYABLE');
    const statements = [this.statement(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM deal_work WHERE product_id=? AND revision=?)
      AND (${providerVersionsSql('?')})=? THEN '{}' ELSE 'DEAL_EVIDENCE_CHANGED' END)`, [evaluation.productId, revision, evaluation.productId, providerVersions])];
    if (job) {
      if (job.type !== 'DEAL_EVALUATE' || job.payload.productId !== evaluation.productId) throw new EventJobError('DEAL_JOB_MISMATCH', 'QUARANTINE');
      statements.push(this.statement(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM automation_jobs
        WHERE id=? AND status='RUNNING' AND claim_token=? AND lease_expires_at>?) THEN '{}' ELSE 'STALE_CLAIM' END)`, [job.id, job.claimToken, now]));
    }
    const effectIndex = statements.length;
    statements.push(this.statement(`INSERT INTO deal_evaluations(product_id,origin,fingerprint,algorithm_version,provider,platform,priority,recommendation,monetization_state,score,confidence,valid_until,provider_versions,payload)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(origin,product_id) DO UPDATE SET fingerprint=excluded.fingerprint,algorithm_version=excluded.algorithm_version,
      provider=excluded.provider,platform=excluded.platform,priority=excluded.priority,recommendation=excluded.recommendation,monetization_state=excluded.monetization_state,
      score=excluded.score,confidence=excluded.confidence,valid_until=excluded.valid_until,provider_versions=excluded.provider_versions,payload=excluded.payload
      WHERE deal_evaluations.fingerprint<>excluded.fingerprint OR deal_evaluations.provider_versions<>excluded.provider_versions RETURNING product_id`,
    [evaluation.productId, evaluation.origin, evaluation.evidenceFingerprint, evaluation.algorithmVersion, evaluation.provider || null, evaluation.platform || null,
      evaluation.priority, evaluation.publishRecommendation, evaluation.monetizationState, evaluation.dealScore, evaluation.confidence, Date.parse(evaluation.validUntil), providerVersions, safePayload(evaluation, 16384)]));
    statements.push(this.statement(`UPDATE deal_work SET evaluated_revision=?,due_at=? WHERE product_id=? AND revision=? AND (evaluated_revision<>? OR due_at<>?)`,
      [revision, Date.parse(evaluation.validUntil), evaluation.productId, revision, revision, Date.parse(evaluation.validUntil)]));
    statements.push(...additionalStatements);
    if (job) statements.push(this.statement(`UPDATE automation_jobs SET status='SUCCEEDED',result=?,dispatch_pending=0,claim_token=NULL,lease_expires_at=0,last_error_code=NULL
      WHERE id=? AND status='RUNNING' AND claim_token=? AND lease_expires_at>? RETURNING id`,
    [JSON.stringify({ evidenceFingerprint: evaluation.evidenceFingerprint }), job.id, job.claimToken, now]));
    const results = await this.batch(statements);
    return { effect: results[effectIndex].results.length, evaluation };
  }
  async evaluate(productId: string, allowedHosts: readonly string[], now: number) { return this.commit(await this.prepare(productId, allowedHosts, now), now); }
  async latest(productId: string, now: number): Promise<DealEvaluation | null> {
    validTime(now);
    const [row] = await this.query(`SELECT evaluation.payload FROM deal_evaluations evaluation JOIN deal_work work ON work.product_id=evaluation.product_id
      WHERE evaluation.origin=? AND evaluation.product_id=? AND evaluation.valid_until>? AND evaluation.algorithm_version=?
      AND work.revision=work.evaluated_revision AND evaluation.provider_versions=(${providerVersionsSql('evaluation.product_id')}) LIMIT 1`,
    [this.origin(), productId, now, String(this.config.algorithmVersion)]);
    return row ? JSON.parse(String(row.payload)) as DealEvaluation : null;
  }
  rankingQuery(filter: DealRanking, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > this.config.limits.ranking) throw new EventJobError('DEAL_RANKING_BOUND', 'QUARANTINE');
    const values: SqlValue[] = [this.origin()]; let predicate = '', order = 'score DESC,product_id';
    if (filter.kind === 'PROVIDER') {
      if (!['accesstrade', 'tiktok'].includes(filter.provider) || (filter.platform && !['shopee','tiktok_shop','other'].includes(filter.platform))) throw new EventJobError('DEAL_RANKING_FILTER', 'QUARANTINE');
      predicate = ' AND provider=?'; values.push(filter.provider);
      if (filter.platform) { predicate += ' AND platform=?'; values.push(filter.platform); }
    } else if (filter.kind === 'RECOMMENDATION') {
      if (!['PUBLISH','REFRESH_FIRST','HOLD','REJECT'].includes(filter.recommendation)) throw new EventJobError('DEAL_RANKING_FILTER', 'QUARANTINE');
      predicate = ' AND recommendation=?'; values.push(filter.recommendation);
    } else if (filter.kind === 'PRIORITY') {
      if (!['TOP','HIGH','NORMAL','LOW','REJECT'].includes(filter.priority)) throw new EventJobError('DEAL_RANKING_FILTER', 'QUARANTINE');
      predicate = ' AND priority=?'; values.push(filter.priority);
    } else if (filter.kind === 'WEAK_CONFIDENCE') { predicate = ' AND confidence<?'; values.push(this.config.confidence.high); order = 'confidence,product_id'; }
    else if (filter.kind === 'NO_SAFE_PATH') { predicate = " AND monetization_state='NO_MONETIZATION_PATH'"; }
    else if (filter.kind === 'STALE') order = 'valid_until,product_id';
    else if (filter.kind !== 'TOP') throw new EventJobError('DEAL_RANKING_FILTER', 'QUARANTINE');
    values.push(limit);
    return { sql: `SELECT * FROM deal_evaluations WHERE origin=?${predicate} ORDER BY ${order} LIMIT ?`, values };
  }
  async rank(filter: DealRanking, limit: number, now: number) {
    validTime(now); const query = this.rankingQuery(filter, limit), candidates = await this.query(query.sql, query.values);
    const data: DealEvaluation[] = [];
    for (const row of candidates) {
      if (filter.kind === 'STALE') { if (Number(row.valid_until) <= now) data.push(JSON.parse(String(row.payload))); }
      else { const current = await this.latest(String(row.product_id), now); if (current) data.push(current); }
    }
    return { data, inspected: candidates.length, limit, partialPagePossible: true };
  }
  async expandProviderChanges() {
    const changes = await this.query("SELECT * FROM deal_provider_refresh WHERE provider IN ('accesstrade','tiktok') AND pending=1 ORDER BY provider LIMIT 2");
    for (const change of changes) {
      const products = await this.query('SELECT product_id FROM deal_provider_products WHERE provider=? AND product_id>? ORDER BY product_id LIMIT ?',
        [String(change.provider), String(change.cursor), this.config.limits.work]);
      await this.batch([this.statement(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM deal_provider_refresh WHERE provider=? AND revision=? AND cursor=? AND pending=1)
        THEN '{}' ELSE 'PROVIDER_REFRESH_CHANGED' END)`, [String(change.provider), Number(change.revision), String(change.cursor)]),
      ...products.map(product => this.statement('UPDATE deal_work SET revision=revision+1,due_at=0 WHERE product_id=?', [String(product.product_id)])),
      this.statement('UPDATE deal_provider_refresh SET cursor=?,pending=? WHERE provider=? AND revision=? AND cursor=?',
        [String(products.at(-1)?.product_id || change.cursor), products.length === this.config.limits.work ? 1 : 0, String(change.provider), Number(change.revision), String(change.cursor)])]);
    }
  }
  async materializeDue(now: number, decisionVersion = ''): Promise<number> {
    validTime(now); await this.expandProviderChanges();
    const due = await this.query('SELECT product_id,revision,due_at FROM deal_work WHERE due_at<=? ORDER BY due_at,product_id LIMIT ?', [now, this.config.limits.work]);
    let created = 0;
    for (const work of due) {
      const key = `deal:${digest(`${work.product_id}:${work.revision}:${work.due_at}:${this.config.algorithmVersion}${decisionVersion ? `:${decisionVersion}` : ''}`)}`;
      validateInput({ type: 'DEAL_EVALUATE', payload: { productId: String(work.product_id) }, idempotencyKey: key });
      const result = await this.batch([this.statement(`INSERT INTO automation_jobs(id,job_type,idempotency_key,payload_version,payload,status,created_at,available_at,expires_at,dispatch_at)
        SELECT ?,'DEAL_EVALUATE',?,1,?,'PENDING',?,?,?,? FROM deal_work WHERE product_id=? AND revision=? AND due_at=?
        ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
      [jobId(key), key, JSON.stringify({ productId: work.product_id }), new Date(now).toISOString(), now, now + EVENT_LIMITS.lifetimeMs, now,
        String(work.product_id), Number(work.revision), Number(work.due_at)]),
      this.statement(`UPDATE deal_work SET due_at=? WHERE product_id=? AND revision=? AND due_at=? AND EXISTS(SELECT 1 FROM automation_jobs WHERE id=?)`,
        [now + EVENT_LIMITS.lifetimeMs, String(work.product_id), Number(work.revision), Number(work.due_at), jobId(key)])]);
      created += result[0].results.length;
    }
    return created;
  }
}
