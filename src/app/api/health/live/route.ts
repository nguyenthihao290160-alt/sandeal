import { getReleaseIdentity } from '@/lib/releaseIdentity';

export const dynamic = 'force-dynamic';

export async function GET() {
  const release = getReleaseIdentity();
  return Response.json({
    status: 'PASS',
    // This deliberately exposes only the already-public release identity
    // fields. The guarded deploy verifier needs all of them to prove that the
    // built artifact, runtime process and browser-visible build agree; a
    // shortened `buildId` alone cannot establish that invariant.
    ...release,
    timestamp: new Date().toISOString(),
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
