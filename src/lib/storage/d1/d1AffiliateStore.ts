import type { AffiliateProviderId } from '../../affiliate/types';
import { COMMISSION_STATES, MONEY_LIMITS, MoneyError, type AffiliateClick, type CommissionState,
  type EvidenceDisposition, type EvidenceOrigin, type ProviderObservation, type RevenueScope, type RevenueSnapshot } from '../../affiliate/money/types';
import { commissionEvidence, conversionEvidence, moneyCurrency, moneyHash, moneyId, moneyOrigin, moneyPlatform, moneyTime, supportedMoneyProvider } from '../../affiliate/money/validation';
import { safePayload } from './d1StorageAdapter';
import type { D1Database, D1Statement, SqlValue } from './database';

type Row = Record<string, string | number | null>;
const scopeNames = ['PROVIDER', 'PLATFORM', 'MERCHANT', 'CAMPAIGN', 'PRODUCT'] as const;
const amountColumns = ['unknown_minor', 'estimated_minor', 'pending_minor', 'approved_minor', 'rejected_minor', 'paid_minor'];
export class D1AffiliateStore {
  constructor(private readonly db: D1Database, private readonly testOnly = false) {}
  private statement(sql: string, values: SqlValue[] = []) { return this.db.prepare(sql).bind(...values); }
  private async query(sql: string, values: SqlValue[] = []): Promise<Row[]> {
    try {
      const result = await this.statement(sql, values).all<Row>();
      if (!result.success) throw new Error();
      return result.results;
    } catch { throw new MoneyError('D1_MONEY_UNAVAILABLE', 'RETRYABLE'); }
  }
  async observeProvider(observation: ProviderObservation) {
    const { health, capabilities, origin } = observation;
    supportedMoneyProvider(health.provider); moneyOrigin(origin, this.testOnly); moneyTime(health.checkedAt);
    if (typeof health.enabled !== 'boolean' || typeof health.ready !== 'boolean' || !capabilities
      || (health.ready && (!health.configured || !health.credentialsPresent || health.state !== 'READY'))
      || ['discovery','trackingLink','conversionEvidence','commissionEvidence'].some(key => typeof capabilities[key as keyof typeof capabilities] !== 'boolean')
      || !['SUB1','UNAVAILABLE'].includes(capabilities.clickReference)) throw new MoneyError('INVALID_PROVIDER_OBSERVATION', 'QUARANTINE');
    await this.query(`INSERT INTO affiliate_provider_observations(provider,payload) VALUES(?,?)
      ON CONFLICT(provider) DO UPDATE SET payload=excluded.payload
      WHERE json_extract(excluded.payload,'$.health.checkedAt')>=json_extract(affiliate_provider_observations.payload,'$.health.checkedAt')`,
    [health.provider, safePayload(observation, 4096)]);
  }
  async providers(): Promise<ProviderObservation[]> {
    const rows = await this.query('SELECT payload FROM affiliate_provider_observations WHERE provider IN (?,?) LIMIT 2', ['accesstrade','tiktok']);
    return rows.map(row => JSON.parse(String(row.payload)) as ProviderObservation).filter(row => this.testOnly || row.origin !== 'TEST_FIXTURE');
  }
  async recordClick(click: AffiliateClick, expectedProductToken: string) {
    supportedMoneyProvider(click.provider); moneyOrigin(click.origin, this.testOnly);
    moneyPlatform(click.platform);
    if ((click.platform === 'shopee' && click.provider !== 'accesstrade') || (click.provider === 'tiktok' && click.platform !== 'tiktok_shop')) throw new MoneyError('CLICK_PROVENANCE_MISMATCH', 'QUARANTINE');
    moneyId(click.id); moneyId(click.productId); moneyId(click.offerId); moneyTime(click.createdAt); moneyCurrency(click.currency);
    if (click.attribution.reference !== click.id || !['PROVIDER_SUB1','UNAVAILABLE'].includes(click.attribution.transport)
      || !['DEAL','PRODUCT'].includes(click.context) || !/^[a-f0-9]{64}$/.test(click.destinationHash)) throw new MoneyError('INVALID_CLICK', 'QUARANTINE');
    const payload = safePayload(click, 4096);
    const rows = await this.query(`INSERT INTO affiliate_clicks(id,product_id,offer_id,provider,merchant_id,campaign_id,currency,created_at,attribution_reference,attribution_transport,origin,payload,platform)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? FROM products WHERE id=? AND token=? AND status='published'
      AND EXISTS(SELECT 1 FROM json_each(products.payload,'$.offers') offer WHERE json_extract(offer.value,'$.monetization.id')=?
        AND json_extract(offer.value,'$.monetization.provider')=? AND json_extract(offer.value,'$.monetization.platform')=?
        AND json_extract(offer.value,'$.monetization.origin')=? AND json_extract(offer.value,'$.monetization.merchant.id')=?
        AND json_extract(offer.value,'$.monetization.campaign.id') IS ?)
      AND EXISTS(SELECT 1 FROM affiliate_provider_observations WHERE provider=?
        AND json_extract(payload,'$.health.ready')=1 AND json_extract(payload,'$.health.enabled')=1
        AND json_extract(payload,'$.health.state')='READY' AND json_extract(payload,'$.origin')=?
        AND json_extract(payload,'$.health.checkedAt')>=?)
      ON CONFLICT(id) DO NOTHING RETURNING id`,
    [click.id, click.productId, click.offerId, click.provider, click.merchantId, click.campaignId, click.currency, click.createdAt,
      click.attribution.reference, click.attribution.transport, click.origin, payload, click.platform, click.productId, expectedProductToken,
      click.offerId,click.provider,click.platform,click.origin,click.merchantId,click.campaignId,click.provider,click.origin,
      new Date(Date.now()-MONEY_LIMITS.providerAgeMs).toISOString()]);
    if (rows.length) return { created: true, click };
    const [existing] = await this.query('SELECT payload FROM affiliate_clicks WHERE id=? LIMIT 1', [click.id]);
    if (existing?.payload === payload) return { created: false, click };
    throw new MoneyError(existing ? 'CLICK_IDEMPOTENCY_CONFLICT' : 'PRODUCT_CHANGED_BEFORE_CLICK', 'QUARANTINE');
  }
  private async unmatched(kind: 'CONVERSION' | 'COMMISSION', provider: string, key: string, reason: string, state: 'UNMATCHED' | 'QUARANTINED'): Promise<EvidenceDisposition> {
    await this.query(`INSERT INTO affiliate_money_unmatched(id,kind,reason,state,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      [moneyHash(`${kind}:${provider}:${key}:${reason}`), kind, reason, state, new Date().toISOString()]);
    return { status: state, code: reason };
  }
  private async authority(provider: AffiliateProviderId, origin: EvidenceOrigin, capability: 'conversionEvidence' | 'commissionEvidence') {
    supportedMoneyProvider(provider); moneyOrigin(origin, this.testOnly);
    const observation = (await this.providers()).find(row => row.health.provider === provider);
    if (!observation || observation.origin !== origin || !observation.health.ready || !observation.health.enabled
      || !observation.capabilities[capability] || Date.now() - Date.parse(observation.health.checkedAt) > MONEY_LIMITS.providerAgeMs) throw new MoneyError('PROVIDER_EVIDENCE_UNAVAILABLE');
  }
  async ingestConversion(provider: AffiliateProviderId, input: unknown, origin: EvidenceOrigin): Promise<EvidenceDisposition> {
    await this.authority(provider, origin, 'conversionEvidence');
    let evidence;
    try { evidence = conversionEvidence(input); }
    catch { return this.unmatched('CONVERSION', provider, 'malformed', 'MALFORMED_PROVIDER_EVIDENCE', 'QUARANTINED'); }
    const fingerprint = moneyHash(JSON.stringify(evidence));
    const [existing] = await this.query('SELECT fingerprint FROM affiliate_conversions WHERE provider=? AND external_id=? LIMIT 1', [provider,evidence.externalId]);
    if (existing) return existing.fingerprint === fingerprint ? { status: 'DUPLICATE', code: 'CONVERSION_ALREADY_APPLIED' }
      : this.unmatched('CONVERSION',provider,evidence.eventId,'CONVERSION_CONFLICT','QUARANTINED');
    const [click] = await this.query('SELECT id,created_at,attribution_transport,origin FROM affiliate_clicks WHERE attribution_reference=? AND provider=? LIMIT 1', [evidence.attributionReference,provider]);
    if (!click || click.origin !== origin || (click.attribution_transport !== 'PROVIDER_SUB1' && origin !== 'TEST_FIXTURE')) return this.unmatched('CONVERSION',provider,evidence.eventId,'UNMATCHED_ATTRIBUTION','UNMATCHED');
    if (evidence.occurredAt < String(click.created_at) || Date.parse(evidence.occurredAt) > Date.now() + 60000) return this.unmatched('CONVERSION',provider,evidence.eventId,'INVALID_CONVERSION_TIME','QUARANTINED');
    const inserted = await this.query(`INSERT INTO affiliate_conversions(provider,external_id,event_id,click_id,occurred_at,fingerprint,origin)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING external_id`,
    [provider,evidence.externalId,evidence.eventId,String(click.id),evidence.occurredAt,fingerprint,origin]);
    if (inserted.length) return { status: 'APPLIED', code: 'CONVERSION_APPLIED' };
    const [current] = await this.query('SELECT fingerprint FROM affiliate_conversions WHERE provider=? AND external_id=? LIMIT 1', [provider,evidence.externalId]);
    return current?.fingerprint === fingerprint ? { status: 'DUPLICATE', code: 'CONVERSION_ALREADY_APPLIED' }
      : this.unmatched('CONVERSION',provider,evidence.eventId,'CONVERSION_CONFLICT','QUARANTINED');
  }
  async ingestCommission(provider: AffiliateProviderId, input: unknown, origin: EvidenceOrigin): Promise<EvidenceDisposition> {
    await this.authority(provider, origin, 'commissionEvidence');
    let evidence;
    try { evidence = commissionEvidence(input); }
    catch { return this.unmatched('COMMISSION',provider,'malformed','MALFORMED_PROVIDER_EVIDENCE','QUARANTINED'); }
    const fingerprint = moneyHash(JSON.stringify(evidence));
    const [existing] = await this.query('SELECT fingerprint FROM affiliate_commission_events WHERE provider=? AND event_id=? LIMIT 1', [provider,evidence.eventId]);
    if (existing) return existing.fingerprint === fingerprint ? { status: 'DUPLICATE', code: 'COMMISSION_ALREADY_APPLIED' }
      : this.unmatched('COMMISSION',provider,evidence.eventId,'COMMISSION_CONFLICT','QUARANTINED');
    const [conversion] = await this.query(`SELECT conversion.occurred_at,conversion.origin,click.currency FROM affiliate_conversions conversion
      JOIN affiliate_clicks click ON click.id=conversion.click_id WHERE conversion.provider=? AND conversion.external_id=? LIMIT 1`, [provider,evidence.conversionExternalId]);
    if (!conversion || conversion.origin !== origin) return this.unmatched('COMMISSION',provider,evidence.eventId,'UNMATCHED_CONVERSION','UNMATCHED');
    if (conversion.currency !== evidence.currency || evidence.occurredAt < String(conversion.occurred_at)
      || Date.parse(evidence.occurredAt) > Date.now() + 60000) return this.unmatched('COMMISSION',provider,evidence.eventId,'COMMISSION_EVIDENCE_MISMATCH','QUARANTINED');
    const [current] = await this.query('SELECT * FROM affiliate_commissions WHERE provider=? AND external_id=? LIMIT 1',[provider,evidence.externalId]);
    const allowed: Record<CommissionState, readonly CommissionState[]> = {
      UNKNOWN: COMMISSION_STATES, ESTIMATED: ['ESTIMATED','PENDING','APPROVED','REJECTED','PAID'],
      PENDING: ['PENDING','APPROVED','REJECTED','PAID'], APPROVED: ['APPROVED','REJECTED','PAID'], REJECTED: ['REJECTED'], PAID: ['PAID'],
    };
    if (evidence.revision !== Number(current?.revision || 0) + 1 || (current && (current.conversion_id !== evidence.conversionExternalId
      || current.currency !== evidence.currency || !allowed[current.state as CommissionState].includes(evidence.state)
      || (current.state === 'PAID' && current.amount_minor !== evidence.amountMinor)))) return this.unmatched('COMMISSION',provider,evidence.eventId,'INVALID_COMMISSION_REVISION_OR_TRANSITION','QUARANTINED');
    const inserted = await this.query(`INSERT INTO affiliate_commission_events(provider,event_id,external_id,conversion_id,revision,state,amount_minor,currency,occurred_at,fingerprint,origin)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE coalesce((SELECT revision FROM affiliate_commissions WHERE provider=? AND external_id=?),0)=?
      ON CONFLICT DO NOTHING RETURNING event_id`,
    [provider,evidence.eventId,evidence.externalId,evidence.conversionExternalId,evidence.revision,evidence.state,evidence.amountMinor,
      evidence.currency,evidence.occurredAt,fingerprint,origin,provider,evidence.externalId,evidence.revision-1]);
    if (inserted.length) return { status: 'APPLIED', code: 'COMMISSION_APPLIED' };
    const [applied] = await this.query('SELECT fingerprint FROM affiliate_commission_events WHERE provider=? AND event_id=? LIMIT 1',[provider,evidence.eventId]);
    return applied?.fingerprint === fingerprint ? { status: 'DUPLICATE', code: 'COMMISSION_ALREADY_APPLIED' }
      : this.unmatched('COMMISSION',provider,evidence.eventId,'COMMISSION_CONFLICT','QUARANTINED');
  }
  async snapshotStatements(): Promise<{ statements: D1Statement[]; eventsProcessed: number; lastSequence: number }> {
    const [cursor] = await this.query("SELECT last_sequence FROM affiliate_revenue_cursor WHERE id='revenue-v1' LIMIT 1");
    if (!cursor) throw new MoneyError('REVENUE_CURSOR_MISSING','RETRYABLE');
    const after = Number(cursor.last_sequence);
    const events = await this.query('SELECT * FROM affiliate_money_events WHERE sequence>? ORDER BY sequence LIMIT ?', [after,MONEY_LIMITS.snapshotEvents]);
    if (String(events.at(-1)?.effect_key || '').endsWith(':old')) events.pop();
    const lastSequence = Number(events.at(-1)?.sequence || after);
    const statements = [this.statement("SELECT json(CASE WHEN last_sequence=? THEN '{}' ELSE 'REVENUE_CURSOR_CHANGED' END) FROM affiliate_revenue_cursor WHERE id='revenue-v1'", [after])];
    const initializations: SqlValue[][] = [], updates: D1Statement[] = [];
    for (const event of events) {
      if (!this.testOnly && event.origin === 'TEST_FIXTURE') throw new MoneyError('FIXTURE_REVENUE_FORBIDDEN');
      const dimensions: [RevenueScope, string | null][] = [['PROVIDER',String(event.provider)],['PLATFORM',`${event.provider}:${event.platform}`],['MERCHANT',String(event.merchant_id)],
        ['CAMPAIGN',event.campaign_id ? `${event.provider}:${event.campaign_id}` : null],['PRODUCT',String(event.product_id)]];
      for (const [scope, scopeId] of dimensions) {
        if (!scopeId) continue;
        const amounts = COMMISSION_STATES.map(state => state === event.commission_state ? Number(event.amount_minor) : 0);
        initializations.push([String(event.origin),scope,scopeId,String(event.day),String(event.currency),Number(event.sequence)]);
        updates.push(this.statement(`UPDATE affiliate_revenue_snapshots SET clicks=clicks+?,conversions=conversions+?,
          ${amountColumns.map(column => `${column}=${column}+?`).join(',')},unknown_amounts=unknown_amounts+?,last_sequence=?
          WHERE origin=? AND scope=? AND scope_id=? AND day=? AND currency=?`,
        [Number(event.clicks),Number(event.conversions),...amounts,Number(event.unknown_amounts),Number(event.sequence),String(event.origin),scope,scopeId,String(event.day),String(event.currency)]));
      }
    }
    for (let offset = 0; offset < initializations.length; offset += 16) {
      const batch = initializations.slice(offset, offset + 16);
      statements.push(this.statement(`INSERT INTO affiliate_revenue_snapshots(origin,scope,scope_id,day,currency,last_sequence)
        VALUES ${batch.map(() => '(?,?,?,?,?,?)').join(',')} ON CONFLICT(origin,scope,scope_id,day,currency) DO NOTHING`, batch.flat()));
    }
    statements.push(...updates);
    statements.push(this.statement("UPDATE affiliate_revenue_cursor SET last_sequence=? WHERE id='revenue-v1' AND last_sequence=?", [lastSequence,after]));
    return { statements, eventsProcessed: events.length, lastSequence };
  }
  async refreshSnapshots() {
    const prepared = await this.snapshotStatements();
    try { const results = await this.db.batch(prepared.statements); if (results.some(row => !row.success)) throw new Error(); }
    catch { throw new MoneyError('REVENUE_SNAPSHOT_RETRY','RETRYABLE'); }
    return { eventsProcessed: prepared.eventsProcessed, lastSequence: prepared.lastSequence };
  }
  async revenue(input: { scope: RevenueScope; scopeId: string; currency: string; from: string; to: string }): Promise<RevenueSnapshot[]> {
    if (!scopeNames.includes(input.scope) || !input.scopeId || input.scopeId.length > 200 || !/^\d{4}-\d\d-\d\d$/.test(input.from)
      || !/^\d{4}-\d\d-\d\d$/.test(input.to) || !Number.isFinite(Date.parse(input.from)) || !Number.isFinite(Date.parse(input.to))
      || Date.parse(input.to) < Date.parse(input.from) || Date.parse(input.to)-Date.parse(input.from) >= MONEY_LIMITS.snapshotDays*86400000) throw new MoneyError('REVENUE_QUERY_BOUND');
    moneyCurrency(input.currency);
    const rows = await this.query(`SELECT * FROM affiliate_revenue_snapshots WHERE origin=? AND scope=? AND scope_id=? AND day>=? AND day<=? AND currency=? ORDER BY day LIMIT ?`,
      [this.testOnly ? 'TEST_FIXTURE' : 'AUTHENTICATED_PROVIDER_API',input.scope,input.scopeId,input.from,input.to,input.currency,MONEY_LIMITS.snapshotDays]);
    return rows.map(row => ({ day:String(row.day),scope:row.scope as RevenueScope,scopeId:String(row.scope_id),currency:String(row.currency),
      clicks:Number(row.clicks),conversions:Number(row.conversions),unknownAmounts:Number(row.unknown_amounts),asOfSequence:Number(row.last_sequence),
      amountsMinor:Object.fromEntries(COMMISSION_STATES.map((state,index) => [state,Number(row[amountColumns[index]])])) as Record<CommissionState,number> }));
  }
}
