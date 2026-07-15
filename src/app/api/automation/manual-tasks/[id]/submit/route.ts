import { type NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { submitManualTask } from '@/lib/automation/manualTasks';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requirePermission(request, 'MANAGE_AUTOMATION');
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Dữ liệu gửi lên không hợp lệ.' }, { status: 400 });
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'input')) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Thiếu dữ liệu theo biểu mẫu công việc.' }, { status: 400 });
  }
  const { id } = await params;
  try {
    const task = await submitManualTask(id, body.input, getServerActor());
    return NextResponse.json({ ok: true, code: 'OK', message: 'Đã kiểm tra dữ liệu và tiếp tục tác vụ từ checkpoint.', data: task });
  } catch (error) {
    const rawCode = error instanceof Error ? error.message.split(':')[0] : 'VALIDATION_ERROR';
    const code = ['MANUAL_TASK_NOT_FOUND', 'MANUAL_TASK_EXPIRED', 'MANUAL_TASK_INVALID_STATE', 'INVALID_MANUAL_INPUT', 'MANUAL_FIELD_REQUIRED', 'MANUAL_FIELD_INVALID', 'SENSITIVE_INPUT_REJECTED', 'MANUAL_RESUME_FAILED'].includes(rawCode) ? rawCode : 'VALIDATION_ERROR';
    const status = code === 'MANUAL_TASK_NOT_FOUND' ? 404 : code === 'MANUAL_TASK_INVALID_STATE' || code === 'MANUAL_TASK_EXPIRED' || code === 'MANUAL_RESUME_FAILED' ? 409 : 400;
    return NextResponse.json({ ok: false, code, message: code === 'SENSITIVE_INPUT_REJECTED' ? 'Không được gửi credential hoặc dữ liệu nhạy cảm trong công việc thủ công.' : 'Dữ liệu chưa đạt quy tắc của công việc; tác vụ chưa được tiếp tục.' }, { status });
  }
}
