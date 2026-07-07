// ===========================================
// Product Cleanup Bot
// Safely archives broken products
// ===========================================

import type { LinkHealthStatus, Product } from '../types';
import { BotContext } from './context';
import { getLinkHealthByProductId } from '../storage/linkHealth';
import { getProductById, updateProduct } from '../storage/products';

export class ProductCleanupBot {
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  async checkAndCleanupBrokenLinks(productId: string): Promise<boolean> {
    const product = await getProductById(productId);
    if (!product) return false;

    const linkHealth = await getLinkHealthByProductId(productId);
    if (!linkHealth) return false;

    const shouldArchive = this.isBrokenBeyondRecovery(linkHealth.productUrlStatus);
    const failureCount = linkHealth.failureCount || 0;

    if (shouldArchive && failureCount >= 3) {
      await updateProduct(productId, {
        status: 'archived',
        unpublishedReason: `Link liên tục bị lỗi (${failureCount} lần). Status: ${linkHealth.productUrlStatus}`,
      });

      await this.ctx.info('Product archived - broken link', {
        productId,
        failureCount,
        status: linkHealth.productUrlStatus,
      });

      return true;
    } else if (failureCount >= 2 && product.status === 'approved') {
      await updateProduct(productId, {
        status: 'needs_review',
        unpublishedReason: `Link gặp vấn đề (${failureCount} lần). Cần xem xét lại.`,
      });

      await this.ctx.warn('Product moved to review - link issues', {
        productId,
        failureCount,
      });

      return true;
    }

    return false;
  }

  private isBrokenBeyondRecovery(status: LinkHealthStatus): boolean {
    const brokenStatuses: LinkHealthStatus[] = [
      'not_found',
      'server_error',
      'product_unavailable',
      'affiliate_error',
    ];
    return brokenStatuses.includes(status);
  }

  async bulkCleanup(productIds: string[]): Promise<number> {
    let cleanedCount = 0;

    for (const productId of productIds) {
      const cleaned = await this.checkAndCleanupBrokenLinks(productId);
      if (cleaned) cleanedCount++;
    }

    await this.ctx.info('Bulk cleanup complete', { cleaned: cleanedCount, total: productIds.length });
    return cleanedCount;
  }
}

export async function createProductCleanup(runId: string): Promise<ProductCleanupBot> {
  return new ProductCleanupBot(new BotContext(runId, 'product_cleanup'));
}
