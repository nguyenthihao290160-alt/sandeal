import {
  createAccessTradeSourceAdapter,
  createAccessTradeTikTokSourceAdapter,
  type ProductSourceAdapter,
  type SourceHealth,
} from '@/lib/autonomous/sourceAdapterPlatform';
import type { NormalizedAccessTradeItem } from '@/lib/integrations/accesstrade';
import {
  createAccessTradeTikTokAffiliateLink,
  type NormalizedAccessTradeTikTokProduct,
} from '@/lib/integrations/accesstradeTikTokShop';
import {
  AFFILIATE_PROVIDER_CONTRACT_VERSION,
  providerSuccess,
  providerUnavailable,
  type AffiliateDiscoveryInput,
  type AffiliateProduct,
  type AffiliateProvider,
  type AffiliateProviderHealth,
  type AffiliateProviderHealthState,
  type AffiliateProviderOperation,
  type AffiliateProviderResult,
  type AffiliateTrackingLink,
  type AffiliateTrackingLinkInput,
} from './types';

function boundedLimit(value: number | undefined): number {
  return Math.max(1, Math.min(50, Math.floor(value || 20)));
}

function healthState(health: SourceHealth): AffiliateProviderHealthState {
  if (health.status === 'ready' && health.ready) return 'READY';
  if (health.status === 'configured') return 'CONFIGURED_NOT_VERIFIED';
  if (health.status === 'not_configured') return 'NOT_CONFIGURED';
  return 'DEGRADED';
}

function normalizedHealth(
  provider: 'accesstrade' | 'tiktok',
  health: SourceHealth,
): AffiliateProviderHealth {
  return {
    provider,
    state: healthState(health),
    enabled: true,
    configured: health.configured,
    ready: health.ready,
    credentialsPresent: health.credentialsPresent ?? health.configured,
    checkedAt: health.checkedAt || new Date().toISOString(),
    reasonCode: health.reason,
  };
}

function affiliateProduct<T extends NormalizedAccessTradeItem>(
  provider: 'accesstrade' | 'tiktok',
  item: T,
): AffiliateProduct<T> {
  return {
    provider,
    externalId: item.id,
    title: item.name,
    productUrl: item.canonicalProductUrl || item.originalUrl,
    affiliateUrl: item.affiliateUrl || undefined,
    imageUrl: item.imageUrl || undefined,
    price: Number(item.salePrice || item.price) || undefined,
    currency: 'VND',
    source: item.source || provider,
    sourcePayload: item,
  };
}

abstract class AccessTradeProviderBase<T extends NormalizedAccessTradeItem>
implements AffiliateProvider<T> {
  abstract readonly id: 'accesstrade' | 'tiktok';
  readonly contractVersion = AFFILIATE_PROVIDER_CONTRACT_VERSION;

  constructor(protected readonly adapter: ProductSourceAdapter<T, T>) {}

  getCapabilities() {
    return { discovery: true, trackingLink: this.id === 'tiktok', conversionEvidence: false,
      commissionEvidence: false, clickReference: this.id === 'tiktok' ? 'SUB1' as const : 'UNAVAILABLE' as const };
  }

  async healthCheck(): Promise<AffiliateProviderHealth> {
    return normalizedHealth(this.id, await this.adapter.healthCheck());
  }

  protected unsupported(operation: AffiliateProviderOperation) {
    return providerUnavailable(
      this.id,
      operation,
      'NOT_SUPPORTED',
      'CONFIGURED_NOT_VERIFIED',
    );
  }

  async discoverProducts(input: AffiliateDiscoveryInput = {}) {
    if (!await this.adapter.isConfigured()) {
      return providerUnavailable(
        this.id,
        'discoverProducts',
        'MISSING_CREDENTIALS',
        'NOT_CONFIGURED',
      );
    }
    try {
      const result = await this.adapter.discover({
        keyword: String(input.keyword || '').trim().slice(0, 160),
        limit: boundedLimit(input.limit),
        strategy: input.strategy,
      });
      return providerSuccess(this.id, {
        products: result.items.map(item => affiliateProduct(this.id, this.adapter.normalize(item))),
        requestCount: result.requests,
        retryAfter: result.retryAfter,
      });
    } catch (error) {
      const status = this.adapter.classifyError(error);
      return providerUnavailable(
        this.id,
        'discoverProducts',
        'PROVIDER_ERROR',
        'DEGRADED',
        ['degraded', 'rate_limited', 'circuit_open'].includes(status),
      );
    }
  }

  async getProduct() {
    return this.unsupported('getProduct');
  }

  async getOffers() {
    return this.unsupported('getOffers');
  }

  async getPromotions() {
    return this.unsupported('getPromotions');
  }

  async createTrackingLink(
    _input: AffiliateTrackingLinkInput,
  ): Promise<AffiliateProviderResult<AffiliateTrackingLink>> {
    void _input;
    return this.unsupported('createTrackingLink');
  }

  async syncTransactions() {
    return this.unsupported('syncTransactions');
  }

  async syncCommissions() {
    return this.unsupported('syncCommissions');
  }
}

export class AccessTradeAffiliateProvider extends AccessTradeProviderBase<NormalizedAccessTradeItem> {
  readonly id = 'accesstrade' as const;

  constructor(
    adapter: ProductSourceAdapter<NormalizedAccessTradeItem, NormalizedAccessTradeItem>
      = createAccessTradeSourceAdapter(),
  ) {
    super(adapter);
  }
}

export class AccessTradeTikTokAffiliateProvider
  extends AccessTradeProviderBase<NormalizedAccessTradeTikTokProduct> {
  readonly id = 'tiktok' as const;

  constructor(
    adapter: ProductSourceAdapter<NormalizedAccessTradeTikTokProduct, NormalizedAccessTradeTikTokProduct>
      = createAccessTradeTikTokSourceAdapter(),
    private readonly createLink = createAccessTradeTikTokAffiliateLink,
  ) {
    super(adapter);
  }

  override async createTrackingLink(input: AffiliateTrackingLinkInput) {
    if (!await this.adapter.isConfigured()) {
      return providerUnavailable(
        this.id,
        'createTrackingLink',
        'MISSING_CREDENTIALS',
        'NOT_CONFIGURED',
      );
    }
    try {
      const link = await this.createLink({
        productUrl: input.productUrl,
        productId: input.productExternalId,
        tracking: {
          utmSource: input.tracking?.source,
          utmMedium: input.tracking?.medium,
          utmCampaign: input.tracking?.campaign,
          utmContent: input.tracking?.content,
          sub1: input.tracking?.sub1,
          sub2: input.tracking?.sub2,
          sub3: input.tracking?.sub3,
          sub4: input.tracking?.sub4,
        },
        signal: input.signal,
      });
      return providerSuccess(this.id, {
        url: link.url,
        createdAt: link.fetchedAt,
        source: 'provider_api' as const,
      });
    } catch {
      return providerUnavailable(
        this.id,
        'createTrackingLink',
        'PROVIDER_ERROR',
        'DEGRADED',
        true,
      );
    }
  }
}
