import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { buildReadinessReport } from '@/lib/health/readiness';
import { getReleaseIdentity } from '@/lib/releaseIdentity';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;
  try {
    const report = await buildReadinessReport();
    return NextResponse.json({ ...getReleaseIdentity(), ...report }, {
      status: report.status === 'CRITICAL' ? 503 : 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({
      ...getReleaseIdentity(),
      status: 'CRITICAL',
      checks: [{ status: 'CRITICAL', code: 'READINESS_CHECK_FAILED', message: 'Readiness could not be evaluated safely.' }],
      timestamp: new Date().toISOString(),
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
