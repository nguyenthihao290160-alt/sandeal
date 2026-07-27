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
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return null;
  const parts = address.split('.').map(Number);
  return parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

/**
 * Browser-safe literal address screening. Fetching code additionally performs
 * server-side DNS resolution and pins the validated public address.
 */
export function isPrivateNetworkAddress(address: string): boolean {
  const lower = address.toLowerCase().split('%')[0].replace(/^\[|\]$/g, '');
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
  if (lower.includes(':')) {
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
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) {
    return { safe: false, code: 'INVALID_URL' };
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { safe: false, code: 'UNSAFE_PROTOCOL' };
    }
    if (url.username || url.password) return { safe: false, code: 'CREDENTIALS_NOT_ALLOWED' };
    if (url.port && !['80', '443'].includes(url.port)) return { safe: false, code: 'UNSAFE_PORT' };
    if (isBlockedHostname(url.hostname)) return { safe: false, code: 'PRIVATE_NETWORK' };
    url.hash = '';
    return { safe: true, normalizedUrl: url.toString() };
  } catch {
    return { safe: false, code: 'INVALID_URL' };
  }
}
