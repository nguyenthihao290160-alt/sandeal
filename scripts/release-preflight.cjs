/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const releaseMode = process.argv.includes('--release');
const healthArg = process.argv.find(argument => argument.startsWith('--health-url='));
const healthUrl = healthArg?.slice('--health-url='.length) || process.env.SANDEAL_PREFLIGHT_HEALTH_URL || '';
const results = [];

function add(status, name, message) {
  results.push({ status, name, message });
  process.stdout.write(`[${status}] ${name}: ${message}\n`);
}

function configured(name) {
  return typeof process.env[name] === 'string' && process.env[name].trim().length > 0;
}

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 9)) add('BLOCKED', 'Node.js', 'Can Node.js 20.9 tro len.');
  else add('READY', 'Node.js', `Phien ban ${process.versions.node} duoc ho tro.`);
}

function checkPackageManager() {
  const lockPath = path.join(root, 'package-lock.json');
  if (!fs.existsSync(lockPath)) add('BLOCKED', 'Trinh quan ly goi', 'Khong tim thay package-lock.json.');
  else add('READY', 'Trinh quan ly goi', 'npm va package-lock.json da san sang.');
}

function checkStorage() {
  const dataDir = path.resolve(process.env.SANDEAL_DATA_DIR || path.join(root, '.data'));
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, `.preflight-${process.pid}.tmp`);
    fs.writeFileSync(probe, 'ok', { flag: 'wx' });
    fs.unlinkSync(probe);
    add(process.env.SANDEAL_DATA_DIR ? 'READY' : 'WARNING', 'Luu tru', process.env.SANDEAL_DATA_DIR ? 'Thu muc du lieu ghi duoc.' : 'Dang dung thu muc .data mac dinh; can dat SANDEAL_DATA_DIR khi phat hanh.');
  } catch {
    add('BLOCKED', 'Luu tru', 'Thu muc du lieu khong ghi duoc.');
  }
}

function checkPublicUrl() {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) {
    add(releaseMode ? 'CONFIGURATION_REQUIRED' : 'WARNING', 'Dia chi cong khai', 'Chua dat NEXT_PUBLIC_SITE_URL.');
    return;
  }
  try {
    const url = new URL(raw);
    const localHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (releaseMode && (url.protocol !== 'https:' || localHost)) add('BLOCKED', 'Dia chi cong khai', 'Ban phat hanh can URL HTTPS khong phai localhost.');
    else add(localHost ? 'WARNING' : 'READY', 'Dia chi cong khai', localHost ? 'Dang dung dia chi local.' : 'URL hop le.');
  } catch {
    add('BLOCKED', 'Dia chi cong khai', 'NEXT_PUBLIC_SITE_URL khong phai URL hop le.');
  }
}

function checkAuth() {
  const enabled = process.env.BASIC_AUTH_ENABLED === 'true';
  const hasUser = configured('BASIC_AUTH_USER') || configured('BASIC_AUTH_USERNAME');
  const hasPassword = configured('BASIC_AUTH_PASSWORD');
  if (enabled && hasUser && hasPassword) add('READY', 'Bao ve quan tri', 'Xac thuc quan tri da du cau hinh.');
  else add(releaseMode ? 'CONFIGURATION_REQUIRED' : 'WARNING', 'Bao ve quan tri', 'Moi truong phat hanh can bat Basic Auth va dat tai khoan/mat khau.');
}

function checkPolicy() {
  const paidBlocked = process.env.ALLOW_PAID_AI !== 'true';
  const publishingBlocked = process.env.ALLOW_PUBLISHING_API !== 'true' && process.env.AUTO_PUBLISH_ENABLED !== 'true';
  add(paidBlocked ? 'READY' : 'WARNING', 'Chi dung dich vu mien phi', paidBlocked ? 'Loi goi AI tinh phi dang bi chan.' : 'ALLOW_PAID_AI dang duoc bat; can phe duyet rieng.');
  add(publishingBlocked ? 'READY' : 'WARNING', 'Dang an toan', publishingBlocked ? 'Dang tu dong ra ben ngoai dang bi chan.' : 'Quyen dang ra ben ngoai dang duoc bat; can phe duyet rieng.');
}

function checkRuntimeCommands() {
  for (const [name, file] of [['Bo xu ly nen', 'automation-worker.cjs'], ['Lich tu dong', 'automation-scheduler.cjs']]) {
    add(fs.existsSync(path.join(root, 'scripts', file)) ? 'READY' : 'BLOCKED', name, fs.existsSync(path.join(root, 'scripts', file)) ? 'Lenh runtime ton tai.' : `Thieu scripts/${file}.`);
  }
  const timezone = process.env.TZ || 'Asia/Ho_Chi_Minh';
  try {
    new Intl.DateTimeFormat('vi-VN', { timeZone: timezone }).format(new Date());
    add(process.env.TZ ? 'READY' : 'WARNING', 'Mui gio', process.env.TZ ? `Da dat ${timezone}.` : 'Dang dung mac dinh Asia/Ho_Chi_Minh; nen dat TZ ro rang khi phat hanh.');
  } catch {
    add('BLOCKED', 'Mui gio', 'Gia tri TZ khong hop le.');
  }
}

function checkConnections() {
  add(configured('TOKEN_VAULT_SECRET_KEY') ? 'READY' : releaseMode ? 'CONFIGURATION_REQUIRED' : 'WARNING', 'Khoa ma hoa kho ket noi', configured('TOKEN_VAULT_SECRET_KEY') ? 'Da khai bao bien ma hoa.' : 'Chua dat TOKEN_VAULT_SECRET_KEY.');
  add(configured('GEMINI_API_KEY') ? 'READY' : 'WARNING', 'Gemini', configured('GEMINI_API_KEY') ? 'Da co cau hinh ket noi.' : 'Chua cau hinh; tinh nang lien quan phai o trang thai chua cau hinh.');
  add(configured('ACCESS_TRADE_API_KEY') ? 'READY' : 'WARNING', 'AccessTrade', configured('ACCESS_TRADE_API_KEY') ? 'Da co cau hinh ket noi.' : 'Chua cau hinh; quet nguon ngoai se khong kha dung.');
}

function checkKillSwitch() {
  const file = path.join(path.resolve(process.env.SANDEAL_DATA_DIR || path.join(root, '.data')), 'automation-control.json');
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const enabled = Array.isArray(value) && value[0]?.killSwitch === true;
    add(enabled ? 'WARNING' : 'READY', 'Dung khan cap', enabled ? 'Dang bat; worker, scheduler va side effect se bi chan.' : 'Dang tat.');
  } catch {
    add('WARNING', 'Dung khan cap', 'Chua co trang thai luu tru de xac minh; he thong se khoi tao khi van hanh.');
  }
}

async function checkHealth() {
  if (!healthUrl) {
    add('WARNING', 'Health endpoint', 'Chua yeu cau kiem tra HTTP; truyen --health-url khi web dang chay.');
    return;
  }
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000), headers: { accept: 'application/json' } });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.ok !== true) add('BLOCKED', 'Health endpoint', `Tra ve HTTP ${response.status} hoac contract khong hop le.`);
    else add('READY', 'Health endpoint', `Tra ve HTTP ${response.status}.`);
  } catch {
    add('BLOCKED', 'Health endpoint', 'Khong the ket noi endpoint trong 5 giay.');
  }
}

(async () => {
  checkNode();
  checkPackageManager();
  checkStorage();
  checkPublicUrl();
  checkAuth();
  checkPolicy();
  checkRuntimeCommands();
  checkConnections();
  checkKillSwitch();
  await checkHealth();

  const blocked = results.some(result => result.status === 'BLOCKED');
  const configurationRequired = results.some(result => result.status === 'CONFIGURATION_REQUIRED');
  const warning = results.some(result => result.status === 'WARNING');
  const status = blocked ? 'BLOCKED' : configurationRequired ? 'CONFIGURATION_REQUIRED' : warning ? 'WARNING' : 'READY';
  process.stdout.write(`PREFLIGHT_STATUS=${status}\n`);
  if (blocked || (releaseMode && configurationRequired)) process.exitCode = 1;
})().catch(() => {
  process.stderr.write('PREFLIGHT_STATUS=BLOCKED\n');
  process.exitCode = 1;
});
