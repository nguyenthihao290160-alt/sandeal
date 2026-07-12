import type { ContentPackage, Product } from '../types';
import { generateEditorialReview } from '../editorialReview';
import { BotContext } from './context';

export class ContentReviewBot {
  constructor(private readonly ctx: BotContext) {}

  async generateContent(product: Product): Promise<ContentPackage> {
    const review = generateEditorialReview(product);
    const price = product.salePrice || product.price;
    const content: ContentPackage = {
      id: `cp-${Date.now()}`,
      productId: product.id,
      websiteTitle: review.reviewTitle,
      websiteReview: `${review.reviewSummary}\n\n${review.reviewVerdict}\n\n${review.reviewDisclosure}`,
      bulletPoints: [...review.strengths, ...review.limitations].slice(0, 6).map((item) => item.text),
      shortCaption: `${product.title}${price ? ` – giá tham khảo ${price.toLocaleString('vi-VN')} VND` : ''}. Kiểm tra dữ kiện và điều cần cân nhắc tại SanDeal.`,
      hashtags: ['SanDeal', 'DanhGiaSanPham', ...(product.category ? [product.category.replace(/\s+/g, '')] : [])],
      cta: 'Xem thông tin và kiểm tra giá tại website đối tác →',
      contentAngle: 'Đánh giá biên tập dựa trên dữ kiện đã xác minh',
      affiliateNote: 'Liên kết có thể là liên kết affiliate. SanDeal có thể nhận hoa hồng, giá của người mua không thay đổi.',
      imageUrl: product.imageUrl,
      productUrl: product.originalUrl || '',
      affiliateUrl: product.affiliateUrl,
      complianceStatus: review.reviewStatus === 'approved' ? 'safe' : 'needs_edit',
      complianceIssues: review.reviewStatus === 'approved' ? [] : ['missing_data'],
      generatedAt: new Date().toISOString(),
    };
    await this.ctx.info('Editorial content package generated', { productId: product.id, reviewStatus: review.reviewStatus, blockReasons: review.reviewBlockReasons });
    return content;
  }
}

export async function createContentReview(runId: string): Promise<ContentReviewBot> {
  return new ContentReviewBot(new BotContext(runId, 'content_review'));
}
