// ===========================================
// Product Scoring — Rule-based evaluation
// ===========================================

import type { Product, ProductRiskLevel, ProductScoreLabel } from './types';

// ---- Risk detection keywords ----

const RISK_KEYWORDS = [
  'trị khỏi',
  'cam kết',
  'chắc chắn',
  'giảm cân thần tốc',
  'thuốc',
  'chữa bệnh',
  'lợi nhuận đảm bảo',
  '100% hiệu quả',
];

// ---- V2 Scoring Result ----

export interface ProductScoreV2Result {
  score: number;
  label: ProductScoreLabel;
  riskLevel: ProductRiskLevel;
  reasons: string[];
  warnings: string[];
}

/**
 * Score a product using the new rule-based system.
 * Start from 0, add/subtract points based on data quality and risk.
 */
export function scoreProductV2(product: Product): ProductScoreV2Result {
  let score = 0;
  const reasons: string[] = [];
  const warnings: string[] = [];
  let hasRiskKeywords = false;

  // ---- Add points ----

  // Has product title
  if (product.title && product.title.length > 0) {
    score += 10;
    reasons.push('Có tên sản phẩm (+10)');
  }

  // Has image
  if (product.imageUrl) {
    score += 10;
    reasons.push('Có hình ảnh sản phẩm (+10)');
  } else {
    score -= 10;
    warnings.push('Thiếu hình ảnh sản phẩm (-10)');
  }

  // Has affiliate URL
  if (product.affiliateUrl) {
    score += 15;
    reasons.push('Có link tiếp thị liên kết (+15)');
  } else {
    score -= 15;
    warnings.push('Thiếu link tiếp thị liên kết (-15)');
  }

  // Has original URL
  if (product.originalUrl) {
    score += 5;
    reasons.push('Có link sản phẩm gốc (+5)');
  }

  // Has price or sale price
  if (product.price || product.salePrice) {
    score += 10;
    reasons.push('Có thông tin giá (+10)');
  } else {
    score -= 5;
    warnings.push('Thiếu thông tin giá (-5)');
  }

  // Has benefits
  if (product.benefits && product.benefits.length > 0) {
    score += 15;
    reasons.push(`Có ${product.benefits.length} lợi ích chính (+15)`);
  }

  // Has target audience or pain point
  if ((product.targetAudience && product.targetAudience.length > 0) ||
      (product.painPoints && product.painPoints.length > 0)) {
    score += 10;
    reasons.push('Có đối tượng/pain point (+10)');
  }

  // Has category or tags
  if (product.category || (product.tags && product.tags.length > 0)) {
    score += 10;
    reasons.push('Có danh mục/tags (+10)');
  }

  // Trusted platform
  const trustedPlatforms = ['shopee', 'tiktok_shop', 'lazada', 'accesstrade'];
  if (trustedPlatforms.includes(product.platform)) {
    score += 10;
    reasons.push('Nền tảng uy tín (+10)');
  }

  // Has clear disclosure/compliance note
  if (product.complianceNotes && product.complianceNotes.length > 0) {
    score += 5;
    reasons.push('Có ghi chú tuân thủ (+5)');
  }

  // Has content angle
  if (product.contentAngles && product.contentAngles.length > 0) {
    score += 10;
    reasons.push('Có gợi ý góc nội dung (+10)');
  }

  // ---- Subtract points ----

  // Unknown kind
  if (product.kind === 'unknown') {
    score -= 10;
    warnings.push('Loại sản phẩm không xác định (-10)');
  }

  // Too little information — count how many key fields are missing
  const missingFields: string[] = [];
  if (!product.description) missingFields.push('mô tả');
  if (!product.imageUrl) missingFields.push('hình ảnh');
  if (!product.affiliateUrl && !product.originalUrl) missingFields.push('link');
  if (!product.price && !product.salePrice) missingFields.push('giá');
  if (!product.benefits || product.benefits.length === 0) missingFields.push('lợi ích');

  if (missingFields.length >= 4) {
    score -= 15;
    warnings.push(`Thiếu nhiều thông tin: ${missingFields.join(', ')} (-15)`);
  }

  // High-risk wording detection
  const textToCheck = [
    product.title,
    product.description ?? '',
    ...(product.benefits ?? []),
  ].join(' ').toLowerCase();

  for (const keyword of RISK_KEYWORDS) {
    if (textToCheck.includes(keyword.toLowerCase())) {
      hasRiskKeywords = true;
      score -= 20;
      warnings.push(`Từ khóa rủi ro: "${keyword}" (-20)`);
      break; // Only subtract once for risk keywords
    }
  }

  // Clamp score between 0 and 100
  score = Math.max(0, Math.min(100, score));

  // ---- Determine label ----
  let label: ProductScoreLabel;
  if (score >= 75) {
    label = 'Nên làm ngay';
  } else if (score >= 45) {
    label = 'Cần xác minh';
  } else {
    label = 'Không nên làm';
  }

  // ---- Determine risk level ----
  let riskLevel: ProductRiskLevel;
  if (hasRiskKeywords) {
    riskLevel = 'high';
  } else if (missingFields.length >= 3) {
    riskLevel = 'medium';
  } else if (missingFields.length >= 4) {
    riskLevel = 'unknown';
  } else {
    riskLevel = 'low';
  }

  return { score, label, riskLevel, reasons, warnings };
}

// ---- Legacy V1 Scoring (kept for backward compat) ----

export interface ProductScoreInput {
  title: string;
  price?: number;
  discount?: number;
  platform: string;
  category?: string;
  hasImage: boolean;
  hasAffiliateUrl: boolean;
  commissionRate?: number;
  reviewCount?: number;
  rating?: number;
  description?: string;
}

export interface ProductScoreResult {
  score: number;
  label: string;
  labelKey: 'should_do' | 'needs_verify' | 'should_not';
  reasons: string[];
  suggestedContentAngle: string;
  suggestedAudience: string;
  warnings: string[];
  breakdown: ScoreBreakdown;
}

export interface ScoreBreakdown {
  demandPotential: number;
  affiliateConversion: number;
  contentCreation: number;
  priceAttractiveness: number;
  visualPotential: number;
  riskLevel: number;
  complianceRisk: number;
  dealClarity: number;
  platformTrust: number;
  commissionInfo: number;
}

const PLATFORM_TRUST: Record<string, number> = {
  shopee: 8,
  tiktok_shop: 7,
  lazada: 7,
  accesstrade: 6,
  other: 4,
};

/**
 * Score a product from 0-100 using rule-based evaluation.
 * This is the fallback when no AI key is available.
 */
export function scoreProduct(input: ProductScoreInput): ProductScoreResult {
  const breakdown: ScoreBreakdown = {
    demandPotential: 5,
    affiliateConversion: 5,
    contentCreation: 5,
    priceAttractiveness: 5,
    visualPotential: 5,
    riskLevel: 7,
    complianceRisk: 7,
    dealClarity: 5,
    platformTrust: 5,
    commissionInfo: 3,
  };

  const reasons: string[] = [];
  const warnings: string[] = [];

  // Platform trust
  const platformKey = input.platform.toLowerCase().replace(/\s+/g, '_');
  breakdown.platformTrust = PLATFORM_TRUST[platformKey] ?? 5;
  if (breakdown.platformTrust >= 7) {
    reasons.push(`Nền tảng ${input.platform} có độ tin cậy cao`);
  }

  // Price attractiveness
  if (input.price && input.price > 0) {
    if (input.price < 100000) {
      breakdown.priceAttractiveness = 8;
      reasons.push('Giá thấp, dễ chuyển đổi');
    } else if (input.price < 500000) {
      breakdown.priceAttractiveness = 7;
      reasons.push('Giá vừa phải, phù hợp nhiều đối tượng');
    } else if (input.price < 2000000) {
      breakdown.priceAttractiveness = 6;
    } else {
      breakdown.priceAttractiveness = 4;
      warnings.push('Giá cao, tỷ lệ chuyển đổi có thể thấp hơn');
    }
  }

  // Discount
  if (input.discount && input.discount > 0) {
    if (input.discount >= 30) {
      breakdown.dealClarity = 9;
      reasons.push(`Giảm ${input.discount}% — deal rất hấp dẫn`);
    } else if (input.discount >= 15) {
      breakdown.dealClarity = 7;
      reasons.push(`Giảm ${input.discount}% — deal tốt`);
    } else {
      breakdown.dealClarity = 5;
    }
  }

  // Image / visual
  if (input.hasImage) {
    breakdown.visualPotential = 7;
    reasons.push('Có hình ảnh, thuận lợi cho video/content');
  } else {
    breakdown.visualPotential = 3;
    warnings.push('Thiếu hình ảnh sản phẩm');
  }

  // Affiliate URL
  if (input.hasAffiliateUrl) {
    breakdown.affiliateConversion = 7;
    reasons.push('Có link tiếp thị liên kết');
  } else {
    breakdown.affiliateConversion = 3;
    warnings.push('Chưa có link tiếp thị liên kết');
  }

  // Commission
  if (input.commissionRate) {
    if (input.commissionRate >= 10) {
      breakdown.commissionInfo = 9;
      reasons.push(`Hoa hồng ${input.commissionRate}% — rất tốt`);
    } else if (input.commissionRate >= 5) {
      breakdown.commissionInfo = 7;
    } else {
      breakdown.commissionInfo = 4;
    }
  }

  // Reviews / rating
  if (input.rating && input.rating >= 4) {
    breakdown.demandPotential = 8;
    reasons.push(`Đánh giá ${input.rating}/5 — sản phẩm được yêu thích`);
  }
  if (input.reviewCount && input.reviewCount >= 100) {
    breakdown.demandPotential = Math.max(breakdown.demandPotential, 8);
    reasons.push('Nhiều đánh giá — nhu cầu cao');
  }

  // Content creation potential
  if (input.description && input.description.length > 50) {
    breakdown.contentCreation = 7;
  }
  if (input.title.length > 10) {
    breakdown.contentCreation = Math.max(breakdown.contentCreation, 6);
  }

  // Calculate total score (weighted average)
  const weights = {
    demandPotential: 15,
    affiliateConversion: 15,
    contentCreation: 10,
    priceAttractiveness: 12,
    visualPotential: 8,
    riskLevel: 10,
    complianceRisk: 8,
    dealClarity: 10,
    platformTrust: 7,
    commissionInfo: 5,
  };

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  const weightedSum = Object.entries(weights).reduce((sum, [key, weight]) => {
    return sum + (breakdown[key as keyof ScoreBreakdown] / 10) * weight;
  }, 0);

  const score = Math.round((weightedSum / totalWeight) * 100);

  // Determine label
  let label: string;
  let labelKey: ProductScoreResult['labelKey'];
  if (score >= 65) {
    label = 'Nên làm ngay';
    labelKey = 'should_do';
  } else if (score >= 40) {
    label = 'Cần xác minh';
    labelKey = 'needs_verify';
  } else {
    label = 'Không nên làm';
    labelKey = 'should_not';
  }

  // Suggested content angle
  let suggestedContentAngle = 'Review trung thực sản phẩm';
  if (input.discount && input.discount >= 20) {
    suggestedContentAngle = 'Deal alert — thông báo giảm giá';
  } else if (input.rating && input.rating >= 4.5) {
    suggestedContentAngle = 'Review sản phẩm được yêu thích';
  }

  // Suggested audience
  let suggestedAudience = 'Người mua hàng online';
  if (input.price && input.price < 200000) {
    suggestedAudience = 'Sinh viên, người mua tiết kiệm';
  } else if (input.price && input.price > 1000000) {
    suggestedAudience = 'Người có thu nhập ổn định';
  }

  return {
    score,
    label,
    labelKey,
    reasons,
    suggestedContentAngle,
    suggestedAudience,
    warnings,
    breakdown,
  };
}

/** Get label for use in UI badges */
export function getScoreLabel(score: number): { label: string; color: string } {
  if (score >= 65) return { label: 'Nên làm ngay', color: 'green' };
  if (score >= 40) return { label: 'Cần xác minh', color: 'yellow' };
  return { label: 'Không nên làm', color: 'red' };
}
