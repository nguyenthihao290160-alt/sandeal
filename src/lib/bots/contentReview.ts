// ===========================================
// Content Review Bot
// Writes professional affiliate content
// ===========================================

import type { Product, ContentPackage } from '../types';
import { BotContext } from './context';

export class ContentReviewBot {
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  async generateContent(product: Product): Promise<ContentPackage> {
    const content: ContentPackage = {
      id: `cp-${Date.now()}`,
      productId: product.id,
      websiteTitle: this.generateTitle(product),
      websiteReview: this.generateReview(product),
      bulletPoints: this.generateBulletPoints(product),
      shortCaption: this.generateCaption(product),
      hashtags: this.generateHashtags(product),
      cta: 'Kiểm tra giá hiện tại và mua hàng →',
      contentAngle: 'Review sản phẩm: Giá trị vs Chi phí',
      affiliateNote: 'Liên kết này có thể bao gồm liên kết liên kết - tôi có thể nhận hoa hồng nếu bạn mua hàng mà không tốn thêm chi phí cho bạn.',
      imageUrl: product.imageUrl,
      productUrl: product.originalUrl || '',
      affiliateUrl: product.affiliateUrl,
      complianceStatus: 'safe',
      complianceIssues: [],
      generatedAt: new Date().toISOString(),
    };

    await this.ctx.info('Content package generated', {
      productId: product.id,
      title: content.websiteTitle,
    });

    return content;
  }

  private generateTitle(product: Product): string {
    return `${product.title} - Review ${new Date().getFullYear()}: Giá, ưu đãi, đánh giá`;
  }

  private generateReview(product: Product): string {
    const discount = product.price && product.salePrice
      ? Math.round(((product.price - product.salePrice) / product.price) * 100)
      : 0;

    let review = `${product.title} là một sản phẩm${product.category ? ` ${product.category}` : ''} được nhiều khách hàng quan tâm.\n\n`;

    if (product.benefits && product.benefits.length > 0) {
      review += `Điểm nổi bật:\n${product.benefits.map(b => `- ${b}`).join('\n')}\n\n`;
    }

    if (discount > 0) {
      review += `Hiện tại sản phẩm này đang có giá ${product.salePrice?.toLocaleString()} VND (giảm ${discount}%).\n\n`;
    } else if (product.salePrice) {
      review += `Giá hiện tại: ${product.salePrice?.toLocaleString()} VND.\n\n`;
    }

    review += `Giá và ưu đãi có thể thay đổi. Bạn nên kiểm tra giá, phí ship và điều kiện ưu đãi trước khi mua.`;

    return review;
  }

  private generateBulletPoints(product: Product): string[] {
    const points: string[] = [];
    if (product.benefits) points.push(...product.benefits.slice(0, 3));
    if (product.category) points.push(`Phù hợp cho người mua ${product.category}`);
    if (product.price && product.salePrice) {
      const discount = Math.round(((product.price - product.salePrice) / product.price) * 100);
      points.push(`Hiện giảm ${discount}%`);
    }
    return points;
  }

  private generateCaption(product: Product): string {
    return `${product.title}${product.salePrice ? ` - từ ${product.salePrice.toLocaleString()} VND` : ''}. ${product.benefits?.[0] || 'Chất lượng tốt'}. #${product.category?.replace(/\\s+/g, '')}`;
  }

  private generateHashtags(product: Product): string[] {
    const tags: string[] = ['SanDeal', 'Review'];
    if (product.category) {
      tags.push(product.category.replace(/\s+/g, ''));
    }
    if (product.tags) {
      tags.push(...product.tags.slice(0, 3));
    }
    return tags.filter((t): t is string => typeof t === 'string' && t.length > 0);
  }
}

export async function createContentReview(runId: string): Promise<ContentReviewBot> {
  return new ContentReviewBot(new BotContext(runId, 'content_review'));
}
