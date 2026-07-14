/* eslint-disable @typescript-eslint/no-require-imports */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const STORAGE_SCHEMA_VERSION = 1;

function option(name, fallback = '') {
  const prefix = `--${name}=`;
  return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function checksum(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function commitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function readJsonStorage(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed === null || typeof parsed !== 'object') throw new Error(`${path.basename(file)} khong phai JSON storage hop le.`);
  return parsed;
}

function verifyBackup(backupDir) {
  const metadataPath = path.join(backupDir, 'metadata.json');
  const metadataChecksumPath = path.join(backupDir, 'metadata.sha256');
  if (!fs.existsSync(metadataPath) || !fs.existsSync(metadataChecksumPath)) throw new Error('Backup thieu metadata hoac checksum.');
  const expectedMetadataChecksum = fs.readFileSync(metadataChecksumPath, 'utf8').trim();
  if (checksum(metadataPath) !== expectedMetadataChecksum) throw new Error('Checksum metadata khong khop.');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (metadata.storageSchemaVersion !== STORAGE_SCHEMA_VERSION || !Array.isArray(metadata.files)) throw new Error('Metadata backup khong tuong thich.');
  for (const item of metadata.files) {
    const file = path.join(backupDir, 'data', item.name);
    if (!fs.existsSync(file) || checksum(file) !== item.sha256) throw new Error(`Checksum khong khop: ${item.name}`);
    const value = readJsonStorage(file);
    const kind = Array.isArray(value) ? 'collection' : 'document';
    if (kind !== item.kind) throw new Error(`Loai JSON khong khop: ${item.name}`);
    if (kind === 'collection' && value.length !== item.records) throw new Error(`So ban ghi khong khop: ${item.name}`);
  }
  return metadata;
}

function createBackup(sourceDir, outputRoot) {
  if (!fs.existsSync(sourceDir)) throw new Error('Thu muc du lieu nguon khong ton tai.');
  fs.mkdirSync(outputRoot, { recursive: true });
  const backupDir = path.join(outputRoot, `sandeal-backup-${timestamp()}`);
  const dataDir = path.join(backupDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const files = [];
  const excluded = [];
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    if (entry.name === 'token-vault.json') {
      excluded.push(entry.name);
      continue;
    }
    const source = path.join(sourceDir, entry.name);
    const value = readJsonStorage(source);
    const destination = path.join(dataDir, entry.name);
    const temporary = `${destination}.tmp`;
    fs.copyFileSync(source, temporary);
    fs.renameSync(temporary, destination);
    files.push({ name: entry.name, kind: Array.isArray(value) ? 'collection' : 'document', records: Array.isArray(value) ? value.length : null, sha256: checksum(destination) });
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const metadata = {
    format: 'sandeal-json-backup-v1',
    createdAt: new Date().toISOString(),
    applicationVersion: packageJson.version,
    commitSha: commitSha(),
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    sourceType: 'json-file-single-instance',
    files,
    excluded,
    retentionRecommendation: '30 daily, 12 monthly; keep encrypted copies outside the application host.',
  };
  const metadataPath = path.join(backupDir, 'metadata.json');
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(backupDir, 'metadata.sha256'), `${checksum(metadataPath)}\n`, 'utf8');
  verifyBackup(backupDir);
  return backupDir;
}

function restoreBackup(backupDir, targetDir) {
  const metadata = verifyBackup(backupDir);
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) throw new Error('Thu muc restore phai moi hoac rong; khong ghi de du lieu hien tai.');
  fs.mkdirSync(targetDir, { recursive: true });
  for (const item of metadata.files) {
    const source = path.join(backupDir, 'data', item.name);
    const destination = path.join(targetDir, item.name);
    const temporary = `${destination}.tmp`;
    fs.copyFileSync(source, temporary);
    fs.renameSync(temporary, destination);
    if (checksum(destination) !== item.sha256) throw new Error(`Restore checksum khong khop: ${item.name}`);
  }
  return metadata;
}

function verifyRoundTrip() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sandeal-release-backup-'));
  const sourceDir = path.join(tempRoot, 'source');
  const backupRoot = path.join(tempRoot, 'backups');
  const restoreDir = path.join(tempRoot, 'restore');
  fs.mkdirSync(sourceDir, { recursive: true });
  const fixtures = {
    'automation-jobs.json': [{ id: 'job-release-check', status: 'PENDING', operationId: 'operation-release-check' }],
    'product-sources.json': [{ id: 'source-release-check', name: 'Nguon kiem tra local', enabled: false }],
    'products.json': [{ id: 'product-release-check', title: 'San pham kiem tra local', status: 'draft' }],
  };
  for (const [name, value] of Object.entries(fixtures)) fs.writeFileSync(path.join(sourceDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(sourceDir, 'token-vault.json'), '[]\n', 'utf8');

  try {
    const backupDir = createBackup(sourceDir, backupRoot);
    const metadata = restoreBackup(backupDir, restoreDir);
    for (const [name, expected] of Object.entries(fixtures)) {
      const restored = readJsonStorage(path.join(restoreDir, name));
      if (restored.length !== expected.length || restored[0]?.id !== expected[0]?.id) throw new Error(`Restore fixture that bai: ${name}`);
    }
    if (fs.existsSync(path.join(restoreDir, 'token-vault.json'))) throw new Error('Kho ket noi nhay cam khong duoc phep vao backup mac dinh.');
    process.stdout.write(`BACKUP_RESTORE_VERIFICATION=READY files=${metadata.files.length} schema=${metadata.storageSchemaVersion}\n`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  const command = process.argv[2];
  if (command === 'backup') {
    const source = path.resolve(option('source', process.env.SANDEAL_DATA_DIR || path.join(root, '.data')));
    const output = path.resolve(option('output', path.join(root, '.backups')));
    process.stdout.write(`BACKUP_PATH=${createBackup(source, output)}\n`);
  } else if (command === 'verify') {
    const backup = option('backup');
    if (!backup) throw new Error('Can --backup=<duong-dan>.');
    const metadata = verifyBackup(path.resolve(backup));
    process.stdout.write(`BACKUP_VERIFICATION=READY files=${metadata.files.length}\n`);
  } else if (command === 'restore') {
    const backup = option('backup');
    const target = option('target');
    if (!backup || !target) throw new Error('Can --backup=<duong-dan> va --target=<thu-muc-rong>.');
    const metadata = restoreBackup(path.resolve(backup), path.resolve(target));
    process.stdout.write(`RESTORE_VERIFICATION=READY files=${metadata.files.length} target=${path.resolve(target)}\n`);
  } else if (command === 'verify-roundtrip') {
    verifyRoundTrip();
  } else {
    throw new Error('Dung: release-storage.cjs <backup|verify|restore|verify-roundtrip>.');
  }
} catch (error) {
  process.stderr.write(`RELEASE_STORAGE=BLOCKED ${error instanceof Error ? error.message : 'unknown_error'}\n`);
  process.exitCode = 1;
}
