/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
require('./register-typescript.cjs');

const tempDir = path.join(process.cwd(), '.test-tmp', `sandeal-automation-tests-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'automation-test';
process.env.BASIC_AUTH_PASSWORD = 'not-a-real-secret';

let passed = 0; let failed = 0;
async function test(name, work) { try { await work(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error}`); } }
function assert(value, message = 'assertion failed') { if (!value) throw new Error(message); }
function equal(actual, expected, message) { if (actual !== expected) throw new Error(message || `${actual} !== ${expected}`); }
const auth = `Basic ${Buffer.from('automation-test:not-a-real-secret').toString('base64')}`;
const headers = { authorization: auth, 'content-type': 'application/json' };

(async () => {
  const adapter = require('../src/lib/storage/adapter.ts');
  const store = require('../src/lib/automation/store.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const scheduler = require('../src/lib/automation/scheduler.ts');
  const settingsStore = require('../src/lib/storage/automationSettings.ts');
  const jobsRoute = require('../src/app/api/automation/jobs/route.ts');
  const controlRoute = require('../src/app/api/automation/control/route.ts');
  const healthRoute = require('../src/app/api/automation/health/route.ts');
  const { NextRequest } = require('next/server');

  async function reset() {
    for (const collection of ['automation-jobs','automation-control','automation-audit','automation-ai-usage','automation-circuits','products']) await adapter.writeCollection(collection, []);
    await settingsStore.updateAutomationSettings({ enabled: false, intervalHours: 6, maxItemsPerRun: 10, maxItemsPerDay: 30 });
  }
  function create(overrides = {}) { return store.createAutomationJob({ type: 'HEALTH_CHECK', payload: {}, idempotencyKey: `job:${Date.now()}:${Math.random().toString(36).slice(2)}`, requestedBy: 'test', riskLevel: 'LOW', ...overrides }); }

  await reset();
  await test('hàng chờ được lưu bền vững trên tệp', async () => {
    const created = await create({ operationId: 'operation-persist-01', idempotencyKey: 'persist-job-0001' });
    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, 'automation-jobs.json'), 'utf8'));
    equal(onDisk[0].id, created.job.id); equal((await store.getAutomationJob(created.job.id)).operationId, 'operation-persist-01');
  });

  await test('storage phục hồi từ bản sao khi tệp chính bị hỏng', async () => {
    await adapter.writeCollection('recovery-check', [{ id: 'version-1' }]);
    await adapter.writeCollection('recovery-check', [{ id: 'version-2' }]);
    fs.writeFileSync(path.join(tempDir, 'recovery-check.json'), '{broken', 'utf8');
    const recovered = await adapter.readCollection('recovery-check');
    equal(recovered[0].id, 'version-1');
  });

  await test('idempotency chặn tạo tác vụ trùng', async () => {
    const first = await create({ idempotencyKey: 'duplicate-job-0001' });
    const second = await create({ idempotencyKey: 'duplicate-job-0001' });
    assert(first.created); assert(!second.created); equal(first.job.id, second.job.id); equal(second.code, 'IN_PROGRESS');
  });

  await test('hai bộ xử lý không claim cùng tác vụ', async () => {
    await reset(); await create({ idempotencyKey: 'claim-once-0001' });
    const [a, b] = await Promise.all([store.claimAutomationJobs('worker-a', 1), store.claimAutomationJobs('worker-b', 1)]);
    equal(a.length + b.length, 1); equal(new Set([...a, ...b].map(job => job.id)).size, 1);
  });

  await test('lease hết hạn phục hồi tác vụ mà không báo thành công', async () => {
    await reset(); const created = await create({ idempotencyKey: 'expired-lease-01', maxAttempts: 3 }); const base = Date.now();
    await store.claimAutomationJobs('worker-a', 1, 100, base);
    await store.claimAutomationJobs('worker-b', 1, 100, base + 101);
    const recovered = await store.getAutomationJob(created.job.id);
    equal(recovered.status, 'RETRY_SCHEDULED'); equal(recovered.lastErrorCode, 'LEASE_EXPIRED'); assert(!recovered.completedAt);
  });

  await test('heartbeat gia hạn lease đúng worker', async () => {
    await reset(); const created = await create({ idempotencyKey: 'heartbeat-job-01' }); const [claimed] = await store.claimAutomationJobs('worker-heartbeat', 1, 100);
    assert(claimed?.claimToken); assert(await store.heartbeatAutomationJob(created.job.id, 'worker-heartbeat', 5000, claimed.claimToken));
    assert(!(await store.heartbeatAutomationJob(created.job.id, 'worker-other', 5000, claimed.claimToken)));
    assert(!(await store.heartbeatAutomationJob(created.job.id, 'worker-heartbeat', 5000)));
  });

  await test('lỗi tạm thời retry có giới hạn, lỗi xác thực không retry', async () => {
    await reset(); const timeout = await create({ idempotencyKey: 'timeout-job-001' }); await store.claimAutomationJobs('worker-a', 1); await store.failAutomationJob(timeout.job.id, 'worker-a', 'TIMEOUT', 'timeout');
    equal((await store.getAutomationJob(timeout.job.id)).status, 'RETRY_SCHEDULED');
    const authJob = await create({ idempotencyKey: 'auth-job-000001' }); await store.claimAutomationJobs('worker-a', 1); await store.failAutomationJob(authJob.job.id, 'worker-a', 'AUTH_REQUIRED', 'not authorized');
    equal((await store.getAutomationJob(authJob.job.id)).status, 'FAILED');
    assert(store.isRetryableAutomationError('RATE_LIMITED')); assert(!store.isRetryableAutomationError('VALIDATION_ERROR'));
  });

  await test('mạch tự ngắt mở sau lỗi liên tiếp và chuyển sang kiểm tra phục hồi', async () => {
    await reset(); const base = Date.now(); await store.recordCircuitResult('gemini', false, base); await store.recordCircuitResult('gemini', false, base + 1); const opened = await store.recordCircuitResult('gemini', false, base + 2);
    equal(opened.state, 'OPEN'); assert(!(await store.canUseCircuit('gemini', base + 3)).allowed); const probe = await store.canUseCircuit('gemini', base + 5 * 60_000 + 3); equal(probe.circuit.state, 'HALF_OPEN'); assert(probe.allowed);
    equal((await store.recordCircuitResult('gemini', true, base + 5 * 60_000 + 4)).state, 'CLOSED');
  });

  await test('hạn mức AI chặn trước khi vượt giới hạn', async () => {
    await reset(); assert((await store.reserveAiUsage(100, 100000)).allowed); const blocked = await store.reserveAiUsage(1, 1); assert(!blocked.allowed); equal(blocked.usage.blocked, 1);
  });

  await test('rủi ro cao chờ phê duyệt và BLOCKER không thể vượt', async () => {
    await reset(); const high = await create({ idempotencyKey: 'high-risk-job01', riskLevel: 'HIGH' }); equal(high.job.status, 'WAITING_APPROVAL');
    const approved = await store.approveAutomationJob(high.job.id, 'admin', 'Đã kiểm tra phạm vi', true); equal(approved.status, 'PENDING'); equal(approved.approvalStatus, 'APPROVED');
    const blocker = await create({ idempotencyKey: 'blocked-job-0001', riskLevel: 'BLOCKER' }); equal(blocker.job.status, 'BLOCKED'); equal(await store.approveAutomationJob(blocker.job.id, 'admin', 'Không được vượt', true), null);
  });

  await test('phê duyệt hết hạn bị từ chối', async () => {
    await reset(); const high = await create({ idempotencyKey: 'expired-approval1', riskLevel: 'HIGH' }); const jobs = await adapter.readCollection('automation-jobs'); jobs[0].approvalExpiresAt = new Date(Date.now() - 1000).toISOString(); await adapter.writeCollection('automation-jobs', jobs);
    const result = await store.approveAutomationJob(high.job.id, 'admin', 'Phê duyệt quá hạn', true); equal(result.status, 'CANCELLED'); equal(result.approvalStatus, 'EXPIRED');
  });

  await test('chạy thử qua worker không thay đổi dữ liệu nghiệp vụ', async () => {
    await reset(); await adapter.writeCollection('products', [{ id: 'p1', title: 'Sản phẩm', status: 'draft', kind: 'product', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
    const before = fs.readFileSync(path.join(tempDir, 'products.json'), 'utf8'); const job = await create({ type: 'PRODUCT_SCAN', dryRun: true, idempotencyKey: 'dry-run-job-0001', payload: { limit: 5 } }); const result = await worker.processAutomationBatch('worker-dry-run', 1);
    equal(result.succeeded, 1); equal((await store.getAutomationJob(job.job.id)).status, 'SUCCEEDED'); equal(fs.readFileSync(path.join(tempDir, 'products.json'), 'utf8'), before); equal((await store.getAutomationJob(job.job.id)).result.externalSideEffect, false);
  });

  await test('tạm dừng worker và dừng khẩn cấp chặn claim', async () => {
    await reset(); await create({ idempotencyKey: 'paused-worker-01' }); await store.updateAutomationControl({ workerPaused: true, reason: 'Tạm dừng để bảo trì' }, 'admin'); equal((await store.claimAutomationJobs('worker-a', 1)).length, 0);
    await store.updateAutomationControl({ workerPaused: false, killSwitch: true, reason: 'Dừng khẩn cấp thử nghiệm' }, 'admin'); equal((await store.claimAutomationJobs('worker-a', 1)).length, 0);
  });

  await test('scheduler tạm dừng, chặn khi worker thiếu và tạo một tác vụ không approval', async () => {
    await reset(); await settingsStore.updateAutomationSettings({ enabled: true, intervalHours: 6 }); equal((await scheduler.runAutomationSchedulerTick()).status, 'paused');
    await store.updateAutomationControl({ schedulerPaused: false, schedulerNextRunAt: undefined, reason: 'Bật lịch kiểm thử' }, 'admin'); const now = Date.now(); equal((await scheduler.runAutomationSchedulerTick(now)).status, 'worker_stale');
    await store.updateAutomationControl({ workerHeartbeatAt: new Date(now).toISOString() }, 'worker-fixture'); const first = await scheduler.runAutomationSchedulerTick(now); equal(first.status, 'scheduled'); equal((await store.getAutomationJob(first.jobId)).status, 'PENDING'); equal((await store.getAutomationJob(first.jobId)).approvalStatus, 'NOT_REQUIRED');
    const second = await scheduler.runAutomationSchedulerTick(now); equal(second.status, 'not_due'); equal((await store.getAllAutomationJobs()).length, 1);
  });

  await test('hủy và chạy lại chỉ cho phép transition hợp lệ', async () => {
    await reset(); const pending = await create({ idempotencyKey: 'cancel-job-00001' }); equal((await store.cancelAutomationJob(pending.job.id, 'admin', 'Không còn cần thiết')).status, 'CANCELLED'); equal(await store.retryAutomationJob(pending.job.id, 'admin'), null);
    const failed = await create({ idempotencyKey: 'retry-job-000001' }); await store.claimAutomationJobs('worker-a', 1); await store.failAutomationJob(failed.job.id, 'worker-a', 'VALIDATION_ERROR', 'invalid'); equal((await store.retryAutomationJob(failed.job.id, 'admin')).status, 'PENDING');
  });

  await test('nhật ký loại bỏ secret đệ quy', async () => {
    await reset(); await store.appendAutomationAudit({ correlationId: 'corr', operationId: 'op', operationType: 'TEST', actor: 'test', risk: 'LOW', result: { apiKey: 'SHOULD_NOT_APPEAR', nested: { password: 'NO', value: 'safe' } }, reasons: ['done'], dryRun: true, attempts: 0 });
    const audit = await store.listAutomationAudit(1, 10); const raw = JSON.stringify(audit); assert(!raw.includes('SHOULD_NOT_APPEAR')); assert(!raw.includes('"password"')); assert(raw.includes('safe'));
  });

  await test('API từ chối anonymous và filter không hợp lệ', async () => {
    equal((await jobsRoute.GET(new NextRequest('http://localhost/api/automation/jobs'))).status, 401);
    equal((await jobsRoute.GET(new NextRequest('http://localhost/api/automation/jobs?status=DROP_TABLE', { headers }))).status, 400);
  });

  await test('API phân trang, DTO ẩn payload và operationId xuyên suốt', async () => {
    await reset(); await create({ idempotencyKey: 'api-page-job-001', operationId: 'operation-api-001', payload: { apiKey: 'hidden', limit: 2 } });
    const response = await jobsRoute.GET(new NextRequest('http://localhost/api/automation/jobs?page=1&pageSize=1', { headers })); equal(response.status, 200); const body = await response.json(); equal(body.data.pagination.pageSize, 1); equal(body.data.items[0].operationId, 'operation-api-001'); assert(!Object.prototype.hasOwnProperty.call(body.data.items[0], 'payload')); assert(!JSON.stringify(body).includes('hidden'));
  });

  await test('API điều khiển yêu cầu lý do và xác nhận dừng khẩn cấp', async () => {
    await reset(); const missing = await controlRoute.PATCH(new NextRequest('http://localhost/api/automation/control', { method: 'PATCH', headers, body: JSON.stringify({ action: 'enable_kill_switch', reason: 'Dừng ngay' }) })); equal(missing.status, 409);
    const confirmed = await controlRoute.PATCH(new NextRequest('http://localhost/api/automation/control', { method: 'PATCH', headers, body: JSON.stringify({ action: 'enable_kill_switch', reason: 'Dừng khẩn cấp để kiểm thử', confirmed: true }) })); equal(confirmed.status, 200); assert((await confirmed.json()).data.killSwitch);
  });

  await test('health phản ánh worker mất tín hiệu và chính sách miễn phí', async () => {
    await reset(); await store.updateAutomationControl({ workerHeartbeatAt: new Date(Date.now() - 60_000).toISOString(), workerId: 'stale-worker' }, 'test');
    const response = await healthRoute.GET(new NextRequest('http://localhost/api/automation/health', { headers })); const body = await response.json(); equal(body.data.worker.status, 'stale'); assert(body.data.policy.freeOnly); assert(!body.data.policy.allowPaidAi);
  });

  console.log(`\nAutomation targeted: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(error => { console.error(error); process.exit(1); });
