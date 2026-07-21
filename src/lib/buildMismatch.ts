const SERVER_ACTION_MISMATCH = /failed to find server action|older or newer deployment|server action.*not found/i;

export function isBuildMismatchMessage(value: unknown): boolean {
  if (value instanceof Error) return SERVER_ACTION_MISMATCH.test(value.message);
  if (typeof value === 'string') return SERVER_ACTION_MISMATCH.test(value);
  if (value && typeof value === 'object' && 'message' in value) {
    return SERVER_ACTION_MISMATCH.test(String((value as { message?: unknown }).message || ''));
  }
  return false;
}

export function isComparableBuildId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !['development', 'unavailable'].includes(value);
}

export type RequestErrorClassification = 'STALE_CLIENT_ACTION_MISMATCH' | 'CURRENT_SERVER_ERROR';

export function classifyRequestError(value: unknown, routeType?: string): {
  classification: RequestErrorClassification;
  currentIncident: boolean;
  severity: 'INFO' | 'ERROR';
} {
  if (routeType === 'action' && isBuildMismatchMessage(value)) {
    return {
      classification: 'STALE_CLIENT_ACTION_MISMATCH',
      currentIncident: false,
      severity: 'INFO',
    };
  }
  return { classification: 'CURRENT_SERVER_ERROR', currentIncident: true, severity: 'ERROR' };
}
