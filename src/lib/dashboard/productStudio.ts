import type { PriceSnapshot } from '@/lib/product-intelligence/types';
import type { Product, ProductOffer } from '@/lib/types';
import {
  buildAffiliateBroadcastCopy,
  buildDealMatrix,
  buildPublicSocialProof,
  buildThirtyDayPriceHistory,
  buildVerifiedUrgency,
  calculateDealEconomics,
  classifyProductFunnel,
  currentVerifiedPaymentPromotions,
  explainProductReason,
  mapProductPipelineStage,
  type VerifiedPaymentPromotion,
} from './v4';

export interface ProductStudioHistoryEvent {
  id: string;
  label: string;
  technicalType: string;
  occurredAt: string;
  state?: string;
}

export interface ProductStudioDetail {
  product: {
    id: string;
    title: string;
    image: string | null;
    price: number | null;
    originalPrice: number | null;
    currency: 'VND';
    shop: string | null;
    source: string;
    platform: string;
    category: string | null;
    brand: string | null;
    sku: string | null;
    score: number | null;
    qualityScore: number | null;
    opportunityScore: number | null;
    dealScore: number | null;
    commissionAmount: number | null;
    commissionRate: number | null;
    lifecycleState: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  presentation: {
    pipelineStage: ReturnType<typeof mapProductPipelineStage>;
    funnel: ReturnType<typeof classifyProductFunnel>;
  };
  overview: {
    dealMatrix: ReturnType<typeof buildDealMatrix>;
    priceHistory30d: ReturnType<typeof buildThirtyDayPriceHistory>;
    priceDropSubscription: { available: false; state: 'COMING_SOON' };
    paymentOptimization: {
      available: boolean;
      state: 'VERIFIED' | 'NO_VERIFIED_DATA';
      promotions: VerifiedPaymentPromotion[];
      disclaimer: string;
    };
    economics: ReturnType<typeof calculateDealEconomics>;
    urgency: ReturnType<typeof buildVerifiedUrgency>;
    socialProof: ReturnType<typeof buildPublicSocialProof>;
  };
  review: {
    status: string;
    approval: boolean;
    quality: number | null;
    originality: number | null;
    confidence: number | null;
    eligibleForReview: boolean | null;
    eligibleForPublish: boolean | null;
    reasons: Array<{ label: string; technicalCode: string; severity: 'blocker' | 'warning' }>;
    checkedAt: string | null;
  };
  affiliate: {
    network: string | null;
    source: string;
    state: string | null;
    originalProductUrl: string | null;
    affiliateUrl: string | null;
    linkHealth: string | null;
    lastValidation: string | null;
    commissionAmount: number | null;
    commissionRate: number | null;
    fetchedAt: string | null;
    verifiedAt: string | null;
    disclosure: string;
  };
  history: ProductStudioHistoryEvent[];
  debug: {
    internalId: string;
    relatedJobId: string | null;
    publicationJobId: string | null;
    sourceIdentity: {
      sourceId: string | null;
      sourceItemId: string | null;
      externalId: string | null;
      identityHash: string | null;
    };
    reasonCodes: string[];
    technicalState: {
      lifecycleState: string | null;
      priceTruthState: string | null;
      duplicateStatus: string | null;
      claimValidationStatus: string | null;
      affiliateUrlStatus: string | null;
      linkHealthStatus: string | null;
      affiliateHealthStatus: string | null;
      imageHealthStatus: string | null;
    };
    timestamps: Record<string, string>;
  };
  broadcast: { available: boolean; copy: string | null };
  generatedAt: string;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function currentPrice(product: Product): number | null {
  return positive(product.salePrice) ?? positive(product.priceTruthEffectivePrice) ?? positive(product.price);
}

function verifiedPrimaryOffer(product: Product): ProductOffer | undefined {
  const offers = product.offers || [];
  const selected = offers.find(offer => offer.id === product.bestOfferId) || offers.find(offer => offer.primary);
  return selected?.sourceVerified === true && selected.confidence >= 0.8 ? selected : undefined;
}

function verifiedPlatformDiscount(product: Product): number | null {
  if (!['FRESH', 'AGING'].includes(product.priceTruthState || '') || product.priceVerificationStatus !== 'VERIFIED') return null;
  const sellingPrice = currentPrice(product);
  const originalPrice = positive(product.price);
  return sellingPrice && originalPrice && originalPrice > sellingPrice ? originalPrice - sellingPrice : null;
}

function historyEvents(product: Product): ProductStudioHistoryEvent[] {
  const candidates: Array<ProductStudioHistoryEvent | null> = [
    product.createdAt ? { id: 'discovered', label: 'Phát hiện', technicalType: 'PRODUCT_DISCOVERED', occurredAt: product.createdAt, state: 'DISCOVERED' } : null,
    product.sourceFetchedAt ? { id: 'source-normalized', label: 'Chuẩn hóa nguồn', technicalType: 'SOURCE_NORMALIZED', occurredAt: product.sourceFetchedAt } : null,
    product.affiliateUrlFetchedAt ? { id: 'affiliate', label: 'Tạo affiliate', technicalType: 'AFFILIATE_URL_FETCHED', occurredAt: product.affiliateUrlFetchedAt, state: product.affiliateUrlStatus } : null,
    product.lastEditorialCheckAt ? { id: 'review', label: 'Review', technicalType: 'EDITORIAL_REVIEWED', occurredAt: product.lastEditorialCheckAt, state: product.reviewContent?.reviewStatus } : null,
    product.lastEligibilityDecision?.checkedAt ? { id: 'safe-publish', label: 'Safe Publish', technicalType: 'SAFE_PUBLISH_EVALUATED', occurredAt: product.lastEligibilityDecision.checkedAt, state: product.lastEligibilityDecision.eligible ? 'ELIGIBLE' : 'BLOCKED' } : null,
    product.publishedAt ? { id: 'published', label: 'Công khai', technicalType: 'PRODUCT_PUBLISHED', occurredAt: product.publishedAt, state: 'PUBLISHED' } : null,
  ];
  return candidates.filter((event): event is ProductStudioHistoryEvent => Boolean(event && Number.isFinite(Date.parse(event.occurredAt))))
    .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
}

function safeTimestamps(product: Product): Record<string, string> {
  const timestamps: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    lifecycleUpdatedAt: product.lifecycleUpdatedAt,
    sourceFetchedAt: product.sourceFetchedAt,
    priceObservedAt: product.priceObservedAt,
    affiliateLastCheckedAt: product.affiliateLastCheckedAt,
    linkLastCheckedAt: product.linkLastCheckedAt,
    imageLastCheckedAt: product.imageLastCheckedAt,
    publishedAt: product.publishedAt,
    nextRetryAt: product.nextRetryAt,
  })) {
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) timestamps[key] = value;
  }
  return timestamps;
}

export function buildProductStudioDetail(input: {
  product: Product;
  priceSnapshots: PriceSnapshot[];
  paymentPromotions?: VerifiedPaymentPromotion[];
  now?: number;
}): ProductStudioDetail {
  const { product } = input;
  const now = input.now ?? Date.now();
  const primaryOffer = verifiedPrimaryOffer(product);
  const critical = [...new Set([
    ...(product.eligibility?.criticalBlockers || product.currentBlockers?.filter(item => item.severity === 'BLOCKER').map(item => item.code) || []),
    ...(product.reviewContent?.reviewBlockReasons || []),
  ])];
  const warnings = product.eligibility?.warningBlockers || product.currentBlockers?.filter(item => item.severity === 'WARNING').map(item => item.code) || [];
  const reasonCodes = [...new Set([
    ...critical,
    ...warnings,
    ...(product.publicBlockReasons || []),
    ...(product.quarantineReasons || []),
    ...(product.priceTruthReasons || []),
  ].filter(Boolean))];
  const paymentPromotions = currentVerifiedPaymentPromotions(input.paymentPromotions || [], product.platform, now);
  const verifiedPromotion = product.priceVerificationStatus === 'VERIFIED'
    && Number(product.priceTruthDiscountPercent) > 0
    && Number(product.priceTruthDiscountPercent) <= 100
    && ['FRESH', 'AGING'].includes(product.priceTruthState || '')
    ? `Giảm ${product.priceTruthDiscountPercent}% theo giá đã xác minh` : null;
  const broadcastCopy = buildAffiliateBroadcastCopy({
    title: product.title,
    price: currentPrice(product),
    verifiedPromotion,
    affiliateUrl: product.affiliateUrlStatus === 'verified' ? product.affiliateUrl : null,
  });
  return {
    product: {
      id: product.id,
      title: product.title,
      image: product.imageUrl || null,
      price: currentPrice(product),
      originalPrice: positive(product.price),
      currency: 'VND',
      shop: product.shopName || product.merchant || null,
      source: product.source,
      platform: product.platform,
      category: product.category || null,
      brand: product.brand || null,
      sku: product.sku || null,
      score: finite(product.score),
      qualityScore: finite(product.qualityScore),
      opportunityScore: finite(product.opportunityScore),
      dealScore: finite(product.dealScore),
      commissionAmount: positive(product.commissionAmount),
      commissionRate: positive(product.commissionRate),
      lifecycleState: product.lifecycleState || null,
      status: product.status,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    },
    presentation: {
      pipelineStage: mapProductPipelineStage(product),
      funnel: classifyProductFunnel(product),
    },
    overview: {
      dealMatrix: buildDealMatrix(product),
      priceHistory30d: buildThirtyDayPriceHistory(input.priceSnapshots, now),
      priceDropSubscription: { available: false, state: 'COMING_SOON' },
      paymentOptimization: {
        available: paymentPromotions.length > 0,
        state: paymentPromotions.length ? 'VERIFIED' : 'NO_VERIFIED_DATA',
        promotions: paymentPromotions,
        disclaimer: 'Có thể đủ điều kiện nhận cashback theo điều kiện của ngân hàng.',
      },
      economics: calculateDealEconomics({
        platformDiscount: verifiedPlatformDiscount(product),
        affiliateCommission: positive(product.commissionAmount),
      }),
      urgency: buildVerifiedUrgency({ promotionExpiresAt: primaryOffer?.expiresAt }, now),
      socialProof: buildPublicSocialProof([], now),
    },
    review: {
      status: product.reviewContent?.reviewStatus || product.status,
      approval: product.reviewContent?.reviewStatus === 'approved',
      quality: finite(product.reviewQuality?.qualityScore ?? product.qualityScore),
      originality: finite(product.reviewContent?.originalityScore),
      confidence: finite(product.reviewContent?.editorialConfidence ?? product.confidences?.editorial),
      eligibleForReview: product.eligibility?.eligibleForReview ?? null,
      eligibleForPublish: product.eligibility?.eligibleForPublish ?? null,
      reasons: [
        ...critical.map(code => ({ ...explainProductReason(code), severity: 'blocker' as const })),
        ...warnings.map(code => ({ ...explainProductReason(code), severity: 'warning' as const })),
      ],
      checkedAt: product.reviewQuality?.evaluatedAt || product.lastEditorialCheckAt || null,
    },
    affiliate: {
      network: product.affiliateUrlProvider || product.affiliateSource || null,
      source: product.source,
      state: product.affiliateUrlStatus || null,
      originalProductUrl: product.canonicalProductUrl || product.originalUrl || null,
      affiliateUrl: product.affiliateUrl || null,
      linkHealth: product.affiliateHealthStatus || null,
      lastValidation: product.affiliateLastCheckedAt || null,
      commissionAmount: positive(product.commissionAmount),
      commissionRate: positive(product.commissionRate),
      fetchedAt: product.affiliateUrlFetchedAt || null,
      verifiedAt: product.affiliateUrlVerifiedAt || null,
      disclosure: product.affiliateDisclosure || 'SanDeal có thể nhận hoa hồng khi bạn mua qua liên kết.',
    },
    history: historyEvents(product),
    debug: {
      internalId: product.id,
      relatedJobId: product.relatedJobId || null,
      publicationJobId: product.publicationJobId || null,
      sourceIdentity: {
        sourceId: product.sourceId || null,
        sourceItemId: product.sourceItemId || null,
        externalId: product.externalId || null,
        identityHash: product.identity?.identityHash || null,
      },
      reasonCodes,
      technicalState: {
        lifecycleState: product.lifecycleState || null,
        priceTruthState: product.priceTruthState || null,
        duplicateStatus: product.duplicateStatus || null,
        claimValidationStatus: product.claimValidationStatus || null,
        affiliateUrlStatus: product.affiliateUrlStatus || null,
        linkHealthStatus: product.linkHealthStatus || null,
        affiliateHealthStatus: product.affiliateHealthStatus || null,
        imageHealthStatus: product.imageHealthStatus || null,
      },
      timestamps: safeTimestamps(product),
    },
    broadcast: { available: Boolean(broadcastCopy), copy: broadcastCopy },
    generatedAt: new Date(now).toISOString(),
  };
}
