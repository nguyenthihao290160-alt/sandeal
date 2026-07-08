// ===========================================
// Product Health Check — Standalone Helpers
// Check link & image health before AutoPilot publish
// Reusable across SourceScout, Approve Route, Cleanup
// ===========================================

// ---- Link Health Check ----

export type LinkCheckStatus =
  | 'ok'
  | 'broken'
  | 'not_allowed'
  | 'forbidden'
  | 'timeout'
  | 'error'
  | 'unknown';

export interface LinkCheckResult {
  status: LinkCheckStatus;
  ok: boolean;
  reason: string;
  statusCode?: number;
  finalUrl?: string;
}

// ---- Image Health Check ----

export type ImageCheckStatus =
  | 'ok'
  | 'image_broken'
  | 'invalid_image'
  | 'forbidden'
  | 'timeout'
  | 'error'
  | 'unknown';

export interface ImageCheckResult {
  status: ImageCheckStatus;
  ok: boolean;
  reason: string;
  statusCode?: number;
  contentType?: string;
}

// ---- Constants ----

const LINK_CHECK_TIMEOUT_MS = 10_000;
const IMAGE_CHECK_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 8_192; // 8KB — đủ để phát hiện lỗi text, không download lớn

/**
 * Các cụm lỗi phổ biến trên trang đích. Nếu body chứa một trong
 * những cụm này, link được coi là hỏng / bị chặn.
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
 * Domains mà HEAD thường không đủ tin cậy — cần GET để phát hiện lỗi
 * trong body (ví dụ AccessTrade trả 200 nhưng body chứa "Not Allowed!").
 */
const FORCE_GET_DOMAINS = [
  'go.isclix.com',
  'pub.accesstrade.vn',
  'accesstrade.vn',
];

// ---- Helpers ----

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
 * Đọc tối đa `maxBytes` từ response body dưới dạng text.
 * Tránh download toàn bộ body lớn.
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

// ---- Link Health Check ----

/**
 * Kiểm tra sức khỏe link sản phẩm / affiliate.
 *
 * - HEAD trước, nếu fail / 405 / 403 → GET fallback.
 * - Đọc body ngắn để phát hiện "Not Allowed!", "Forbidden", v.v.
 * - Đặc biệt với go.isclix.com / AccessTrade: luôn GET.
 * - Timeout 10 giây.
 * - Không crash nếu lỗi network/DNS.
 */
export async function checkLinkHealth(url: string): Promise<LinkCheckResult> {
  // Validate URL
  if (!url || !url.trim()) {
    return { status: 'error', ok: false, reason: 'URL rỗng' };
  }

  if (!isValidHttpUrl(url)) {
    return { status: 'error', ok: false, reason: 'URL không hợp lệ hoặc không phải http/https' };
  }

  const forceGet = shouldForceGet(url);

  try {
    // Step 1: HEAD request (bỏ qua nếu domain cần GET)
    if (!forceGet) {
      try {
        const headResponse = await fetch(url, {
          method: 'HEAD',
          redirect: 'follow',
          signal: AbortSignal.timeout(LINK_CHECK_TIMEOUT_MS),
        });

        if (headResponse.ok) {
          // HEAD 200 — link có vẻ ok, nhưng không đọc được body
          return {
            status: 'ok',
            ok: true,
            reason: 'HEAD 200 OK',
            statusCode: headResponse.status,
            finalUrl: headResponse.url || url,
          };
        }

        // HEAD fail rõ ràng
        if (headResponse.status === 404 || headResponse.status === 410) {
          return {
            status: 'broken',
            ok: false,
            reason: `HTTP ${headResponse.status} — không tìm thấy trang`,
            statusCode: headResponse.status,
          };
        }

        if (headResponse.status === 403) {
          // 403 từ HEAD có thể là server chặn HEAD, cần fallback GET
          // Fall through to GET
        } else if (headResponse.status === 405) {
          // Method not allowed — server không hỗ trợ HEAD, fallback GET
          // Fall through to GET
        } else if (headResponse.status >= 500) {
          return {
            status: 'broken',
            ok: false,
            reason: `Server error HTTP ${headResponse.status}`,
            statusCode: headResponse.status,
          };
        } else if (headResponse.status >= 400) {
          // Other 4xx — still try GET to confirm
          // Fall through to GET
        }
      } catch (headError) {
        // HEAD completely failed (network, timeout, etc.) — try GET
        if (headError instanceof Error && headError.name === 'TimeoutError') {
          return { status: 'timeout', ok: false, reason: 'HEAD request timeout' };
        }
        // Fall through to GET
      }
    }

    // Step 2: GET request (fallback hoặc forced)
    const getResponse = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(LINK_CHECK_TIMEOUT_MS),
    });

    if (getResponse.status === 404 || getResponse.status === 410) {
      return {
        status: 'broken',
        ok: false,
        reason: `HTTP ${getResponse.status} — không tìm thấy trang`,
        statusCode: getResponse.status,
      };
    }

    if (getResponse.status === 403) {
      return {
        status: 'forbidden',
        ok: false,
        reason: `HTTP 403 Forbidden`,
        statusCode: 403,
      };
    }

    if (getResponse.status >= 500) {
      return {
        status: 'broken',
        ok: false,
        reason: `Server error HTTP ${getResponse.status}`,
        statusCode: getResponse.status,
      };
    }

    if (getResponse.status >= 400) {
      return {
        status: 'broken',
        ok: false,
        reason: `HTTP ${getResponse.status}`,
        statusCode: getResponse.status,
      };
    }

    // Response is 2xx or 3xx — read limited body to check for error content
    const body = await readLimitedBody(getResponse, MAX_BODY_BYTES);
    const bodyMatch = matchBodyError(body);

    if (bodyMatch) {
      return {
        status: bodyMatch.status,
        ok: false,
        reason: bodyMatch.reason,
        statusCode: getResponse.status,
        finalUrl: getResponse.url || url,
      };
    }

    return {
      status: 'ok',
      ok: true,
      reason: `HTTP ${getResponse.status} OK`,
      statusCode: getResponse.status,
      finalUrl: getResponse.url || url,
    };
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        return { status: 'timeout', ok: false, reason: 'Request timeout (10s)' };
      }

      return {
        status: 'error',
        ok: false,
        reason: `Network error: ${error.message}`,
      };
    }

    return { status: 'unknown', ok: false, reason: 'Lỗi không xác định' };
  }
}

// ---- Image Health Check ----

/**
 * Kiểm tra sức khỏe imageUrl.
 *
 * - HEAD trước, nếu HEAD không đủ tin cậy → GET fallback.
 * - Check status 400–599 → fail.
 * - Check content-type phải image/* → fail nếu không.
 * - Timeout 8 giây.
 * - Không crash nếu lỗi network/DNS.
 */
export async function checkImageHealth(imageUrl: string): Promise<ImageCheckResult> {
  // Validate URL
  if (!imageUrl || !imageUrl.trim()) {
    return { status: 'error', ok: false, reason: 'Image URL rỗng' };
  }

  if (!isValidHttpUrl(imageUrl)) {
    return { status: 'error', ok: false, reason: 'Image URL không hợp lệ hoặc không phải http/https' };
  }

  try {
    // Step 1: HEAD request
    let headOk = false;
    let headContentType: string | null = null;

    try {
      const headResponse = await fetch(imageUrl, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(IMAGE_CHECK_TIMEOUT_MS),
      });

      if (headResponse.status >= 400) {
        if (headResponse.status === 403) {
          return {
            status: 'forbidden',
            ok: false,
            reason: 'HTTP 403 — ảnh bị chặn truy cập',
            statusCode: 403,
          };
        }

        if (headResponse.status === 404 || headResponse.status === 410) {
          return {
            status: 'image_broken',
            ok: false,
            reason: `HTTP ${headResponse.status} — ảnh không tồn tại`,
            statusCode: headResponse.status,
          };
        }

        if (headResponse.status >= 500) {
          return {
            status: 'image_broken',
            ok: false,
            reason: `Server error HTTP ${headResponse.status}`,
            statusCode: headResponse.status,
          };
        }

        // Other 4xx — try GET fallback
      } else {
        headOk = true;
        headContentType = headResponse.headers.get('content-type');

        // Check content-type from HEAD
        if (headContentType && !headContentType.toLowerCase().startsWith('image/')) {
          return {
            status: 'invalid_image',
            ok: false,
            reason: `Content-Type không phải ảnh: ${headContentType}`,
            contentType: headContentType,
            statusCode: headResponse.status,
          };
        }

        if (headContentType && headContentType.toLowerCase().startsWith('image/')) {
          return {
            status: 'ok',
            ok: true,
            reason: 'Image OK',
            contentType: headContentType,
            statusCode: headResponse.status,
          };
        }

        // HEAD 200 but no content-type — fallback to GET
      }
    } catch (headError) {
      if (headError instanceof Error && headError.name === 'TimeoutError') {
        return { status: 'timeout', ok: false, reason: 'HEAD request timeout (8s)' };
      }
      // Fall through to GET
    }

    // Step 2: GET fallback (nếu HEAD không có content-type hoặc fail)
    if (!headOk || !headContentType) {
      const getResponse = await fetch(imageUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(IMAGE_CHECK_TIMEOUT_MS),
      });

      if (getResponse.status >= 400) {
        if (getResponse.status === 403) {
          return {
            status: 'forbidden',
            ok: false,
            reason: 'HTTP 403 — ảnh bị chặn truy cập',
            statusCode: 403,
          };
        }

        return {
          status: 'image_broken',
          ok: false,
          reason: `HTTP ${getResponse.status}`,
          statusCode: getResponse.status,
        };
      }

      const contentType = getResponse.headers.get('content-type') ?? '';

      // Cancel body download — we only need headers
      try { getResponse.body?.cancel(); } catch { /* ignore */ }

      if (!contentType.toLowerCase().startsWith('image/')) {
        return {
          status: 'invalid_image',
          ok: false,
          reason: contentType
            ? `Content-Type không phải ảnh: ${contentType}`
            : 'Không có Content-Type header',
          contentType: contentType || undefined,
          statusCode: getResponse.status,
        };
      }

      return {
        status: 'ok',
        ok: true,
        reason: 'Image OK (GET)',
        contentType,
        statusCode: getResponse.status,
      };
    }

    // Should not reach here, but just in case
    return { status: 'unknown', ok: false, reason: 'Không xác định được trạng thái ảnh' };
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        return { status: 'timeout', ok: false, reason: 'Request timeout (8s)' };
      }

      return {
        status: 'error',
        ok: false,
        reason: `Network error: ${error.message}`,
      };
    }

    return { status: 'unknown', ok: false, reason: 'Lỗi không xác định' };
  }
}
