import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getAutomationJob, publicAutomationJob } from '@/lib/automation/store';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireAuth(request); if (authError) return authError;
  const { id } = await params; const job = await getAutomationJob(id);
  if (!job) return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'Không tìm thấy tác vụ.' }, { status: 404 });
  return NextResponse.json({ ok: true, code: 'OK', message: 'Đã tải tác vụ.', data: publicAutomationJob(job) });
}
