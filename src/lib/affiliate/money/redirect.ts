import { randomUUID } from 'node:crypto';
import type { AffiliateProvider } from '../types';
import type { StoredProduct } from '../../storage/domainStorage';
import type { D1AffiliateStore } from '../../storage/d1/d1AffiliateStore';
import { MoneyError, type AffiliateClick } from './types';
import { moneyHash, safeAffiliateDestination } from './validation';
import { selectMoneyRoute } from './router';
import { resolveMoneyDestination } from './providers';

export async function prepareMoneyRedirect(request: Request, product: StoredProduct, store: D1AffiliateStore,
  allowedHosts: readonly string[], providers: readonly AffiliateProvider[] = []) {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) if (key !== 'context' || url.searchParams.getAll(key).length !== 1) throw new MoneyError('REDIRECT_INPUT_REJECTED');
  const context = url.searchParams.get('context') || 'DEAL';
  if (!['DEAL','PRODUCT'].includes(context)) throw new MoneyError('REDIRECT_CONTEXT_REJECTED');
  if (request.method !== 'GET' || /bot|crawler|spider|preview|headless|lighthouse|uptime|monitor|curl|wget/i.test(request.headers.get('user-agent') || '')
    || /prefetch|prerender/i.test(`${request.headers.get('purpose') || ''} ${request.headers.get('sec-purpose') || ''}`)
    || request.headers.get('next-router-prefetch') === '1') throw new MoneyError('NON_CLICK_REQUEST');
  const decision = selectMoneyRoute(product.value, await store.providers(), allowedHosts, Date.now(), providers.map(provider => provider.id));
  if (!decision.selected) throw new MoneyError(decision.reason);
  const offer = decision.selected, id = `click-${randomUUID()}`, provider = providers.find(provider => provider.id === offer.provider);
  let target = safeAffiliateDestination(offer.destination.url, offer.destinationUrl, allowedHosts);
  let transport: AffiliateClick['attribution']['transport'] = 'UNAVAILABLE';
  if (provider?.getCapabilities().trackingLink && provider.getCapabilities().clickReference === 'SUB1') {
    target = await resolveMoneyDestination(provider, offer, id, allowedHosts); transport = 'PROVIDER_SUB1';
  }
  if (!target || (offer.destination.attributionRequired && transport === 'UNAVAILABLE')) throw new MoneyError('UNSAFE_OR_UNATTRIBUTABLE_DESTINATION');
  const finalCheck = selectMoneyRoute(product.value, await store.providers(), allowedHosts, Date.now(), providers.map(item => item.id));
  if (finalCheck.candidates.find(candidate => candidate.offerId === offer.id)?.reasons.length !== 0) throw new MoneyError('OFFER_CHANGED_BEFORE_REDIRECT');
  const click: AffiliateClick = { id,productId:product.value.id,offerId:offer.id,provider:offer.provider,platform:offer.platform,merchantId:offer.merchant.id,
    campaignId:offer.campaign?.id || null,currency:offer.currency,createdAt:new Date().toISOString(),attribution:{reference:id,transport},
    context:context as AffiliateClick['context'],destinationHash:moneyHash(target),origin:offer.origin };
  await store.recordClick(click, product.version.token);
  return { target, click, decision };
}
