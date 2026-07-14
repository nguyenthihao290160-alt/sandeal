import { type NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { getAutomationJob, publicAutomationJob } from '@/lib/automation/store';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requirePermission(request, 'MANAGE_AUTOMATION'); if (authError) return authError;
  const { id } = await params; const job = await getAutomationJob(id);
  if (!job) return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'Không tìm thấy tác vụ.' }, { status: 404 });
  return NextResponse.json({ ok: true, code: 'OK', message: 'Đã tải tác vụ.', data: publicAutomationJob(job) });
}
