// ===========================================
// API: App Health — System Health Check
// ===========================================

import { successResponse, serverErrorResponse } from '@/lib/apiResponse';
import { getProductStats } from '@/lib/storage/products';
import { getVaultStats } from '@/lib/storage/tokenVault';
import { isAccessTradeConfigured } from '@/lib/integrations/accesstrade';
import { config } from '@/lib/config';
import { createAppHealthChecker } from '@/lib/bots/appHealth';
import { getBotRunsStats } from '@/lib/storage/botRuns';
import { getLinkHealthStats } from '@/lib/storage/linkHealth';
import { getContentPackageStats } from '@/lib/storage/contentPackages';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const stats = await getProductStats();
    let vaultStats = null;
    try {
      vaultStats = await getVaultStats();
    } catch {
      // Token vault may not be initialized yet
    }

    // Get AI bot infrastructure status
    const tempRunId = `health-check-${Date.now()}`;
    const healthBot = await createAppHealthChecker(tempRunId);
    const botStatus = await healthBot.getHealthStatus();
    const botRunStats = await getBotRunsStats();
    const linkStats = await getLinkHealthStats();
    const contentStats = await getContentPackageStats();

    const health = {
      app: {
        name: config.appName,
        engine: config.engineName,
        url: config.siteUrl,
      },
      safeMode: {
        costMode: config.costMode,
        allowPaidAi: config.allowPaidAi,
        autoPublishEnabled: config.autoPublishEnabled,
        allowPublishingApi: config.allowPublishingApi,
      },
      flags: {
        safeModeOn: config.costMode === 'free_only',
        freeOnly: config.costMode === 'free_only',
        autoPublish: config.autoPublishEnabled,
      },
      products: {
        storageType: 'json-file',
        storageStatus: 'active',
        productCount: stats.total,
        ...stats,
      },
      aiBots: {
        enabled: true,
        orchestratorEnabled: true,
        lastRunStatus: botStatus.lastBotRunStatus,
        lastRunAt: botStatus.lastBotRunAt,
        totalRuns: botRunStats.totalRuns,
        completedRuns: botRunStats.completedRuns,
        failedRuns: botRunStats.failedRuns,
        pendingRuns: botRunStats.pendingRuns,
      },
      linkHealth: {
        totalChecked: linkStats.totalChecked,
        healthy: linkStats.healthy,
        broken: linkStats.broken,
        needsReview: linkStats.needsReview,
        lastCheckedAt: linkStats.lastCheckedAt,
      },
      contentGeneration: {
        totalPackages: contentStats.totalPackages,
        safePackages: contentStats.safePackages,
        needsEditPackages: contentStats.needsEditPackages,
        blockedPackages: contentStats.blockedPackages,
        lastGeneratedAt: contentStats.lastGeneratedAt,
      },
      integrations: {
        accesstrade: {
          configured: await isAccessTradeConfigured(),
          // Never expose the actual key
        },
      },
      tokenVault: vaultStats ? {
        storageStatus: 'active',
        ...vaultStats,
      } : {
        storageStatus: 'empty',
        totalCredentials: 0,
      },
      hasGeminiPrimaryToken: vaultStats ? !!vaultStats.geminiPrimaryConfigured : false,
      hasAccessTradePrimaryToken: vaultStats ? !!vaultStats.accessTradeConfigured : false,
      tokenVaultStatus: vaultStats ? 'active' : 'missing',
      storageStatus: 'json-file',
      timestamp: new Date().toISOString(),
    };

    return successResponse('Trạng thái hệ thống.', health);
  } catch (err) {
    return serverErrorResponse('Không thể tải trạng thái hệ thống.', err);
  }
}
