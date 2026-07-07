// ===========================================
// Source Scout Bot
// Finds candidate products from real sources
// ===========================================

import type { Product, ProductSource } from '../types';
import { BotContext } from './context';
import { listProducts, createProduct, getAllProducts } from '../storage/products';
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

      const KEYWORDS = [
        'iphone', 'điện thoại', 'laptop', 'tai nghe', 'máy lọc không khí', 'nồi chiên không dầu',
        'skincare', 'kem chống nắng', 'mẹ và bé', 'gia dụng', 'thời trang'
      ];

      const totalLimit = Math.min(Math.max(limit || 10, 1), 20); // enforce 1..20
      const savedProducts: Product[] = [];
      let duplicates = 0;
      let returnedTotal = 0;

      // seed dedupe set from existing products
      const existing = await getAllProducts();
      const seenExternal = new Set<string>(existing.filter(e => e.externalId).map(e => String(e.externalId)));
      const seenUrls = new Set<string>(existing.filter(e => e.affiliateUrl || e.originalUrl).map(e => (e.affiliateUrl || e.originalUrl) as string));
      const seenTitles = new Set<string>(existing.filter(e => e.title).map(e => e.title.toLowerCase()));

      for (let ki = 0; ki < KEYWORDS.length && savedProducts.length < totalLimit; ki++) {
        const keyword = KEYWORDS[ki];
        const remainingSlots = totalLimit - savedProducts.length;
        const perKeyword = Math.max(1, Math.ceil(remainingSlots / (KEYWORDS.length - ki)));

        let result;
        try {
          result = await searchAccessTrade({ keyword, limit: perKeyword, kind: 'all' });
        } catch (err) {
          await this.ctx.error('AccessTrade search error', { keyword, error: err instanceof Error ? err.message : String(err) });
          continue;
        }

        const items = result.items || [];
        returnedTotal += items.length;
        await this.ctx.info('AccessTrade returned items for keyword', { keyword, count: items.length });

        for (const rawItem of items) {
          if (savedProducts.length >= totalLimit) break;

          // Deduplicate by external id, url, or title
          const ext = String(rawItem.id || '');
          const au = (rawItem.affiliateUrl || rawItem.originalUrl || '').trim();
          const titleKey = (rawItem.name || '').toLowerCase();

          if (ext && seenExternal.has(ext)) { duplicates++; continue; }
          if (au && seenUrls.has(au)) { duplicates++; continue; }
          if (titleKey && seenTitles.has(titleKey)) { duplicates++; continue; }

          // Map to product input
          try {
            const mapped = mapAccessTradeToProduct(rawItem);

            // Clean price fields: avoid fake 0 prices
            if (mapped.price === 0) mapped.price = undefined as any;
            if (mapped.salePrice === 0) mapped.salePrice = undefined as any;

            // Add safe meta fields (use any cast to avoid type issues)
            (mapped as any).status = 'needs_review';
            (mapped as any).source = 'accesstrade';
            (mapped as any).platform = mapped.platform || 'accesstrade';
            (mapped as any).sourceType = 'affiliate';
            (mapped as any).verifiedSource = true;
            (mapped as any).sourceVerified = true;
            (mapped as any).publicHidden = false;
            (mapped as any).needsVerification = !(mapped.affiliateUrl || (mapped.imageUrl && (mapped.price || mapped.salePrice)) );
            (mapped as any).importedFrom = 'accesstrade';
            (mapped as any).rawSourceKind = rawItem.kind || 'unknown';
            (mapped as any).externalId = rawItem.id ? String(rawItem.id) : undefined;

            // Use affiliateUrl preferred, otherwise originalUrl
            if (mapped.affiliateUrl) {
              // ok
            } else if (mapped.originalUrl) {
              // mark needsVerification if originalUrl may have tracking
              (mapped as any).needsVerification = true;
            }

            // Persist
            const saved = await createProduct(mapped as any);
            savedProducts.push(saved);

            // mark as seen
            if ((mapped as any).externalId) seenExternal.add((mapped as any).externalId);
            if (mapped.affiliateUrl) seenUrls.add(mapped.affiliateUrl);
            if (mapped.originalUrl) seenUrls.add(mapped.originalUrl);
            if (mapped.title) seenTitles.add(mapped.title.toLowerCase());

            await this.ctx.info('Saved product from AccessTrade', { keyword, externalId: (mapped as any).externalId, id: saved.id });
          } catch (err) {
            await this.ctx.error('Failed to map/save AccessTrade item', { error: err instanceof Error ? err.message : String(err), raw: rawItem });
          }
        }
      }

      await this.ctx.info('AccessTrade scan complete', { requestedLimit: limit, returnedTotal, duplicates, saved: savedProducts.length });
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
