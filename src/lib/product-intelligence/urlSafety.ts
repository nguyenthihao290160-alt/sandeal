import { isIP } from 'net';
import { lookup } from 'dns/promises';

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  '169.254.169.254',
  '100.100.100.200',
]);

export interface UrlSafetyResult {
  safe: boolean;
  code?: 'INVALID_URL' | 'UNSAFE_PROTOCOL' | 'CREDENTIALS_NOT_ALLOWED' | 'PRIVATE_NETWORK' | 'UNSAFE_PORT';
  normalizedUrl?: string;
}

function ipv4Parts(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

export function isPrivateNetworkAddress(address: string): boolean {
  const lower = address.toLowerCase().split('%')[0];
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateNetworkAddress(mapped);
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPrivateNetworkAddress(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
  }
  const ipv4 = ipv4Parts(lower);
  if (ipv4) {
    const [a, b] = ipv4;
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  if (isIP(lower) === 6) {
    return lower === '::' || lower === '::1'
      || /^f[cd]/.test(lower)
      || /^fe[89ab]/.test(lower)
      || /^ff/.test(lower);
  }
  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return BLOCKED_HOSTS.has(host)
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.home')
    || host.endsWith('.lan')
    || isPrivateNetworkAddress(host);
}

export function validateExternalUrl(value: unknown): UrlSafetyResult {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) return { safe: false, code: 'INVALID_URL' };
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { safe: false, code: 'UNSAFE_PROTOCOL' };
    if (url.username || url.password) return { safe: false, code: 'CREDENTIALS_NOT_ALLOWED' };
    if (url.port && !['80', '443'].includes(url.port)) return { safe: false, code: 'UNSAFE_PORT' };
    if (isBlockedHostname(url.hostname)) return { safe: false, code: 'PRIVATE_NETWORK' };
    url.hash = '';
    return { safe: true, normalizedUrl: url.toString() };
  } catch {
    return { safe: false, code: 'INVALID_URL' };
  }
}

export async function assertPublicDns(hostname: string): Promise<void> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record => isPrivateNetworkAddress(record.address))) {
    throw new Error('PRIVATE_NETWORK');
  }
}

export async function fetchExternalSafely(
  value: string,
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    resolveDns?: boolean;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ response: Response; finalUrl: string; body: Uint8Array }> {
  const timeoutMs = Math.max(500, Math.min(options.timeoutMs || 8_000, 20_000));
  const maxBytes = Math.max(1_024, Math.min(options.maxBytes || 512 * 1_024, 2 * 1024 * 1024));
  const maxRedirects = Math.max(0, Math.min(options.maxRedirects ?? 4, 5));
  const fetchImpl = options.fetchImpl || fetch;
  let current = value;
  const visited = new Set<string>();
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const validated = validateExternalUrl(current);
    if (!validated.safe || !validated.normalizedUrl) throw new Error(validated.code || 'INVALID_URL');
    current = validated.normalizedUrl;
    if (visited.has(current)) throw new Error('REDIRECT_LOOP');
    visited.add(current);
    const parsed = new URL(current);
    if (options.resolveDns !== false) await assertPublicDns(parsed.hostname);
    const response = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'text/html,application/json;q=0.9,*/*;q=0.1', Range: `bytes=0-${maxBytes - 1}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (redirect === maxRedirects) throw new Error('TOO_MANY_REDIRECTS');
      current = new URL(response.headers.get('location')!, current).toString();
      continue;
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    if (!response.body) return { response, finalUrl: current, body: new Uint8Array() };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('RESPONSE_TOO_LARGE');
      }
      chunks.push(chunk);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return { response, finalUrl: current, body };
  }
  throw new Error('TOO_MANY_REDIRECTS');
}
