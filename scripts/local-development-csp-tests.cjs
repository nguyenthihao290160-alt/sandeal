/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

function readHeaders(nodeEnv) {
  const probe = `
    (async () => {
      const configModule = require('./next.config.ts');
      const groups = await configModule.default.headers();
      const group = groups.find(item => item.source === '/:path*');
      const headers = Object.fromEntries((group?.headers || []).map(header => [header.key, header.value]));
      process.stdout.write(JSON.stringify({ source: group?.source || null, headers }));
    })().catch(error => {
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    });
  `;
  const result = spawnSync(process.execPath, ['-e', probe], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: nodeEnv,
      SANDEAL_RELEASE_ID: head,
      GIT_COMMIT_SHA: head,
      SANDEAL_BUILD_VALIDATION_ONLY: '',
    },
  });
  assert.equal(result.status, 0, `${nodeEnv} config probe failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function directive(policy, name) {
  return policy.split(';').map(value => value.trim()).find(value => value.startsWith(`${name} `)) || '';
}

const development = readHeaders('development');
const production = readHeaders('production');

test('development CSP permits React and Next.js diagnostics only through script-src unsafe-eval', () => {
  const policy = development.headers['Content-Security-Policy'];
  assert.equal(development.source, '/:path*');
  assert.ok(policy);
  assert.match(directive(policy, 'script-src'), /^script-src 'self' 'unsafe-inline' 'unsafe-eval'$/);
  assert.equal((policy.match(/'unsafe-eval'/g) || []).length, 1);
  assert.doesNotMatch(policy, /upgrade-insecure-requests/);
});

test('production CSP remains strict and never permits unsafe-eval', () => {
  const policy = production.headers['Content-Security-Policy'];
  assert.equal(production.source, '/:path*');
  assert.ok(policy);
  assert.match(directive(policy, 'script-src'), /^script-src 'self' 'unsafe-inline'$/);
  assert.doesNotMatch(policy, /'unsafe-eval'/);
  assert.match(policy, /(?:^|; )upgrade-insecure-requests(?:;|$)/);
});

test('production security headers and CSP protections remain intact', () => {
  const headers = production.headers;
  assert.equal(headers['X-DNS-Prefetch-Control'], 'on');
  assert.equal(headers['X-SanDeal-Build-Id'], head);
  assert.equal(headers['X-SanDeal-Release-Id'], head);
  assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Permissions-Policy'], 'camera=(), microphone=(), geolocation=()');
  assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin');

  const policy = headers['Content-Security-Policy'];
  for (const expected of [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "media-src 'self' https:",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
  ]) assert.ok(policy.split(';').map(value => value.trim()).includes(expected), expected);
});

console.log(`\nLocal development CSP: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
