import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { buildAutomationDashboard } from '@/lib/automation/dashboard';
import { getPrimaryCredential } from '@/lib/storage/tokenVault';

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request); if (authError) return authError;
  try {
    const [data, geminiVault, accessTradeVault] = await Promise.all([
      buildAutomationDashboard('today'),
      getPrimaryCredential('gemini'),
      getPrimaryCredential('accesstrade'),
    ]);
    const geminiConfigured = Boolean(geminiVault && geminiVault.status !== 'disabled') || Boolean(process.env.GEMINI_API_KEY?.trim());
    const accessTradeConfigured = Boolean(accessTradeVault && accessTradeVault.status !== 'disabled') || Boolean(process.env.ACCESS_TRADE_API_KEY?.trim());
    return NextResponse.json({ ok: true, code: 'OK', message: 'Đã kiểm tra hệ thống tự động hóa.', data: {
      liveness: 'active', readiness: data.control.killSwitch ? 'paused' : 'active', worker: data.worker, scheduler: data.scheduler,
      queue: data.queue, aiUsage: data.aiUsage, circuits: data.circuits, policy: data.policy,
      providers: { gemini: geminiConfigured ? 'configured' : 'not_configured', accessTrade: accessTradeConfigured ? 'configured' : 'not_configured' },
      killSwitch: data.control.killSwitch, updatedAt: data.updatedAt,
    } });
  } catch {
    return NextResponse.json({ ok: false, code: 'INTERNAL_ERROR', message: 'Không thể xác minh tình trạng hệ thống. Dữ liệu hiện tại không bị thay đổi.' }, { status: 500 });
  }
}
