// ===========================================
// API: App Health
// ===========================================

import { successResponse, serverErrorResponse } from '@/lib/apiResponse';
import { getProductStats } from '@/lib/storage/products';
import { isAccessTradeConfigured } from '@/lib/integrations/accesstrade';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const stats = await getProductStats();

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
          configured: isAccessTradeConfigured(),
          // Never expose the actual key
        },
      },
      timestamp: new Date().toISOString(),
    };

    return successResponse('Trạng thái hệ thống.', health);
  } catch (err) {
    return serverErrorResponse('Không thể tải trạng thái hệ thống.', err);
  }
}
