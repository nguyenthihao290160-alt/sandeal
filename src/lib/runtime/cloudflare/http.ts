import { validateBasicAuthHeader } from '../../basicAuth';
import { validateExternalUrl } from '../../product-intelligence/urlValidation';
import { cloudflareContext, dependencyStatus, CloudflareRequestError, type CloudflareEnvironment } from './context';
import { isCloudflarePublic, publicDetail, publicPage } from './publicCatalogue';
import type { SettingsKey } from '../../storage/settingsStore';
import { D1AffiliateStore } from '../../storage/d1/d1AffiliateStore';
import { prepareMoneyRedirect } from '../../affiliate/money/redirect';
import { MoneyError } from '../../affiliate/money/types';

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self' data:",
};
function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { ...securityHeaders, 'Cache-Control': 'no-store' } }); }
function protect(request: Request, env: CloudflareEnvironment) {
  if (!env.BASIC_AUTH_USER || !env.BASIC_AUTH_PASSWORD) throw new CloudflareRequestError('ADMIN_NOT_CONFIGURED');
  if (!validateBasicAuthHeader(request.headers.get('authorization'), env.BASIC_AUTH_USER, env.BASIC_AUTH_PASSWORD)) throw new CloudflareRequestError('UNAUTHORIZED', 401);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.headers.get('origin') !== new URL(request.url).origin) throw new CloudflareRequestError('ORIGIN_REJECTED', 403);
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new CloudflareRequestError('JSON_REQUIRED', 415);
  }
}
export async function boundedJson(request: Request, maximum = 65536): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new CloudflareRequestError('BODY_TOO_LARGE', 413);
  if (!request.body) throw new CloudflareRequestError('JSON_REQUIRED', 400);
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    // Terminated by EOF or the byte limit. This is bounded request parsing, not background polling.
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new CloudflareRequestError('BODY_TOO_LARGE', 413); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new CloudflareRequestError('INVALID_JSON', 400); }
}
async function asset(request: Request, env: CloudflareEnvironment, pathname?: string) {
  if (!env.ASSETS) throw new CloudflareRequestError('ASSET_BINDING_UNAVAILABLE');
  const url = new URL(request.url); if (pathname) { url.pathname = pathname; url.search = ''; }
  const response = await env.ASSETS.fetch(new Request(url, { method: request.method, headers: request.headers }));
  const secured = new Response(response.body, response);
  for (const [key, value] of Object.entries(securityHeaders)) secured.headers.set(key, value);
  if (pathname) secured.headers.set('Cache-Control', 'no-store');
  return secured;
}
export async function cloudflareFetch(request: Request, env: CloudflareEnvironment, options: { moneyTestOnly?: boolean } = {}): Promise<Response> {
  try {
    const url = new URL(request.url), pathname = url.pathname.replace(/\/$/, '') || '/';
    if (request.url.length > 8192 || /%2f|%5c|%00/i.test(url.pathname)) throw new CloudflareRequestError('INVALID_URL', 400);
    if (pathname === '/api/health/live' && ['GET', 'HEAD'].includes(request.method)) return json({ ok: true, status: 'LIVE' });
    const reserved = ['/api', '/go', '/dashboard'].some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
    const productShell = /^\/deals\/[a-z0-9-]{1,160}$/i.test(pathname);
    if (!reserved && !productShell) {
      if (!['GET', 'HEAD'].includes(request.method)) throw new CloudflareRequestError('METHOD_NOT_ALLOWED', 405);
      return await asset(request, env);
    }
    const context = cloudflareContext(env);
    return await context.run(async () => {
      if (pathname.startsWith('/api/admin/')) {
        protect(request, env);
        const settings = pathname.match(/^\/api\/admin\/settings\/(automation|scheduler)$/);
        if (settings && ['GET', 'PUT'].includes(request.method)) {
          const key = settings[1] as SettingsKey;
          if (request.method === 'PUT') await context.settings.write(key, await boundedJson(request));
          return json({ ok: true, data: await context.settings.read(key) });
        }
        const publication = pathname.match(/^\/api\/admin\/products\/([a-z0-9-]{1,160})\/publication$/i);
        if (publication && request.method === 'GET') {
          const record = await context.domain.getProduct(publication[1]);
          if (!record) throw new CloudflareRequestError('NOT_FOUND', 404);
          return json({ ok: true, data: { id: record.value.id, status: record.value.status, public: isCloudflarePublic(record.value), version: record.version } });
        }
        if (pathname === '/api/admin/affiliate/revenue' && request.method === 'GET' && env.SANDEAL_MONEY_ENGINE_ENABLED === 'true') {
          const allowed = ['scope','scopeId','currency','from','to'];
          for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new CloudflareRequestError('INVALID_REVENUE_QUERY',400);
          const data = await new D1AffiliateStore(context.db).revenue({ scope: url.searchParams.get('scope') as 'PROVIDER' | 'PLATFORM' | 'MERCHANT' | 'CAMPAIGN' | 'PRODUCT',
            scopeId:url.searchParams.get('scopeId') || '',currency:url.searchParams.get('currency') || '',from:url.searchParams.get('from') || '',to:url.searchParams.get('to') || '' });
          return json({ ok:true,data,unit:'MINOR_CURRENCY_UNITS',source:'VERIFIED_LEDGER',liveProviderSync:'UNAVAILABLE' });
        }
        throw new CloudflareRequestError('METHOD_OR_ROUTE_UNSUPPORTED', 405);
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw new CloudflareRequestError('METHOD_NOT_ALLOWED', 405);
      if (['/api/health', '/api/health/ready'].includes(pathname)) {
        const readiness = await dependencyStatus(env); return json(readiness, readiness.ok ? 200 : 503);
      }
      if (pathname === '/api/public/affiliate/health') {
        const state = await context.provider.healthCheck();
        return json({ ok: true, data: { shopee: { state: state.state, enabled: state.enabled, ready: state.ready },
          accesstrade: { state: 'DISABLED_LOCAL_RUNTIME' }, tiktok: { state: 'DISABLED_LOCAL_RUNTIME' } } });
      }
      if (pathname === '/api/public/products') return json({ ok: true, data: await publicPage(context.domain, url.searchParams) });
      const detail = pathname.match(/^\/api\/public\/products\/([^/]+)(\/offers)?$/);
      if (detail) { const data = await publicDetail(context.domain, detail[1]); return json({ ok: true, data: detail[2] ? data.offers : data }); }
      const redirect = pathname.match(/^\/go\/([a-z0-9-]{1,160})$/i);
      if (redirect) {
        const record = await context.domain.getProduct(redirect[1]);
        if (!record || !isCloudflarePublic(record.value)) throw new CloudflareRequestError('NOT_FOUND', 404);
        if (env.SANDEAL_MONEY_ENGINE_ENABLED === 'true') {
          const hosts = (env.AFFILIATE_REDIRECT_HOSTS || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
          const redirect = await prepareMoneyRedirect(request, record, new D1AffiliateStore(context.db, options.moneyTestOnly === true), hosts);
          return new Response(null, { status:302,headers:{ ...securityHeaders,'Cache-Control':'no-store',Location:redirect.target } });
        }
        const target = validateExternalUrl(record.value.affiliateUrl);
        const allowed = new Set((env.AFFILIATE_REDIRECT_HOSTS || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean));
        if (!target.safe || !target.normalizedUrl) throw new CloudflareRequestError('AFFILIATE_DESTINATION_REJECTED', 422);
        const destination = new URL(target.normalizedUrl);
        if (destination.protocol !== 'https:' || !allowed.has(destination.hostname) || record.value.affiliateUrlStatus !== 'verified') throw new CloudflareRequestError('AFFILIATE_DESTINATION_REJECTED', 422);
        return new Response(null, { status: 302, headers: { ...securityHeaders, 'Cache-Control': 'no-store', Location: destination.toString() } });
      }
      if (reserved) {
        // Legacy admin/automation routes are never silently routed into the static site.
        throw new CloudflareRequestError('LEGACY_ONLY_ROUTE', 501);
      }
      if (productShell) {
        await publicDetail(context.domain, pathname.slice('/deals/'.length));
        return asset(request, env, '/product/');
      }
      return asset(request, env);
    });
  } catch (error) {
    if (error instanceof MoneyError) return json({ok:false,code:error.code},error.classification === 'RETRYABLE' ? 503 : 422);
    if (error instanceof CloudflareRequestError) return json({ ok: false, code: error.code }, error.status);
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (['SETTINGS_SECRET_FORBIDDEN', 'SETTINGS_VALUE_INVALID'].includes(code)) return json({ ok: false, code }, 400);
    // No driver exception text, SQL, parameters, bindings or secret configuration in responses/logs.
    return json({ ok: false, code: 'CLOUDFLARE_DEPENDENCY_UNAVAILABLE' }, 503);
  }
}
