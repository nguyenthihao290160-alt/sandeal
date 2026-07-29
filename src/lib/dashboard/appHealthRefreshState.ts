export interface AppHealthRefreshState<T> {
  snapshot: T | null;
  stale: boolean;
  message: string;
  lastSuccessfulAt: string | null;
}

const APP_HEALTH_REFRESH_FALLBACK =
  'Không thể làm mới sức khỏe. Bản chụp hợp lệ gần nhất được giữ lại.';

export function appHealthRequestFailureMessage(error: unknown): string {
  const value = error && typeof error === 'object'
    ? error as { code?: unknown; status?: unknown }
    : {};
  const code = typeof value.code === 'string' ? value.code : '';
  const status = typeof value.status === 'number' && Number.isFinite(value.status)
    ? value.status
    : null;

  if (code === 'REQUEST_TIMEOUT') {
    return 'Yêu cầu làm mới đã hết thời gian chờ. Bản chụp hợp lệ gần nhất được giữ lại.';
  }
  if (status === 401 || status === 403) {
    return 'Phiên đăng nhập không có quyền xem sức khỏe vận hành.';
  }
  if (status !== null && status >= 500) {
    return 'Máy chủ chưa thể hoàn tất lần làm mới. Bản chụp hợp lệ gần nhất được giữ lại.';
  }
  if (code === 'INVALID_JSON' || code === 'EMPTY_RESPONSE') {
    return 'Phản hồi sức khỏe không hợp lệ. Bản chụp hợp lệ gần nhất được giữ lại.';
  }
  if (code === 'RESPONSE_TOO_LARGE') {
    return 'Phản hồi sức khỏe vượt giới hạn an toàn. Bản chụp hợp lệ gần nhất được giữ lại.';
  }
  return APP_HEALTH_REFRESH_FALLBACK;
}

export function initialAppHealthRefreshState<T>(): AppHealthRefreshState<T> {
  return { snapshot: null, stale: false, message: '', lastSuccessfulAt: null };
}

export function appHealthRefreshStarted<T>(
  current: AppHealthRefreshState<T>,
): AppHealthRefreshState<T> {
  return { ...current, message: '' };
}

export function appHealthRefreshSucceeded<T>(
  current: AppHealthRefreshState<T>,
  snapshot: T,
  options: { receivedAt: string; stale: boolean; message?: string },
): AppHealthRefreshState<T> {
  return {
    ...current,
    snapshot,
    stale: options.stale,
    message: options.message || '',
    lastSuccessfulAt: options.receivedAt,
  };
}

export function appHealthRefreshFailed<T>(
  current: AppHealthRefreshState<T>,
  message: string,
): AppHealthRefreshState<T> {
  return {
    ...current,
    snapshot: current.snapshot,
    stale: current.snapshot !== null,
    message,
  };
}
