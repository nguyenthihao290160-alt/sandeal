import { getReleaseIdentity } from '@/lib/releaseIdentity';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    status: 'PASS',
    ...getReleaseIdentity(),
    timestamp: new Date().toISOString(),
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
