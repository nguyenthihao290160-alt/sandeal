import { getReleaseIdentity } from '@/lib/releaseIdentity';

export const dynamic = 'force-dynamic';

export async function GET() {
  const release = getReleaseIdentity();
  return Response.json({
    status: 'PASS',
    app: release.app,
    version: release.version,
    buildId: release.buildId,
    timestamp: new Date().toISOString(),
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
