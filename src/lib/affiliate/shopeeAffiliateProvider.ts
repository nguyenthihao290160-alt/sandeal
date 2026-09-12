import {
  AFFILIATE_PROVIDER_CONTRACT_VERSION,
  providerUnavailable,
  type AffiliateProvider,
  type AffiliateProviderHealth,
  type AffiliateProviderHealthState,
  type AffiliateProviderOperation,
} from './types';

interface ShopeeAffiliateConfiguration {
  enabled: boolean;
  valid: boolean;
  credentialsPresent: boolean;
  partialCredentials: boolean;
}

function credentialPresent(value: string | undefined): boolean {
  return Boolean(value && value.trim() && !/[\u0000-\u001f\u007f]/.test(value));
}

function readConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): ShopeeAffiliateConfiguration {
  const rawEnabled = environment.SHOPEE_AFFILIATE_ENABLED;
  const normalized = rawEnabled === undefined || rawEnabled.trim() === ''
    ? 'false'
    : rawEnabled.trim().toLowerCase();
  const valid = normalized === 'true' || normalized === 'false';
  const appIdPresent = credentialPresent(environment.SHOPEE_APP_ID);
  const apiKeyPresent = credentialPresent(environment.SHOPEE_API_KEY);
  return {
    enabled: valid && normalized === 'true',
    valid,
    credentialsPresent: appIdPresent && apiKeyPresent,
    partialCredentials: appIdPresent !== apiKeyPresent,
  };
}

function configurationState(
  config: ShopeeAffiliateConfiguration,
): AffiliateProviderHealthState {
  if (!config.valid || config.partialCredentials) return 'INVALID_CONFIGURATION';
  if (!config.enabled && !config.credentialsPresent) return 'DISABLED_NO_CREDENTIALS';
  if (!config.enabled) return 'DISABLED';
  if (!config.credentialsPresent) return 'PENDING_EXTERNAL_ACCESS';
  return 'CONFIGURED_NOT_VERIFIED';
}

export class ShopeeAffiliateProvider implements AffiliateProvider {
  readonly id = 'shopee' as const;
  readonly contractVersion = AFFILIATE_PROVIDER_CONTRACT_VERSION;

  getCapabilities() {
    return { discovery: false, trackingLink: false, conversionEvidence: false,
      commissionEvidence: false, clickReference: 'UNAVAILABLE' as const };
  }

  constructor(
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  async healthCheck(): Promise<AffiliateProviderHealth> {
    const config = readConfiguration(this.environment);
    const state = configurationState(config);
    const reasonCode = state === 'DISABLED_NO_CREDENTIALS'
      ? 'SHOPEE_DISABLED_NO_CREDENTIALS'
      : state === 'PENDING_EXTERNAL_ACCESS'
        ? 'SHOPEE_OPEN_API_ACCESS_PENDING'
        : state === 'CONFIGURED_NOT_VERIFIED'
          ? 'SHOPEE_LIVE_INTEGRATION_NOT_IMPLEMENTED'
          : state === 'INVALID_CONFIGURATION'
            ? 'SHOPEE_CONFIGURATION_INVALID'
            : 'SHOPEE_AFFILIATE_DISABLED';
    return {
      provider: this.id,
      state,
      enabled: config.enabled,
      configured: config.credentialsPresent,
      ready: false,
      credentialsPresent: config.credentialsPresent,
      checkedAt: new Date().toISOString(),
      reasonCode,
    };
  }

  private async unavailable(operation: AffiliateProviderOperation) {
    const health = await this.healthCheck();
    const reason = health.state === 'INVALID_CONFIGURATION'
      ? 'INVALID_CONFIGURATION'
      : health.state === 'DISABLED' || health.state === 'DISABLED_NO_CREDENTIALS'
        ? health.credentialsPresent ? 'DISABLED' : 'MISSING_CREDENTIALS'
        : health.state === 'PENDING_EXTERNAL_ACCESS'
          ? 'PENDING_EXTERNAL_ACCESS'
          : 'NOT_IMPLEMENTED';
    return providerUnavailable(this.id, operation, reason, health.state);
  }

  async discoverProducts() {
    return this.unavailable('discoverProducts');
  }

  async getProduct() {
    return this.unavailable('getProduct');
  }

  async getOffers() {
    return this.unavailable('getOffers');
  }

  async getPromotions() {
    return this.unavailable('getPromotions');
  }

  async createTrackingLink() {
    return this.unavailable('createTrackingLink');
  }

  async syncTransactions() {
    return this.unavailable('syncTransactions');
  }

  async syncCommissions() {
    return this.unavailable('syncCommissions');
  }
}
