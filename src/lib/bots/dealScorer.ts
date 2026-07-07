// ===========================================
// Deal Scorer Bot
// Scores products on deal opportunity 0-100
// ===========================================

import type { Product, DealScoreResult, DealScoringCriteria } from '../types';
import { BotContext } from './context';
import { updateProduct } from '../storage/products';

export class DealScorerBot {
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  async scoreProduct(product: Product): Promise<DealScoreResult> {
    const criteria = this.evaluateCriteria(product);
    const score = this.calculateScore(criteria);
    const label = this.getScoreLabel(score);
    const reasons = this.getScoreReasons(criteria, score);

    const result: DealScoreResult = {
      score,
      label,
      reasons,
      criteria,
    };

    await this.ctx.info(`Product scored`, {
      productId: product.id,
      title: product.title,
      score,
      label,
    });

    return result;
  }

  async scoreAndSaveProduct(product: Product): Promise<DealScoreResult> {
    const result = await this.scoreProduct(product);
    
    // Save score to product
    await updateProduct(product.id, {
      score: result.score,
      scoreLabel: result.label,
      scoreReasons: result.reasons,
      scoreWarnings: [],
    });

    return result;
  }

  private evaluateCriteria(product: Product): DealScoringCriteria {
    const hasRealImage = !!product.imageUrl && product.imageUrl.trim().length > 0;
    const hasCurrentPrice = product.salePrice !== undefined && product.salePrice > 0;
    const hasOriginalPrice = product.price !== undefined && product.price > 0;
    const discountPercent = hasCurrentPrice && hasOriginalPrice
      ? Math.round(((product.price! - product.salePrice!) / product.price!) * 100)
      : 0;
    const hasAffiliateUrl = !!product.affiliateUrl && product.affiliateUrl.trim().length > 0;

    // Check if source is trusted
    const trustedSources = ['accesstrade', 'shopee_affiliate', 'lazada_affiliate'];
    const trustedSource = product.source ? trustedSources.includes(product.source) : false;

    // Calculate data completeness (0-100)
    const completenessChecks = [
      !!product.description,
      !!product.category,
      product.benefits && product.benefits.length > 0,
      product.tags && product.tags.length > 0,
      hasCurrentPrice,
      hasOriginalPrice,
      hasRealImage,
    ];
    const dataCompleteness = Math.round((completenessChecks.filter(Boolean).length / completenessChecks.length) * 100);

    const lowRisk = product.riskLevel === 'low';
    const contentPotential = discountPercent >= 10 || (hasRealImage && dataCompleteness >= 60);

    return {
      hasRealImage,
      hasCurrentPrice,
      hasOriginalPrice,
      discountPercent,
      hasAffiliateUrl,
      trustedSource,
      dataCompleteness,
      lowRisk,
      contentPotential,
    };
  }

  private calculateScore(criteria: DealScoringCriteria): number {
    let score = 0;

    // Image (20 points)
    if (criteria.hasRealImage) score += 20;
    else score += 5; // Placeholder image gives minimal points

    // Pricing (30 points)
    if (criteria.hasCurrentPrice) score += 10;
    if (criteria.hasOriginalPrice) score += 10;
    if (criteria.discountPercent && criteria.discountPercent >= 10) score += 10;
    else if (criteria.discountPercent && criteria.discountPercent >= 5) score += 5;

    // Affiliate & Trust (20 points)
    if (criteria.hasAffiliateUrl) score += 10;
    if (criteria.trustedSource) score += 10;

    // Completeness (20 points)
    score += Math.round((criteria.dataCompleteness / 100) * 15);

    // Risk & Potential (10 points)
    if (criteria.lowRisk) score += 5;
    if (criteria.contentPotential) score += 5;

    return Math.min(100, score);
  }

  private getScoreLabel(score: number): 'Bỏ qua' | 'Cần xem xét' | 'Nên làm' | 'Ưu tiên cao' {
    if (score < 30) return 'Bỏ qua';
    if (score < 60) return 'Cần xem xét';
    if (score < 80) return 'Nên làm';
    return 'Ưu tiên cao';
  }

  private getScoreReasons(criteria: DealScoringCriteria, score: number): string[] {
    const reasons: string[] = [];

    if (criteria.hasRealImage) reasons.push('Có hình ảnh sản phẩm thực');
    else reasons.push('Không có hình ảnh hoặc dùng placeholder');

    if (criteria.hasCurrentPrice) reasons.push('Có giá hiện tại');
    if (criteria.hasOriginalPrice) reasons.push('Có giá gốc');
    if (criteria.discountPercent && criteria.discountPercent >= 10) {
      reasons.push(`Giảm giá ${criteria.discountPercent}%`);
    }

    if (criteria.hasAffiliateUrl) reasons.push('Có link affiliate');
    else reasons.push('Không có link affiliate');

    if (criteria.trustedSource) reasons.push('Nguồn đáng tin cậy');

    if (criteria.dataCompleteness >= 80) reasons.push('Thông tin đầy đủ');
    else if (criteria.dataCompleteness >= 50) reasons.push('Thông tin khá đầy đủ');

    if (criteria.lowRisk) reasons.push('Rủi ro thấp');
    if (criteria.contentPotential) reasons.push('Tiềm năng nội dung cao');

    return reasons;
  }
}

export async function createDealScorer(runId: string): Promise<DealScorerBot> {
  return new DealScorerBot(new BotContext(runId, 'deal_scorer'));
}
