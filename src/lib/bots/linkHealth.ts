// ===========================================
// Link Health Bot
// Checks product & affiliate URLs for health
// ===========================================

import type { LinkHealthStatus, LinkHealthCheck } from '../types';
import { BotContext } from './context';
import {
  createLinkHealthCheck,
  getLinkHealthByProductId,
  updateLinkHealth,
  incrementLinkFailureCount,
} from '../storage/linkHealth';
import { checkImageHealth, checkLinkHealth } from './productHealthCheck';

export class LinkHealthBot {
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  async checkProductLink(
    productId: string,
    productUrl?: string,
    affiliateUrl?: string,
    imageUrl?: string
  ): Promise<LinkHealthCheck | null> {
    if (!productUrl) {
      await this.ctx.warn('No product URL to check', { productId });
      return null;
    }

    try {
      const productStatus = await this.checkUrl(productUrl);
      let existingCheck = await getLinkHealthByProductId(productId);

      if (!existingCheck) {
        existingCheck = await createLinkHealthCheck(productId, productStatus);
      } else {
        existingCheck = await updateLinkHealth(productId, {
          productUrlStatus: productStatus,
          checkedAt: new Date().toISOString(),
        });
      }

      if (affiliateUrl) {
        const affiliateStatus = await this.checkUrl(affiliateUrl);
        existingCheck = await updateLinkHealth(productId, {
          affiliateUrlStatus: affiliateStatus,
        });
      }

      if (imageUrl) {
        const imageStatus = await this.checkUrl(imageUrl, true);
        existingCheck = await updateLinkHealth(productId, {
          imageUrlStatus: imageStatus,
        });
      }

      await this.ctx.info('Link health check complete', {
        productId,
        productStatus,
        affiliateStatus: affiliateUrl ? 'checked' : 'skipped',
        imageStatus: imageUrl ? 'checked' : 'skipped',
      });

      return existingCheck;
    } catch (error) {
      await this.ctx.error('Link health check failed', {
        productId,
        error: error instanceof Error ? error.message : String(error),
      });

      const existing = await getLinkHealthByProductId(productId);
      if (existing) {
        return await incrementLinkFailureCount(
          productId,
          error instanceof Error ? error.message : 'Unknown error'
        );
      }
      return null;
    }
  }

  private async checkUrl(url: string, isImage = false): Promise<LinkHealthStatus> {
    const result = isImage ? await checkImageHealth(url) : await checkLinkHealth(url);
    return result.status as LinkHealthStatus;
  }

  /** Retained only for compatibility evidence; active checks use the bounded body-aware checker above. */
  private async legacyCheckUrl(url: string, isImage = false): Promise<LinkHealthStatus> {
    try {
      // Validate URL format
      const urlObj = new URL(url);

      // Use fetch with timeout
      const controller = new AbortController();
      const timeout = isImage ? 5000 : 8000; // Images faster timeout
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          method: isImage ? 'HEAD' : 'GET',
          signal: controller.signal,
          redirect: 'follow',
          // Don't follow redirects for HEAD requests to images
          ...(isImage && { redirect: 'manual' }),
        });

        clearTimeout(timeoutId);

        if (response.status === 200) {
          return 'ok';
        }

        if (response.status >= 300 && response.status < 400) {
          return 'redirect_ok';
        }

        if (response.status === 404 || response.status === 410) {
          return 'not_found';
        }

        if (response.status >= 500) {
          return 'server_error';
        }

        if (response.status >= 400 && response.status < 500) {
          return isImage ? 'image_broken' : 'affiliate_error';
        }

        return 'needs_manual_check';
      } catch (fetchError) {
        clearTimeout(timeoutId);

        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          return 'timeout';
        }

        return 'needs_manual_check';
      }
    } catch (error) {
      // Invalid URL format
      return 'needs_manual_check';
    }
  }

  async checkBulkLinks(
    items: Array<{ productId: string; productUrl?: string; affiliateUrl?: string; imageUrl?: string }>
  ): Promise<LinkHealthCheck[]> {
    const results: LinkHealthCheck[] = [];

    for (const item of items) {
      const check = await this.checkProductLink(
        item.productId,
        item.productUrl,
        item.affiliateUrl,
        item.imageUrl
      );
      if (check) results.push(check);
    }

    await this.ctx.info('Bulk link health check complete', { checked: results.length });
    return results;
  }
}

export async function createLinkHealthChecker(runId: string): Promise<LinkHealthBot> {
  return new LinkHealthBot(new BotContext(runId, 'link_health'));
}
