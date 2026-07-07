// ===========================================
// Gemini Analyst Bot
// Uses Gemini to analyze products (if token available)
// ===========================================

import type { Product } from '../types';
import { BotContext } from './context';
import { getPrimaryCredential } from '../storage/tokenVault';

export class GeminiAnalystBot {
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  async analyzeProduct(product: Product): Promise<Partial<Product>> {
    const token = await getPrimaryCredential('gemini');
    if (!token || token.status !== 'valid') {
      await this.ctx.warn('Gemini token not available - skipping analysis');
      return {};
    }

    // TODO: Implement actual Gemini API call
    // For now, return basic analysis
    const analysis: Partial<Product> = {
      contentAngles: ['Giá hợp lý', 'Chất lượng tốt'],
      warnings: [],
    };

    await this.ctx.info('Product analyzed', {
      productId: product.id,
      analysisFields: Object.keys(analysis),
    });

    return analysis;
  }
}

export async function createGeminiAnalyst(runId: string): Promise<GeminiAnalystBot> {
  return new GeminiAnalystBot(new BotContext(runId, 'gemini_analyst'));
}
