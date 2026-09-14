import { EventJobError, validTime } from '../../platform/cloudflareContracts';
import { moneyId, supportedMoneyProvider } from '../../affiliate/money/validation';
import { LIFECYCLE_CONFIG, lifecycleId, valueWindow } from '../../content/lifecycle/config';
import { buildContentValue } from '../../content/lifecycle/value';
import type { ContentAttributionSource, ContentValueSnapshot } from '../../content/lifecycle/types';
import { safePayload } from './d1StorageAdapter';
import type { D1Database, D1Statement, SqlValue } from './database';

type Row = Record<string, string | number | null>;
export class D1ContentValueStore {
  readonly origin: 'TEST_FIXTURE' | 'AUTHENTICATED_PROVIDER_API';
  constructor(private readonly db: D1Database, testOnly = false) {
    if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') throw new EventJobError('CONTENT_VALUE_D1_REQUIRED', 'QUARANTINE');
    this.origin = testOnly ? 'TEST_FIXTURE' : 'AUTHENTICATED_PROVIDER_API';
  }
  private statement(sql: string, values: SqlValue[] = []) { return this.db.prepare(sql).bind(...values); }
  private async query(sql: string, values: SqlValue[] = []): Promise<Row[]> {
    try { const result = await this.statement(sql, values).all<Row>(); if (!result.success) throw new Error(); return result.results; }
    catch { throw new EventJobError('D1_CONTENT_VALUE_UNAVAILABLE', 'RETRYABLE'); }
  }
  private async batch(statements: D1Statement[]) {
    try { const results = await this.db.batch<Row>(statements); if (results.some(result => !result.success)) throw new Error(); return results; }
    catch { throw new EventJobError('CONTENT_ATTRIBUTION_ATOMIC_CONFLICT', 'RETRYABLE'); }
  }
  async reconcile(source: ContentAttributionSource, now: number) {
    validTime(now);
    let eventKey: string, clickId: string, revision = 1, sourceEventId: string;
    let conversion: Row | undefined, commission: Row | undefined;
    if (source.kind === 'CLICK') {
      clickId = moneyId(source.clickId); eventKey = `click:${clickId}`; sourceEventId = eventKey;
    } else {
      supportedMoneyProvider(source.provider); moneyId(source.externalId);
      if (!['CONVERSION', 'COMMISSION'].includes(source.kind)) throw new EventJobError('CONTENT_ATTRIBUTION_KIND_INVALID', 'QUARANTINE');
      eventKey = `${source.kind === 'CONVERSION' ? 'conversion' : 'commission'}:${source.provider}:${source.externalId}`;
      if (source.kind === 'COMMISSION') {
        [commission] = await this.query(`SELECT current.*,event.occurred_at,event.origin FROM affiliate_commissions current
          JOIN affiliate_commission_events event ON event.provider=current.provider AND event.event_id=current.event_id
          WHERE current.provider=? AND current.external_id=? LIMIT 1`, [source.provider, source.externalId]);
        if (!commission || commission.origin !== this.origin) return { status: 'UNATTRIBUTED', effect: 0 };
        revision = Number(commission.revision); sourceEventId = `${eventKey}:${revision}:new`;
      } else sourceEventId = eventKey;
      [conversion] = await this.query('SELECT * FROM affiliate_conversions WHERE provider=? AND external_id=? LIMIT 1',
        [source.provider, commission ? String(commission.conversion_id) : source.externalId]);
      if (!conversion || conversion.origin !== this.origin) return { status: 'UNATTRIBUTED', effect: 0 };
      clickId = String(conversion.click_id);
    }
    const [click] = await this.query('SELECT * FROM affiliate_clicks WHERE id=? AND origin=? LIMIT 1', [clickId, this.origin]);
    const [inbox] = await this.query('SELECT * FROM content_attribution_inbox WHERE event_key=? AND origin=? LIMIT 1', [eventKey, this.origin]);
    if (!click || !inbox) return { status: 'UNATTRIBUTED', effect: 0 };
    const contentId = lifecycleId(inbox.content_id);
    const [content] = await this.query('SELECT product_id,entity FROM content_lifecycle_sources WHERE origin=? AND content_id=? LIMIT 1', [this.origin, contentId]);
    const clickedAt = Date.parse(String(click.created_at));
    const occurredAt = commission ? Date.parse(String(commission.occurred_at)) : conversion ? Date.parse(String(conversion.occurred_at)) : clickedAt;
    const productMatches = content?.product_id === click.product_id && JSON.parse(String(click.payload)).contentEntityId === contentId;
    if (!productMatches || (conversion && conversion.provider !== click.provider) || !Number.isSafeInteger(occurredAt)
      || clickedAt > now || occurredAt > now || occurredAt < clickedAt
      || (commission && occurredAt < Date.parse(String(conversion?.occurred_at)))
      || Date.parse(JSON.parse(String(content.entity)).createdAt) > clickedAt)
      throw new EventJobError('CONTENT_ATTRIBUTION_CHAIN_INVALID', 'QUARANTINE');
    const [businessEvent] = await this.query('SELECT product_id,origin FROM affiliate_money_events WHERE effect_key=? LIMIT 1', [sourceEventId]);
    if (businessEvent?.product_id !== click.product_id || businessEvent.origin !== this.origin) throw new EventJobError('CONTENT_BUSINESS_EVENT_MISSING', 'QUARANTINE');
    const day = Math.floor((conversion ? Date.parse(String(conversion.occurred_at)) : clickedAt) / LIFECYCLE_CONFIG.dayMs) * LIFECYCLE_CONFIG.dayMs;
    const statements: D1Statement[] = [];
    if (commission) statements.push(this.statement(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM affiliate_commissions WHERE provider=? AND external_id=? AND revision=?)
      THEN '{}' ELSE 'COMMISSION_REVISION_CHANGED' END)`, [String(commission.provider), String(commission.external_id), revision]));
    statements.push(this.statement(`INSERT INTO content_attribution(event_key,origin,content_id,click_id,provider,platform,product_id,offer_id,source_event_id,
      revision,day,currency,clicks,conversions,approved_minor,paid_minor,approved_count,paid_count,commission_events,occurred_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET revision=excluded.revision,source_event_id=excluded.source_event_id,
      approved_minor=excluded.approved_minor,paid_minor=excluded.paid_minor,approved_count=excluded.approved_count,paid_count=excluded.paid_count,occurred_at=excluded.occurred_at
      WHERE content_attribution.revision<excluded.revision AND content_attribution.origin=excluded.origin AND content_attribution.content_id=excluded.content_id
      AND content_attribution.click_id=excluded.click_id AND content_attribution.currency=excluded.currency RETURNING event_key`,
    [eventKey, this.origin, contentId, clickId, String(click.provider), String(click.platform), String(click.product_id), String(click.offer_id), sourceEventId,
      revision, day, String(commission?.currency ?? click.currency), Number(source.kind === 'CLICK'), Number(source.kind === 'CONVERSION'),
      commission?.state === 'APPROVED' ? Number(commission.amount_minor) : 0, commission?.state === 'PAID' ? Number(commission.amount_minor) : 0,
      Number(commission?.state === 'APPROVED'), Number(commission?.state === 'PAID'), Number(source.kind === 'COMMISSION'), occurredAt]));
    statements.push(this.statement("UPDATE content_attribution_inbox SET pending=0,disposition='DIRECTLY_ATTRIBUTED' WHERE event_key=? AND origin=?", [eventKey, this.origin]));
    const results = await this.batch(statements), effect = results.at(-2)!.results.length;
    return { status: effect ? 'DIRECTLY_ATTRIBUTED' : 'DUPLICATE', effect };
  }
  async reconcileDue(now: number, limit: number = LIFECYCLE_CONFIG.batch): Promise<number> {
    this.bound(limit); validTime(now);
    const rows = await this.query('SELECT * FROM content_attribution_inbox WHERE origin=? AND pending=1 ORDER BY sequence LIMIT ?', [this.origin, limit]);
    for (const row of rows) {
      const source: ContentAttributionSource = row.kind === 'CLICK' ? { kind: 'CLICK', clickId: String(row.click_id) }
        : { kind: row.kind as 'CONVERSION' | 'COMMISSION', provider: row.provider as 'accesstrade' | 'tiktok', externalId: String(row.external_id) };
      try {
        const result = await this.reconcile(source, now);
        if (result.status === 'UNATTRIBUTED') await this.query("UPDATE content_attribution_inbox SET pending=0,disposition='UNATTRIBUTED' WHERE event_key=? AND origin=?", [String(row.event_key), this.origin]);
      }
      catch (error) {
        if (!(error instanceof EventJobError) || error.classification !== 'QUARANTINE') throw error;
        await this.query("UPDATE content_attribution_inbox SET pending=0,disposition='UNKNOWN' WHERE event_key=? AND origin=?", [String(row.event_key), this.origin]);
      }
    }
    return rows.length;
  }
  async snapshot(contentEntityId: string, now: number, start = Math.max(0, Math.floor(now / LIFECYCLE_CONFIG.dayMs) - LIFECYCLE_CONFIG.valueDays + 1) * LIFECYCLE_CONFIG.dayMs,
    end = now, persist = true): Promise<ContentValueSnapshot> {
    lifecycleId(contentEntityId); valueWindow(start, end, now);
    if (persist && end !== now) throw new EventJobError('CONTENT_VALUE_HISTORICAL_SNAPSHOT_READ_ONLY', 'QUARANTINE');
    if (end !== now && end % LIFECYCLE_CONFIG.dayMs) throw new EventJobError('CONTENT_VALUE_HISTORICAL_WINDOW_INVALID', 'QUARANTINE');
    const [content] = await this.query(`SELECT source.content_id,work.revision FROM content_lifecycle_sources source
      JOIN content_lifecycle_work work ON work.origin=source.origin AND work.content_id=source.content_id
      WHERE source.origin=? AND source.content_id=? LIMIT 1`, [this.origin, contentEntityId]);
    if (!content) throw new EventJobError('CONTENT_VALUE_ENTITY_MISSING', 'FINAL');
    const rows = await this.query(`SELECT * FROM content_value_daily WHERE origin=? AND content_id=? AND day>=? AND day<? ORDER BY day,currency LIMIT ?`,
      [this.origin, contentEntityId, start, end, LIFECYCLE_CONFIG.valueDays * LIFECYCLE_CONFIG.currencies]);
    if (rows.some(row => Number(row.last_event_at) > end)) throw new EventJobError('CONTENT_VALUE_WINDOW_EVIDENCE_MISMATCH', 'QUARANTINE');
    const snapshot = buildContentValue(contentEntityId, this.origin, start, end, now, rows.map(row => ({ day: Number(row.day), currency: String(row.currency),
      clicks: Number(row.clicks), conversions: Number(row.conversions), approvedMinor: Number(row.approved_minor), paidMinor: Number(row.paid_minor),
      approvedCount: Number(row.approved_count), paidCount: Number(row.paid_count), commissionEvents: Number(row.commission_events),
      sourceEvents: Number(row.source_events), lastSequence: Number(row.last_sequence) })));
    if (persist) await this.batch([this.statement(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM content_lifecycle_work WHERE origin=? AND content_id=? AND revision=?)
      THEN '{}' ELSE 'CONTENT_VALUE_EVIDENCE_CHANGED' END)`, [this.origin, contentEntityId, Number(content.revision)]), this.snapshotStatement(snapshot)]);
    return snapshot;
  }
  snapshotStatement(snapshot: ContentValueSnapshot) {
    if (snapshot.origin !== this.origin) throw new EventJobError('CONTENT_VALUE_ORIGIN_MISMATCH', 'QUARANTINE');
    return this.statement(`INSERT INTO content_value_snapshots(origin,content_id,fingerprint,business_value,conversions,revenue_evidence,confidence,generated_at,payload)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(origin,content_id) DO UPDATE SET fingerprint=excluded.fingerprint,business_value=excluded.business_value,
      conversions=excluded.conversions,revenue_evidence=excluded.revenue_evidence,confidence=excluded.confidence,generated_at=excluded.generated_at,payload=excluded.payload
      WHERE content_value_snapshots.fingerprint<>excluded.fingerprint AND content_value_snapshots.generated_at<=excluded.generated_at`,
    [this.origin, snapshot.contentEntityId, snapshot.evidenceFingerprint, snapshot.businessValue, snapshot.attributedConversions, Number(snapshot.revenueEvidence !== null),
      snapshot.valueConfidence, snapshot.generatedAt, safePayload(snapshot, 8192)]);
  }
  private bound(limit: number) { if (!Number.isInteger(limit) || limit < 1 || limit > LIFECYCLE_CONFIG.read) throw new EventJobError('CONTENT_VALUE_QUERY_BOUND', 'QUARANTINE'); }
  rankingQuery(kind: 'TOP' | 'CONVERSIONS' | 'REVENUE' | 'UNKNOWN' | 'NEW', limit: number) {
    this.bound(limit);
    const filter = { TOP: '', CONVERSIONS: ' AND conversions>0', REVENUE: ' AND revenue_evidence=1', UNKNOWN: " AND business_value='UNKNOWN'", NEW: " AND business_value='INSUFFICIENT_EVIDENCE'" };
    if (!Object.hasOwn(filter, kind)) throw new EventJobError('CONTENT_VALUE_QUERY_FILTER', 'QUARANTINE');
    return { sql: `SELECT payload FROM content_value_snapshots WHERE origin=?${filter[kind]} ORDER BY conversions DESC,content_id LIMIT ?`, values: [this.origin, limit] as SqlValue[] };
  }
  async rank(kind: Parameters<D1ContentValueStore['rankingQuery']>[0], limit: number) {
    const query = this.rankingQuery(kind, limit), rows = await this.query(query.sql, query.values);
    return { boundedSample: true, journalOnly: true, records: rows.map(row => JSON.parse(String(row.payload)) as ContentValueSnapshot) };
  }
}
