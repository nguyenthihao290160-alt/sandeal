import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { buildAutomationDashboard } from '@/lib/automation/dashboard';
import { getPrimaryCredential } from '@/lib/storage/tokenVault';
import { getLatestRuntimeHealth, providerHealth } from '@/lib/automation/runtimeGuardian';
import { getReleaseIdentity } from '@/lib/releaseIdentity';
import { deriveSystemCapabilityStatus } from '@/lib/health/systemCapability';
import { getGeminiProviderReadiness } from '@/lib/ai/geminiProviderStatus';

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request); if (authError) return authError;
  try {
    const [data, geminiReadiness, accessTradeVault, runtime] = await Promise.all([
      buildAutomationDashboard('today'),
      getGeminiProviderReadiness(),
      getPrimaryCredential('accesstrade'),
      getLatestRuntimeHealth(),
    ]);
    const accessTradeConfigured = Boolean(accessTradeVault && accessTradeVault.status !== 'disabled') || Boolean(process.env.ACCESS_TRADE_API_KEY?.trim());
    const runtimeGemini = runtime?.providers.gemini;
    const geminiStatus = geminiReadiness.status === 'ready'
      && ['circuit_open', 'rate_limited', 'quota_exhausted', 'last_check_failed'].includes(String(runtimeGemini || ''))
      ? 'degraded'
      : geminiReadiness.status;
    const providers = {
      gemini: geminiStatus,
      accessTrade: runtime?.providers.accessTrade || providerHealth({ configured: accessTradeConfigured, adapterAvailable: true }),
    };
    const release = getReleaseIdentity();
    const capabilities = deriveSystemCapabilityStatus({
      web: runtime?.web,
      worker: data.worker,
      scheduler: data.scheduler,
      queue: {
        pending: data.queue.PENDING,
        running: data.queue.RUNNING,
        stuck: runtime?.queue.stuck,
        staleJobs: runtime?.queue.staleJobs,
      },
      control: data.control,
      runtime,
      release,
      ai: {
        providerStatus: providers.gemini,
        budgetAvailable: data.aiUsage.requests < data.aiUsage.requestLimit && data.aiUsage.tokens < data.aiUsage.tokenLimit,
        policyAllowed: data.policy.freeOnly || data.policy.allowPaidAi,
      },
    });
    const readiness = capabilities.overallStatus === 'OPERATIONAL' ? 'active'
      : capabilities.overallStatus === 'LIMITED' ? 'degraded' : 'paused';
    return NextResponse.json({ ok: true, code: 'OK', message: 'Đã kiểm tra hệ thống tự động hóa.', data: {
      release,
      web: runtime?.web || { status: 'alive', buildAvailable: process.env.NODE_ENV !== 'production', publicRouteHealthy: null },
      readiness,
      capabilities,
      operationalStatus: capabilities.operationalStatus,
      publishingStatus: capabilities.publishingStatus,
      aiStatus: capabilities.aiStatus,
      emergencyStatus: capabilities.emergencyStatus,
      overallStatus: capabilities.overallStatus,
      overallLabel: capabilities.overallLabel,
      worker: data.worker, scheduler: data.scheduler,
      queue: data.queue, aiUsage: data.aiUsage, circuits: data.circuits, policy: data.policy,
      providers, providerDetails: { gemini: geminiReadiness }, runtime: runtime ? {
        publishSafe: runtime.publishSafe, reasons: runtime.reasons, historicalReasons: runtime.historicalReasons || [],
        restart: runtime.restart || null, storage: runtime.storage, duplicateRoles: runtime.duplicateRoles, checkedAt: runtime.checkedAt,
      } : null,
      control: data.control,
      killSwitch: data.control.killSwitch, updatedAt: data.updatedAt,
    } });
  } catch {
    return NextResponse.json({ ok: false, code: 'INTERNAL_ERROR', message: 'Không thể xác minh tình trạng hệ thống. Dữ liệu hiện tại không bị thay đổi.' }, { status: 500 });
  }
}
