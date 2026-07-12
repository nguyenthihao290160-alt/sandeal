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
  retryable?: boolean;
}

// ---- Image Health Check ----

export type ImageCheckStatus =
  | 'ok'
  | 'image_broken'    // 404/410 confirmed, or confirmed non-image data
  | 'invalid_image'   // response ok but content is not image/*
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
  contentType?: string;
  retryable?: boolean;
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
const MAX_BODY_BYTES = 8_192; // 8KB — enough to detect error text, not download large files

/**
 * Common error patterns in destination pages. If body contains one of
 * these, the link is considered broken / blocked.
 */
const BODY_ERROR_PATTERNS: Array<{ pattern: RegExp; status: LinkCheckStatus }> = [
  { pattern: /not\s+allowed!?/i, status: 'not_allowed' },
  { pattern: /forbidden/i, status: 'forbidden' },
  { pattern: /access\s+denied/i, status: 'forbidden' },
  { pattern: /not\s+found/i, status: 'broken' },
  { pattern: /\b404\b/, status: 'broken' },
  { pattern: /unavailable/i, status: 'broken' },
  { pattern: /\bblocked\b/i, status: 'forbidden' },
];

/**
 * Domains where HEAD is typically unreliable — need GET to detect errors
 * in body (e.g. AccessTrade returns 200 but body contains "Not Allowed!").
 */
const FORCE_GET_DOMAINS = [
  'go.isclix.com',
  'pub.accesstrade.vn',
  'accesstrade.vn',
];

/**
 * Affiliate deeplink domains: returning HTML 200 without immediate redirect
 * is NORMAL — deeplinks need JavaScript to redirect. Only need 2xx/3xx
 * not 404/410/5xx for affiliate link to be ok.
 * Do NOT consider HTML response from these domains as "unverified".
 */
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
  'forbidden', 'not_allowed', 'rate_limited', 'server_error', 'timeout', 'dns_error', 'error', 'unknown',
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
function buildImageRequestHeaders(method: 'HEAD' | 'GET'): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
  };
  if (method === 'GET') {
    // Limit download for GET probe
    headers['Range'] = `bytes=0-${MAX_BODY_BYTES - 1}`;
  }
  return headers;
}

async function fetchSafeRedirects(url: string, method: string, timeoutMs: number, customHeaders?: Record<string, string>): Promise<Response> {
  let currentUrl = url;
  let redirects = 0;
  while (redirects < 5) {
    const parsed = new URL(currentUrl);
    if (isPrivateIp(parsed.hostname)) {
      throw new Error(`SSRF blocked: ${parsed.hostname}`);
    }
    const headers = customHeaders || (method === 'GET' ? { Range: `bytes=0-${MAX_BODY_BYTES - 1}` } : undefined);
    const res = await fetch(currentUrl, {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      const location = res.headers.get('location');
      if (!location) return res;
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

function shouldForceGet(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return FORCE_GET_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
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

function matchBodyError(body: string): { status: LinkCheckStatus; reason: string } | null {
  for (const { pattern, status } of BODY_ERROR_PATTERNS) {
    if (pattern.test(body)) {
      return {
        status,
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
function classifyFetchError(error: unknown): { status: LinkCheckStatus; reason: string; isSsrf: boolean } | null {
  if (!(error instanceof Error)) return null;

  if (error.message.includes('SSRF')) {
    return { status: 'forbidden', reason: error.message, isSsrf: true };
  }

  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return { status: 'timeout', reason: 'Request timeout', isSsrf: false };
  }

  const msg = error.message.toLowerCase();
  if (msg.includes('getaddrinfo') || msg.includes('dns') || msg.includes('enotfound')) {
    return { status: 'dns_error', reason: `DNS lỗi: ${error.message}`, isSsrf: false };
  }

  if (error.message.includes('Too many redirects')) {
    return { status: 'error', reason: 'Quá nhiều redirect', isSsrf: false };
  }

  return { status: 'error', reason: `Network error: ${error.message}`, isSsrf: false };
}

/**
 * Map HTTP status code to LinkCheckResult for GET responses.
 */
function classifyGetResponse(status: number): LinkCheckResult | null {
  if (PERMANENTLY_DEAD_CODES.has(status)) {
    return {
      status: 'broken', ok: false, retryable: false,
      reason: `HTTP ${status} — không tìm thấy trang`,
      statusCode: status,
    };
  }
  if (status === 401) {
    return {
      status: 'not_allowed', ok: false, retryable: true,
      reason: 'HTTP 401 — Yêu cầu xác thực, không thể xác minh link (có thể do anti-bot)',
      statusCode: status,
    };
  }
  if (status === 403) {
    return {
      status: 'not_allowed', ok: false, retryable: true,
      reason: 'HTTP 403 — Link bị từ chối truy cập (anti-bot hoặc IP bị chặn). KHÔNG phải link chết.',
      statusCode: status,
    };
  }
  if (status === 405) {
    return {
      status: 'not_allowed', ok: false, retryable: true,
      reason: 'HTTP 405 — Phương thức không được phép, có thể do anti-bot',
      statusCode: status,
    };
  }
  if (status === 429) {
    return {
      status: 'rate_limited', ok: false, retryable: true,
      reason: 'HTTP 429 — Rate limit, cần thử lại sau 1 giờ',
      statusCode: status,
    };
  }
  if (status >= 500) {
    return {
      status: 'server_error', ok: false, retryable: true,
      reason: `Server error HTTP ${status} — tạm thời, có thể phục hồi`,
      statusCode: status,
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
 * 1. HEAD is a probe only — if HEAD succeeds with 200, link is ok.
 * 2. If HEAD fails (timeout, error, 4xx, 5xx), ALWAYS fall through to GET
 *    (except SSRF/invalid URL which are hard blocks).
 * 3. GET is the authoritative check. Only GET 404/410 = broken.
 * 4. 401/403/405 = not_allowed (retryable), NOT broken.
 * 5. 429 = rate_limited (retryable).
 * 6. 5xx = server_error (retryable).
 * 7. timeout = timeout (retryable).
 */
export async function checkLinkHealth(url: string): Promise<LinkCheckResult> {
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

  const forceGet = shouldForceGet(url);

  try {
    // Step 1: HEAD request (probe only — skip if domain needs GET)
    if (!forceGet) {
      try {
        const headResponse = await fetchSafeRedirects(url, 'HEAD', LINK_CHECK_TIMEOUT_MS, buildRequestHeaders('HEAD'));

        if (headResponse.ok) {
          // HEAD 200 — link is ok
          return {
            status: 'ok', ok: true, retryable: false,
            reason: 'HEAD 200 OK',
            statusCode: headResponse.status,
            finalUrl: headResponse.url || url,
          };
        }

        // HEAD returned definitive 404/410 — still try GET to confirm
        // (some servers return wrong status for HEAD)
        if (PERMANENTLY_DEAD_CODES.has(headResponse.status)) {
          // Fall through to GET for confirmation
        }

        // All other HEAD errors: fall through to GET
        // 401/403/405/429/5xx from HEAD may just mean server blocks HEAD
      } catch (headError) {
        const classified = classifyFetchError(headError);
        if (classified?.isSsrf) {
          return { status: 'forbidden', ok: false, reason: classified.reason };
        }
        // All other HEAD errors (timeout, DNS, network): fall through to GET
      }
    }

    // Step 2: GET request (authoritative check)
    const getResponse = await fetchSafeRedirects(url, 'GET', LINK_CHECK_TIMEOUT_MS, buildRequestHeaders('GET'));

    // Check HTTP status
    const statusResult = classifyGetResponse(getResponse.status);
    if (statusResult) return statusResult;

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
export async function checkImageHealth(imageUrl: string): Promise<ImageCheckResult> {
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
      const headResponse = await fetchSafeRedirects(imageUrl, 'HEAD', IMAGE_CHECK_TIMEOUT_MS, buildImageRequestHeaders('HEAD'));

      if (headResponse.status >= 400) {
        // HEAD 404/410 — still try GET to confirm
        if (PERMANENTLY_DEAD_CODES.has(headResponse.status)) {
          // Fall through to GET for confirmation
        }
        // HEAD 401/403/405/429/5xx — fall through to GET
        // These may just mean server blocks HEAD for images
      } else {
        headOk = true;
        headContentType = headResponse.headers.get('content-type');

        // Check content-type from HEAD
        if (headContentType && !headContentType.toLowerCase().startsWith('image/')) {
          return {
            status: 'invalid_image', ok: false, retryable: false,
            reason: `Content-Type không phải ảnh: ${headContentType}`,
            contentType: headContentType,
            statusCode: headResponse.status,
          };
        }

        if (headContentType && headContentType.toLowerCase().startsWith('image/')) {
          return {
            status: 'ok', ok: true, retryable: false,
            reason: 'Image OK',
            contentType: headContentType,
            statusCode: headResponse.status,
          };
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
    if (!headOk || !headContentType) {
      const getResponse = await fetchSafeRedirects(imageUrl, 'GET', IMAGE_CHECK_TIMEOUT_MS, buildImageRequestHeaders('GET'));

      if (getResponse.status >= 400) {
        // Definitively dead
        if (PERMANENTLY_DEAD_CODES.has(getResponse.status)) {
          return {
            status: 'image_broken', ok: false, retryable: false,
            reason: `HTTP ${getResponse.status} — ảnh không tồn tại`,
            statusCode: getResponse.status,
          };
        }

        // Access restricted — retryable, NOT image_broken
        if (getResponse.status === 401 || getResponse.status === 403) {
          return {
            status: 'forbidden', ok: false, retryable: true,
            reason: `HTTP ${getResponse.status} — Ảnh bị từ chối truy cập, có thể là anti-bot`,
            statusCode: getResponse.status,
          };
        }

        if (getResponse.status === 405) {
          return {
            status: 'not_allowed', ok: false, retryable: true,
            reason: 'HTTP 405 — Phương thức không được phép, không thể xác minh ảnh',
            statusCode: getResponse.status,
          };
        }

        // Rate limited — retryable, NOT image_broken
        if (getResponse.status === 429) {
          return {
            status: 'rate_limited', ok: false, retryable: true,
            reason: 'HTTP 429 — Rate limit, ảnh tạm thời không thể truy cập',
            statusCode: getResponse.status,
          };
        }

        // Server error — retryable, NOT image_broken
        if (getResponse.status >= 500) {
          return {
            status: 'server_error', ok: false, retryable: true,
            reason: `Server error HTTP ${getResponse.status} — tạm thời`,
            statusCode: getResponse.status,
          };
        }

        // Other 4xx
        return {
          status: 'error', ok: false, retryable: false,
          reason: `HTTP ${getResponse.status}`,
          statusCode: getResponse.status,
        };
      }

      const contentType = getResponse.headers.get('content-type') ?? '';

      // Cancel body download — we only need headers
      try { getResponse.body?.cancel(); } catch { /* ignore */ }

      if (!contentType.toLowerCase().startsWith('image/')) {
        return {
          status: 'invalid_image', ok: false, retryable: false,
          reason: contentType
            ? `Content-Type không phải ảnh: ${contentType}`
            : 'Không có Content-Type header',
          contentType: contentType || undefined,
          statusCode: getResponse.status,
        };
      }

      return {
        status: 'ok', ok: true, retryable: false,
        reason: 'Image OK (GET)',
        contentType,
        statusCode: getResponse.status,
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

    const response = await fetchSafeRedirects(affiliateUrl, 'HEAD', 3000, buildRequestHeaders('HEAD'));

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

    // For affiliate deeplink domains: any 2xx/3xx is OK
    // These domains redirect via JavaScript, not HTTP 30x
    if (isDeeplinkDomain) {
      if (response.ok || (response.status >= 200 && response.status < 400)) {
        return {
          status: 'ok',
          reason: `Affiliate deeplink OK (HTTP ${response.status}) — redirect via JS`,
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
