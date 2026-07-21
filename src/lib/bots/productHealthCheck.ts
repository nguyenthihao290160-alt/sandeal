// ===========================================
// Product Health Check V2 — Standalone Helpers
// Check link & image health before AutoPilot publish
// Reusable across SourceScout, Approve Route, Cleanup
//
// V2 CHANGES:
// - HEAD is probe only: failures fall through to GET
// - Proper status classification: retryable vs broken
// - Browser-like request headers (no fake auth/cookies)
// - Expanded ImageCheckStatus with retryable states
// - Affiliate deeplink domains handled correctly
// ===========================================

import { assertPublicDns, validateExternalUrl } from '@/lib/product-intelligence/urlSafety';

// ---- Link Health Check ----

export type LinkCheckStatus =
  | 'ok'
  | 'broken'        // 404/410: definitively dead
  | 'not_allowed'   // 403/401/405: access restricted, not necessarily dead
  | 'rate_limited'  // 429: temporary, retry later
  | 'server_error'  // 5xx: server-side issue, recoverable
  | 'timeout'       // network timeout, recoverable
  | 'dns_error'     // DNS resolution failed
  | 'error'         // other network error
  | 'forbidden'     // anti-bot block, same as not_allowed legacy alias
  | 'unknown';

export interface LinkCheckResult {
  status: LinkCheckStatus;
  ok: boolean;
  reason: string;
  statusCode?: number;
  finalUrl?: string;
  errorCode?: string;
  timedOut?: boolean;
  retryable?: boolean;
  retryAfter?: string;
}

// ---- Image Health Check ----

export type ImageCheckStatus =
  | 'ok'
  | 'image_broken'    // 404/410 confirmed, or confirmed non-image data
  | 'invalid_image'   // response ok but content is not image/*
  | 'hotlink_blocked'
  | 'too_small'
  | 'too_large'
  | 'dark_image_suspected'
  | 'placeholder'
  | 'fallback_used'
  | 'forbidden'       // 401/403 anti-bot
  | 'not_allowed'     // same as forbidden, alias
  | 'rate_limited'    // 429: temporary
  | 'server_error'    // 5xx: temporary
  | 'timeout'         // network timeout
  | 'dns_error'       // DNS resolution failed
  | 'error'           // other network error
  | 'unknown';

export interface ImageCheckResult {
  status: ImageCheckStatus;
  ok: boolean;
  reason: string;
  statusCode?: number;
  finalUrl?: string;
  contentType?: string;
  contentLength?: number;
  width?: number;
  height?: number;
  dimensionsVerified?: boolean;
  retryable?: boolean;
}

export type ProductImageValidationState =
  | 'VALID'
  | 'BROKEN'
  | 'HOTLINK_BLOCKED'
  | 'TIMEOUT'
  | 'INVALID_CONTENT_TYPE'
  | 'TOO_SMALL'
  | 'DARK_IMAGE_SUSPECTED'
  | 'PLACEHOLDER'
  | 'FALLBACK_USED';

export interface ImageCandidateResolution {
  selectedUrl?: string;
  result: ImageCheckResult;
  checked: Array<{ url: string; result: ImageCheckResult }>;
  attempts: number;
}

export interface HealthCheckRequestOptions {
  fetchImpl?: typeof fetch;
  resolveDns?: boolean;
  inspectImageBody?: boolean;
}

/** Try source candidates in order and retain a retryable verdict over a false permanent failure. */
export async function resolveHealthyImageCandidate(
  candidates: Array<string | undefined>,
  options: HealthCheckRequestOptions = {},
): Promise<ImageCandidateResolution> {
  const urls = [...new Set(candidates.map(value => String(value || '').trim()).filter(Boolean))];
  const checked: ImageCandidateResolution['checked'] = [];
  for (const url of urls) {
    const result = await checkImageHealth(url, options);
    checked.push({ url, result });
    if (result.ok) return { selectedUrl: url, result, checked, attempts: checked.length };
  }
  const retryable = checked.find(item => item.result.retryable === true);
  const fallback = retryable || checked[0];
  return {
    result: fallback?.result || { status: 'error', ok: false, retryable: false, reason: 'No image candidate' },
    checked,
    attempts: checked.length,
  };
}

// ---- Source Preflight Check ----

export type SourcePreflightStatus =
  | 'ok'
  | 'stale_image'
  | 'stale_product_url'
  | 'stale_affiliate'
  | 'affiliate_unverified'
  | 'malformed_url'
  | 'missing_field'
  | 'invalid_source';

export interface SourcePreflightResult {
  status: SourcePreflightStatus;
  valid: boolean;
  reason: string;
  cooldownDurationHours?: number;
  blockedBy?: 'image' | 'product_url' | 'affiliate' | 'validation';
}

// ---- Constants ----

const LINK_CHECK_TIMEOUT_MS = 10_000;
const IMAGE_CHECK_TIMEOUT_MS = 8_000;
const MIN_PRODUCT_IMAGE_BYTES = 128;
const MAX_PRODUCT_IMAGE_BYTES = 25 * 1024 * 1024;
const MIN_PRODUCT_IMAGE_DIMENSION = 120;
const INITIAL_FETCH = globalThis.fetch;
const MAX_IMAGE_PROBE_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 8_192; // 8KB — enough to detect error text, not download large files

/**
 * Common error patterns in destination pages. If body contains one of
 * these, the link is considered broken / blocked.
 */
const BODY_ERROR_PATTERNS: Array<{ pattern: RegExp; status: LinkCheckStatus; errorCode: string }> = [
  { pattern: /not\s+allowed!?/i, status: 'not_allowed', errorCode: 'DEEPLINK_NOT_SUPPORTED' },
  { pattern: /deep\s*link\s+(?:is\s+)?not\s+supported/i, status: 'not_allowed', errorCode: 'DEEPLINK_NOT_SUPPORTED' },
  { pattern: /invalid\s+campaign/i, status: 'not_allowed', errorCode: 'PROVIDER_CAMPAIGN_INVALID' },
  { pattern: /forbidden/i, status: 'forbidden', errorCode: 'DESTINATION_FORBIDDEN' },
  { pattern: /access\s+denied/i, status: 'forbidden', errorCode: 'ACCESS_DENIED' },
  { pattern: /provider\s+error/i, status: 'server_error', errorCode: 'PROVIDER_ERROR_PAGE' },
  { pattern: /not\s+found/i, status: 'broken', errorCode: 'DESTINATION_NOT_FOUND' },
  { pattern: /\b404\b/, status: 'broken', errorCode: 'DESTINATION_NOT_FOUND' },
  { pattern: /unavailable/i, status: 'broken', errorCode: 'DESTINATION_UNAVAILABLE' },
  { pattern: /\bblocked\b/i, status: 'forbidden', errorCode: 'DESTINATION_BLOCKED' },
];

/** Known AccessTrade redirect hosts; response-body errors still take precedence. */
const AFFILIATE_DEEPLINK_DOMAINS = [
  'pub.accesstrade.vn',
  'go.isclix.com',
  'accesstrade.vn',
  'click.accesstrade.vn',
];

/** HTTP status codes that indicate the resource is definitively gone */
const PERMANENTLY_DEAD_CODES = new Set([404, 410]);



/** Retryable link statuses — should NOT trigger archival or permanent broken */
const RETRYABLE_LINK_STATUSES = new Set<LinkCheckStatus>([
  'not_allowed', 'rate_limited', 'server_error', 'timeout', 'dns_error', 'forbidden', 'error', 'unknown',
]);

/** Retryable image statuses — should NOT trigger image_broken */
const RETRYABLE_IMAGE_STATUSES = new Set<ImageCheckStatus>([
  'forbidden', 'hotlink_blocked', 'not_allowed', 'rate_limited', 'server_error', 'timeout', 'dns_error', 'error', 'unknown',
]);

// ---- Helpers ----

/** Check if status is retryable (not permanent failure) */
export function isRetryableLinkStatus(status: LinkCheckStatus): boolean {
  return RETRYABLE_LINK_STATUSES.has(status);
}

/** Check if image status is retryable (not permanent failure) */
export function isRetryableImageStatus(status: ImageCheckStatus): boolean {
  return RETRYABLE_IMAGE_STATUSES.has(status);
}

function isPrivateIp(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^0\./.test(hostname)) return true;
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  return false;
}

/**
 * Standard browser-like headers for health check requests.
 * Does NOT fake login, cookies, or bypass protection mechanisms.
 */
function buildRequestHeaders(method: 'HEAD' | 'GET'): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': method === 'GET'
      ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      : '*/*',
    'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
  };
  if (method === 'GET') {
    headers['Range'] = `bytes=0-${MAX_BODY_BYTES - 1}`;
  }
  return headers;
}

/**
 * Standard browser-like headers for image health check requests.
 */
function buildImageRequestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
  };
  // Do not send Range for image verification. Public eligibility requires an
  // exact HTTP 200 response. The capped body reader cancels the remaining stream.
  return headers;
}

async function fetchSafeRedirects(
  url: string,
  method: 'HEAD' | 'GET',
  timeoutMs: number,
  customHeaders?: Record<string, string>,
  options: HealthCheckRequestOptions = {},
): Promise<Response> {
  let currentUrl = url;
  let redirects = 0;
  const deadline = Date.now() + timeoutMs;
  const visited = new Set<string>();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  // Injected transports can disable DNS for isolated tests; runtime requests resolve every hop.
  const resolveDns = options.resolveDns ?? fetchImpl === INITIAL_FETCH;
  while (redirects < 5) {
    const validation = validateExternalUrl(currentUrl);
    if (!validation.safe || !validation.normalizedUrl) {
      throw new Error(`SSRF blocked: ${validation.code || 'INVALID_URL'}`);
    }
    currentUrl = validation.normalizedUrl;
    if (visited.has(currentUrl)) throw new Error('Too many redirects: redirect loop');
    visited.add(currentUrl);
    const parsed = new URL(currentUrl);
    if (resolveDns) {
      try {
        await assertPublicDns(parsed.hostname);
      } catch (error) {
        if (error instanceof Error && error.message === 'PRIVATE_NETWORK') {
          throw new Error(`SSRF blocked: ${parsed.hostname}`);
        }
        throw error;
      }
    }
    const headers = customHeaders || (method === 'GET' ? { Range: `bytes=0-${MAX_BODY_BYTES - 1}` } : undefined);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new DOMException('Request timeout', 'TimeoutError');
    const res = await fetchImpl(currentUrl, {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(remainingMs)
    });
    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      const location = res.headers.get('location');
      if (!location) return res;
      try { await res.body?.cancel(); } catch { /* ignore */ }
      currentUrl = new URL(location, currentUrl).toString();
      redirects++;
    } else {
      // Attach finalUrl so caller knows where it ended up
      Object.defineProperty(res, 'url', { value: currentUrl });
      return res;
    }
  }
  throw new Error('Too many redirects');
}

function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function responseContentLength(response: Response): number | undefined {
  const parsed = Number(response.headers.get('content-length'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function invalidImageSize(length: number | undefined): string | undefined {
  if (length === undefined) return undefined;
  if (length < MIN_PRODUCT_IMAGE_BYTES) return `Image payload too small: ${length} bytes`;
  if (length > MAX_PRODUCT_IMAGE_BYTES) return `Image payload too large: ${length} bytes`;
  return undefined;
}

function imageStatusForSize(length: number | undefined): 'too_small' | 'too_large' | undefined {
  if (length === undefined) return undefined;
  if (length < MIN_PRODUCT_IMAGE_BYTES) return 'too_small';
  if (length > MAX_PRODUCT_IMAGE_BYTES) return 'too_large';
  return undefined;
}

export function productImageValidationState(result: ImageCheckResult, fallbackUsed = false): ProductImageValidationState {
  if (fallbackUsed && result.ok) return 'FALLBACK_USED';
  if (result.status === 'ok' || result.status === 'fallback_used') return 'VALID';
  if (result.status === 'image_broken') return 'BROKEN';
  if (result.status === 'forbidden' || result.status === 'not_allowed' || result.status === 'hotlink_blocked') return 'HOTLINK_BLOCKED';
  if (result.status === 'timeout' || result.status === 'dns_error' || result.status === 'rate_limited' || result.status === 'server_error') return 'TIMEOUT';
  if (result.status === 'too_small' || result.status === 'too_large') return 'TOO_SMALL';
  if (result.status === 'dark_image_suspected') return 'DARK_IMAGE_SUSPECTED';
  if (result.status === 'placeholder') return 'PLACEHOLDER';
  return 'INVALID_CONTENT_TYPE';
}

async function readLimitedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maximum) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = maximum - total;
      const chunk = value.length > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    try { await reader.cancel(); } catch { /* response already ended */ }
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + length + 2 > bytes.length) return undefined;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: (bytes[offset + 5] << 8) | bytes[offset + 6], width: (bytes[offset + 7] << 8) | bytes[offset + 8] };
    }
    offset += length + 2;
  }
  return undefined;
}

function imageMetadata(bytes: Uint8Array, contentType: string): { signatureValid: boolean; width?: number; height?: number; darkSuspected?: boolean } {
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length >= 24 && pngSignature.every((value, index) => bytes[index] === value)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { signatureValid: true, width: view.getUint32(16), height: view.getUint32(20) };
  }
  const ascii = new TextDecoder('ascii').decode(bytes.slice(0, Math.min(bytes.length, MAX_IMAGE_PROBE_BYTES)));
  if (bytes.length >= 10 && (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a'))) {
    return { signatureValid: true, width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
  }
  const jpeg = jpegDimensions(bytes);
  if (jpeg) return { signatureValid: true, ...jpeg };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return { signatureValid: true };
  if (bytes.length >= 30 && ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') {
    if (ascii.slice(12, 16) === 'VP8X') {
      return {
        signatureValid: true,
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      };
    }
    return { signatureValid: true };
  }
  if (contentType.toLowerCase().includes('svg')) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (!/<svg\b/i.test(text)) return { signatureValid: false };
    const widthMatch = text.match(/\bwidth=["']\s*(\d+(?:\.\d+)?)/i);
    const heightMatch = text.match(/\bheight=["']\s*(\d+(?:\.\d+)?)/i);
    const viewBox = text.match(/\bviewBox=["']\s*[-\d.]+\s+[-\d.]+\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/i);
    const colors = [...text.matchAll(/(?:fill|background(?:-color)?)\s*[:=]\s*["']?([^;"'\s>]+)/gi)].map(match => match[1].toLowerCase());
    const dark = colors.length > 0 && colors.every(color => /^(?:#0{3,8}|black|rgb\(0,?0,?0\))$/.test(color));
    return {
      signatureValid: true,
      width: Number(widthMatch?.[1] || viewBox?.[1]) || undefined,
      height: Number(heightMatch?.[1] || viewBox?.[2]) || undefined,
      darkSuspected: dark,
    };
  }
  if (bytes.length >= 12 && ascii.slice(4, 8) === 'ftyp') return { signatureValid: true };
  return { signatureValid: false };
}

/**
 * Read up to `maxBytes` from response body as text.
 * Avoid downloading entire large body.
 */
async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return '';

    const chunks: Uint8Array[] = [];
    let totalRead = 0;

    while (totalRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      totalRead += value.length;
    }

    // Cancel the rest — we don't need more data
    try { reader.cancel(); } catch { /* ignore */ }

    const decoder = new TextDecoder('utf-8', { fatal: false });
    return chunks.map((c) => decoder.decode(c, { stream: true })).join('');
  } catch {
    return '';
  }
}

function matchBodyError(body: string): { status: LinkCheckStatus; reason: string; errorCode: string } | null {
  for (const { pattern, status, errorCode } of BODY_ERROR_PATTERNS) {
    if (pattern.test(body)) {
      return {
        status,
        errorCode,
        reason: `Trang đích chứa nội dung lỗi: "${body.match(pattern)?.[0] ?? pattern.source}"`,
      };
    }
  }
  return null;
}

/**
 * Classify an error into a LinkCheckStatus.
 * Returns null if the error is NOT an SSRF block (should fall through to GET).
 * Returns a result if the error is SSRF or similar hard block.
 */
function networkErrorCode(error: Error): string | undefined {
  const direct = (error as Error & { code?: unknown }).code;
  const cause = (error as Error & { cause?: unknown }).cause;
  const caused = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
  const value = typeof direct === 'string' ? direct : typeof caused === 'string' ? caused : undefined;
  return value?.trim().slice(0, 80) || undefined;
}

function classifyFetchError(error: unknown): { status: LinkCheckStatus; reason: string; isSsrf: boolean; errorCode?: string; timedOut?: boolean } | null {
  if (!(error instanceof Error)) return null;

  if (error.message.includes('SSRF')) {
    return { status: 'forbidden', reason: error.message, isSsrf: true };
  }

  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return { status: 'timeout', reason: 'Request timeout', isSsrf: false, errorCode: 'TIMEOUT', timedOut: true };
  }

  const msg = error.message.toLowerCase();
  const errorCode = networkErrorCode(error);
  if (msg.includes('getaddrinfo') || msg.includes('dns') || msg.includes('enotfound') || errorCode === 'ENOTFOUND') {
    return { status: 'dns_error', reason: `DNS lỗi: ${error.message}`, isSsrf: false, errorCode: errorCode || 'DNS_ERROR' };
  }

  if (error.message.includes('redirect loop')) {
    return { status: 'error', reason: 'Redirect loop', isSsrf: false, errorCode: 'REDIRECT_LOOP' };
  }

  if (error.message.includes('Too many redirects')) {
    return { status: 'error', reason: 'Quá nhiều redirect', isSsrf: false, errorCode: 'REDIRECT_LIMIT_EXCEEDED' };
  }

  const reset = errorCode === 'ECONNRESET' || msg.includes('socket hang up') || msg.includes('connection reset');
  return {
    status: 'error',
    reason: reset ? 'Kết nối bị reset bởi upstream' : `Network error: ${error.message}`,
    isSsrf: false,
    errorCode: reset ? 'ECONNRESET' : errorCode || 'NETWORK_ERROR',
  };
}

/**
 * Map HTTP status code to LinkCheckResult for GET responses.
 */
function retryAfterIso(value: string | null, now = Date.now()): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const timestamp = /^\d+$/.test(trimmed) ? now + Number(trimmed) * 1000 : Date.parse(trimmed);
  return Number.isFinite(timestamp) && timestamp > now ? new Date(timestamp).toISOString() : undefined;
}

function classifyGetResponse(status: number, retryAfter?: string): LinkCheckResult | null {
  if (status >= 300 && status < 400) {
    return {
      status: 'error', ok: false, retryable: false,
      reason: `HTTP ${status} redirect without a valid Location header`,
      statusCode: status,
      errorCode: 'REDIRECT_LOCATION_MISSING',
    };
  }
  if (PERMANENTLY_DEAD_CODES.has(status)) {
    return {
      status: 'broken', ok: false, retryable: false,
      reason: `HTTP ${status} — không tìm thấy trang`,
      statusCode: status,
      errorCode: status === 404 ? 'HTTP_NOT_FOUND' : 'HTTP_GONE',
    };
  }
  if (status === 401) {
    return {
      status: 'not_allowed', ok: false, retryable: true,
      reason: 'HTTP 401 — Yêu cầu xác thực, không thể xác minh link (có thể do anti-bot)',
      statusCode: status,
      errorCode: 'HTTP_UNAUTHORIZED',
    };
  }
  if (status === 403) {
    return {
      status: 'not_allowed', ok: false, retryable: true,
      reason: 'HTTP 403 — Link bị từ chối truy cập (anti-bot hoặc IP bị chặn). KHÔNG phải link chết.',
      statusCode: status,
      errorCode: 'HTTP_FORBIDDEN',
    };
  }
  if (status === 405) {
    return {
      status: 'not_allowed', ok: false, retryable: true,
      reason: 'HTTP 405 — Phương thức không được phép, có thể do anti-bot',
      statusCode: status,
      errorCode: 'HTTP_METHOD_NOT_ALLOWED',
    };
  }
  if (status === 429) {
    return {
      status: 'rate_limited', ok: false, retryable: true,
      reason: 'HTTP 429 — Rate limit, cần thử lại sau 1 giờ',
      statusCode: status,
      errorCode: 'HTTP_RATE_LIMITED',
      retryAfter,
    };
  }
  if (status >= 500) {
    return {
      status: 'server_error', ok: false, retryable: true,
      reason: `Server error HTTP ${status} — tạm thời, có thể phục hồi`,
      statusCode: status,
      errorCode: 'HTTP_SERVER_ERROR',
    };
  }
  if (status >= 400) {
    return {
      status: 'error', ok: false, retryable: false,
      reason: `HTTP ${status}`,
      statusCode: status,
    };
  }
  return null; // 2xx/3xx — needs body check
}

// ---- Link Health Check ----

/**
 * Check link health for product / affiliate URLs.
 *
 * V2 STRATEGY:
 * GET is authoritative because a successful HEAD cannot reveal an upstream
 * error page such as "Not Allowed!". Redirects are still followed manually
 * and validated at every hop.
 */
export async function checkLinkHealth(url: string, options: HealthCheckRequestOptions = {}): Promise<LinkCheckResult> {
  // Validate URL
  if (!url || !url.trim()) {
    return { status: 'error', ok: false, reason: 'URL rỗng' };
  }

  if (!isValidHttpUrl(url)) {
    return { status: 'error', ok: false, reason: 'URL không hợp lệ hoặc không phải http/https' };
  }

  // SSRF check before any request
  try {
    const parsed = new URL(url);
    if (isPrivateIp(parsed.hostname)) {
      return { status: 'forbidden', ok: false, reason: `SSRF blocked: ${parsed.hostname}` };
    }
  } catch {
    return { status: 'error', ok: false, reason: 'URL parse error' };
  }

  try {
    // A single GET both verifies transport and inspects the short response body.
    const getResponse = await fetchSafeRedirects(url, 'GET', LINK_CHECK_TIMEOUT_MS, buildRequestHeaders('GET'), options);

    // Check HTTP status
    const statusResult = classifyGetResponse(getResponse.status, retryAfterIso(getResponse.headers.get('retry-after')));
    if (statusResult) return { ...statusResult, finalUrl: getResponse.url || url };

    // Response is 2xx or 3xx — read limited body to check for error content
    const body = await readLimitedBody(getResponse, MAX_BODY_BYTES);
    const bodyMatch = matchBodyError(body);

    if (bodyMatch) {
      return {
        status: bodyMatch.status,
        ok: false,
        retryable: isRetryableLinkStatus(bodyMatch.status),
        reason: bodyMatch.reason,
        statusCode: getResponse.status,
        finalUrl: getResponse.url || url,
        errorCode: bodyMatch.errorCode,
      };
    }

    const finalUrl = getResponse.url || url;
    if (isAffiliateDeeplyinkDomain(url) && isAffiliateDeeplyinkDomain(finalUrl)) {
      return {
        status: 'unknown',
        ok: false,
        retryable: true,
        reason: 'Tracking URL did not resolve to a public merchant destination',
        statusCode: getResponse.status,
        finalUrl,
        errorCode: 'TRACKING_DESTINATION_UNVERIFIED',
      };
    }

    return {
      status: 'ok', ok: true, retryable: false,
      reason: `HTTP ${getResponse.status} OK`,
      statusCode: getResponse.status,
      finalUrl: getResponse.url || url,
    };
  } catch (error) {
    const classified = classifyFetchError(error);
    if (classified) {
      return {
        status: classified.status,
        ok: false,
        retryable: !classified.isSsrf,
        reason: classified.reason,
        finalUrl: url,
        errorCode: classified.errorCode,
        timedOut: classified.timedOut,
      };
    }
    return { status: 'unknown', ok: false, retryable: true, reason: 'Lỗi không xác định' };
  }
}

// ---- Image Health Check V2 ----

/**
 * Check image URL health.
 *
 * V2 CHANGES:
 * - 429/5xx/timeout/DNS = retryable status, NOT image_broken
 * - Only 404/410 confirmed = image_broken
 * - Only confirmed non-image content-type = invalid_image
 * - HEAD failure always falls through to GET
 * - Proper status types for all temporary failures
 */
export async function checkImageHealth(imageUrl: string, options: HealthCheckRequestOptions = {}): Promise<ImageCheckResult> {
  if (/(?:placeholder|spacer|transparent[-_]?pixel|blank[-_]?image|\/1x1(?:\.|\/|$))/i.test(imageUrl)) {
    return { status: 'placeholder', ok: false, retryable: false, reason: 'Image URL has a known placeholder shape' };
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const inspectImageBody = options.inspectImageBody ?? fetchImpl === INITIAL_FETCH;
  // Validate URL
  if (!imageUrl || !imageUrl.trim()) {
    return { status: 'error', ok: false, reason: 'Image URL rỗng' };
  }

  if (!isValidHttpUrl(imageUrl)) {
    return { status: 'error', ok: false, reason: 'Image URL không hợp lệ hoặc không phải http/https' };
  }

  // SSRF check
  try {
    const parsed = new URL(imageUrl);
    if (isPrivateIp(parsed.hostname)) {
      return { status: 'forbidden', ok: false, reason: `SSRF blocked: ${parsed.hostname}` };
    }
  } catch {
    return { status: 'error', ok: false, reason: 'Image URL parse error' };
  }

  try {
    // Step 1: HEAD request (probe)
    let headOk = false;
    let headContentType: string | null = null;

    try {
      const headResponse = await fetchSafeRedirects(imageUrl, 'HEAD', IMAGE_CHECK_TIMEOUT_MS, buildImageRequestHeaders(), options);

      if (headResponse.status !== 200) {
        // HEAD 404/410 — still try GET to confirm
        if (PERMANENTLY_DEAD_CODES.has(headResponse.status)) {
          // Fall through to GET for confirmation
        }
        // HEAD 401/403/405/429/5xx — fall through to GET
        // These may just mean server blocks HEAD for images
      } else {
        headOk = true;
        headContentType = headResponse.headers.get('content-type');
        const headContentLength = responseContentLength(headResponse);

        // Check content-type from HEAD
        if (headContentType && !headContentType.toLowerCase().startsWith('image/')) {
          return {
            status: 'invalid_image', ok: false, retryable: false,
            reason: `Content-Type không phải ảnh: ${headContentType}`,
            contentType: headContentType,
            statusCode: headResponse.status,
            finalUrl: headResponse.url || imageUrl,
          };
        }

        if (headContentType && headContentType.toLowerCase().startsWith('image/')) {
          const sizeError = invalidImageSize(headContentLength);
          if (sizeError) {
            return {
              status: imageStatusForSize(headContentLength) || 'invalid_image', ok: false, retryable: false,
              reason: sizeError,
              contentType: headContentType,
              contentLength: headContentLength,
              statusCode: headResponse.status,
              finalUrl: headResponse.url || imageUrl,
            };
          }
          if (!inspectImageBody) {
            return {
              status: 'ok', ok: true, retryable: false,
              reason: 'Image headers OK; body inspection disabled for injected transport',
              contentType: headContentType,
              contentLength: headContentLength,
              dimensionsVerified: false,
              statusCode: headResponse.status,
              finalUrl: headResponse.url || imageUrl,
            };
          }
        }

        // HEAD 200 but no content-type — fallback to GET
      }
    } catch (headError) {
      if (headError instanceof Error && headError.message.includes('SSRF')) {
        return { status: 'forbidden', ok: false, reason: headError.message };
      }
      // All other HEAD errors: fall through to GET
    }

    // Step 2: GET fallback (if HEAD didn't resolve or had issues)
    if (!headOk || !headContentType || inspectImageBody) {
      const getResponse = await fetchSafeRedirects(imageUrl, 'GET', IMAGE_CHECK_TIMEOUT_MS, buildImageRequestHeaders(), options);

      if (getResponse.status !== 200) {
        // Definitively dead
        if (PERMANENTLY_DEAD_CODES.has(getResponse.status)) {
          return {
            status: 'image_broken', ok: false, retryable: false,
            reason: `HTTP ${getResponse.status} — ảnh không tồn tại`,
            statusCode: getResponse.status,
            finalUrl: getResponse.url || imageUrl,
          };
        }

        // Access restricted — retryable, NOT image_broken
        if (getResponse.status === 401 || getResponse.status === 403) {
          return {
            status: 'hotlink_blocked', ok: false, retryable: true,
            reason: `HTTP ${getResponse.status} — Ảnh bị từ chối truy cập, có thể là anti-bot`,
            statusCode: getResponse.status,
            finalUrl: getResponse.url || imageUrl,
          };
        }

        if (getResponse.status === 405) {
          return {
            status: 'not_allowed', ok: false, retryable: true,
            reason: 'HTTP 405 — Phương thức không được phép, không thể xác minh ảnh',
            statusCode: getResponse.status,
            finalUrl: getResponse.url || imageUrl,
          };
        }

        // Rate limited — retryable, NOT image_broken
        if (getResponse.status === 429) {
          return {
            status: 'rate_limited', ok: false, retryable: true,
            reason: 'HTTP 429 — Rate limit, ảnh tạm thời không thể truy cập',
            statusCode: getResponse.status,
            finalUrl: getResponse.url || imageUrl,
          };
        }

        // Server error — retryable, NOT image_broken
        if (getResponse.status >= 500) {
          return {
            status: 'server_error', ok: false, retryable: true,
            reason: `Server error HTTP ${getResponse.status} — tạm thời`,
            statusCode: getResponse.status,
            finalUrl: getResponse.url || imageUrl,
          };
        }

        // Other 4xx
        return {
          status: 'error', ok: false, retryable: false,
          reason: `HTTP ${getResponse.status}`,
          statusCode: getResponse.status,
          finalUrl: getResponse.url || imageUrl,
        };
      }

      const contentType = getResponse.headers.get('content-type') ?? '';
      const getContentLength = responseContentLength(getResponse);

      // Cancel body download — we only need headers
      if (!contentType.toLowerCase().startsWith('image/')) {
        try { await getResponse.body?.cancel(); } catch { /* ignore */ }
        return {
          status: 'invalid_image', ok: false, retryable: false,
          reason: contentType
            ? `Content-Type không phải ảnh: ${contentType}`
            : 'Không có Content-Type header',
          contentType: contentType || undefined,
          statusCode: getResponse.status,
          finalUrl: getResponse.url || imageUrl,
        };
      }

      const sizeError = invalidImageSize(getContentLength);
      if (sizeError) {
        try { await getResponse.body?.cancel(); } catch { /* ignore */ }
        return {
          status: imageStatusForSize(getContentLength) || 'invalid_image', ok: false, retryable: false,
          reason: sizeError,
          contentType,
          contentLength: getContentLength,
          statusCode: getResponse.status,
          finalUrl: getResponse.url || imageUrl,
        };
      }

      if (inspectImageBody) {
        const bytes = await readLimitedBytes(getResponse, MAX_IMAGE_PROBE_BYTES);
        const metadata = imageMetadata(bytes, contentType);
        if (!metadata.signatureValid) {
          return {
            status: 'invalid_image', ok: false, retryable: false,
            reason: 'Image payload signature does not match a supported image format',
            contentType, contentLength: getContentLength, statusCode: getResponse.status,
            finalUrl: getResponse.url || imageUrl,
          };
        }
        if (metadata.width && metadata.height && (metadata.width < MIN_PRODUCT_IMAGE_DIMENSION || metadata.height < MIN_PRODUCT_IMAGE_DIMENSION)) {
          return {
            status: 'too_small', ok: false, retryable: false,
            reason: `Image dimensions too small: ${metadata.width}x${metadata.height}`,
            contentType, contentLength: getContentLength, width: metadata.width, height: metadata.height,
            dimensionsVerified: true, statusCode: getResponse.status,
            finalUrl: getResponse.url || imageUrl,
          };
        }
        if (metadata.darkSuspected) {
          return {
            status: 'dark_image_suspected', ok: false, retryable: false,
            reason: 'Image payload is uniformly dark in the format that can be inspected safely',
            contentType, contentLength: getContentLength, width: metadata.width, height: metadata.height,
            dimensionsVerified: Boolean(metadata.width && metadata.height), statusCode: getResponse.status,
            finalUrl: getResponse.url || imageUrl,
          };
        }
        return {
          status: 'ok', ok: true, retryable: false,
          reason: metadata.width && metadata.height ? `Image OK (${metadata.width}x${metadata.height})` : 'Image signature OK; dimensions unavailable for this encoded format',
          contentType, contentLength: getContentLength, width: metadata.width, height: metadata.height,
          dimensionsVerified: Boolean(metadata.width && metadata.height), statusCode: getResponse.status,
          finalUrl: getResponse.url || imageUrl,
        };
      }

      try { await getResponse.body?.cancel(); } catch { /* ignore */ }

      return {
        status: 'ok', ok: true, retryable: false,
        reason: 'Image OK (GET)',
        contentType,
        contentLength: getContentLength,
        dimensionsVerified: false,
        statusCode: getResponse.status,
        finalUrl: getResponse.url || imageUrl,
      };
    }

    // Should not reach here, but just in case
    return { status: 'unknown', ok: false, retryable: true, reason: 'Không xác định được trạng thái ảnh' };
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('SSRF')) {
        return { status: 'forbidden', ok: false, retryable: false, reason: error.message };
      }
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        return { status: 'timeout', ok: false, retryable: true, reason: 'Request timeout (8s)' };
      }
      const msg = error.message.toLowerCase();
      if (msg.includes('getaddrinfo') || msg.includes('dns') || msg.includes('enotfound')) {
        return { status: 'dns_error', ok: false, retryable: true, reason: `DNS lỗi: ${error.message}` };
      }
      return {
        status: 'error', ok: false, retryable: true,
        reason: `Network error: ${error.message}`,
      };
    }

    return { status: 'unknown', ok: false, retryable: true, reason: 'Lỗi không xác định' };
  }
}

// ---- Source Preflight Check ----

/**
 * Quick preflight validation for AccessTrade items before merging into storage.
 * Detects dead/stale items without full health checks.
 *
 * Check trong vòng:
 * - Image 404/410 → stale_image
 * - Product URL 404/410 → stale_product_url
 * - Affiliate URL 404/410 → stale_affiliate
 * - Affiliate 200 but no redirect → affiliate_unverified
 * - Malformed URL → malformed_url
 * - Missing required field → missing_field
 *
 * Nếu valid === false, sản phẩm nên được skip hoặc đánh dấu cooldown.
 */
export async function checkSourcePreflight(
  productTitle: string | undefined,
  imageUrl: string | undefined,
  productUrl: string | undefined,
  affiliateUrl: string | undefined,
): Promise<SourcePreflightResult> {
  // Validate required fields
  if (!productTitle || !productTitle.trim()) {
    return {
      status: 'missing_field',
      valid: false,
      reason: 'Thiếu tiêu đề sản phẩm',
      cooldownDurationHours: 0,
      blockedBy: 'validation',
    };
  }

  // Validate URL formats
  if (productUrl && !isValidHttpUrl(productUrl)) {
    return {
      status: 'malformed_url',
      valid: false,
      reason: 'URL sản phẩm không hợp lệ hoặc không phải http/https',
      cooldownDurationHours: 0,
      blockedBy: 'product_url',
    };
  }

  if (affiliateUrl && !isValidHttpUrl(affiliateUrl)) {
    return {
      status: 'malformed_url',
      valid: false,
      reason: 'Affiliate URL không hợp lệ hoặc không phải http/https',
      cooldownDurationHours: 0,
      blockedBy: 'affiliate',
    };
  }

  if (imageUrl && !isValidHttpUrl(imageUrl)) {
    return {
      status: 'malformed_url',
      valid: false,
      reason: 'Image URL không hợp lệ hoặc không phải http/https',
      cooldownDurationHours: 0,
      blockedBy: 'image',
    };
  }

  // Quick image check for 404/410
  if (imageUrl) {
    try {
      const headResponse = await fetchSafeRedirects(imageUrl, 'HEAD', 3000);
      if (headResponse.status === 404 || headResponse.status === 410) {
        return {
          status: 'stale_image',
          valid: false,
          reason: `Ảnh không tồn tại (HTTP ${headResponse.status})`,
          cooldownDurationHours: 24,
          blockedBy: 'image',
        };
      }
    } catch {
      // Timeout or network error on preflight — not immediately stale
      // Will be checked again during full health check
    }
  }

  // Quick product URL check for 404/410
  if (productUrl) {
    try {
      const headResponse = await fetchSafeRedirects(productUrl, 'HEAD', 3000);
      if (headResponse.status === 404 || headResponse.status === 410) {
        return {
          status: 'stale_product_url',
          valid: false,
          reason: `URL sản phẩm không tồn tại (HTTP ${headResponse.status})`,
          cooldownDurationHours: 24,
          blockedBy: 'product_url',
        };
      }
    } catch {
      // Timeout or network error on preflight — not immediately stale
    }
  }

  // Quick affiliate URL check
  if (affiliateUrl) {
    try {
      const affiliateCheck = await checkAffiliateVerification(affiliateUrl);
      if (affiliateCheck.status === 'unverified') {
        return {
          status: 'affiliate_unverified',
          valid: false,
          reason: affiliateCheck.reason,
          cooldownDurationHours: 4,
          blockedBy: 'affiliate',
        };
      }
      if (affiliateCheck.status === 'stale') {
        return {
          status: 'stale_affiliate',
          valid: false,
          reason: affiliateCheck.reason,
          cooldownDurationHours: 24,
          blockedBy: 'affiliate',
        };
      }
    } catch {
      // Network error on preflight — not immediately invalid
    }
  }

  // Passed preflight
  return {
    status: 'ok',
    valid: true,
    reason: 'Kiểm tra sơ bộ thành công',
  };
}

/**
 * Check if a URL is an affiliate deeplink domain where HTML 200 response
 * without redirect is normal behavior (deeplink needs JS to redirect).
 */
function isAffiliateDeeplyinkDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return AFFILIATE_DEEPLINK_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

/**
 * Check affiliate URL verification without full redirect following.
 * Returns { status: 'ok' | 'unverified' | 'stale', reason: string }
 *
 * V2 CHANGES:
 * - 401/403/405 from affiliate domains = unverified, NOT stale/broken
 * - 429/5xx/timeout = unverified (retryable), NOT stale
 * - Only confirmed 404/410 = stale
 * - Affiliate deeplink domains: any 2xx/3xx = ok regardless of HTML content
 */
async function checkAffiliateVerification(
  affiliateUrl: string,
): Promise<{ status: 'ok' | 'unverified' | 'stale'; reason: string }> {
  try {
    const isDeeplinkDomain = isAffiliateDeeplyinkDomain(affiliateUrl);

    const response = await fetchSafeRedirects(affiliateUrl, 'GET', 3000, buildRequestHeaders('GET'));

    // 404/410 = stale regardless of domain
    if (response.status === 404 || response.status === 410) {
      return {
        status: 'stale',
        reason: `Affiliate URL không tồn tại (HTTP ${response.status})`,
      };
    }

    // 429 = rate limited, treat as unverified (NOT stale)
    if (response.status === 429) {
      return {
        status: 'unverified',
        reason: `Affiliate URL rate limited (HTTP 429) — cần thử lại sau`,
      };
    }

    // 5xx = server error, treat as unverified (not stale)
    if (response.status >= 500) {
      return {
        status: 'unverified',
        reason: `Affiliate URL lỗi server (HTTP ${response.status})`,
      };
    }

    // 401/403/405 = access restricted, unverified but NOT stale
    if ([401, 403, 405].includes(response.status)) {
      return {
        status: 'unverified',
        reason: `Affiliate URL bị hạn chế truy cập (HTTP ${response.status}) — có thể do anti-bot`,
      };
    }

    const responseBody = await readLimitedBody(response, MAX_BODY_BYTES);
    const bodyError = matchBodyError(responseBody);
    if (bodyError) {
      return {
        status: 'unverified',
        reason: bodyError.reason,
      };
    }

    // A tracking host that never resolves to a merchant destination remains
    // unverified. JavaScript behavior is not sufficient evidence for publish.
    if (isDeeplinkDomain) {
      if (response.ok || (response.status >= 200 && response.status < 400)) {
        return {
          status: 'unverified',
          reason: `Tracking URL did not resolve to a merchant destination (HTTP ${response.status})`,
        };
      }
      return {
        status: 'unverified',
        reason: `Affiliate deeplink không thể xác minh (HTTP ${response.status})`,
      };
    }

    // If not 200, we can't verify for regular domains
    if (!response.ok) {
      return {
        status: 'unverified',
        reason: `Affiliate URL không thể xác minh (HTTP ${response.status})`,
      };
    }

    // HTTP 200 for regular domain — check if it's HTML without redirect
    const contentType = response.headers.get('content-type') || '';
    const isBrowser = contentType.toLowerCase().includes('text/html');

    if (isBrowser) {
      // Regular domain returning HTML but didn't redirect — can't verify destination
      return {
        status: 'unverified',
        reason: 'Affiliate link trả về HTML nhưng không redirect tự động - cần xác minh thủ công',
      };
    }

    // Assume OK if not HTML
    return {
      status: 'ok',
      reason: 'Affiliate URL đã xác minh',
    };
  } catch {
    // Network error
    return {
      status: 'unverified',
      reason: 'Lỗi mạng khi kiểm tra affiliate URL',
    };
  }
}
