import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getAutomationControl, updateAutomationControl } from '@/lib/automation/store';

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request); if (authError) return authError;
  return NextResponse.json({ ok: true, code: 'OK', message: 'Đã tải trạng thái điều khiển.', data: await getAutomationControl() });
}

export async function PATCH(request: NextRequest) {
  const authError = await requireAuth(request); if (authError) return authError;
  let body: Record<string, unknown>; try { body = await request.json() as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Dữ liệu điều khiển không hợp lệ.' }, { status: 400 }); }
  const action = body.action; const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (typeof action !== 'string' || reason.length < 8) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Vui lòng chọn thao tác và nhập lý do ít nhất 8 ký tự.' }, { status: 400 });
  if ((action === 'enable_kill_switch' || action === 'disable_kill_switch') && body.confirmed !== true) return NextResponse.json({ ok: false, code: 'CONFIRMATION_REQUIRED', message: 'Dừng khẩn cấp cần được xác nhận rõ ràng.' }, { status: 409 });
  const updates = action === 'pause_worker' ? { workerPaused: true } : action === 'resume_worker' ? { workerPaused: false }
    : action === 'pause_scheduler' ? { schedulerPaused: true } : action === 'resume_scheduler' ? { schedulerPaused: false }
      : action === 'enable_kill_switch' ? { killSwitch: true, workerPaused: true, schedulerPaused: true }
        : action === 'disable_kill_switch' ? { killSwitch: false } : null;
  if (!updates) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Thao tác điều khiển không hợp lệ.' }, { status: 400 });
  const state = await updateAutomationControl({ ...updates, reason }, 'dashboard-admin');
  return NextResponse.json({ ok: true, code: 'OK', message: 'Đã cập nhật trạng thái vận hành.', data: state });
}
