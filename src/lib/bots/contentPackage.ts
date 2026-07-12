// ===========================================
// Content Package Bot
// Packages finalized content for publishing
// ===========================================

import { BotContext } from './context';
import { getContentPackageByProductId } from '../storage/contentPackages';
import type { ContentPackage } from '../types';

export class ContentPackageBot {
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  async getPackageStatus(productId: string): Promise<{ ready: boolean; package: ContentPackage | null }> {
    const pkg = await getContentPackageByProductId(productId);

    if (!pkg) {
      await this.ctx.info('No content package found for product', { productId });
      return { ready: false, package: null };
    }

    const ready = pkg.complianceStatus === 'safe' && pkg.complianceIssues.length === 0;

    await this.ctx.info('Content package status checked', {
      productId,
      ready,
      complianceStatus: pkg.complianceStatus,
    });

    return { ready, package: pkg };
  }
}

export async function createContentPackager(runId: string): Promise<ContentPackageBot> {
  return new ContentPackageBot(new BotContext(runId, 'content_package'));
}
