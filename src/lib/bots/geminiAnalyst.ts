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
      await this.ctx.warn('Gemini analysis requires provider configuration', {
        productId: product.id,
        code: 'CONFIGURATION_REQUIRED',
      });
      throw new Error('CONFIGURATION_REQUIRED');
    }

    await this.ctx.warn('Legacy Gemini analyst adapter is not implemented', {
      productId: product.id,
      code: 'PROVIDER_NOT_IMPLEMENTED',
    });
    throw new Error('PROVIDER_NOT_IMPLEMENTED');
  }
}

export async function createGeminiAnalyst(runId: string): Promise<GeminiAnalystBot> {
  return new GeminiAnalystBot(new BotContext(runId, 'gemini_analyst'));
}
