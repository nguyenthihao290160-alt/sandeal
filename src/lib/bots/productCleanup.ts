// ===========================================
// Product Cleanup Bot
// Safely archives broken products
// ===========================================

import type { LinkHealthStatus, Product } from '../types';
import { BotContext } from './context';
import {
  getLinkHealthByProductId,
  getBrokenLinks,
} from '../storage/linkHealth';
import { getProductById, updateProduct } from '../storage/products';

export class ProductCleanupBot {
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  async cleanupBrokenProducts(options: {
    dryRun?: boolean;
    limit?: number;
  } = {}): Promise<{
    checked: number;
    archived: number;
    needsReview: number;
  }> {
    const limit = options.limit || 50;
    const dryRun = options.dryRun === true;

    let checked = 0;
    let archived = 0;
    let needsReview = 0;

    try {
      // Get broken links from link health storage
      const brokenLinks = await getBrokenLinks(1); // threshold 1 or more failures

      if (brokenLinks.length === 0) {
        await this.ctx.info('No broken links found for cleanup');
        return { checked: 0, archived: 0, needsReview: 0 };
      }

      // Process up to limit items
      const itemsToProcess = brokenLinks.slice(0, limit);

      for (const linkCheck of itemsToProcess) {
        const product = await getProductById(linkCheck.productId);
        if (!product) continue;

        checked++;
        const failureCount = linkCheck.failureCount || 0;

        if (!dryRun) {
          // Update link check timestamp
          await updateProduct(linkCheck.productId, {
            linkLastCheckedAt: new Date().toISOString(),
            linkFailureCount: failureCount,
            linkHealthStatus: linkCheck.productUrlStatus,
          });

          if (failureCount >= 3 && this.isBrokenBeyondRecovery(linkCheck.productUrlStatus)) {
            // Archive the product
            await updateProduct(linkCheck.productId, {
              status: 'archived',
              archivedReason: `Link liên tục bị lỗi (${failureCount} lần). Status: ${linkCheck.productUrlStatus}`,
            });
            archived++;

            await this.ctx.info('Product archived - broken link', {
              productId: linkCheck.productId,
              failureCount,
              status: linkCheck.productUrlStatus,
            });
          } else if (failureCount >= 1 && product.status !== 'archived') {
            // Mark as needs review
            if (product.status !== 'needs_review') {
              await updateProduct(linkCheck.productId, {
                status: 'needs_review',
              });
              needsReview++;

              await this.ctx.info('Product marked for review - link issues', {
                productId: linkCheck.productId,
                failureCount,
              });
            }
          }
        } else {
          // Dry run: just log what would happen
          if (failureCount >= 3 && this.isBrokenBeyondRecovery(linkCheck.productUrlStatus)) {
            archived++;
            await this.ctx.info('[DRY RUN] Would archive product', {
              productId: linkCheck.productId,
              failureCount,
            });
          } else if (failureCount >= 1) {
            needsReview++;
            await this.ctx.info('[DRY RUN] Would mark as needs review', {
              productId: linkCheck.productId,
              failureCount,
            });
          }
        }
      }

      await this.ctx.info('Cleanup complete', {
        dryRun,
        checked,
        archived,
        needsReview,
      });

      return { checked, archived, needsReview };
    } catch (error) {
      await this.ctx.error('Cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { checked, archived, needsReview };
    }
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
