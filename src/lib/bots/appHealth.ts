// ===========================================
// App Health Bot
// Monitors system health and bot infrastructure
// ===========================================

import { BotContext } from './context';
import { config } from '../config';
import { getProductStats } from '../storage/products';
import { getBotRunsStats } from '../storage/botRuns';
import { getLinkHealthStats } from '../storage/linkHealth';
import { getContentPackageStats } from '../storage/contentPackages';
import { getPrimaryCredential } from '../storage/tokenVault';
import type { BotTeamStatus } from '../types';

export class AppHealthBot {
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  async getHealthStatus(): Promise<BotTeamStatus> {
    const productStats = await getProductStats();
    const botStats = await getBotRunsStats();
    const linkStats = await getLinkHealthStats();
    const contentStats = await getContentPackageStats();

    const geminiToken = await getPrimaryCredential('gemini');
    const atToken = await getPrimaryCredential('accesstrade');

    const status: BotTeamStatus = {
      aiBotsEnabled: true,
      contentBotEnabled: true,
      linkHealthBotEnabled: true,
      cleanupBotEnabled: true,
      lastBotRunStatus: botStats.lastRunStatus,
      lastBotRunAt: botStats.lastRunAt,
      productCount: productStats.total,
      approvedProductCount: productStats.approved + productStats.published,
      reviewProductCount: productStats.needsReview,
      brokenLinkCount: linkStats.broken,
      contentPackageCount: contentStats.totalPackages,
      hasGeminiPrimaryToken: !!geminiToken && geminiToken.status === 'valid',
      hasAccessTradePrimaryToken: !!atToken && atToken.status === 'valid',
      safeMode: !config.allowPaidAi,
      freeOnly: config.costMode === 'free_only',
      autoPublish: config.autoPublishEnabled,
    };

    await this.ctx.info('System health checked', {
      productCount: status.productCount,
      brokenLinks: status.brokenLinkCount,
      contentPackages: status.contentPackageCount,
      hasGemini: status.hasGeminiPrimaryToken,
      hasAccessTrade: status.hasAccessTradePrimaryToken,
    });

    return status;
  }
}

export async function createAppHealthChecker(runId: string): Promise<AppHealthBot> {
  return new AppHealthBot(new BotContext(runId, 'app_health'));
}
