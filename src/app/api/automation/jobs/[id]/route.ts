import { type NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { getAutomationJob, publicAutomationJob } from '@/lib/automation/store';
import { getCandidateById } from '@/lib/storage/candidateQueue';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requirePermission(request, 'MANAGE_AUTOMATION'); if (authError) return authError;
  const { id } = await params;
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Mã tác vụ không hợp lệ.' }, { status: 400 });
  }
  const job = await getAutomationJob(id);
  if (!job) return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'Không tìm thấy tác vụ.' }, { status: 404 });
  const candidateId = job.type === 'PROCESS_CANDIDATE' && typeof job.payload.candidateId === 'string' ? job.payload.candidateId : '';
  const candidate = candidateId ? await getCandidateById(candidateId) : null;
  const candidateDiagnostics = candidate ? {
    status: candidate.status,
    reasonCode: candidate.terminalReason || candidate.delayReason || null,
    retryable: candidate.retryable === true,
    attempts: candidate.attempts,
    nextRetryAt: candidate.nextAttemptAt || null,
    affiliateGatewayDomain: candidate.affiliateGatewayDomain || null,
    merchantDomain: candidate.merchantDomain || null,
    affiliateHealth: candidate.sourceEvidence?.affiliate.classification || 'UNVERIFIED',
    merchantHealth: candidate.sourceEvidence?.merchant?.classification || 'UNVERIFIED',
    lastProbeAt: candidate.lastProbeAt || null,
  } : null;
  return NextResponse.json({ ok: true, code: 'OK', message: 'Đã tải tác vụ.', data: { ...publicAutomationJob(job), candidateDiagnostics } });
}
