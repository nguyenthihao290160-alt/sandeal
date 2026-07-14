import { type NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { approveAutomationJob, cancelAutomationJob, publicAutomationJob, retryAutomationJob } from '@/lib/automation/store';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) {
  const authError = await requirePermission(request, 'MANAGE_AUTOMATION'); if (authError) return authError;
  const { id, action } = await params;
  let body: Record<string, unknown> = {}; try { body = await request.json() as Record<string, unknown>; } catch { /* optional body */ }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (['cancel','approve','reject'].includes(action) && reason.length < 5) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Vui lòng nhập lý do ít nhất 5 ký tự.' }, { status: 400 });
  let job = null;
  const actor = getServerActor();
  if (action === 'cancel') job = await cancelAutomationJob(id, actor, reason);
  else if (action === 'retry') job = await retryAutomationJob(id, actor);
  else if (action === 'approve') job = await approveAutomationJob(id, actor, reason, true);
  else if (action === 'reject') job = await approveAutomationJob(id, actor, reason, false);
  else return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Thao tác không hợp lệ.' }, { status: 400 });
  if (!job) return NextResponse.json({ ok: false, code: 'INVALID_TRANSITION', message: 'Không thể thực hiện thao tác ở trạng thái hiện tại.' }, { status: 409 });
  return NextResponse.json({ ok: true, code: 'OK', message: 'Đã cập nhật tác vụ.', data: publicAutomationJob(job) });
}
