export type GeminiProviderErrorCategory =
  | 'INVALID_KEY'
  | 'PERMISSION_DENIED'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'MODEL_NOT_AVAILABLE'
  | 'REGION_RESTRICTED'
  | 'NETWORK_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'TRANSIENT_ERROR'
  | 'UNKNOWN_PROVIDER_ERROR';

export interface GeminiProviderDiagnostic {
  httpStatus?: number;
  category: GeminiProviderErrorCategory;
  retryable: boolean;
  retryAfterMs?: number;
}

export const GEMINI_MIN_COOLDOWN_MS = 30_000;
export const GEMINI_MAX_COOLDOWN_MS = 6 * 60 * 60_000;

const RETRYABLE_CATEGORIES = new Set<GeminiProviderErrorCategory>([
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'NETWORK_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'TRANSIENT_ERROR',
]);

export async function classifyGeminiProviderResponse(response: Response): Promise<GeminiProviderDiagnostic> {
  const httpStatus = safeHttpStatus(response.status);
  const hints = await readProviderHints(response);
  let category: GeminiProviderErrorCategory;

  if (response.status === 401) category = 'INVALID_KEY';
  else if (response.status === 403 && /region|location|country|territor|geo|not supported in your/i.test(hints)) category = 'REGION_RESTRICTED';
  else if (response.status === 403 && /api.?key.*invalid|invalid.*api.?key|key expired|key revoked/i.test(hints)) category = 'INVALID_KEY';
  else if (response.status === 403) category = 'PERMISSION_DENIED';
  else if (response.status === 404 || /model.*(?:not found|not available|unsupported)|unsupported.*model/i.test(hints)) category = 'MODEL_NOT_AVAILABLE';
  else if (response.status === 429 && /quota|resource_exhausted|limit.*exceed|billing/i.test(hints)) category = 'QUOTA_EXCEEDED';
  else if (response.status === 429) category = 'RATE_LIMITED';
  else if (response.status === 408 || response.status === 504) category = 'NETWORK_TIMEOUT';
  else if ([500, 502, 503].includes(response.status)) category = 'PROVIDER_UNAVAILABLE';
  else if (response.status === 400 && /api.?key.*invalid|invalid.*api.?key|key expired|key revoked/i.test(hints)) category = 'INVALID_KEY';
  else if (response.status >= 500) category = 'PROVIDER_UNAVAILABLE';
  else category = 'UNKNOWN_PROVIDER_ERROR';

  return {
    httpStatus,
    category,
    retryable: RETRYABLE_CATEGORIES.has(category),
    retryAfterMs: parseGeminiRetryAfter(response.headers.get('retry-after')),
  };
}

export function classifyGeminiProviderException(error: unknown): GeminiProviderDiagnostic {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  const causeCode = error instanceof Error && error.cause && typeof error.cause === 'object'
    ? String((error.cause as { code?: unknown }).code || '')
    : '';
  const category: GeminiProviderErrorCategory =
    name === 'AbortError' || name === 'TimeoutError' || /timeout|timed out|etimedout/i.test(`${message} ${causeCode}`)
      ? 'NETWORK_TIMEOUT'
      : 'TRANSIENT_ERROR';
  return { category, retryable: true };
}

export function computeGeminiCooldownMs(
    category: GeminiProviderErrorCategory,
    failureStreak: number,
    retryAfterMs?: number,
): number | undefined {
  if (!RETRYABLE_CATEGORIES.has(category)) return undefined;
  const boundedStreak = Math.max(1, Math.min(10, Math.floor(failureStreak || 1)));
  const base = category === 'QUOTA_EXCEEDED' ? 5 * 60_000
    : category === 'RATE_LIMITED' ? 60_000
      : 30_000;
  const categoryMax = category === 'QUOTA_EXCEEDED' ? GEMINI_MAX_COOLDOWN_MS
    : category === 'RATE_LIMITED' ? 60 * 60_000
      : 30 * 60_000;
  const exponential = Math.min(categoryMax, base * (2 ** (boundedStreak - 1)));
  if (!retryAfterMs) return exponential;
  return Math.min(GEMINI_MAX_COOLDOWN_MS, Math.max(GEMINI_MIN_COOLDOWN_MS, exponential, retryAfterMs));
}

export function geminiDiagnosticMessage(category: GeminiProviderErrorCategory, testedModel?: string): string {
  const model = testedModel ? ` (${testedModel})` : '';
  switch (category) {
    case 'INVALID_KEY': return 'Khóa Gemini không hợp lệ, đã hết hạn hoặc bị thu hồi. Hãy kiểm tra cấu hình khóa.';
    case 'PERMISSION_DENIED': return `Khóa Gemini chưa có quyền tạo nội dung với mô hình đã thử${model}.`;
    case 'QUOTA_EXCEEDED': return 'Hạn mức Gemini hiện đã hết. Hệ thống sẽ thử lại sau thời gian chờ có giới hạn.';
    case 'RATE_LIMITED': return 'Gemini đang giới hạn tốc độ. Hệ thống sẽ thử lại sau thời gian chờ có giới hạn.';
    case 'MODEL_NOT_AVAILABLE': return `Mô hình Gemini đã chọn không khả dụng cho khóa này${model}.`;
    case 'REGION_RESTRICTED': return 'Gemini không khả dụng tại khu vực hoặc dự án hiện tại.';
    case 'NETWORK_TIMEOUT': return 'Yêu cầu kiểm tra Gemini hết thời gian chờ. Có thể thử lại sau.';
    case 'PROVIDER_UNAVAILABLE': return 'Dịch vụ Gemini đang tạm thời không khả dụng. Có thể thử lại sau.';
    case 'TRANSIENT_ERROR': return 'Kết nối Gemini gặp lỗi tạm thời. Có thể thử lại sau.';
    default: return 'Gemini trả về lỗi chưa xác định; khóa vẫn chưa được đánh dấu sẵn sàng tạo nội dung.';
  }
}

function safeHttpStatus(value: number): number | undefined {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function parseGeminiRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(GEMINI_MAX_COOLDOWN_MS, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date) || date <= Date.now()) return undefined;
  return Math.min(GEMINI_MAX_COOLDOWN_MS, date - Date.now());
}

async function readProviderHints(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 16_384);
    if (!text) return '';
    try {
      const parsed = JSON.parse(text) as {
        error?: { status?: unknown; message?: unknown; details?: unknown };
      };
      return JSON.stringify({
        status: parsed.error?.status,
        message: parsed.error?.message,
        details: parsed.error?.details,
      }).slice(0, 8_192);
    } catch {
      return text.slice(0, 2_048);
    }
  } catch {
    return '';
  }
}
