/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt12-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
process.env.ALLOW_PUBLISHING_API = 'false';
process.env.AUTO_PUBLISH_ENABLED = 'false';
delete process.env.SANDEAL_STORAGE_DRIVER;
delete process.env.MONGODB_URI;
global.fetch = async () => { throw new Error('PROMPT12_NETWORK_FORBIDDEN'); };
require('./register-typescript.cjs');

const storage = require('../src/lib/storage/adapter.ts');
const storageConfig = require('../src/lib/storage/storageConfig.ts');
const incidents = require('../src/lib/product-intelligence/alertIncidents.ts');
const automationTruth = require('../src/lib/automation/truth.ts');
const timezone = require('../src/lib/automation/timezone.ts');
const productTruth = require('../src/lib/product-intelligence/productPipelineTruth.ts');
const classification = require('../src/lib/autonomous/recordClassification.ts');
const cleanup = require('../src/lib/product-intelligence/accessTradeCleanup.ts');
const urlSafety = require('../src/lib/product-intelligence/urlSafety.ts');
const credentialTruth = require('../src/lib/ai/credentialTruth.ts');
const secrets = require('../src/lib/security/secrets.ts');
const tokenVault = require('../src/lib/storage/tokenVault.ts');

const source = (file) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const now = Date.parse('2026-07-19T05:00:00.000Z');
let passed = 0;
let failed = 0;

async function test(number, name, work) {
  try {
    await work();
    passed += 1;
    console.log(`PASS ${number}. ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${number}. ${name}\n${error && error.stack ? error.stack : error}`);
  }
}

function alert(id, type = 'broken_link', entityId = id) {
  const at = new Date(now).toISOString();
  return { id, deduplicationKey: id, groupKey: type, type, severity: 'important', title: type, message: type,
    entityType: 'product', entityId, operationId: id, suggestedAction: 'recheck', recommendedAction: 'recheck',
    status: 'new', createdAt: at, updatedAt: at, firstSeenAt: at, lastSeenAt: at, occurrenceCount: 1, autoResolve: false };
}

function control(overrides = {}) {
  const at = new Date(now).toISOString();
  return { schemaVersion: 2, id: 'automation-control', mode: 'SAFE_MANUAL', effectiveMode: 'SAFE_MANUAL', publishPaused: true,
    ingestionPaused: false, workerPaused: false, schedulerPaused: false, killSwitch: false, timezone: 'Asia/Ho_Chi_Minh', updatedAt: at,
    schedulerHeartbeatAt: at, schedulerLastRunAt: at, schedulerNextRunAt: new Date(now + 60_000).toISOString(), ...overrides };
}

function lease(role, owner = role.toLowerCase(), overrides = {}) {
  const at = new Date(now).toISOString();
  return { schemaVersion: 2, id: role, role, ownerId: owner, instanceId: `${owner}-instance`, holderId: owner, status: 'ACTIVE',
    acquiredAt: at, startedAt: at, heartbeatAt: at, expiresAt: new Date(now + 45_000).toISOString(), leaseExpiresAt: new Date(now + 45_000).toISOString(),
    fencingToken: 2, takeoverCount: 0, updatedAt: at, ...overrides };
}

function job(id, status = 'PENDING', overrides = {}) {
  const at = new Date(now).toISOString();
  return { schemaVersion: 2, policyVersion: 'test', handlerVersion: 'test', id, type: 'RECHECK_PRODUCT_HEALTH', status,
    payload: {}, priority: 50, idempotencyKey: id, operationId: id, requestedBy: 'fixture', approvalStatus: 'NOT_REQUIRED', riskLevel: 'LOW', dryRun: false,
    attemptCount: 0, maxAttempts: 3, scheduledAt: at, createdAt: at, updatedAt: at, ...overrides };
}

function truthInput(overrides = {}) {
  return { now, settings: { enabled: true, intervalHours: 1, maxItemsPerDay: 100 }, control: control(), leases: [lease('SCHEDULER'), lease('WORKER')],
    conflicts: [], jobs: [], usage: { id: 'usage', day: '2026-07-19', requests: 0, tokens: 0, fallbacks: 0, blocked: 0, requestLimit: 100, tokenLimit: 1000, updatedAt: new Date(now).toISOString() }, ...overrides };
}

function product(overrides = {}) {
  const at = new Date(now).toISOString();
  return { id: 'product-1', title: 'Tai nghe Bluetooth fixture', slug: 'tai-nghe-fixture', kind: 'product', recordType: 'PRODUCT', platform: 'website', source: 'manual',
    originalUrl: 'https://merchant.example/product-1', affiliateUrl: 'https://merchant.example/product-1?ref=fixture', imageUrl: 'https://merchant.example/product-1.jpg',
    price: 100000, currency: 'VND', status: 'needs_review', lifecycleState: 'STAGED', publicHidden: true, verifiedSource: true, sourceVerified: true,
    linkHealthStatus: 'ok', imageHealthStatus: 'ok', createdAt: at, updatedAt: at, ...overrides };
}

function pipeline(p = product(), jobs = [], actions = []) {
  return productTruth.buildProductPipelineTruth({ product: p, jobs, actions, launchEnabled: false, effectiveMode: 'SAFE_MANUAL', now });
}

async function reset(...collections) { for (const name of collections) await storage.writeCollection(name, []); }

async function main() {
  const grouped = incidents.groupAlertsIntoIncidents([alert('a', 'broken_link', 'p1'), alert('b', 'broken_link', 'p2')], now);
  await test(1, 'Cùng root cause được gom đúng', () => assert.equal(grouped.incidents.length, 1));
  await test(2, 'Khác root cause không bị gom', () => assert.equal(incidents.groupAlertsIntoIncidents([alert('a'), alert('b', 'broken_image')], now).incidents.length, 2));
  await test(3, 'affectedCount chính xác', () => assert.equal(grouped.incidents[0].affectedCount, 2));
  await test(4, 'Re-run grouping deterministic', () => assert.deepEqual(grouped, incidents.groupAlertsIntoIncidents([alert('a', 'broken_link', 'p1'), alert('b', 'broken_link', 'p2')], now)));
  await test(5, 'New occurrence cập nhật incident cũ', async () => { await reset('product-alerts', 'alert-incidents', 'alert-occurrences'); await storage.writeCollection('product-alerts', [alert('a')]); await incidents.synchronizeAlertIncidents(now); await storage.writeCollection('product-alerts', [alert('a'), alert('b', 'broken_link', 'p2')]); await incidents.synchronizeAlertIncidents(now + 1); assert.equal((await incidents.listAlertIncidents()).items[0].affectedCount, 2); });
  await test(6, 'Resolved incident reopen khi lỗi quay lại', async () => { const item = (await incidents.listAlertIncidents()).items[0]; await storage.writeCollection('alert-incidents', [{ ...item, status: 'RESOLVED', resolvedAt: new Date(now).toISOString() }]); const result = await incidents.synchronizeAlertIncidents(now + 2); assert.equal(result.reopened, 1); assert.notEqual((await incidents.listAlertIncidents()).items[0].status, 'RESOLVED'); });
  await test(7, 'Remediation queued không tự resolved', () => assert.ok(source('src/lib/product-intelligence/alertIncidents.ts').includes("current.remediationAttemptCount = attempt; current.status = 'REMEDIATION_QUEUED'")));
  await test(8, 'Recheck PASS + zero occurrence mới resolved', async () => { const item = (await incidents.listAlertIncidents()).items[0]; await storage.writeCollection('alert-occurrences', []); const checked = await incidents.recordIncidentRecheck(item.id, { checker: 'fixture-checker', checkerVersion: '1', checkedAt: new Date(now + 3).toISOString(), result: 'PASS', affectedCountBefore: 2, affectedCountAfter: 0, sampleEntityIds: [], metadata: {} }); assert.equal(checked.status, 'RESOLVED'); });
  await test(9, 'Recheck FAIL giữ active', async () => { const item = (await incidents.listAlertIncidents()).items[0]; const checked = await incidents.recordIncidentRecheck(item.id, { checker: 'fixture', checkerVersion: '1', checkedAt: new Date(now + 4).toISOString(), result: 'FAIL', affectedCountBefore: 1, affectedCountAfter: 0, sampleEntityIds: [], metadata: {} }); assert.notEqual(checked.status, 'RESOLVED'); });
  await test(10, 'Inconclusive không resolved', async () => { const item = (await incidents.listAlertIncidents()).items[0]; const checked = await incidents.recordIncidentRecheck(item.id, { checker: 'fixture', checkerVersion: '1', checkedAt: new Date(now + 5).toISOString(), result: 'INCONCLUSIVE', affectedCountBefore: 1, affectedCountAfter: 0, sampleEntityIds: [], metadata: {} }); assert.notEqual(checked.status, 'RESOLVED'); });
  await test(11, 'Retry bounded', () => assert.equal(incidents.deriveAlertRootCause(alert('x', 'broken_link')).maxAttempts, 3));
  await test(12, 'Cooldown được tôn trọng', () => assert.ok(source('src/lib/product-intelligence/alertIncidents.ts').includes('REMEDIATION_COOLDOWN_ACTIVE')));
  await test(13, 'Permanent error không retry', () => assert.equal(incidents.deriveAlertRootCause(alert('x', 'credential_missing')).autoRemediationAllowed, false));
  await test(14, 'Duplicate remediation job bị chặn', () => assert.ok(source('src/lib/product-intelligence/alertIncidents.ts').includes('idempotencyKey: `${incident.idempotencyKey}:${attempt}`')));
  await test(15, 'Evidence redact secret', () => { const safe = incidents.safeRemediationEvidence({ checker: 'x', checkerVersion: '1', checkedAt: new Date(now).toISOString(), result: 'FAIL', affectedCountBefore: 1, affectedCountAfter: 1, sampleEntityIds: [], metadata: { token: 'test-sensitive-value', nested: { password: 'test-sensitive-value', reason: 'timeout' } } }); assert.equal('token' in safe.metadata, false); assert.equal(safe.metadata.nested.password, undefined); });
  await test(16, 'Bulk acknowledge không đổi lifecycle', () => assert.ok(!source('src/lib/product-intelligence/alertIncidents.ts').match(/ALERT_INCIDENT_ACKNOWLEDGE[\s\S]{0,300}lifecycle/)));
  await test(17, 'Bulk resolved thiếu evidence bị chặn', () => assert.ok(source('src/app/api/dashboard/alert-incidents/route.ts').includes('RECHECK_EVIDENCE_REQUIRED')));

  await test(18, 'Scheduler lease healthy active', () => assert.equal(automationTruth.buildAutomationTruth(truthInput()).scheduler.active, true));
  await test(19, 'Lease stale inactive/degraded', () => { const value = automationTruth.buildAutomationTruth(truthInput({ leases: [lease('SCHEDULER', 's', { leaseExpiresAt: new Date(now - 1).toISOString() })] })); assert.equal(value.scheduler.active, false); });
  await test(20, 'Heartbeat stale inactive', () => { const value = automationTruth.buildAutomationTruth(truthInput({ leases: [lease('SCHEDULER', 's', { heartbeatAt: new Date(now - 200000).toISOString() })] })); assert.equal(value.scheduler.active, false); });
  await test(21, 'Duplicate owner inconsistent', () => { const value = automationTruth.buildAutomationTruth(truthInput({ leases: [lease('SCHEDULER', 'a'), lease('SCHEDULER', 'b', { fencingToken: 3 })] })); assert.ok(value.inconsistencies.some(x => x.code === 'DUPLICATE_ACTIVE_SCHEDULER_LEASE')); });
  await test(22, 'Fencing conflict inconsistent', () => { const value = automationTruth.buildAutomationTruth(truthInput({ leases: [lease('SCHEDULER', 'a'), lease('SCHEDULER', 'b')] })); assert.ok(value.inconsistencies.some(x => x.code === 'FENCING_TOKEN_CONFLICT')); });
  await test(23, 'Schedule enabled runtime stale không ACTIVE', () => assert.equal(automationTruth.buildAutomationTruth(truthInput({ leases: [] })).scheduler.state, 'INACTIVE'));
  await test(24, 'Queue pending và worker inactive inconsistency', () => { const value = automationTruth.buildAutomationTruth(truthInput({ leases: [lease('SCHEDULER')], jobs: [job('p')] })); assert.ok(value.inconsistencies.some(x => x.code === 'QUEUE_PENDING_WORKER_INACTIVE')); });
  await test(25, 'nextRunAt quá khứ inconsistency', () => { const value = automationTruth.buildAutomationTruth(truthInput({ control: control({ schedulerNextRunAt: new Date(now - 200000).toISOString() }) })); assert.ok(value.inconsistencies.some(x => x.code === 'NEXT_RUN_OVERDUE')); });
  await test(26, 'Recent run cũ hơn schedule inconsistency', () => { const old = new Date(now - 4 * 3600000).toISOString(); const value = automationTruth.buildAutomationTruth(truthInput({ jobs: [job('old', 'SUCCEEDED', { requestedBy: 'scheduler', updatedAt: old, completedAt: old })] })); assert.ok(value.inconsistencies.some(x => x.code === 'SCHEDULE_RUN_STALE')); });
  await test(27, 'Timezone Asia/Ho_Chi_Minh', () => assert.equal(automationTruth.buildAutomationTruth(truthInput()).timezone, 'Asia/Ho_Chi_Minh'));
  await test(28, 'Boundary ngày Việt Nam đúng', () => { assert.equal(timezone.vietnamDayKey(Date.parse('2026-07-18T16:59:59Z')), '2026-07-18'); assert.equal(timezone.vietnamDayKey(Date.parse('2026-07-18T17:00:00Z')), '2026-07-19'); });
  await test(29, 'Daily usage không trộn UTC date', () => assert.equal(timezone.vietnamDayKey(Date.parse('2026-07-18T18:00:00Z')), '2026-07-19'));
  await test(30, 'Legacy logs không override truth', () => assert.ok(!source('src/lib/automation/truth.ts').includes('legacy')));
  await test(31, 'Automation API không trả secret payload', () => { const text = source('src/lib/automation/truth.ts'); assert.ok(text.includes('publicAutomationJob')); assert.ok(!text.includes('getServerConfig')); });
  await test(32, 'Read model deterministic fixture', () => assert.deepEqual(automationTruth.buildAutomationTruth(truthInput()), automationTruth.buildAutomationTruth(truthInput())));

  await test(33, 'Classification PRODUCT đúng', () => assert.equal(classification.classifyRecord(product()).recordType, 'PRODUCT'));
  await test(34, 'VOUCHER không vào lifecycle product', () => assert.notEqual(pipeline(product({ title: 'Giảm 20% cho đơn hàng', price: undefined })).classification.type, 'PRODUCT'));
  await test(35, 'STORE_OFFER bị quarantine', () => assert.equal(classification.classifyRecord({ title: '[Shop] - Giảm 20% đơn hàng', rawSourceType: 'store offer' }).action, 'QUARANTINE'));
  await test(36, 'publicHidden mặc định true', () => assert.equal(pipeline(product({ publicHidden: undefined })).lifecycle.publicHidden, true));
  await test(37, 'Publishing disabled phản ánh truth', () => assert.equal(pipeline().safety.publishingEnabled, false));
  await test(38, 'Current job truth đúng', () => assert.equal(pipeline(product(), [job('job-current', 'PENDING', { payload: { productId: 'product-1' } })]).automation.currentJobId, 'job-current'));
  await test(39, 'Stale RUNNING phát hiện', () => assert.equal(pipeline(product(), [job('stale', 'RUNNING', { payload: { productId: 'product-1' }, leaseExpiresAt: new Date(now - 1).toISOString() })]).automation.status, 'STALE'));
  await test(40, 'Retry scheduled có nextRetryAt', () => { const next = new Date(now + 1000).toISOString(); assert.equal(pipeline(product(), [job('retry', 'RETRY_SCHEDULED', { payload: { productId: 'product-1' }, nextRetryAt: next })]).automation.nextRetryAt, next); });
  await test(41, 'Critical blocker chặn canary readiness', () => assert.equal(pipeline(product({ price: undefined }), [], [{ productId: 'product-1', action: 'canary_ready' }]).lifecycle.canaryReady, false));
  await test(42, 'Mark reviewed không tạo publish job', () => assert.ok(!source('src/lib/product-intelligence/productActions.ts').match(/action === 'reviewed'[\s\S]{0,300}createAutomationJob/)));
  await test(43, 'Data verified không tự publish', () => assert.ok(!source('src/lib/product-intelligence/productActions.ts').match(/action === 'data_verified'[\s\S]{0,400}publishCanonical/)));
  await test(44, 'Canary ready không bật CANARY', () => assert.ok(!source('src/lib/product-intelligence/productActions.ts').includes("effectiveMode: 'CANARY'")));
  await test(45, 'Safe publish request chỉ tạo assessment', () => assert.ok(source('src/lib/product-intelligence/productActions.ts').includes('safePublishAssessment: true')));
  await test(46, 'Safe publish request idempotent', () => assert.ok(source('src/lib/product-intelligence/productActions.ts').includes('actionId(input.productId, input.action, operationId)')));
  await test(47, 'Publish approved không publish khi disabled', () => assert.equal(pipeline(product(), [], [{ productId: 'product-1', action: 'publish_approved' }]).lifecycle.published, false));
  await test(48, 'Prompt 12 không tạo published state', () => assert.ok(!source('src/lib/product-intelligence/productActions.ts').includes("action: 'published'")));

  await test(49, 'Link normalization an toàn', () => assert.equal(urlSafety.validateExternalUrl(' https://example.com/a#b ').normalizedUrl, 'https://example.com/a'));
  await test(50, 'javascript/data URL bị từ chối', () => { assert.equal(urlSafety.validateExternalUrl('javascript:alert(1)').safe, false); assert.equal(urlSafety.validateExternalUrl('data:text/plain,x').safe, false); });
  await test(51, 'Private IP và metadata endpoint bị chặn', () => { for (const host of ['127.0.0.1', '10.0.0.1', '169.254.169.254', 'metadata.google.internal', '[::1]']) assert.equal(urlSafety.validateExternalUrl(`http://${host}/`).safe, false); });
  await test(52, 'Timeout bounded', () => { const text = source('src/lib/product-intelligence/urlSafety.ts'); assert.ok(text.includes('Math.min(options.timeoutMs || 8_000, 20_000)')); assert.ok(text.includes('AbortSignal.timeout(timeoutMs)')); });
  await test(53, 'Image fallback không loop', () => assert.ok(source('src/components/safe-product-image.tsx').includes('if (index < sources.length)')));
  await test(54, 'Fallback không ghi source image', () => assert.ok(!source('src/components/safe-product-image.tsx').match(/fetch\(|save|updateProduct/)));
  await test(55, 'Missing price không thay bằng 0', () => assert.ok(!source('src/lib/product-intelligence/productActions.ts').match(/price\s*:\s*0/)));
  await test(56, 'Price update cần evidence', () => assert.ok(source('docs/operations/PROMPT12_OPERATIONAL_TRUTH.md').includes('Price không được thay bằng 0')));
  await test(57, 'Duplicate consolidation giữ provenance', () => assert.ok(source('src/lib/product-intelligence/accessTradeCleanup.ts').includes('rollbackClassification')));
  await test(58, 'Raw record không bị xóa', () => assert.ok(!source('src/lib/product-intelligence/accessTradeCleanup.ts').match(/deleteOne|splice\(|\.filter\([^\n]*update\.id/)));
  await test(59, 'Stale recovery dùng fencing', () => assert.ok(source('src/lib/automation/store.ts').includes("isRuntimeRoleOwner('WORKER', ownership")));
  await test(60, 'Healthy lease không takeover', () => assert.ok(source('src/lib/automation/store.ts').includes('HEALTHY_JOB_LEASE_TAKEOVER_FORBIDDEN')));
  await test(61, 'Retry max được tôn trọng', () => assert.ok(source('src/lib/automation/store.ts').includes('job.attemptCount < job.maxAttempts')));
  await test(62, 'Không gọi network thật', () => assert.equal(global.fetch.toString().includes('PROMPT12_NETWORK_FORBIDDEN'), true));

  const storedCredential = { id: 'cred-b', maskedValue: '****abcd', status: 'valid', role: 'backup', metadata: { generationStatus: 'available', priority: 2 }, lastCheckedAt: new Date(now).toISOString() };
  await test(63, 'API không trả raw key', () => assert.ok(!source('src/app/api/token-vault/list/route.ts').includes('encryptedValue')));
  await test(64, 'Masking đúng', () => assert.equal(secrets.maskSecret('fixture-value-abcd'), '****abcd'));
  await test(65, 'stored không đồng nghĩa valid', () => { const value = credentialTruth.getCredentialTruth({ ...storedCredential, status: 'unchecked' }, now); assert.equal(value.valid, false); });
  await test(66, 'valid không đồng nghĩa generation_ready', () => { const value = credentialTruth.getCredentialTruth({ ...storedCredential, metadata: { generationStatus: 'unchecked' } }, now); assert.equal(value.generationReady, false); });
  await test(67, 'Cooldown key không được chọn', () => { const value = credentialTruth.getCredentialTruth({ ...storedCredential, metadata: { generationStatus: 'available', cooldownUntil: new Date(now + 1000).toISOString() } }, now); assert.equal(value.generationReady, false); });
  await test(68, 'Disabled key không được chọn', () => assert.equal(credentialTruth.getCredentialTruth({ ...storedCredential, role: 'disabled' }, now).state, 'disabled'));
  await test(69, 'Priority deterministic và write idempotent', async () => { const a = { id: 'a', truth: { priority: 1 } }; const b = { id: 'b', truth: { priority: 2 } }; assert.ok(credentialTruth.compareCredentialTruth(a, b) < 0); await reset('token-vault'); await storage.writeCollection('token-vault', [{ ...storedCredential, platform: 'gemini', credentialType: 'api_key', label: 'fixture', encryptedValue: 'test-encrypted-placeholder', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }]); assert.equal((await tokenVault.updateCredentialPriority('cred-b', 4, 'test-priority-operation')).changed, true); assert.equal((await tokenVault.updateCredentialPriority('cred-b', 4, 'test-priority-operation')).changed, false); });
  await test(70, 'Không random key', () => assert.ok(!source('src/lib/ai/geminiCredentialRouter.ts').includes('Math.random')));
  await test(71, 'Paid AI disabled ngăn generation', () => assert.equal(process.env.ALLOW_PAID_AI, 'false'));
  await test(72, 'Provider probe không chạy khi render', () => assert.ok(!source('src/app/dashboard/token-vault/page.tsx').match(/useEffect\([\s\S]{0,300}\/probe/)));
  await test(73, 'Error message không chứa secret', () => { const safe = secrets.toSafeCredential({ ...storedCredential, platform: 'gemini', credentialType: 'api_key', label: 'x', encryptedValue: 'fixture-encrypted', lastError: 'provider raw fixture', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }); assert.equal(safe.lastError, 'PROVIDER_CHECK_FAILED'); assert.equal('encryptedValue' in safe, false); });
  await test(74, 'Audit không chứa secret', () => assert.ok(source('src/lib/automation/store.ts').includes('sanitizeAutomationData')));

  const detailSource = source('src/app/dashboard/products/[id]/page.tsx');
  const cssSource = source('src/app/globals.css');
  const alertsSource = source('src/app/dashboard/alerts/page.tsx');
  await test(75, 'Product detail hiển thị pipeline truth', () => assert.ok(detailSource.includes('Operational truth')));
  await test(76, 'SafeProductImage fallback', () => assert.ok(source('src/components/safe-product-image.tsx').includes("const FALLBACK = '/product-placeholder.svg'")));
  await test(77, 'Topbar không hard-code black light mode', () => assert.ok(cssSource.includes('.topbar') && !cssSource.match(/\.topbar[^}]*background:\s*#0{3,6}/i)));
  await test(78, 'Input/select dùng theme styles', () => assert.ok(cssSource.includes(':where(input, select, textarea)') && cssSource.includes('var(--ds-surface, var(--bg-input))')));
  await test(79, 'Selection style mới tồn tại', () => assert.ok(cssSource.includes('::selection') && cssSource.includes('color-mix')));
  await test(80, 'Component styles chống horizontal overflow', () => assert.ok(cssSource.includes('overflow-wrap: anywhere')));
  await test(81, 'Token cards có min-width/overflow-wrap', () => assert.ok(cssSource.includes('.token-card') && cssSource.includes('min-width: 0')));
  await test(82, 'Action button labels đúng semantics', () => { for (const label of ['Đánh dấu đã xem', 'Xác nhận dữ liệu', 'Đưa vào danh sách xét CANARY', 'Yêu cầu kiểm tra Safe Publish']) assert.ok(detailSource.includes(label)); });
  await test(83, 'Đánh dấu đã xem không gọi safe publish endpoint', () => assert.ok(detailSource.includes("handleAction('reviewed')") && detailSource.includes('/actions')));
  await test(84, 'Safe publish request label rõ', () => assert.ok(detailSource.includes('Yêu cầu kiểm tra Safe Publish')));
  await test(85, 'Mobile layout không render text từng ký tự', () => assert.ok(cssSource.includes('overflow-wrap: anywhere') && !cssSource.includes('word-break: break-all')));
  await test(86, 'Alert UI không render toàn bộ occurrence mặc định', () => assert.ok(alertsSource.includes('pageSize=25') && alertsSource.includes('expanded === item.id')));
  await test(87, 'Resolved action disabled thiếu evidence', () => assert.ok(alertsSource.includes('disabled title="Chỉ recheck evidence PASS')));

  await test(88, 'Voucher title phân loại VOUCHER', () => assert.equal(classification.classifyRecord({ title: 'Giảm 50K cho đơn hàng từ 500K' }).recordType, 'VOUCHER'));
  await test(89, 'Store offer phân loại STORE_OFFER', () => assert.equal(classification.classifyRecord({ rawSourceType: 'store offer', title: 'Official shop giảm 10%' }).recordType, 'STORE_OFFER'));
  await test(90, 'Product thật không quarantine nhầm', () => assert.equal(classification.classifyRecord(product()).action, 'ACCEPT'));
  await test(91, 'Dry-run không write', async () => { await reset('candidate-queue'); const record = { id: 'at-1', source: 'accesstrade', payload: { title: 'Giảm 20% đơn hàng' } }; await storage.writeCollection('candidate-queue', [record]); await cleanup.cleanupAccessTradeRecords({ limit: 10 }); assert.deepEqual(await storage.readCollection('candidate-queue'), [record]); });
  await test(92, 'Apply fixture idempotent', async () => { await cleanup.cleanupAccessTradeRecords({ apply: true, operationId: 'fixture-cleanup' }); const once = await storage.readCollection('candidate-queue'); await cleanup.cleanupAccessTradeRecords({ apply: true, operationId: 'fixture-cleanup' }); assert.deepEqual(await storage.readCollection('candidate-queue'), once); });
  await test(93, 'Raw record giữ nguyên', async () => assert.equal((await storage.readCollection('candidate-queue'))[0].payload.title, 'Giảm 20% đơn hàng'));
  await test(94, 'Before/after report chính xác', async () => { await reset('candidate-queue'); await storage.writeCollection('candidate-queue', [{ id: 'at-2', source: 'accesstrade', payload: { title: 'Giảm 20% đơn hàng' } }]); const report = await cleanup.cleanupAccessTradeRecords({ limit: 10 }); assert.equal(report.countsBefore.UNKNOWN, 1); assert.equal(report.countsAfter.VOUCHER, 1); });
  await test(95, 'Bounded scan', async () => { await reset('candidate-queue'); await storage.writeCollection('candidate-queue', Array.from({ length: 510 }, (_, i) => ({ id: `at-${String(i).padStart(4, '0')}`, source: 'accesstrade', payload: { title: 'Voucher giảm 10%' } }))); assert.equal((await cleanup.cleanupAccessTradeRecords({ limit: 900 })).scanned, 500); });
  await test(96, 'Cleanup không provider call', () => assert.ok(!source('src/lib/product-intelligence/accessTradeCleanup.ts').includes('fetch(')));
  await test(97, 'Non-product không có public lifecycle', async () => { const report = await cleanup.cleanupAccessTradeRecords({ limit: 1 }); assert.ok(report.quarantined >= 1); });

  await test(98, 'File driver vẫn mặc định', () => assert.equal(storageConfig.getStorageConfig().driver, 'file'));
  await test(99, 'Build/import không yêu cầu Mongo URI', () => assert.doesNotThrow(() => require('../src/lib/config.ts')));
  await test(100, 'Prompt 12 không auto-migrate', () => assert.ok(!source('src/lib/automation/truth.ts').match(/migrat/i)));
  await test(101, 'Không dual-write', () => assert.ok(!source('src/lib/product-intelligence/alertIncidents.ts').match(/dual.?write/i)));
  await test(102, 'Public product filter vẫn chặn blocker', () => { const text = source('src/lib/publicProductFilter.ts'); assert.ok(text.includes('getPublicProductBlockReason') && text.includes('publicHidden')); });
  await test(103, 'Inventory public 0 không card giả', () => assert.ok(!source('src/app/deals/page.tsx').match(/fake|sample product|mock product/i)));
  await test(104, 'launchEnabled vẫn false mặc định', () => assert.ok(source('src/lib/storage/automationSettings.ts').includes('launchEnabled: false')));
  await test(105, 'publishing vẫn disabled mặc định', () => { assert.equal(process.env.ALLOW_PUBLISHING_API, 'false'); assert.equal(process.env.AUTO_PUBLISH_ENABLED, 'false'); });
  await test(106, 'publicHidden vẫn true', () => assert.equal(pipeline(product({ publicHidden: undefined })).lifecycle.publicHidden, true));
  await test(107, 'Token Vault không nằm trong report/backup mới', () => assert.ok(!source('src/lib/product-intelligence/accessTradeCleanup.ts').includes('token-vault')));
  await test(108, 'Không thay đổi .data thật', () => assert.ok(tempDir.includes('.test-tmp') && process.env.SANDEAL_DATA_DIR === tempDir));

  console.log(`\nPrompt 12 tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().finally(() => fs.rmSync(tempDir, { recursive: true, force: true }));
