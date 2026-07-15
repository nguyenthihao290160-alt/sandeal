import { type NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { getManualTask } from '@/lib/automation/manualTasks';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requirePermission(request, 'MANAGE_AUTOMATION');
  if (denied) return denied;
  const { id } = await params;
  const task = await getManualTask(id);
  if (!task) return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'Không tìm thấy công việc thủ công.' }, { status: 404 });
  return NextResponse.json({ ok: true, code: 'OK', message: 'Đã tải công việc thủ công.', data: task }, { headers: { 'Cache-Control': 'no-store' } });
}
