// ===========================================
// SanDeal / ReviewPilot AI — App Configuration
// ===========================================

export const config = {
  // Branding
  appName: process.env.NEXT_PUBLIC_APP_NAME || 'SanDeal',
  engineName: process.env.NEXT_PUBLIC_ENGINE_NAME || 'ReviewPilot AI',
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL || 'https://sandeal.tech',

  // Cost / Safety Mode
  costMode: process.env.AI_COST_MODE || 'free_only',
  allowPaidAi: process.env.ALLOW_PAID_AI === 'true',
  allowVeoApi: process.env.ALLOW_VEO_API === 'true',
  allowImageGeneration: process.env.ALLOW_IMAGE_GENERATION === 'true',
  allowTtsGeneration: process.env.ALLOW_TTS_GENERATION === 'true',
  allowGoogleSearchGrounding: process.env.ALLOW_GOOGLE_SEARCH_GROUNDING === 'true',
  allowDeepResearch: process.env.ALLOW_DEEP_RESEARCH === 'true',
  allowPublishingApi: process.env.ALLOW_PUBLISHING_API === 'true',
  allowAdsApi: process.env.ALLOW_ADS_API === 'true',
  autoPublishEnabled: process.env.AUTO_PUBLISH_ENABLED === 'true',

  // Auth
  basicAuthEnabled: process.env.BASIC_AUTH_ENABLED === 'true',
  basicAuthUsername: process.env.BASIC_AUTH_USERNAME || '',
  basicAuthPassword: process.env.BASIC_AUTH_PASSWORD || '',
} as const;

/** Server-side only config — never import this from client components */
export function getServerConfig() {
  return {
    geminiApiKeys: [
      process.env.GEMINI_API_KEY,
      process.env.GEMINI_API_KEY_2,
      process.env.GEMINI_API_KEY_3,
      process.env.GEMINI_API_KEY_4,
    ].filter(Boolean) as string[],
    accessTradeApiKey: process.env.ACCESS_TRADE_API_KEY || '',
    facebookAppId: process.env.FACEBOOK_APP_ID || '',
    facebookAppSecret: process.env.FACEBOOK_APP_SECRET || '',
    facebookUserToken: process.env.FACEBOOK_USER_TOKEN || '',
    facebookPageId: process.env.FACEBOOK_PAGE_ID || '',
    facebookPageToken: process.env.FACEBOOK_PAGE_TOKEN || '',
    instagramBusinessAccountId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || '',
    instagramAccessToken: process.env.INSTAGRAM_ACCESS_TOKEN || '',
    threadsUserId: process.env.THREADS_USER_ID || '',
    threadsAccessToken: process.env.THREADS_ACCESS_TOKEN || '',
    youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
    youtubeClientId: process.env.YOUTUBE_CLIENT_ID || '',
    youtubeClientSecret: process.env.YOUTUBE_CLIENT_SECRET || '',
    tiktokClientKey: process.env.TIKTOK_CLIENT_KEY || '',
    tiktokClientSecret: process.env.TIKTOK_CLIENT_SECRET || '',
    shopeeAffiliateAppId: process.env.SHOPEE_AFFILIATE_APP_ID || '',
    shopeeAffiliateSecret: process.env.SHOPEE_AFFILIATE_SECRET || '',
    lazadaAffiliateAppKey: process.env.LAZADA_AFFILIATE_APP_KEY || '',
    lazadaAffiliateAppSecret: process.env.LAZADA_AFFILIATE_APP_SECRET || '',
  };
}

export type CostModeStatus = {
  isFreeOnly: boolean;
  allowPaidAi: boolean;
  autoPublish: boolean;
  allowPublishingApi: boolean;
  costMode: string;
};
