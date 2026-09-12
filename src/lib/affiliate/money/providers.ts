import type { AffiliateProvider, AffiliateSyncInput } from '../types';
import type { D1AffiliateStore } from '../../storage/d1/d1AffiliateStore';
import { MONEY_LIMITS, MoneyError, type EvidenceOrigin, type NormalizedAffiliateOffer } from './types';
import { safeAffiliateDestination, supportedMoneyProvider } from './validation';

export async function resolveMoneyDestination(provider: AffiliateProvider, offer: NormalizedAffiliateOffer, clickReference: string, allowedHosts: readonly string[]) {
  supportedMoneyProvider(provider.id);
  if (provider.id !== offer.provider) throw new MoneyError('PROVIDER_MISMATCH');
  const health = await provider.healthCheck(), capabilities = provider.getCapabilities();
  if (!health.ready || !health.enabled || health.state !== 'READY') throw new MoneyError('PROVIDER_DISABLED');
  if (!capabilities.trackingLink || capabilities.clickReference !== 'SUB1') throw new MoneyError('ATTRIBUTION_UNAVAILABLE');
  const result = await provider.createTrackingLink({ productUrl: offer.destinationUrl, productExternalId: offer.externalId,
    tracking: { sub1: clickReference }, signal: AbortSignal.timeout(10000) });
  if (!result.ok) throw new MoneyError(result.error.reason, result.error.retryable ? 'RETRYABLE' : 'FINAL');
  const destination = safeAffiliateDestination(result.data.url, offer.destinationUrl, allowedHosts);
  if (result.provider !== provider.id || result.data.source !== 'provider_api' || !destination) throw new MoneyError('UNSAFE_RESOLVED_DESTINATION', 'QUARANTINE');
  return destination;
}
export async function syncMoneyEvidence(provider: AffiliateProvider, store: D1AffiliateStore, kind: 'CONVERSION' | 'COMMISSION', input: AffiliateSyncInput,
  origin: EvidenceOrigin = 'AUTHENTICATED_PROVIDER_API') {
  supportedMoneyProvider(provider.id);
  const capabilities = provider.getCapabilities();
  if (!capabilities[kind === 'CONVERSION' ? 'conversionEvidence' : 'commissionEvidence']) throw new MoneyError('PROVIDER_SYNC_NOT_SUPPORTED');
  if (!Number.isInteger(input.limit) || !input.limit || input.limit < 1 || input.limit > MONEY_LIMITS.evidenceBatch
    || (input.cursor?.length || 0) > 200) throw new MoneyError('EVIDENCE_BATCH_LIMIT');
  const health = await provider.healthCheck();
  if (health.provider !== provider.id || !health.ready || !health.enabled || health.state !== 'READY') throw new MoneyError('PROVIDER_DISABLED');
  await store.observeProvider({ health, capabilities, origin });
  let response;
  try { response = kind === 'CONVERSION' ? await provider.syncTransactions(input) : await provider.syncCommissions(input); }
  catch { throw new MoneyError('PROVIDER_SYNC_UNAVAILABLE', 'RETRYABLE'); }
  if (!response.ok) throw new MoneyError(response.error.reason, response.error.retryable ? 'RETRYABLE' : 'FINAL');
  if (response.provider !== provider.id || !response.data || !Array.isArray(response.data.records) || response.data.records.length > input.limit
    || (response.data.nextCursor?.length || 0) > 200) throw new MoneyError('MALFORMED_PROVIDER_RESPONSE', 'QUARANTINE');
  const outcomes = [];
  for (const record of response.data.records) outcomes.push(kind === 'CONVERSION'
    ? await store.ingestConversion(provider.id, record, origin) : await store.ingestCommission(provider.id, record, origin));
  return { outcomes, nextCursor: response.data.nextCursor ?? null };
}
