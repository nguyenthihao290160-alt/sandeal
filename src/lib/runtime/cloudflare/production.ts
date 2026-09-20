import type { CloudflareEnvironment } from './context';
import type { D1Database, D1Statement } from '../../storage/d1/database';
import { executionFingerprint } from '../../execution-control-plane/fingerprint';
import { productionPreflight, validProductionIdentity, PRODUCTION_SECRET_REFERENCES,
  type ProductionIdentity, type ProductionBundle, type ProductionApproval, type ProductionControls,
  type ProductionTrust } from '../../execution-control-plane/production';

export interface ProductionEnvironment {
  SANDEAL_PRODUCTION_EXECUTION_ENABLED?: string;
  SANDEAL_PRODUCTION_IDENTITY?: string;
  SANDEAL_PRODUCTION_BUNDLE_FINGERPRINT?: string;
  SANDEAL_PRODUCTION_APPROVAL_KEYS?: string;
}
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Robots-Tag': 'noindex, nofollow' };
function parse<T>(value: unknown, maximum = 65536): T {
  if (typeof value !== 'string' || value.length > maximum) throw new Error('PRODUCTION_RECORD_INVALID');
  return JSON.parse(value) as T;
}
async function first<Row>(statement: D1Statement): Promise<Row | null> {
  const result = await statement.all<Row>();
  if (!result.success || !Array.isArray(result.results) || result.results.length > 1) throw new Error('PRODUCTION_READ_FAILED');
  return result.results[0] ?? null;
}
async function readControls(db: D1Database): Promise<ProductionControls> {
  const row = await first<{
    state: string; revision: number; observed_at: number; expires_at: number; payload: string;
  }>(db.prepare("SELECT state, revision, observed_at, expires_at, payload FROM execution_controls WHERE id='global' LIMIT 1"));
  if (!row) throw new Error('PRODUCTION_CONTROL_UNAVAILABLE');
  const controls = parse<ProductionControls>(row.payload);
  if (controls.killSwitch.state !== row.state || controls.killSwitch.revision !== row.revision
    || controls.killSwitch.observedAt !== row.observed_at || controls.killSwitch.expiresAt !== row.expires_at) throw new Error('PRODUCTION_CONTROL_DRIFT');
  return controls;
}
export async function productionFetch(request: Request, env: CloudflareEnvironment): Promise<Response> {
  try {
    if (env.SANDEAL_RUNTIME !== 'cloudflare' || env.SANDEAL_LOCAL_ONLY !== 'false' || env.SANDEAL_PRODUCTION !== 'true'
      || env.SANDEAL_PRODUCTION_EXECUTION_ENABLED !== 'true') throw new Error('PRODUCTION_DISABLED');
    if (env.SHOPEE_AFFILIATE_ENABLED !== 'false' || ['SANDEAL_AUTOPILOT_ENABLED', 'SANDEAL_MONEY_ENGINE_ENABLED',
      'SANDEAL_DEAL_INTELLIGENCE_ENABLED', 'SANDEAL_DECISION_OS_ENABLED', 'SANDEAL_OPPORTUNITY_ENABLED',
      'SANDEAL_CONTENT_LIFECYCLE_ENABLED'].some(name => env[name as keyof CloudflareEnvironment] !== 'false')
      || (env.SANDEAL_DECISION_EXECUTION_MODE ?? 'DISABLED') !== 'DISABLED') throw new Error('PRODUCTION_CAPABILITY_DISABLED');
    const identity = parse<ProductionIdentity>(env.SANDEAL_PRODUCTION_IDENTITY, 16384);
    if (!validProductionIdentity(identity)) throw new Error('PRODUCTION_IDENTITY_INVALID');
    const url = new URL(request.url);
    if (!['GET', 'HEAD'].includes(request.method) || url.origin !== `https://${identity.targets.domain}` || url.search
      || !['/api/health/live', '/api/health/ready'].includes(url.pathname)) throw new Error('PRODUCTION_ROUTE_DISABLED');
    const db = env.DB as D1Database | undefined;
    if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function' || !env.JOB_QUEUE
      || typeof env.JOB_QUEUE.send !== 'function' || !env.ASSETS || typeof env.ASSETS.fetch !== 'function'
      || !/^[a-f0-9]{64}$/.test(env.SANDEAL_PRODUCTION_BUNDLE_FINGERPRINT ?? '')) throw new Error('PRODUCTION_BINDING_UNAVAILABLE');
    const releaseStatement = () => db.prepare("SELECT payload FROM release_bundles WHERE id=? AND environment='PRODUCTION' LIMIT 1")
      .bind(`prod-${env.SANDEAL_PRODUCTION_BUNDLE_FINGERPRINT}`);
    const row = await first<{ payload: string }>(releaseStatement());
    const record = parse<{ bundle: ProductionBundle; approval: ProductionApproval }>(row?.payload);
    if (executionFingerprint(record.bundle) !== env.SANDEAL_PRODUCTION_BUNDLE_FINGERPRINT) throw new Error('PRODUCTION_BUNDLE_MISMATCH');
    const trusted = parse<ProductionTrust[]>(env.SANDEAL_PRODUCTION_APPROVAL_KEYS, 16384);
    const controls = await readControls(db);
    const input = { enabled: true, bundle: record.bundle, current: identity, approval: record.approval, trusted, controls,
      now: Date.now(), capability: 'READ_PRODUCTION_HEALTH', bindings: { DB: true, JOB_QUEUE: true, ASSETS: true },
      availableSecretReferences: PRODUCTION_SECRET_REFERENCES.filter(name => typeof env[name] === 'string' && env[name]!.length > 0) };
    if (!productionPreflight(input).allowed) throw new Error('PRODUCTION_PREFLIGHT_BLOCKED');
    const latest = await first<{ name: string }>(db.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1'));
    if (latest?.name !== identity.migrations.at(-1)?.name) throw new Error('PRODUCTION_SCHEMA_DRIFT');
    const freshControls = await readControls(db);
    const freshRecord = await first<{ payload: string }>(releaseStatement());
    if (freshRecord?.payload !== row?.payload || executionFingerprint(freshControls) !== executionFingerprint(controls)
      || !productionPreflight({ ...input, controls: freshControls, now: Date.now() }).allowed) throw new Error('PRODUCTION_AUTHORITY_CHANGED');
    return new Response(request.method === 'HEAD' ? null : JSON.stringify({ ok: true, scope: 'AUTHORIZED_READ_ONLY_HEALTH', mutationAllowed: false }),
      { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } });
  } catch {
    return Response.json({ ok: false, code: 'PRODUCTION_EXECUTION_BLOCKED' }, { status: 503, headers });
  }
}
