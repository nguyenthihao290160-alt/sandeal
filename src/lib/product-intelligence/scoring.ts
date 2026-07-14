import type { Product } from '@/lib/types';
import { PRODUCT_INTELLIGENCE_CONFIG as CONFIG } from './config';
import type {
  DealScoreResultV2,
  OpportunityScoreResult,
  PriceStatistics,
  QualityBand,
  QualityScoreResult,
  ScoreRule,
} from './types';

const GOOD_HEALTH = new Set(['ok', 'redirect_ok', 'healthy', 'redirected']);

function validHttpUrl(value?: string): boolean {
  try {
    const url = new URL(value || '');
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function currentPrice(product: Partial<Product>): number | undefined {
  const value = Number(product.salePrice || product.price || 0);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function ageInDays(value: string | undefined, now: number): number | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return Math.max(0, (now - Date.parse(value)) / 86_400_000);
}

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function bandForQuality(score: number, blocked: boolean): QualityBand {
  if (blocked) return 'blocked';
  if (score >= CONFIG.thresholds.qualityGood) return 'good';
  if (score >= CONFIG.thresholds.qualityFair) return 'fair';
  if (score >= CONFIG.thresholds.qualityNeedsData) return 'needs_data';
  return 'poor';
}

function rule(
  code: string,
  label: string,
  maximum: number,
  points: number,
  status: ScoreRule['status'],
  recommendation?: string,
): ScoreRule {
  return { code, label, maximum, points: clamp(points, 0, maximum), status, recommendation };
}

export function calculateQualityScore(
  product: Partial<Product>,
  now = Date.now(),
): QualityScoreResult {
  const rules: ScoreRule[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const recommendations: string[] = [];
  const title = String(product.title || '').trim();
  const price = currentPrice(product);
  const hasProductUrl = validHttpUrl(product.originalUrl);
  const hasImage = validHttpUrl(product.imageUrl);
  const isProduct = product.kind === 'product' || product.kind === 'deal';

  if (!isProduct) blockers.push('not_a_product');
  if (product.status === 'archived') blockers.push('archived');
  if ((product.publicBlockReasons || []).some(item => /prohibited|blocker/i.test(item))) blockers.push('policy_blocker');

  const identity = (title.length >= 8 ? 10 : title ? 4 : 0)
    + (product.brand ? 4 : 0)
    + (product.sku || product.gtin || product.mpn ? 4 : 0);
  rules.push(rule('identity', 'Nhận diện sản phẩm', CONFIG.weights.quality.identity, identity,
    title.length >= 8 ? 'passed' : 'failed', 'Bổ sung tên rõ ràng và mã SKU/model nếu có.'));

  const commerce = (hasProductUrl ? 6 : 0)
    + (price ? 8 : 0)
    + (product.currency === 'VND' ? 3 : 0)
    + (product.price && product.salePrice && product.price > product.salePrice ? 5 : 0);
  rules.push(rule('commerce', 'Giá và đường dẫn', CONFIG.weights.quality.commerce, commerce,
    hasProductUrl && Boolean(price) ? 'passed' : 'failed', 'Bổ sung URL nguồn và giá VND đang được xác minh.'));

  const media = hasImage ? (GOOD_HEALTH.has(String(product.imageHealthStatus || '')) ? 10 : 6) : 0;
  rules.push(rule('media', 'Hình ảnh', CONFIG.weights.quality.media, media,
    !hasImage ? 'failed' : GOOD_HEALTH.has(String(product.imageHealthStatus || '')) ? 'passed' : 'warning',
    'Bổ sung ảnh hợp lệ và chạy kiểm tra ảnh.'));

  const classification = (product.category ? 5 : 0) + (product.tags?.length ? 3 : 0) + (isProduct ? 2 : 0);
  rules.push(rule('classification', 'Phân loại', CONFIG.weights.quality.classification, classification,
    product.category && isProduct ? 'passed' : 'warning', 'Chọn danh mục và xác nhận loại dữ liệu là sản phẩm.'));

  const specificationCount = Object.keys(product.specifications || {}).length;
  const specifications = (product.description && product.description.trim().length >= 40 ? 5 : 0)
    + Math.min(5, specificationCount);
  rules.push(rule('specifications', 'Mô tả và thông số', CONFIG.weights.quality.specifications, specifications,
    specifications >= 5 ? 'passed' : 'warning', 'Bổ sung mô tả hoặc thông số có nguồn.'));

  const provenance = (product.verifiedSource === true || product.sourceVerified === true ? 8 : 0)
    + (product.sourceHash ? 2 : 0)
    + (product.source && product.source !== 'other' ? 2 : 0);
  rules.push(rule('provenance', 'Nguồn và xuất xứ dữ liệu', CONFIG.weights.quality.provenance, provenance,
    provenance >= 8 ? 'passed' : 'warning', 'Xác minh nguồn và lưu dấu vết dữ liệu.'));

  const linkHealthy = GOOD_HEALTH.has(String(product.linkHealthStatus || product.productHealthStatus || ''));
  const affiliateHealthy = !product.affiliateUrl || GOOD_HEALTH.has(String(product.affiliateHealthStatus || ''));
  const imageHealthy = !product.imageUrl || GOOD_HEALTH.has(String(product.imageHealthStatus || ''));
  const health = (linkHealthy ? 6 : 0) + (affiliateHealthy ? 3 : 0) + (imageHealthy ? 3 : 0);
  rules.push(rule('health', 'Sức khỏe link và ảnh', CONFIG.weights.quality.health, health,
    linkHealthy && affiliateHealthy && imageHealthy ? 'passed' : 'warning', 'Chạy kiểm tra lại link và ảnh.'));

  const freshnessDays = ageInDays(product.lastSeenAt || product.updatedAt, now);
  const freshness = freshnessDays === undefined ? 0
    : freshnessDays <= CONFIG.freshness.productDays ? 6
      : freshnessDays <= CONFIG.freshness.productDays * 2 ? 3 : 0;
  rules.push(rule('freshness', 'Độ mới dữ liệu', CONFIG.weights.quality.freshness, freshness,
    freshness >= 6 ? 'passed' : 'warning', 'Cập nhật lại sản phẩm từ nguồn.'));

  if (!price) blockers.push('missing_price');
  if (!hasProductUrl) blockers.push('missing_product_url');
  if (product.duplicateConfidence && product.duplicateConfidence >= CONFIG.thresholds.duplicateHigh) {
    warnings.push('duplicate_risk_high');
  }
  if (!linkHealthy) warnings.push('link_not_verified');
  if (!hasImage) warnings.push('missing_image');
  if (!(product.verifiedSource || product.sourceVerified)) warnings.push('source_unverified');

  const rawScore = rules.reduce((sum, item) => sum + item.points, 0)
    - (product.duplicateConfidence ? Math.round(product.duplicateConfidence * 10) : 0);
  const score = blockers.length ? Math.min(39, clamp(rawScore)) : clamp(rawScore);
  for (const item of rules) {
    if (item.status !== 'passed' && item.recommendation) recommendations.push(item.recommendation);
  }
  const failedRules = rules.filter(item => item.status === 'failed' || item.status === 'blocker').map(item => item.code);
  return {
    score,
    band: bandForQuality(score, blockers.length > 0),
    passedRules: rules.filter(item => item.status === 'passed').map(item => item.code),
    failedRules,
    warnings: [...new Set(warnings)],
    blockers: [...new Set(blockers)],
    recommendations: [...new Set(recommendations)],
    breakdown: Object.fromEntries(rules.map(item => [item.code, item.points])),
    rules,
    version: CONFIG.versions.quality,
    calculatedAt: new Date(now).toISOString(),
  };
}

export function calculateDealScore(
  product: Partial<Product>,
  quality: Pick<QualityScoreResult, 'score' | 'blockers'>,
  history?: PriceStatistics,
  now = Date.now(),
): DealScoreResultV2 {
  const current = currentPrice(product);
  const original = Number(product.price || 0);
  const discountPercent = current && original > current ? ((original - current) / original) * 100 : 0;
  const discountAmount = current && original > current ? original - current : 0;
  const positives: string[] = [];
  const negatives: string[] = [];
  const reasons: string[] = [];
  const suspiciousOriginalPrice = Boolean(current && original / current > CONFIG.thresholds.unusualOriginalPriceRatio);

  if (!current || quality.blockers.includes('not_a_product')) {
    return {
      dealScore: 0,
      dealBand: 'ineligible',
      reasons: ['Không đủ giá hoặc dữ liệu sản phẩm để chấm điểm deal.'],
      positiveSignals: [],
      negativeSignals: ['missing_eligible_price'],
      confidence: 'none',
      breakdown: {},
      calculatedAt: new Date(now).toISOString(),
      version: CONFIG.versions.deal,
    };
  }

  let discount = Math.min(CONFIG.weights.deal.discount, discountPercent * 0.75);
  if (suspiciousOriginalPrice) {
    discount = Math.min(discount, 5);
    negatives.push('original_price_unusual');
    reasons.push('Giá gốc có tỷ lệ bất thường và cần xác minh.');
  } else if (discountPercent > 0) {
    positives.push('verified_discount_present');
    reasons.push(`Giảm ${Math.round(discountPercent)}% (${Math.round(discountAmount).toLocaleString('vi-VN')}₫) theo dữ liệu đang lưu.`);
  } else {
    negatives.push('no_verified_discount');
  }

  let historical = 0;
  if (history?.lowest && current <= history.lowest) {
    historical = CONFIG.weights.deal.history;
    positives.push('at_internal_recorded_low');
    reasons.push('Giá hiện tại bằng mức thấp nhất trong lịch sử SanDeal ghi nhận.');
  } else if (history?.average && current < history.average) {
    historical = CONFIG.weights.deal.history * 0.65;
    positives.push('below_internal_average');
    reasons.push('Giá hiện tại thấp hơn trung bình lịch sử SanDeal ghi nhận.');
  } else if (history?.snapshots) {
    historical = CONFIG.weights.deal.history * 0.25;
  }

  const age = ageInDays(product.priceLastChangedAt || product.lastSeenAt || product.updatedAt, now);
  const freshness = age !== undefined && age <= CONFIG.freshness.priceDays
    ? CONFIG.weights.deal.freshness
    : age !== undefined && age <= CONFIG.freshness.priceDays * 2 ? 7 : 0;
  if (!freshness) negatives.push('stale_price');

  const linkHealthy = GOOD_HEALTH.has(String(product.linkHealthStatus || product.productHealthStatus || ''));
  const health = linkHealthy ? CONFIG.weights.deal.health : 0;
  if (!linkHealthy) negatives.push('link_not_healthy');

  const provenance = product.verifiedSource || product.sourceVerified ? CONFIG.weights.deal.provenance : 0;
  if (!provenance) negatives.push('source_unverified');
  const qualityPoints = (clamp(quality.score) / 100) * CONFIG.weights.deal.quality;
  const score = clamp(discount + historical + freshness + health + provenance + qualityPoints);
  const evidenceSignals = Number(discountPercent > 0 && !suspiciousOriginalPrice)
    + Number(Boolean(history?.snapshots)) + Number(Boolean(freshness)) + Number(linkHealthy)
    + Number(Boolean(provenance));
  const confidence = evidenceSignals >= 4 ? 'high' : evidenceSignals >= 2 ? 'medium' : 'low';
  const band = suspiciousOriginalPrice || !linkHealthy || !provenance
    ? 'verify'
    : score >= CONFIG.thresholds.dealFeatured ? 'featured'
      : score >= CONFIG.thresholds.dealConsider ? 'consider'
        : score >= CONFIG.thresholds.dealNormal ? 'normal' : 'verify';
  if (!reasons.length) reasons.push('Chưa có đủ tín hiệu giảm giá được xác minh.');
  return {
    dealScore: score,
    dealBand: band,
    reasons,
    positiveSignals: positives,
    negativeSignals: negatives,
    confidence,
    breakdown: {
      discount: clamp(discount, 0, CONFIG.weights.deal.discount),
      history: clamp(historical, 0, CONFIG.weights.deal.history),
      freshness,
      health,
      provenance,
      quality: clamp(qualityPoints, 0, CONFIG.weights.deal.quality),
    },
    calculatedAt: new Date(now).toISOString(),
    version: CONFIG.versions.deal,
  };
}

export function calculateOpportunityScore(
  product: Partial<Product>,
  quality: QualityScoreResult,
  deal: DealScoreResultV2,
  now = Date.now(),
): OpportunityScoreResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const freshnessDays = ageInDays(product.lastSeenAt || product.updatedAt, now);
  const freshness = freshnessDays !== undefined && freshnessDays <= CONFIG.freshness.productDays ? 100
    : freshnessDays !== undefined && freshnessDays <= CONFIG.freshness.productDays * 2 ? 50 : 0;
  const specifications = Object.keys(product.specifications || {}).length;
  const contentReadiness = clamp(
    (product.description && product.description.length >= 40 ? 35 : 0)
    + Math.min(35, specifications * 7)
    + (product.reviewContent?.reviewStatus === 'approved' ? 30 : product.reviewContent ? 15 : 0),
  );
  const provenance = product.verifiedSource || product.sourceVerified ? 100 : 20;
  const analytics = product.analyticsSummary?.clicks
    ? Math.min(100, 20 + Math.log10(product.analyticsSummary.clicks + 1) * 25) : 0;
  let risk = 100;
  if (product.riskLevel === 'medium') risk = 55;
  if (product.riskLevel === 'high' || product.riskLevel === 'unknown') risk = 10;
  if ((product.duplicateConfidence || 0) >= CONFIG.thresholds.duplicateMedium) risk = Math.min(risk, 20);
  if (product.publicHidden === false && product.status === 'published') risk = Math.max(0, risk - 15);

  const weighted = quality.score * CONFIG.weights.opportunity.quality
    + deal.dealScore * CONFIG.weights.opportunity.deal
    + freshness * CONFIG.weights.opportunity.freshness
    + contentReadiness * CONFIG.weights.opportunity.contentReadiness
    + provenance * CONFIG.weights.opportunity.provenance
    + analytics * CONFIG.weights.opportunity.analytics
    + risk * CONFIG.weights.opportunity.risk;
  const totalWeight = Object.values(CONFIG.weights.opportunity).reduce((sum, value) => sum + value, 0);
  let score = clamp(weighted / totalWeight);
  const blocked = quality.blockers.length > 0 || product.status === 'archived';
  if (blocked) score = Math.min(score, 39);
  if (quality.score >= 70) reasons.push('Dữ liệu đủ tốt để tiếp tục xử lý nội dung.');
  if (deal.dealScore >= 65) reasons.push('Deal Score cho thấy ưu đãi đáng được xem xét.');
  if (contentReadiness >= 60) reasons.push('Có đủ dữ liệu để chuẩn bị bản nháp có kiểm chứng.');
  if (!provenance || provenance < 100) warnings.push('Nguồn chưa được xác minh đầy đủ.');
  if ((product.duplicateConfidence || 0) >= CONFIG.thresholds.duplicateMedium) warnings.push('Cần xử lý nguy cơ trùng trước khi ưu tiên.');
  if (product.status === 'published') warnings.push('Sản phẩm đã public; ưu tiên kiểm tra độ mới thay vì tạo lại nội dung.');
  const band = blocked ? 'blocked'
    : score >= CONFIG.thresholds.opportunityPriority ? 'priority'
      : score >= CONFIG.thresholds.opportunityRecommended ? 'recommended'
        : score >= CONFIG.thresholds.opportunityConsider ? 'consider' : 'low';
  return {
    score,
    band,
    reasons,
    warnings,
    breakdown: {
      quality: quality.score,
      deal: deal.dealScore,
      freshness: clamp(freshness),
      contentReadiness,
      provenance,
      analytics: clamp(analytics),
      risk,
    },
    version: CONFIG.versions.opportunity,
    calculatedAt: new Date(now).toISOString(),
  };
}

export function calculateProductScores(product: Partial<Product>, history?: PriceStatistics, now = Date.now()) {
  const quality = calculateQualityScore(product, now);
  const deal = calculateDealScore(product, quality, history, now);
  const opportunity = calculateOpportunityScore(product, quality, deal, now);
  return { quality, deal, opportunity };
}
