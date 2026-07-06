// ===========================================
// API: App Health — System Health Check
// ===========================================

import { successResponse, serverErrorResponse } from '@/lib/apiResponse';
import { getProductStats } from '@/lib/storage/products';
import { getVaultStats } from '@/lib/storage/tokenVault';
import { isAccessTradeConfigured } from '@/lib/integrations/accesstrade';
import { config } from '@/lib/config';

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
      products: {
        storageType: 'json-file',
        storageStatus: 'active',
        ...stats,
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
      timestamp: new Date().toISOString(),
    };

    return successResponse('Trạng thái hệ thống.', health);
  } catch (err) {
    return serverErrorResponse('Không thể tải trạng thái hệ thống.', err);
  }
}
