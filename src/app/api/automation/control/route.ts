import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { ensurePreCanarySnapshot } from '@/lib/autonomous/backupManager';
import { getAutomationControl, updateAutomationControl } from '@/lib/automation/store';
import type { AutonomousMode } from '@/lib/automation/types';

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request); if (authError) return authError;
  return NextResponse.json({ ok: true, code: 'OK', message: 'Đã tải trạng thái điều khiển.', data: await getAutomationControl() });
}

export async function PATCH(request: NextRequest) {
  const authError = await requireAuth(request); if (authError) return authError;
  let body: Record<string, unknown>; try { body = await request.json() as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Dữ liệu điều khiển không hợp lệ.' }, { status: 400 }); }
  const action = body.action; const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (typeof action !== 'string' || reason.length < 8) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Vui lòng chọn thao tác và nhập lý do ít nhất 8 ký tự.' }, { status: 400 });
  if ((action === 'enable_kill_switch' || action === 'disable_kill_switch' || action === 'set_mode') && body.confirmed !== true) return NextResponse.json({ ok: false, code: 'CONFIRMATION_REQUIRED', message: 'Thay đổi chế độ vận hành cần được xác nhận rõ ràng.' }, { status: 409 });
  const requestedMode = typeof body.mode === 'string' ? body.mode as AutonomousMode : undefined;
  if (action === 'set_mode' && (!requestedMode || !['OBSERVE', 'SHADOW', 'CANARY', 'AUTONOMOUS', 'EMERGENCY_STOP'].includes(requestedMode))) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Chế độ vận hành không hợp lệ.' }, { status: 400 });
  }
  if (action === 'set_mode' && (requestedMode === 'CANARY' || requestedMode === 'AUTONOMOUS')) {
    const current = await getAutomationControl();
    const changesPublishSafety = current.mode !== requestedMode
      || current.effectiveMode !== requestedMode
      || current.publishPaused
      || current.killSwitch;
    if (changesPublishSafety) {
      try {
        await ensurePreCanarySnapshot({ targetMode: requestedMode, retention: 30 });
      } catch {
        return NextResponse.json({
          ok: false,
          code: 'PRE_CANARY_BACKUP_FAILED',
          message: 'Khong the xac minh ban sao luu truoc khi doi che do van hanh.',
        }, { status: 503 });
      }
    }
  }
  const updates = action === 'pause_worker' ? { workerPaused: true } : action === 'resume_worker' ? { workerPaused: false }
    : action === 'pause_scheduler' ? { schedulerPaused: true } : action === 'resume_scheduler' ? { schedulerPaused: false }
      : action === 'pause_autopilot' ? { schedulerPaused: true, publishPaused: true }
        : action === 'resume_autopilot' ? { schedulerPaused: false, publishPaused: false }
          : action === 'set_mode' && requestedMode === 'EMERGENCY_STOP' ? { mode: requestedMode, killSwitch: true, publishPaused: true, ingestionPaused: true }
            : action === 'set_mode' && requestedMode && requestedMode !== 'EMERGENCY_STOP' ? { mode: requestedMode, effectiveMode: requestedMode, killSwitch: false, publishPaused: requestedMode === 'OBSERVE' || requestedMode === 'SHADOW', ingestionPaused: requestedMode === 'OBSERVE' }
              : action === 'enable_kill_switch' ? { mode: 'EMERGENCY_STOP' as const, killSwitch: true, publishPaused: true, ingestionPaused: true }
                : action === 'disable_kill_switch' ? { mode: 'OBSERVE' as const, effectiveMode: 'OBSERVE' as const, killSwitch: false, publishPaused: true, ingestionPaused: true } : null;
  if (!updates) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Thao tác điều khiển không hợp lệ.' }, { status: 400 });
  const state = await updateAutomationControl({ ...updates, reason }, 'dashboard-admin');
  return NextResponse.json({ ok: true, code: 'OK', message: 'Đã cập nhật trạng thái vận hành.', data: state });
}
