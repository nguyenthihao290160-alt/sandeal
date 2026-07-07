// ===========================================
// Source Scout Bot
// Finds candidate products from real sources
// ===========================================

import type { Product, ProductSource } from '../types';
import { BotContext } from './context';
import { listProducts, createProduct } from '../storage/products';
import { getPrimaryCredential } from '../storage/tokenVault';
import { isAccessTradeConfigured, searchAccessTrade, mapAccessTradeToProduct } from '../integrations/accesstrade';

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

      const configured = await isAccessTradeConfigured();
      if (!configured) {
        await this.ctx.warn('AccessTrade token not configured. Skipping AccessTrade scan');
        return [];
      }

      await this.ctx.info('Calling AccessTrade search adapter', { limit });
      const result = await searchAccessTrade({ limit, kind: 'product' });
      const items = result.items || [];

      await this.ctx.info('AccessTrade returned items', { count: items.length });

      const savedProducts: Product[] = [];
      for (const rawItem of items.slice(0, limit)) {
        try {
          const input = mapAccessTradeToProduct(rawItem);
          // Ensure status is needs_review by default
          input.status = 'needs_review';
          const saved = await createProduct(input as any);
          savedProducts.push(saved);
        } catch (err) {
          await this.ctx.error('Failed to save product from AccessTrade', { error: err instanceof Error ? err.message : String(err) });
        }
      }

      await this.ctx.info('AccessTrade scan complete', { saved: savedProducts.length });
      return savedProducts;
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
