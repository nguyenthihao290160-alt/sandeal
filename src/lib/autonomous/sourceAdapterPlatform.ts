import {
  AccessTradeRequestError,
  isAccessTradeConfigured,
  searchAccessTrade,
  type AccessTradeResultType,
  type NormalizedAccessTradeItem,
} from '@/lib/integrations/accesstrade';

export const SOURCE_ADAPTER_PLATFORM_VERSION = 'source-adapter-platform-v1';

export type SourceProviderStatus =
  | 'not_configured'
  | 'configured'
  | 'adapter_unavailable'
  | 'ready'
  | 'degraded'
  | 'circuit_open'
  | 'rate_limited'
  | 'invalid_credential'
  | 'quota_exhausted'
  | 'last_check_failed';

export interface SourceBudget {
  maximumRequests: number;
  usedRequests: number;
  remainingRequests: number;
  resetAt?: string;
}

export interface SourceHealth {
  status: SourceProviderStatus;
  configured: boolean;
  ready: boolean;
  checkedAt?: string;
  reason?: string;
}

export interface SourceDiscoveryInput {
  keyword: string;
  limit: number;
}

export interface SourceDiscoveryResult<T> {
  items: T[];
  requests: number;
  retryAfter?: string;
  outcomes?: Record<string, number>;
}

export interface ProductSourceAdapter<TSource = unknown, TNormalized = unknown> {
  readonly id: string;
  readonly version: string;
  isConfigured(): Promise<boolean>;
  healthCheck(options?: { probe?: boolean }): Promise<SourceHealth>;
  discover(input: SourceDiscoveryInput): Promise<SourceDiscoveryResult<TSource>>;
  normalize(item: TSource): TNormalized;
  budget(): Promise<SourceBudget>;
  classifyError(error: unknown): SourceProviderStatus;
  retryAfter(error: unknown): string | undefined;
  disclosure(): Record<string, unknown>;
}

export interface AccessTradeAdapterDependencies {
  configured?: () => Promise<boolean>;
  discover?: typeof searchAccessTrade;
  healthProbe?: () => Promise<boolean | SourceHealth>;
  getBudget?: () => Promise<SourceBudget>;
}

function assertLoopbackMockUrl(value: string): URL {
  if (process.env.NODE_ENV !== 'test') throw new Error('MOCK_SOURCE_TEST_ONLY');
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('MOCK_SOURCE_LOOPBACK_REQUIRED');
  }
  return url;
}

export interface SourceAdapterPlatformDisclosure {
  id: string;
  version: string;
  platformVersion: string;
  details: Record<string, unknown>;
}

const SENSITIVE_DISCLOSURE_KEYS = new Set([
  'apikey',
  'api_key',
  'accesskey',
  'access_key',
  'token',
  'accesstoken',
  'access_token',
  'secret',
  'password',
  'authorization',
]);

function normalizeDisclosure(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeDisclosure);
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /^(?:bearer|basic)\s+/i.test(value.trim())) return '[redacted]';
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_DISCLOSURE_KEYS.has(key.toLowerCase()) ? '[redacted]' : normalizeDisclosure(item);
  }
  return output;
}

function normalizeBudget(value: SourceBudget): SourceBudget {
  const maximumRequests = Math.max(0, Math.floor(Number(value.maximumRequests) || 0));
  const usedRequests = Math.max(0, Math.min(maximumRequests, Math.floor(Number(value.usedRequests) || 0)));
  return {
    maximumRequests,
    usedRequests,
    remainingRequests: Math.max(0, Math.min(maximumRequests - usedRequests, Math.floor(Number(value.remainingRequests) || 0))),
    resetAt: value.resetAt && Number.isFinite(Date.parse(value.resetAt)) ? new Date(value.resetAt).toISOString() : undefined,
  };
}

function normalizeHealth(value: SourceHealth, configured: boolean): SourceHealth {
  const ready = configured && value.status === 'ready' && value.ready === true;
  return {
    status: configured ? (ready ? 'ready' : value.status === 'ready' ? 'last_check_failed' : value.status) : 'not_configured',
    configured,
    ready,
    checkedAt: value.checkedAt && Number.isFinite(Date.parse(value.checkedAt)) ? new Date(value.checkedAt).toISOString() : undefined,
    reason: value.reason?.slice(0, 200),
  };
}

export class SourceAdapterRegistry {
  private readonly adapters = new Map<string, ProductSourceAdapter<unknown, unknown>>();

  register<TSource, TNormalized>(adapter: ProductSourceAdapter<TSource, TNormalized>): void {
    const id = adapter.id.trim().toLowerCase();
    if (!id || !adapter.version.trim()) throw new Error('SOURCE_ADAPTER_CONTRACT_INVALID');
    if (this.adapters.has(id)) throw new Error(`SOURCE_ADAPTER_ALREADY_REGISTERED:${id}`);
    this.adapters.set(id, adapter as ProductSourceAdapter<unknown, unknown>);
  }

  get<TSource = unknown, TNormalized = unknown>(id: string): ProductSourceAdapter<TSource, TNormalized> | null {
    return (this.adapters.get(id.trim().toLowerCase()) as ProductSourceAdapter<TSource, TNormalized> | undefined) || null;
  }

  list(): ProductSourceAdapter<unknown, unknown>[] {
    return [...this.adapters.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  disclosures(): SourceAdapterPlatformDisclosure[] {
    return this.list().map(adapter => ({
      id: adapter.id,
      version: adapter.version,
      platformVersion: SOURCE_ADAPTER_PLATFORM_VERSION,
      details: normalizeDisclosure(adapter.disclosure()) as Record<string, unknown>,
    }));
  }

  async health(options: { probe?: boolean } = {}): Promise<Record<string, SourceHealth>> {
    const entries = await Promise.all(this.list().map(async adapter => [adapter.id, await adapter.healthCheck(options)] as const));
    return Object.fromEntries(entries);
  }
}

function retryAfterFromError(error: unknown): string | undefined {
  if (error instanceof AccessTradeRequestError) {
    return error.requests.map(request => request.retryAfter).filter((item): item is string => Boolean(item)).sort().at(-1);
  }
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  return typeof record.retryAfter === 'string' ? record.retryAfter : undefined;
}

export function createAccessTradeSourceAdapter(dependencies: AccessTradeAdapterDependencies = {}): ProductSourceAdapter<NormalizedAccessTradeItem, NormalizedAccessTradeItem> {
  const configured = dependencies.configured || isAccessTradeConfigured;
  const discover = dependencies.discover || searchAccessTrade;
  return {
    id: 'accesstrade',
    version: 'accesstrade-adapter-v1',
    isConfigured: configured,
    async healthCheck(options = {}) {
      const isConfigured = await configured();
      if (!isConfigured) return { status: 'not_configured', configured: false, ready: false };
      if (!options.probe) return { status: 'configured', configured: true, ready: false, reason: 'live_probe_not_run' };
      if (!dependencies.healthProbe) return { status: 'adapter_unavailable', configured: true, ready: false, reason: 'health_probe_unavailable' };
      try {
        const probe = await dependencies.healthProbe();
        const checkedAt = new Date().toISOString();
        if (typeof probe === 'boolean') {
          return { status: probe ? 'ready' : 'last_check_failed', configured: true, ready: probe, checkedAt };
        }
        return normalizeHealth({ ...probe, checkedAt: probe.checkedAt || checkedAt }, true);
      } catch (error) {
        return { status: this.classifyError(error), configured: true, ready: false, checkedAt: new Date().toISOString(), reason: 'health_probe_failed' };
      }
    },
    async discover(input) {
      if (!(await configured())) throw new Error('SOURCE_NOT_CONFIGURED');
      const result = await discover({ keyword: input.keyword.trim().slice(0, 160), kind: 'product', limit: Math.max(1, Math.min(50, Math.floor(input.limit || 1))) });
      return {
        items: result.items,
        requests: result.requests.reduce((total, request) => total + Math.max(0, request.attempts ?? 1), 0),
        retryAfter: result.requests.map(request => request.retryAfter).filter((item): item is string => Boolean(item)).sort().at(-1),
        outcomes: result.requests.reduce<Record<string, number>>((outcomes, request) => {
          outcomes[request.resultType] = (outcomes[request.resultType] || 0) + 1;
          return outcomes;
        }, {}),
      };
    },
    normalize(item) {
      const safe = { ...item };
      delete safe.rawData;
      return safe;
    },
    async budget() {
      return normalizeBudget(await (dependencies.getBudget?.() || Promise.resolve({ maximumRequests: 0, usedRequests: 0, remainingRequests: 0 })));
    },
    classifyError(error) {
      if (error instanceof AccessTradeRequestError) {
        const map: Partial<Record<AccessTradeResultType, SourceProviderStatus>> = {
          rate_limited: 'rate_limited', unauthorized: 'invalid_credential', forbidden: 'invalid_credential',
          circuit_open: 'circuit_open', timeout: 'degraded', network_error: 'degraded', upstream_error: 'degraded',
        };
        return map[error.resultType] || 'last_check_failed';
      }
      return 'last_check_failed';
    },
    retryAfter: retryAfterFromError,
    disclosure() {
      return {
        id: 'accesstrade',
        version: 'accesstrade-adapter-v1',
        providerType: 'affiliate-product-source',
        paidProvider: false,
        credentialExposed: false,
        configuredIsReady: false,
        discoveryKinds: ['product'],
      };
    },
  };
}

/** Test-only adapter used by the full-stack smoke. It cannot target a remote host. */
export function createLoopbackMockSourceAdapter(endpoint: string): ProductSourceAdapter<NormalizedAccessTradeItem, NormalizedAccessTradeItem> {
  const baseUrl = assertLoopbackMockUrl(endpoint);
  return {
    id: 'accesstrade',
    version: 'loopback-mock-source-v1',
    async isConfigured() { return true; },
    async healthCheck() {
      return { status: 'ready', configured: true, ready: true, checkedAt: new Date().toISOString(), reason: 'loopback_mock_source' };
    },
    async discover(input) {
      const url = new URL(baseUrl);
      url.searchParams.set('keyword', input.keyword.slice(0, 160));
      url.searchParams.set('limit', String(Math.max(1, Math.min(50, Math.floor(input.limit || 1)))));
      const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(2_000) });
      if (!response.ok) throw new Error(`MOCK_SOURCE_HTTP_${response.status}`);
      const body = await response.json() as { items?: unknown };
      if (!Array.isArray(body.items)) throw new Error('MOCK_SOURCE_INVALID_RESPONSE');
      const items = body.items.filter((item): item is NormalizedAccessTradeItem => Boolean(item && typeof item === 'object'));
      return { items, requests: 0, outcomes: { [items.length ? 'success_with_results' : 'success_empty']: 1 } };
    },
    normalize(item) {
      const safe = { ...item };
      delete safe.rawData;
      return safe;
    },
    async budget() { return { maximumRequests: 2_000, usedRequests: 0, remainingRequests: 2_000 }; },
    classifyError(error) {
      return /timeout|abort/i.test(error instanceof Error ? `${error.name}:${error.message}` : String(error)) ? 'degraded' : 'last_check_failed';
    },
    retryAfter() { return undefined; },
    disclosure() {
      return { id: 'accesstrade', version: 'loopback-mock-source-v1', providerType: 'test-fixture', credentialExposed: false, loopbackOnly: true };
    },
  };
}

export function createDefaultSourceAdapterRegistry(dependencies: { accessTrade?: AccessTradeAdapterDependencies } = {}): SourceAdapterRegistry {
  const registry = new SourceAdapterRegistry();
  const mockEndpoint = process.env.NODE_ENV === 'test' ? process.env.SANDEAL_MOCK_SOURCE_URL?.trim() : '';
  registry.register(mockEndpoint && !dependencies.accessTrade
    ? createLoopbackMockSourceAdapter(mockEndpoint)
    : createAccessTradeSourceAdapter(dependencies.accessTrade));
  return registry;
}
