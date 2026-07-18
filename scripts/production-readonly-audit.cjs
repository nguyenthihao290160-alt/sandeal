/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const baseArg = process.argv.find(argument => argument.startsWith('--base-url='));
if (!baseArg) throw new Error('BASE_URL_REQUIRED');
const baseUrl = new URL(baseArg.slice('--base-url='.length));
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(baseUrl.hostname);
if ((baseUrl.protocol !== 'https:' && !(loopback && baseUrl.protocol === 'http:')) || baseUrl.username || baseUrl.password || baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) {
  throw new Error('BASE_URL_NOT_APPROVED');
}

const authUser = process.env.SANDEAL_AUDIT_AUTH_USER || '';
const authPassword = process.env.SANDEAL_AUDIT_AUTH_PASSWORD || '';
if (Boolean(authUser) !== Boolean(authPassword)) throw new Error('AUDIT_AUTH_INCOMPLETE');
const authHeader = authUser && authPassword ? `Basic ${Buffer.from(`${authUser}:${authPassword}`).toString('base64')}` : undefined;
const startedAt = new Date().toISOString();
const checks = [];
const observed = { publicProductCount: null, totalProductRecords: null, candidateCounts: null, jobCounts: null, launchReadyCount: null, sourceStatus: null, workerStatus: null, schedulerStatus: null };

function secretKeys(value, prefix = '', found = []) {
  if (!value || typeof value !== 'object' || found.length >= 20) return found;
  for (const [key, item] of Object.entries(value)) {
    const current = prefix ? `${prefix}.${key}` : key;
    if (/(?:password|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|credential)/i.test(key)) found.push(current);
    if (/(?:stackTrace|dataDirectory|absolutePath|leaseOwnership)/i.test(key)) found.push(current);
    if (typeof item === 'object') secretKeys(item, current, found);
  }
  return found;
}

function levelFor(status, critical, leaks, truthMismatch) {
  if (leaks.length || status >= 500 || (critical && (status < 200 || status >= 400))) return 'CRITICAL';
  if (status >= 400 || truthMismatch) return 'WARNING';
  return 'PASS';
}

async function inspect(route, options = {}) {
  const target = new URL(route, baseUrl);
  if (target.origin !== baseUrl.origin) throw new Error('AUDIT_ROUTE_ESCAPED_ORIGIN');
  const before = Date.now();
  let response;
  try {
    response = await fetch(target, {
      method: options.method || 'GET', redirect: 'manual',
      headers: options.auth && authHeader ? { authorization: authHeader } : undefined,
      signal: AbortSignal.timeout(options.timeoutMs || 8_000),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.subarray(0, 1024 * 1024).toString('utf8');
    let json = null;
    if ((response.headers.get('content-type') || '').includes('json')) {
      try { json = JSON.parse(text); } catch {}
    }
    const leaks = json ? secretKeys(json) : [];
    const truthMismatch = Boolean(json && ((json.ok === true && response.status >= 400) || (json.ok === false && response.status < 400)));
    const location = response.headers.get('location');
    let redirectOrigin = null;
    if (location) {
      try { redirectOrigin = new URL(location, baseUrl).origin; } catch { redirectOrigin = 'INVALID'; }
    }
    const check = {
      route, method: options.method || 'GET', authenticated: Boolean(options.auth && authHeader),
      status: response.status, latencyMs: Date.now() - before, bytes: buffer.length,
      contentType: (response.headers.get('content-type') || '').split(';')[0] || null,
      redirectOrigin, truthMismatch, leakagePaths: leaks,
    };
    check.result = levelFor(response.status, options.critical === true, leaks, truthMismatch);
    checks.push(check);
    return { response, json, check };
  } catch (error) {
    const check = { route, method: options.method || 'GET', authenticated: Boolean(options.auth && authHeader), status: null, latencyMs: Date.now() - before, result: options.critical ? 'CRITICAL' : 'WARNING', error: error instanceof Error && /timeout|abort/i.test(`${error.name}:${error.message}`) ? 'TIMEOUT' : 'REQUEST_FAILED' };
    checks.push(check);
    return { response: null, json: null, check };
  }
}

async function main() {
  await inspect('/', { critical: true });
  await inspect('/deals', { critical: true });
  const publicProducts = await inspect('/api/public/products?pageSize=5', { critical: true });
  await inspect('/api/health', { critical: true });
  const publicData = publicProducts.json?.data;
  observed.publicProductCount = publicData?.pagination?.totalItems ?? publicData?.items?.length ?? null;
  const firstProduct = Array.isArray(publicData?.items) ? publicData.items[0] : null;
  if (firstProduct?.slug) await inspect(`/api/public/products/${encodeURIComponent(firstProduct.slug)}`, { critical: true });
  if (firstProduct?.slug) await inspect(`/deals/${encodeURIComponent(firstProduct.slug)}`, { critical: true });
  if (firstProduct?.id) await inspect(`/go/${encodeURIComponent(firstProduct.id)}`, { critical: true });

  const health = await inspect('/api/automation/health', { auth: true });
  const onboarding = await inspect('/api/automation/onboarding', { auth: true });
  const jobs = await inspect('/api/automation/jobs?page=1&pageSize=5', { auth: true });
  const dashboardApi = await inspect('/api/automation/dashboard?range=today', { auth: true });
  const sources = await inspect('/api/product-sources', { auth: true });
  for (const route of ['/dashboard', '/dashboard/products', '/dashboard/ai-bots', '/dashboard/automation', '/dashboard/alerts', '/dashboard/product-sources']) {
    await inspect(route, { auth: true });
  }

  const healthData = health.json?.data;
  const dashboardData = dashboardApi.json?.data;
  observed.workerStatus = healthData?.worker?.status ?? dashboardData?.worker?.status ?? null;
  observed.schedulerStatus = healthData?.scheduler?.status ?? dashboardData?.scheduler?.status ?? null;
  observed.jobCounts = healthData?.queue ?? dashboardData?.queue ?? jobs.json?.data?.stats ?? null;
  observed.candidateCounts = dashboardData?.inventory?.diagnostic?.candidateQueue ?? null;
  observed.launchReadyCount = dashboardData?.inventory?.launchReady?.totalReady ?? null;
  observed.totalProductRecords = dashboardData?.inventory?.diagnostic?.totalProductRecords ?? null;
  observed.sourceStatus = dashboardData?.inventory?.diagnostic?.sourceStatus ?? onboarding.json?.data?.source?.status ?? sources.json?.data?.status ?? null;

  const counts = { PASS: 0, WARNING: 0, CRITICAL: 0 };
  for (const check of checks) counts[check.result] += 1;
  const status = counts.CRITICAL ? 'CRITICAL' : counts.WARNING ? 'WARNING' : 'PASS';
  const report = {
    schemaVersion: 1, status, startedAt, completedAt: new Date().toISOString(),
    baseOrigin: baseUrl.origin, readOnlyMethods: [...new Set(checks.map(check => check.method))],
    credentialsUsed: Boolean(authHeader), summary: counts, observed, checks,
  };
  const outputDir = path.join(root, '.test-tmp', 'production-readonly-audit');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `audit-${Date.now()}.json`);
  fs.writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ status, summary: counts, output: path.relative(root, outputFile), methods: report.readOnlyMethods }));
  if (status === 'CRITICAL') process.exitCode = 2;
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'AUDIT_FAILED'); process.exitCode = 1; });
