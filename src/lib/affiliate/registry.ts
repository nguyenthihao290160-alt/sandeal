import {
  AccessTradeAffiliateProvider,
  AccessTradeTikTokAffiliateProvider,
} from './accessTradeProviders';
import { ShopeeAffiliateProvider } from './shopeeAffiliateProvider';
import {
  providerUnavailable,
  type AffiliateProvider,
  type AffiliateProviderId,
  type AffiliateProviderUnavailable,
} from './types';

export interface AffiliateProviderSelectionSuccess {
  ok: true;
  provider: AffiliateProvider;
}

export type AffiliateProviderSelection =
  | AffiliateProviderSelectionSuccess
  | AffiliateProviderUnavailable;

function canonicalProviderId(value: string): AffiliateProviderId | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'accesstrade') return 'accesstrade';
  if (
    normalized === 'tiktok'
    || normalized === 'accesstrade-tiktok'
    || normalized === 'accesstrade_tiktok_shop'
  ) return 'tiktok';
  if (normalized === 'shopee') return 'shopee';
  return null;
}

export class AffiliateProviderRegistry {
  private readonly providers = new Map<AffiliateProviderId, AffiliateProvider>();

  register(provider: AffiliateProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`AFFILIATE_PROVIDER_ALREADY_REGISTERED:${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  select(id: string): AffiliateProviderSelection {
    const canonical = canonicalProviderId(id);
    const provider = canonical ? this.providers.get(canonical) : undefined;
    if (provider) return { ok: true, provider };
    return providerUnavailable(
      'unknown',
      'discoverProducts',
      'UNKNOWN_PROVIDER',
      'INVALID_CONFIGURATION',
    );
  }

  list(): AffiliateProvider[] {
    return [...this.providers.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}

export function createDefaultAffiliateProviderRegistry(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AffiliateProviderRegistry {
  const registry = new AffiliateProviderRegistry();
  registry.register(new AccessTradeAffiliateProvider());
  registry.register(new AccessTradeTikTokAffiliateProvider());
  registry.register(new ShopeeAffiliateProvider(environment));
  return registry;
}

export function selectAffiliateProvider(
  id: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AffiliateProviderSelection {
  return createDefaultAffiliateProviderRegistry(environment).select(id);
}
