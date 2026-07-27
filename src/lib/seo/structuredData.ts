import { validateExternalUrl } from '@/lib/product-intelligence/urlValidation';

const MAX_JSON_LD_BYTES = 256 * 1024;

export function structuredDataText(value: unknown, maximum = 4_096): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? normalized.slice(0, Math.max(1, maximum)) : undefined;
}

export function verifiedPublicHttpsUrl(value: unknown): string | undefined {
  const validation = validateExternalUrl(value);
  if (!validation.safe || !validation.normalizedUrl) return undefined;
  const parsed = new URL(validation.normalizedUrl);
  return parsed.protocol === 'https:' ? parsed.toString() : undefined;
}

export function futureStructuredDataDate(value: unknown, now = Date.now()): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(now)) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= now) return undefined;
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function serializeJsonLd(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('JSON_LD_PAYLOAD_INVALID');
  }
  if (
    serialized === undefined
    || Buffer.byteLength(serialized, 'utf8') > MAX_JSON_LD_BYTES
  ) {
    throw new Error('JSON_LD_PAYLOAD_INVALID');
  }
  return serialized
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
