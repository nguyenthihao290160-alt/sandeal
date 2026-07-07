// ===========================================
// Product Normalizer Bot
// Normalizes raw product data to standard schema
// ===========================================

import type { Product, CreateProductInput } from '../types';
import { BotContext } from './context';

export class ProductNormalizerBot {
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  async normalizeProduct(rawData: Record<string, unknown>, source: string): Promise<CreateProductInput> {
    const normalized: CreateProductInput = {
      title: String(rawData.title || rawData.name || 'Untitled'),
      description: String(rawData.description || rawData.summary || ''),
      kind: 'product',
      platform: this.detectPlatform(rawData),
      source: source as any,
      originalUrl: String(rawData.url || rawData.originalUrl || rawData.productUrl || ''),
      affiliateUrl: String(rawData.affiliateUrl || rawData.affiliate_url || rawData.commissionSharingUrl || ''),
      imageUrl: String(rawData.image || rawData.imageUrl || rawData.image_url || ''),
      gallery: Array.isArray(rawData.gallery) ? rawData.gallery.map(String) : [],
      price: this.parsePrice(rawData.price || rawData.originalPrice),
      salePrice: this.parsePrice(rawData.salePrice || rawData.currentPrice || rawData.sale_price),
      currency: 'VND',
      category: String(rawData.category || rawData.categoryName || ''),
      tags: this.parseTags(rawData.tags),
      benefits: Array.isArray(rawData.benefits) ? rawData.benefits.map(String) : [],
      warnings: Array.isArray(rawData.warnings) ? rawData.warnings.map(String) : [],
      riskLevel: (rawData.riskLevel ? String(rawData.riskLevel) : 'unknown') as 'low' | 'medium' | 'high' | 'unknown',
      status: 'draft',
    };

    await this.ctx.info('Product normalized', {
      title: normalized.title,
      platform: normalized.platform,
      source: normalized.source,
    });

    return normalized;
  }

  private detectPlatform(data: Record<string, unknown>): 'shopee' | 'tiktok_shop' | 'lazada' | 'accesstrade' | 'website' | 'other' {
    const platform = String(data.platform || data.source || '').toLowerCase();

    if (platform.includes('shopee')) return 'shopee';
    if (platform.includes('tiktok')) return 'tiktok_shop';
    if (platform.includes('lazada')) return 'lazada';
    if (platform.includes('accesstrade')) return 'accesstrade';
    if (platform.includes('website') || platform.includes('blog')) return 'website';

    const url = String(data.url || data.originalUrl || '').toLowerCase();
    if (url.includes('shopee')) return 'shopee';
    if (url.includes('tiktok')) return 'tiktok_shop';
    if (url.includes('lazada')) return 'lazada';
    if (url.includes('accesstrade')) return 'accesstrade';

    return 'other';
  }

  private parsePrice(value: unknown): number | undefined {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = parseInt(value.replace(/[^0-9]/g, ''), 10);
      return isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  }

  private parseTags(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string') return value.split(',').map(t => t.trim());
    return [];
  }
}

export async function createProductNormalizer(runId: string): Promise<ProductNormalizerBot> {
  return new ProductNormalizerBot(new BotContext(runId, 'product_normalizer'));
}
