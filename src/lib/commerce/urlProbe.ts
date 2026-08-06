import { fetchExternalSafely } from '@/lib/product-intelligence/urlSafety';

export const COMMERCE_URL_PROBE_VERSION = 'commerce-url-probe-v1';

export type CommerceUrlProbeClassification =
  | 'HEALTHY'
  | 'AFFILIATE_LINK_NOT_FOUND'
  | 'AFFILIATE_LINK_REJECTED'
  | 'MERCHANT_NOT_FOUND'
  | 'MERCHANT_UNREACHABLE'
  | 'RATE_LIMITED'
  | 'PROVIDER_SERVER_ERROR'
  | 'DNS_FAILURE'
  | 'TLS_FAILURE'
  | 'CONNECT_TIMEOUT'
  | 'REQUEST_TIMEOUT'
  | 'CONNECTION_RESET'
  | 'REDIRECT_LOOP'
  | 'UNSAFE_URL'
  | 'INVALID_URL';

export type CommerceUrlProbeRole = 'AFFILIATE' | 'MERCHANT';

export interface SanitizedUrlShape {
  scheme?: 'http' | 'https';
  domain?: string;
  pathSegmentCount: number;
  queryParameterNames: string[];
}

export interface CommerceUrlProbeDiagnostics {
  probeVersion: string;
  requested: SanitizedUrlShape;
  final?: SanitizedUrlShape;
  networkErrorCode?: string;
  responseContentType?: string;
}

export interface CommerceUrlProbeResult {
  classification: CommerceUrlProbeClassification;
  httpStatus?: number;
  /** Query values and high-entropy path segments are redacted for persistence/UI. */
  normalizedFinalUrl?: string;
  affiliateGatewayDomain?: string;
  merchantDomain?: string;
  redirectCount: number;
  elapsedTimeMs: number;
  retryable: boolean;
  reasonCode: string;
  checkedAt: string;
  retryAfter?: string;
  diagnostics: CommerceUrlProbeDiagnostics;
}

export interface CommerceUrlProbeLogEvent {
  event: 'commerce_url_probe_completed';
  correlationId?: string;
  operationId?: string;
  jobId?: string;
  role: CommerceUrlProbeRole;
  classification: CommerceUrlProbeClassification;
  reasonCode: string;
  affiliateGatewayDomain?: string;
  merchantDomain?: string;
  httpStatus?: number;
  redirectCount: number;
  elapsedTimeMs: number;
  retryable: boolean;
  checkedAt: string;
  retryAfter?: string;
  queryParameterNames: string[];
}

export interface CommerceUrlProbeOptions {
  role: CommerceUrlProbeRole;
  timeoutMs?: number;
  maxRedirects?: number;
  maximumBodyBytes?: number;
  fetchImpl?: typeof fetch;
  resolveDns?: boolean;
  signal?: AbortSignal;
  now?: () => number;
  correlationId?: string;
  operationId?: string;
  jobId?: string;
  logger?: (event: CommerceUrlProbeLogEvent) => void;
}

const ACCESS_TRADE_GATEWAYS = new Set([
  'go.isclix.com',
  'pub.accesstrade.vn',
  'click.accesstrade.vn',
  'accesstrade.vn',
]);

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
]);

const CONNECT_TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA']);

function domainOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return new URL(value).hostname.toLowerCase().replace(/\.$/, ''); }
  catch { return undefined; }
}

function isAffiliateGateway(domain: string | undefined): boolean {
  if (!domain) return false;
  return [...ACCESS_TRADE_GATEWAYS].some(gateway => domain === gateway || domain.endsWith(`.${gateway}`));
}

function highEntropySegment(segment: string): boolean {
  return segment.length > 48
    || /^[a-f0-9]{28,}$/i.test(segment)
    || /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?$/.test(segment);
}

function sanitizedUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = '';
    url.username = '';
    url.password = '';
    const names = [...new Set([...url.searchParams.keys()].map(key => key.slice(0, 80)))].sort();
    url.search = '';
    for (const name of names) url.searchParams.append(name, '');
    url.pathname = `/${url.pathname.split('/').filter(Boolean).map(segment => highEntropySegment(segment) ? ':redacted' : segment.slice(0, 120)).join('/')}`;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function sanitizedUrlShape(value: string | undefined): SanitizedUrlShape {
  if (!value) return { pathSegmentCount: 0, queryParameterNames: [] };
  try {
    const url = new URL(value);
    return {
      scheme: url.protocol === 'http:' ? 'http' : url.protocol === 'https:' ? 'https' : undefined,
      domain: url.hostname.toLowerCase().replace(/\.$/, ''),
      pathSegmentCount: url.pathname.split('/').filter(Boolean).length,
      queryParameterNames: [...new Set([...url.searchParams.keys()].map(key => key.slice(0, 80)))].sort().slice(0, 40),
    };
  } catch {
    return { pathSegmentCount: 0, queryParameterNames: [] };
  }
}

function networkCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = (error as { code?: unknown }).code;
  const cause = (error as { cause?: unknown }).cause;
  const nested = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
  const code = typeof direct === 'string' ? direct : typeof nested === 'string' ? nested : undefined;
  return code?.trim().toUpperCase().slice(0, 80);
}

function retryAfterValue(response: Response, nowMs: number): string | undefined {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw) return undefined;
  const parsed = /^\d+$/.test(raw) ? nowMs + Number(raw) * 1_000 : Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed <= nowMs || parsed > nowMs + 7 * 24 * 60 * 60_000) return undefined;
  return new Date(parsed).toISOString();
}

function classificationForResponse(
  response: Response,
  role: CommerceUrlProbeRole,
  gatewayDomain: string | undefined,
  finalDomain: string | undefined,
  redirectCount: number,
): Pick<CommerceUrlProbeResult, 'classification' | 'retryable' | 'reasonCode'> {
  const status = response.status;
  // Once the exact gateway URL has redirected to a non-gateway merchant, the
  // affiliate deep link itself is accepted. Merchant status is classified by
  // the independent merchant probe so a downstream 404/timeout never poisons
  // the affiliate-gateway circuit.
  if (role === 'AFFILIATE' && redirectCount > 0 && gatewayDomain && finalDomain
    && gatewayDomain !== finalDomain && !isAffiliateGateway(finalDomain)) {
    return { classification: 'HEALTHY', retryable: false, reasonCode: 'AFFILIATE_REDIRECT_ACCEPTED' };
  }
  if (status === 404 || status === 410) {
    return role === 'AFFILIATE'
      ? { classification: 'AFFILIATE_LINK_NOT_FOUND', retryable: false, reasonCode: `AFFILIATE_HTTP_${status}` }
      : { classification: 'MERCHANT_NOT_FOUND', retryable: false, reasonCode: `MERCHANT_HTTP_${status}` };
  }
  if (status === 401 || status === 403) {
    return role === 'AFFILIATE'
      ? { classification: 'AFFILIATE_LINK_REJECTED', retryable: false, reasonCode: `AFFILIATE_HTTP_${status}` }
      : { classification: 'MERCHANT_UNREACHABLE', retryable: true, reasonCode: `MERCHANT_HTTP_${status}` };
  }
  if (status === 429) return { classification: 'RATE_LIMITED', retryable: true, reasonCode: 'HTTP_429' };
  if (status >= 500) return { classification: 'PROVIDER_SERVER_ERROR', retryable: true, reasonCode: `HTTP_${status}` };
  if (status >= 300 && status < 400) {
    return role === 'AFFILIATE'
      ? { classification: 'AFFILIATE_LINK_REJECTED', retryable: false, reasonCode: 'AFFILIATE_REDIRECT_TARGET_MISSING' }
      : { classification: 'MERCHANT_UNREACHABLE', retryable: true, reasonCode: 'MERCHANT_REDIRECT_TARGET_MISSING' };
  }
  if (status < 200 || status >= 400) {
    return role === 'AFFILIATE'
      ? { classification: 'AFFILIATE_LINK_REJECTED', retryable: false, reasonCode: `AFFILIATE_HTTP_${status}` }
      : { classification: 'MERCHANT_UNREACHABLE', retryable: false, reasonCode: `MERCHANT_HTTP_${status}` };
  }
  if (role === 'AFFILIATE' && isAffiliateGateway(gatewayDomain) && (!finalDomain || isAffiliateGateway(finalDomain))) {
    return { classification: 'AFFILIATE_LINK_REJECTED', retryable: false, reasonCode: 'AFFILIATE_GATEWAY_DID_NOT_RESOLVE' };
  }
  return { classification: 'HEALTHY', retryable: false, reasonCode: 'HTTP_REACHABLE' };
}

function classificationForError(error: unknown): Pick<CommerceUrlProbeResult, 'classification' | 'retryable' | 'reasonCode'> {
  const code = networkCode(error);
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message.toUpperCase() : String(error || '').toUpperCase();
  if (message.includes('PRIVATE_NETWORK') || message.includes('UNSAFE_PROTOCOL') || message.includes('CREDENTIALS_NOT_ALLOWED') || message.includes('UNSAFE_PORT')) {
    return { classification: 'UNSAFE_URL', retryable: false, reasonCode: message.split(':')[0].slice(0, 80) || 'UNSAFE_URL' };
  }
  if (message.includes('INVALID_URL')) return { classification: 'INVALID_URL', retryable: false, reasonCode: 'INVALID_URL' };
  if (message.includes('REDIRECT_LOOP') || message.includes('TOO_MANY_REDIRECTS')) {
    return { classification: 'REDIRECT_LOOP', retryable: false, reasonCode: message.includes('REDIRECT_LOOP') ? 'REDIRECT_LOOP' : 'REDIRECT_LIMIT_EXCEEDED' };
  }
  if (code && TLS_CODES.has(code) || /TLS|CERTIFICATE|SSL/.test(message)) {
    return { classification: 'TLS_FAILURE', retryable: true, reasonCode: code || 'TLS_FAILURE' };
  }
  if (code && DNS_CODES.has(code) || /GETADDRINFO|DNS/.test(message)) {
    return { classification: 'DNS_FAILURE', retryable: true, reasonCode: code || 'DNS_FAILURE' };
  }
  if (code && RESET_CODES.has(code) || /ECONNRESET|CONNECTION RESET|SOCKET HANG UP/.test(message)) {
    return { classification: 'CONNECTION_RESET', retryable: true, reasonCode: code || 'CONNECTION_RESET' };
  }
  if (code && CONNECT_TIMEOUT_CODES.has(code) || /CONNECT TIMEOUT/.test(message)) {
    return { classification: 'CONNECT_TIMEOUT', retryable: true, reasonCode: code || 'CONNECT_TIMEOUT' };
  }
  if (name === 'TimeoutError' || name === 'AbortError' || /TIMED OUT|TIMEOUT|ABORT/.test(message)) {
    return { classification: 'REQUEST_TIMEOUT', retryable: true, reasonCode: 'REQUEST_TIMEOUT' };
  }
  return { classification: 'MERCHANT_UNREACHABLE', retryable: true, reasonCode: code || 'NETWORK_FAILURE' };
}

function logResult(result: CommerceUrlProbeResult, role: CommerceUrlProbeRole, options: CommerceUrlProbeOptions): void {
  const event: CommerceUrlProbeLogEvent = {
    event: 'commerce_url_probe_completed',
    correlationId: options.correlationId?.slice(0, 160),
    operationId: options.operationId?.slice(0, 160),
    jobId: options.jobId?.slice(0, 160),
    role,
    classification: result.classification,
    reasonCode: result.reasonCode,
    affiliateGatewayDomain: result.affiliateGatewayDomain,
    merchantDomain: result.merchantDomain,
    httpStatus: result.httpStatus,
    redirectCount: result.redirectCount,
    elapsedTimeMs: result.elapsedTimeMs,
    retryable: result.retryable,
    checkedAt: result.checkedAt,
    retryAfter: result.retryAfter,
    queryParameterNames: result.diagnostics.requested.queryParameterNames,
  };
  if (options.logger) options.logger(event);
  else console.info(JSON.stringify(event));
}

const INITIAL_FETCH = globalThis.fetch;

export async function probeCommerceUrl(value: string, options: CommerceUrlProbeOptions): Promise<CommerceUrlProbeResult> {
  const now = options.now || Date.now;
  const startedAt = now();
  const checkedAt = new Date(startedAt).toISOString();
  const requestedShape = sanitizedUrlShape(value);
  const gatewayDomain = options.role === 'AFFILIATE' ? requestedShape.domain : undefined;
  const fetchImpl = options.fetchImpl || (globalThis.fetch !== INITIAL_FETCH ? globalThis.fetch : undefined);
  const resolveDns = options.resolveDns !== undefined ? options.resolveDns : (fetchImpl ? false : true);
  try {
    const fetched = await fetchExternalSafely(value, {
      method: 'GET',
      timeoutMs: Math.max(750, Math.min(options.timeoutMs || 8_000, 15_000)),
      maxBytes: Math.max(1_024, Math.min(options.maximumBodyBytes || 16_384, 64 * 1_024)),
      maxRedirects: Math.max(0, Math.min(options.maxRedirects ?? 4, 5)),
      allowPartialBody: true,
      // Production always uses the DNS-validated, address-pinned transport.
      // A mock fetch and DNS bypass are accepted only in an isolated test process.
      fetchImpl,
      resolveDns,
      signal: options.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SanDealCommerceProbe/1.0)',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5',
        'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.7',
        'Cache-Control': 'no-cache',
      },
    });
    const finalDomain = domainOf(fetched.finalUrl);
    const merchantDomain = options.role === 'MERCHANT'
      ? finalDomain
      : finalDomain && !isAffiliateGateway(finalDomain) ? finalDomain : undefined;
    const verdict = classificationForResponse(fetched.response, options.role, gatewayDomain, finalDomain, fetched.redirectCount);
    const result: CommerceUrlProbeResult = {
      ...verdict,
      httpStatus: fetched.response.status,
      normalizedFinalUrl: sanitizedUrl(fetched.finalUrl),
      affiliateGatewayDomain: gatewayDomain,
      merchantDomain,
      redirectCount: fetched.redirectCount,
      elapsedTimeMs: Math.max(0, now() - startedAt),
      reasonCode: verdict.reasonCode,
      checkedAt,
      retryAfter: fetched.response.status === 429 ? retryAfterValue(fetched.response, startedAt) : undefined,
      diagnostics: {
        probeVersion: COMMERCE_URL_PROBE_VERSION,
        requested: requestedShape,
        final: sanitizedUrlShape(fetched.finalUrl),
        responseContentType: fetched.response.headers.get('content-type')?.split(';')[0]?.trim().slice(0, 100),
      },
    };
    logResult(result, options.role, options);
    return result;
  } catch (error) {
    const verdict = classificationForError(error);
    const roleVerdict = verdict.classification === 'MERCHANT_UNREACHABLE' && options.role === 'AFFILIATE'
      ? { ...verdict, classification: 'AFFILIATE_LINK_REJECTED' as const, reasonCode: verdict.reasonCode === 'NETWORK_FAILURE' ? 'AFFILIATE_NETWORK_FAILURE' : verdict.reasonCode, retryable: true }
      : verdict;
    const result: CommerceUrlProbeResult = {
      ...roleVerdict,
      affiliateGatewayDomain: gatewayDomain,
      merchantDomain: options.role === 'MERCHANT' ? requestedShape.domain : undefined,
      redirectCount: 0,
      elapsedTimeMs: Math.max(0, now() - startedAt),
      checkedAt,
      diagnostics: {
        probeVersion: COMMERCE_URL_PROBE_VERSION,
        requested: requestedShape,
        networkErrorCode: networkCode(error),
      },
    };
    logResult(result, options.role, options);
    return result;
  }
}

export function commerceProbeBlockerCode(result: CommerceUrlProbeResult, role: CommerceUrlProbeRole): string {
  if (role === 'AFFILIATE') return result.classification;
  if (result.classification === 'CONNECT_TIMEOUT') return 'MERCHANT_CONNECT_TIMEOUT';
  if (result.classification === 'REQUEST_TIMEOUT') return 'MERCHANT_REQUEST_TIMEOUT';
  if (result.classification === 'CONNECTION_RESET') return 'MERCHANT_CONNECTION_RESET';
  if (result.classification === 'DNS_FAILURE') return 'MERCHANT_DNS_FAILURE';
  if (result.classification === 'TLS_FAILURE') return 'MERCHANT_TLS_FAILURE';
  return result.classification;
}

export function commerceProbeIsPermanent(result: CommerceUrlProbeResult): boolean {
  return !result.retryable && result.classification !== 'HEALTHY';
}

export function commerceProbeToLegacyLinkResult(result: CommerceUrlProbeResult): {
  status: 'ok' | 'broken' | 'not_allowed' | 'rate_limited' | 'server_error' | 'timeout' | 'dns_error' | 'error';
  ok: boolean;
  reason: string;
  statusCode?: number;
  finalUrl?: string;
  errorCode?: string;
  timedOut?: boolean;
  retryable: boolean;
  retryAfter?: string;
} {
  const status = result.classification === 'HEALTHY' ? 'ok'
    : ['AFFILIATE_LINK_NOT_FOUND', 'MERCHANT_NOT_FOUND'].includes(result.classification) ? 'broken'
      : result.classification === 'RATE_LIMITED' ? 'rate_limited'
        : result.classification === 'PROVIDER_SERVER_ERROR' ? 'server_error'
          : result.classification === 'DNS_FAILURE' ? 'dns_error'
            : ['CONNECT_TIMEOUT', 'REQUEST_TIMEOUT', 'CONNECTION_RESET'].includes(result.classification) ? 'timeout'
              : result.classification === 'AFFILIATE_LINK_REJECTED' ? 'not_allowed'
                : 'error';
  return {
    status,
    ok: result.classification === 'HEALTHY',
    reason: result.reasonCode,
    statusCode: result.httpStatus,
    finalUrl: result.normalizedFinalUrl,
    errorCode: result.reasonCode,
    timedOut: ['CONNECT_TIMEOUT', 'REQUEST_TIMEOUT'].includes(result.classification),
    retryable: result.retryable,
    retryAfter: result.retryAfter,
  };
}
