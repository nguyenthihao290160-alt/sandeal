import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { buildAutomationDashboard } from '@/lib/automation/dashboard';
import { getPrimaryCredential } from '@/lib/storage/tokenVault';
import { getLatestRuntimeHealth, providerHealth } from '@/lib/automation/runtimeGuardian';

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request); if (authError) return authError;
  try {
    const [data, geminiVault, accessTradeVault, runtime] = await Promise.all([
      buildAutomationDashboard('today'),
      getPrimaryCredential('gemini'),
      getPrimaryCredential('accesstrade'),
      getLatestRuntimeHealth(),
    ]);
    const geminiConfigured = Boolean(geminiVault && geminiVault.status !== 'disabled') || Boolean(process.env.GEMINI_API_KEY?.trim());
    const accessTradeConfigured = Boolean(accessTradeVault && accessTradeVault.status !== 'disabled') || Boolean(process.env.ACCESS_TRADE_API_KEY?.trim());
    const providers = {
      gemini: runtime?.providers.gemini || providerHealth({ configured: geminiConfigured, adapterAvailable: false }),
      accessTrade: runtime?.providers.accessTrade || providerHealth({ configured: accessTradeConfigured, adapterAvailable: true }),
    };
    return NextResponse.json({ ok: true, code: 'OK', message: 'Đã kiểm tra hệ thống tự động hóa.', data: {
      web: runtime?.web || { status: 'alive', buildAvailable: process.env.NODE_ENV !== 'production', publicRouteHealthy: null },
      readiness: data.control.killSwitch || data.control.publishPaused ? 'paused' : runtime?.publishSafe === false ? 'degraded' : 'unverified',
      worker: data.worker, scheduler: data.scheduler,
      queue: data.queue, aiUsage: data.aiUsage, circuits: data.circuits, policy: data.policy,
      providers, runtime: runtime ? { publishSafe: runtime.publishSafe, reasons: runtime.reasons, storage: runtime.storage, duplicateRoles: runtime.duplicateRoles, checkedAt: runtime.checkedAt } : null,
      killSwitch: data.control.killSwitch, updatedAt: data.updatedAt,
    } });
  } catch {
    return NextResponse.json({ ok: false, code: 'INTERNAL_ERROR', message: 'Không thể xác minh tình trạng hệ thống. Dữ liệu hiện tại không bị thay đổi.' }, { status: 500 });
  }
}
