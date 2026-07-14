/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}: ${error.message}`);
  }
}

test('design token #07 tập trung màu, surface, radius, shadow và motion', () => {
  const css = read('src/app/globals.css');
  for (const token of ['--ds-app-bg: #f6f8fc', '--ds-surface-blue', '--ds-surface-purple', '--ds-text-soft', '--ds-border-strong', '--ds-radius-md', '--ds-shadow-md', '--ds-duration']) assert(css.includes(token), token);
  assert(css.includes('@media (prefers-reduced-motion: reduce)'));
});

test('quy tắc gradient nút đầu tiên cũ được ghi đè bằng button hierarchy sáng', () => {
  const css = read('src/app/globals.css');
  const legacy = css.indexOf('background: var(--gradient-accent);');
  const override = css.lastIndexOf('.dashboard-shell button:first-of-type');
  assert(legacy >= 0 && override > legacy);
  assert(css.slice(override).includes('background: var(--ds-surface)'));
});

test('dashboard module không còn background tối lỗi', () => {
  const files = [
    'src/app/dashboard/dashboard.module.css',
    'src/app/dashboard/operations.module.css',
    'src/app/dashboard/products/products.module.css',
    'src/components/dashboard/task-status.module.css',
  ];
  for (const file of files) assert(!/background\s*:\s*(?:#000|#111(?:827)?|#0f172a)\b/i.test(read(file)), file);
});

test('KPI chính dùng icon và accent có ý nghĩa từ dữ liệu backend', () => {
  const dashboard = read('src/app/dashboard/page.tsx');
  const products = read('src/app/dashboard/products/products-dashboard.tsx');
  const health = read('src/app/dashboard/app-health/page.tsx');
  assert(dashboard.includes("icon: 'product'") && dashboard.includes("tone: 'cyan'") && dashboard.includes("tone: 'red'"));
  assert(products.includes('metricIndigo') && products.includes('metricGreen') && products.includes('metricRed'));
  assert(health.includes('<DashboardIcon name="health"') && health.includes('<DashboardIcon name="emergency"'));
});

test('drawer mobile có nút đóng, overlay, Esc và vòng focus cơ bản', () => {
  const layout = read('src/app/dashboard/layout.tsx');
  const css = read('src/app/globals.css');
  assert(layout.includes('dashboard-sidebar-close'));
  assert(layout.includes("event.key === 'Escape'"));
  assert(layout.includes("event.key === 'Tab'"));
  assert(layout.includes('dashboard-sidebar-backdrop'));
  assert(css.includes('@media (max-width: 768px)') && css.includes('.dashboard-shell .dashboard-sidebar-backdrop'));
});

test('Kết quả bot có bộ lọc nâng cao, số filter và empty state hành động thật', () => {
  const page = read('src/app/dashboard/products/products-dashboard.tsx');
  assert(page.includes('activeFilterCount'));
  assert(page.includes('Bộ lọc nâng cao'));
  assert(page.includes('Thêm nguồn sản phẩm'));
  assert(page.includes("setOperationDialog('source_scan')"));
  assert(page.includes('Mã giảm giá (voucher)'));
});

test('đổi list/grid vẫn chỉ thay view state và không gọi API', () => {
  const page = read('src/app/dashboard/products/products-dashboard.tsx');
  const match = page.match(/const selectView[\s\S]*?\n\s*};/);
  assert(match);
  assert(!match[0].includes('fetch('));
  assert(match[0].includes('setViewMode'));
});

test('Hàng chờ phê duyệt có empty state hữu ích và không tạo dữ liệu giả', () => {
  const page = read('src/app/dashboard/queue/page.tsx');
  assert(page.includes('Không có tác vụ cần phê duyệt'));
  assert(page.includes('Các tác vụ có rủi ro cao sẽ xuất hiện tại đây'));
  assert(page.includes('href="/dashboard/ai-bots"'));
  assert(page.includes('href="/dashboard/automation"'));
});

test('Tự động hóa yêu cầu confirmation, lý do và ghi audit backend', () => {
  const page = read('src/app/dashboard/automation/page.tsx');
  const route = read('src/app/api/ai-bots/schedule/route.ts');
  assert(page.includes('reason.trim().length < 8'));
  assert(page.includes('confirmed: true'));
  assert(route.includes('appendAutomationAudit'));
  assert(route.includes("operationType: 'SCHEDULER_SETTINGS_CHANGED'"));
});

test('Sức khỏe không báo Gemini bình thường khi chưa cấu hình', () => {
  const route = read('src/app/api/automation/health/route.ts');
  const page = read('src/app/dashboard/app-health/page.tsx');
  assert(route.includes("geminiConfigured ? 'configured' : 'not_configured'"));
  assert(page.includes("const status = configured ? circuit.state : 'not_configured'"));
});

test('Kết nối bảo mật bỏ topbar tối lặp, icon chữ cái và fallback tiếng Anh', () => {
  const page = read('src/app/dashboard/token-vault/page.tsx');
  assert(!page.includes('<div className="topbar">'));
  assert(page.includes('dashboard-tinted-header'));
  assert(page.includes('geminiCredentials === 0'));
  assert(!page.includes('Gemini key tests failed'));
  assert(!page.includes('Generation probe failed'));
});

test('Nguồn sản phẩm giải thích thuật ngữ và tab mobile chỉ có một hệ tab', () => {
  const page = read('src/app/dashboard/product-sources/page.tsx');
  assert(page.includes('Minh bạch tiếp thị liên kết'));
  assert(page.includes('Nhập tệp bảng dữ liệu (CSV)'));
  assert(page.includes('product-source-tabs'));
  assert.equal((page.match(/className="tabs-bar product-source-tabs"/g) || []).length, 1);
});

test('route nội dung được hạ ưu tiên trung thực và giữ đường dẫn cũ', () => {
  const content = read('src/app/dashboard/content/page.tsx');
  const layout = read('src/app/dashboard/layout.tsx');
  assert(content.includes('Đang hoàn thiện'));
  assert(content.includes('chưa có backend hoàn chỉnh'));
  assert(layout.includes("href: '/dashboard/content'"));
  assert(layout.includes("badge: 'Đang hoàn thiện'"));
});

test('release CI có đủ gate và tuyệt đối không deploy', () => {
  const workflow = read('.github/workflows/release-quality.yml');
  for (const command of ['npm ci', 'npm run typecheck', 'npm run lint', 'npm run test:automation', 'npm test', 'npm run build', 'release:secret-scan', 'release:backup-verify', 'release:manifest:validate', 'actions/upload-artifact@v4']) assert(workflow.includes(command), command);
  assert(!/\bdeploy\b\s*:/i.test(workflow));
});

test('env example chỉ chứa tên biến và giá trị rỗng', () => {
  const lines = read('.env.example').split(/\r?\n/).filter(line => /^[A-Z][A-Z0-9_]*=/.test(line));
  assert(lines.length > 10);
  for (const line of lines) assert(/^[A-Z][A-Z0-9_]*=$/.test(line), line.split('=')[0]);
});

test('backup mặc định loại kho nhạy cảm, chống ghi đè và có checksum', () => {
  const storage = read('scripts/release-storage.cjs');
  assert(storage.includes("entry.name === 'token-vault.json'"));
  assert(storage.includes('Thu muc restore phai moi hoac rong'));
  assert(storage.includes("metadata.sha256"));
  assert(storage.includes('verifyRoundTrip'));
});

test('release manifest bắt buộc artifact checksum và quality result đạt', () => {
  const manifest = read('scripts/release-manifest.cjs');
  assert(manifest.includes("option('test') !== 'passed'"));
  assert(manifest.includes('artifact.sha256'));
  assert(manifest.includes("backupRestore: option('backup-restore', 'passed')"));
  assert(manifest.includes('packageLockChecksum'));
});

console.log(`\nPROMPT #07 targeted: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
