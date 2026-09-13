import { createRuntimeStorage, withStorageAdapter, type D1Binding } from '../../storage/runtimeStorage';
import { createD1StorageAdapter } from '../../storage/d1/d1StorageAdapter';
import type { D1Database } from '../../storage/d1/database';
import { ShopeeAffiliateProvider } from '../../affiliate/shopeeAffiliateProvider';
import type { QueueBinding } from '../../platform/cloudflareContracts';

export interface CloudflareEnvironment {
  SANDEAL_RUNTIME: string;
  SANDEAL_LOCAL_ONLY: string;
  SANDEAL_PRODUCTION: string;
  DB?: D1Binding;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  SHOPEE_AFFILIATE_ENABLED?: string;
  SHOPEE_APP_ID?: string;
  SHOPEE_API_KEY?: string;
  BASIC_AUTH_USER?: string;
  BASIC_AUTH_PASSWORD?: string;
  AFFILIATE_REDIRECT_HOSTS?: string;
  SANDEAL_AUTOPILOT_ENABLED?: string;
  JOB_QUEUE?: QueueBinding;
  SANDEAL_MONEY_ENGINE_ENABLED?: string;
  SANDEAL_DEAL_INTELLIGENCE_ENABLED?: string;
  SANDEAL_DECISION_OS_ENABLED?: string;
  SANDEAL_DECISION_EXECUTION_MODE?: string;
  SANDEAL_OPPORTUNITY_ENABLED?: string;
}

export class CloudflareRequestError extends Error {
  constructor(readonly code: string, readonly status = 503) { super(code); }
}

export function cloudflareContext(env: CloudflareEnvironment) {
  if (env.SANDEAL_RUNTIME !== 'cloudflare' || env.SANDEAL_LOCAL_ONLY !== 'true' || env.SANDEAL_PRODUCTION !== 'false') {
    throw new CloudflareRequestError('CLOUDFLARE_LOCAL_RUNTIME_REQUIRED');
  }
  const adapter = createRuntimeStorage({ runtime: env.SANDEAL_RUNTIME, bindings: { DB: env.DB }, createD1: createD1StorageAdapter },
    () => { throw new CloudflareRequestError('LEGACY_STORAGE_FORBIDDEN'); });
  const provider = new ShopeeAffiliateProvider({ SHOPEE_AFFILIATE_ENABLED: env.SHOPEE_AFFILIATE_ENABLED ?? 'false',
    SHOPEE_APP_ID: env.SHOPEE_APP_ID, SHOPEE_API_KEY: env.SHOPEE_API_KEY });
  return { adapter, db: env.DB as D1Database, domain: adapter.domain!, settings: adapter.settingsStore!, provider,
    run<T>(work: () => T): T { return withStorageAdapter(adapter, work); } };
}

export async function dependencyStatus(env: CloudflareEnvironment) {
  const context = cloudflareContext(env);
  // Verify schema and a real read, rather than treating a binding's presence as readiness.
  await context.domain.listProducts({ limit: 1 });
  await context.settings.read('automation');
  const shopee = await context.provider.healthCheck();
  const providerValid = ['DISABLED_NO_CREDENTIALS', 'DISABLED'].includes(shopee.state);
  return { ok: providerValid, runtime: 'cloudflare', d1: 'PASS', remote: false, production: false,
    dependencies: { storage: 'READY', shopee: shopee.state, accesstrade: 'DISABLED_LOCAL_RUNTIME', tiktok: 'DISABLED_LOCAL_RUNTIME' } };
}
