/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const command = process.argv[2];
const excludedDirectories = new Set(['.git', '.next', '.data', '.release', 'node_modules', 'coverage', 'out', 'build']);

function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target, files);
    else files.push(target);
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

function secretScan() {
  const extensions = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.json', '.yml', '.yaml', '.md', '.sh', '.ps1', '.css', '.html']);
  const files = walk(root).filter(file => extensions.has(path.extname(file).toLowerCase()) || path.basename(file) === '.env.example');
  const findings = [];
  const rules = [
    { name: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
    { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: 'github-token', pattern: /\bgh[opurs]_[A-Za-z0-9_]{30,}\b/ },
    { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  ];
  const assignment = /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]([^'"\r\n]{16,})['"]/ig;
  const allowed = /process\.env|not-a-real|local-test|test[-_ ]|placeholder|example|mock|fake|redacted|masked|change_me|your_/i;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const rule of rules) {
      const match = rule.pattern.exec(content);
      if (match) findings.push({ file: relative(file), line: content.slice(0, match.index).split(/\r?\n/).length, rule: rule.name });
      rule.pattern.lastIndex = 0;
    }
    for (const match of content.matchAll(assignment)) {
      const candidate = match[1];
      if (!allowed.test(candidate) && !/\s/.test(candidate) && /^[A-Za-z0-9_./+=:-]+$/.test(candidate) && !/^SHOULD_NOT_/i.test(candidate)) {
        findings.push({ file: relative(file), line: content.slice(0, match.index).split(/\r?\n/).length, rule: 'literal-secret-assignment' });
      }
    }
  }

  const example = path.join(root, '.env.example');
  if (fs.existsSync(example)) {
    fs.readFileSync(example, 'utf8').split(/\r?\n/).forEach((line, index) => {
      if (/^[A-Z][A-Z0-9_]*=.+/.test(line.trim())) findings.push({ file: '.env.example', line: index + 1, rule: 'non-empty-example-value' });
    });
  }

  if (findings.length) {
    for (const finding of findings) process.stderr.write(`${finding.file}:${finding.line} ${finding.rule}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`SECRET_SCAN=READY files=${files.length}\n`);
}

function generatedCheck() {
  const findings = walk(root).map(relative).filter(file => /(?:\.tmp(?:\.|$)|\.lock$)/.test(file));
  let tracked = [];
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  } catch {
    process.stderr.write('Khong the kiem tra file duoc Git theo doi.\n');
    process.exitCode = 1;
    return;
  }
  findings.push(...tracked.filter(file => /^(?:\.next|\.data|\.release|coverage|out|build)\//.test(file) || /(?:\.tsbuildinfo|next-env\.d\.ts)$/.test(file)));
  const unique = [...new Set(findings)];
  if (unique.length) {
    unique.forEach(file => process.stderr.write(`${file}\n`));
    process.exitCode = 1;
    return;
  }
  process.stdout.write('GENERATED_FILE_CHECK=READY\n');
}

function migrationCheck() {
  const schemaVersion = 1;
  const dataDir = path.resolve(process.env.SANDEAL_DATA_DIR || path.join(root, '.data'));
  const errors = [];
  if (fs.existsSync(dataDir)) {
    for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, entry.name), 'utf8'));
        if (parsed === null || typeof parsed !== 'object') errors.push(`${entry.name}: invalid_storage_root`);
      } catch {
        errors.push(`${entry.name}: invalid_json`);
      }
    }
  }
  if (errors.length) {
    errors.forEach(error => process.stderr.write(`${error}\n`));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`MIGRATION_CHECK=READY schema=${schemaVersion} migrations=none\n`);
}

if (command === 'secret-scan') secretScan();
else if (command === 'generated-check') generatedCheck();
else if (command === 'migration-check') migrationCheck();
else {
  process.stderr.write('Dung: node scripts/release-validation.cjs <secret-scan|generated-check|migration-check>\n');
  process.exitCode = 1;
}
