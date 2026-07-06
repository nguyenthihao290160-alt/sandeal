// ===========================================
// Cost Guard — Prevents paid API calls by default
// ===========================================

import { config, type CostModeStatus } from './config';

export class PaidApiBlockedError extends Error {
  constructor(featureName: string) {
    super(
      `Tính năng "${featureName}" có thể phát sinh chi phí. Hiện app đang ở chế độ an toàn nên chưa thực hiện.`
    );
    this.name = 'PaidApiBlockedError';
  }
}

/** Check if app is in free-only mode */
export function isFreeOnlyMode(): boolean {
  return config.costMode === 'free_only' || !config.allowPaidAi;
}

/** Throws if paid API is not allowed. Call before any paid API request. */
export function assertPaidApiAllowed(featureName: string): void {
  if (isFreeOnlyMode()) {
    throw new PaidApiBlockedError(featureName);
  }
}

/** Check specific feature gates */
export function isFeatureAllowed(feature: keyof typeof featureFlags): boolean {
  return featureFlags[feature]();
}

const featureFlags = {
  paidAi: () => config.allowPaidAi,
  veoApi: () => config.allowVeoApi,
  imageGeneration: () => config.allowImageGeneration,
  ttsGeneration: () => config.allowTtsGeneration,
  googleSearchGrounding: () => config.allowGoogleSearchGrounding,
  deepResearch: () => config.allowDeepResearch,
  publishingApi: () => config.allowPublishingApi,
  adsApi: () => config.allowAdsApi,
  autoPublish: () => config.autoPublishEnabled,
} as const;

/** Get full cost mode status for UI display */
export function getCostModeStatus(): CostModeStatus {
  return {
    isFreeOnly: isFreeOnlyMode(),
    allowPaidAi: config.allowPaidAi,
    autoPublish: config.autoPublishEnabled,
    allowPublishingApi: config.allowPublishingApi,
    costMode: config.costMode,
  };
}

/** Vietnamese warning message for blocked features */
export function getBlockedFeatureMessage(featureName: string): string {
  return `Tính năng "${featureName}" có thể phát sinh chi phí. Hiện app đang ở chế độ an toàn nên chưa thực hiện.`;
}
