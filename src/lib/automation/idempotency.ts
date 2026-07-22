export const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9:_-]{8,160}$/;
export const DEFAULT_IDEMPOTENCY_WINDOW_MS = 5 * 60_000;

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value.trim());
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
    .join(',')}}`;
}

/** A deterministic browser-safe digest for operation scope; it is not a secret. */
function scopeDigest(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${first.toString(36)}${second.toString(36)}`;
}

export function buildIdempotencyKey(input: {
  scope: string;
  values?: Record<string, unknown>;
  nowMs?: number;
  windowMs?: number;
}): string {
  const scope = input.scope.toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96);
  const windowMs = Math.max(60_000, input.windowMs || DEFAULT_IDEMPOTENCY_WINDOW_MS);
  const bucket = Math.floor((input.nowMs ?? Date.now()) / windowMs).toString(36);
  const digest = scopeDigest(stableSerialize(input.values || {}));
  const key = `${scope}:${bucket}:${digest}`.slice(0, 160);
  if (!isValidIdempotencyKey(key)) throw new Error('INVALID_IDEMPOTENCY_SCOPE');
  return key;
}
