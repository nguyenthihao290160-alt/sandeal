// ===========================================
// Source Scout Bot
// Finds candidate products from real sources
// ===========================================

import type { Product, ProductSource } from '../types';
import { BotContext } from './context';
import { listProducts } from '../storage/products';
import { getPrimaryCredential } from '../storage/tokenVault';

export class SourceScoutBot {
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  async scanSource(source: 'local' | 'accesstrade' | 'manual' | 'all', limit: number): Promise<Product[]> {
    const candidates: Product[] = [];

    if (source === 'all' || source === 'local') {
      const localProducts = await this.scanLocalSource(limit);
      candidates.push(...localProducts);
    }

    if (source === 'all' || source === 'accesstrade') {
      const atProducts = await this.scanAccessTradeSource(limit - candidates.length);
      candidates.push(...atProducts);
    }

    if (source === 'all' || source === 'manual') {
      const manualProducts = await this.scanManualSource(limit - candidates.length);
      candidates.push(...manualProducts);
    }

    await this.ctx.info(`Source scan complete`, {
      source,
      candidatesFound: candidates.length,
    });

    return candidates;
  }

  private async scanLocalSource(limit: number): Promise<Product[]> {
    try {
      await this.ctx.info('Scanning local source');

      // Get draft products from storage that haven't been processed yet
      const allProducts = await listProducts();
      const candidates = allProducts.filter(p => p.source === 'manual' && p.status === 'draft').slice(0, limit);

      await this.ctx.info(`Local source scan complete`, { count: candidates.length });
      return candidates;
    } catch (error) {
      await this.ctx.error(`Local source scan failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async scanAccessTradeSource(limit: number): Promise<Product[]> {
    try {
      await this.ctx.info('Checking AccessTrade token status');

      const token = await getPrimaryCredential('accesstrade');
      if (!token || token.status !== 'valid') {
        await this.ctx.warn('AccessTrade token not available or invalid', {
          tokenStatus: token?.status,
        });
        return [];
      }

      await this.ctx.info('AccessTrade source would scan here', {
        note: 'Integration with AccessTrade API required',
        limit,
      });

      // TODO: Implement actual AccessTrade API integration
      // For now, return empty to avoid API errors
      return [];
    } catch (error) {
      await this.ctx.error(`AccessTrade source scan failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async scanManualSource(limit: number): Promise<Product[]> {
    try {
      await this.ctx.info('Scanning manual product submissions');

      // In production, this would check a submission queue or webhook endpoint
      // For now, return empty as no manual submissions exist yet
      return [];
    } catch (error) {
      await this.ctx.error(`Manual source scan failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}

export async function createSourceScout(runId: string): Promise<SourceScoutBot> {
  return new SourceScoutBot(new BotContext(runId, 'source_scout'));
}
