// ===========================================
// GET /api/health
// Safe public health check for uptime monitoring
// Does NOT trigger bots. Does NOT expose secrets.
// ===========================================

const APP_START_TIME = Date.now();

export const dynamic = 'force-dynamic';

export async function GET() {
  const now = new Date();
  const uptimeSeconds = Math.floor((Date.now() - APP_START_TIME) / 1000);

  const environment =
    process.env.NODE_ENV === 'production'
      ? 'production'
      : process.env.NODE_ENV === 'development'
        ? 'development'
        : 'unknown';

  return Response.json({
    ok: true,
    app: 'sandeal',
    service: 'SanDeal / ReviewPilot AI',
    environment,
    time: now.toISOString(),
    uptimeSeconds,
    safeMode: true,
    freeOnly: true,
    autoPilot: true,
    safePublish: true,
  });
}
