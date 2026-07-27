/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./register-typescript.cjs');

const urlSafety = require('../src/lib/product-intelligence/urlSafety.ts');
const productHealth = require('../src/lib/bots/productHealthCheck.ts');

let passed = 0;
let failed = 0;

async function test(name, work) {
  try {
    await work();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error instanceof Error ? error.stack : error}`);
  }
}

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

async function run() {
  await test('Unsafe URL protocols, credentials, ports, and private targets are rejected', () => {
    const unsafe = [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://user:password@example.com/',
      'https://example.com:8443/private',
      'http://127.0.0.1/private',
      'http://169.254.169.254/latest/meta-data',
      'http://100.100.100.200/latest',
      'https://[::1]/private',
      'https://metadata.google.internal/latest',
    ];
    for (const value of unsafe) assert.equal(urlSafety.validateExternalUrl(value).safe, false, value);
  });

  await test('DNS validation accepts only entirely public answer sets', async () => {
    const publicAnswers = await urlSafety.resolvePublicDns('public.example', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    assert.equal(publicAnswers.length, 2);
    await assert.rejects(
      urlSafety.resolvePublicDns('rebind.example', async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
      /PRIVATE_NETWORK/,
    );
  });

  await test('The runtime transport pins the validated address into the socket lookup', () => {
    const implementation = source('src/lib/product-intelligence/urlSafety.ts');
    assert.ok(implementation.includes('agent: false'));
    assert.ok(implementation.includes('lookup: lookupPinned'));
    assert.ok(implementation.includes("'Accept-Encoding': 'identity'"));
  });

  await test('Every redirect is revalidated before another request', async () => {
    let calls = 0;
    const transport = async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: calls === 1 ? 'https://second.example/path' : 'http://127.0.0.1/private' },
      });
    };
    await assert.rejects(
      urlSafety.fetchExternalSafely('https://first.example/start', {
        resolveDns: false,
        fetchImpl: transport,
      }),
      /PRIVATE_NETWORK/,
    );
    assert.equal(calls, 2);
  });

  await test('Redirect loops and excessive redirect chains are bounded', async () => {
    await assert.rejects(
      urlSafety.fetchExternalSafely('https://loop.example/start', {
        resolveDns: false,
        fetchImpl: async input => new Response(null, { status: 302, headers: { location: String(input) } }),
      }),
      /REDIRECT_LOOP/,
    );
    let count = 0;
    await assert.rejects(
      urlSafety.fetchExternalSafely('https://chain.example/start', {
        resolveDns: false,
        maxRedirects: 1,
        fetchImpl: async () => new Response(null, {
          status: 302,
          headers: { location: `https://chain.example/${++count}` },
        }),
      }),
      /TOO_MANY_REDIRECTS/,
    );
  });

  await test('Declared and streamed response-size limits are enforced', async () => {
    await assert.rejects(
      urlSafety.fetchExternalSafely('https://large.example/declared', {
        resolveDns: false,
        maxBytes: 1_024,
        fetchImpl: async () => new Response('small', {
          status: 200,
          headers: { 'content-length': '2048' },
        }),
      }),
      /RESPONSE_TOO_LARGE/,
    );
    await assert.rejects(
      urlSafety.fetchExternalSafely('https://large.example/streamed', {
        resolveDns: false,
        maxBytes: 1_024,
        fetchImpl: async () => new Response('x'.repeat(2_048), { status: 200 }),
      }),
      /RESPONSE_TOO_LARGE/,
    );
  });

  await test('Unexpected compressed content is rejected to prevent decompression ambiguity', async () => {
    await assert.rejects(
      urlSafety.fetchExternalSafely('https://encoded.example/product', {
        resolveDns: false,
        fetchImpl: async () => new Response('encoded', {
          status: 200,
          headers: { 'content-encoding': 'gzip' },
        }),
      }),
      /UNSAFE_CONTENT_ENCODING/,
    );
  });

  await test('Bodyless HTTP statuses remain replayable without constructor failures', async () => {
    for (const status of [204, 304]) {
      const result = await urlSafety.fetchExternalSafely(`https://bodyless.example/${status}`, {
        resolveDns: false,
        fetchImpl: async () => new Response(null, { status }),
      });
      assert.equal(result.response.status, status);
      assert.equal(result.body.byteLength, 0);
    }
  });

  await test('Product-page verification rejects a misleading MIME type', async () => {
    const result = await productHealth.checkLinkHealth('https://merchant.example/product', {
      resolveDns: false,
      fetchImpl: async () => new Response('binary payload', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'UNSAFE_CONTENT_TYPE');
  });

  await test('Safe product images block local targets, reset changed sources, and expose a failure category', () => {
    const implementation = source('src/components/safe-product-image.tsx');
    assert.ok(implementation.includes("host === 'localhost'"));
    assert.ok(implementation.includes("parsed.protocol === 'https:'"));
    assert.ok(implementation.includes("storedState.sourceInputKey === sourceInputKey"));
    assert.ok(implementation.includes('data-image-failure-category'));
    assert.ok(implementation.includes('referrerPolicy="no-referrer"'));
  });

  await test('CSP and JSON-LD script-termination escaping remain present', () => {
    const config = source('next.config.ts');
    const layout = source('src/app/layout.tsx');
    const deal = source('src/app/deals/[slug]/page.tsx');
    const serializer = source('src/lib/seo/structuredData.ts');
    assert.ok(config.includes("default-src 'self'"));
    assert.ok(config.includes("object-src 'none'"));
    assert.ok(config.includes("frame-ancestors 'none'"));
    assert.ok(config.includes("'X-Content-Type-Options'"));
    assert.ok(layout.includes('serializeJsonLd('));
    assert.ok(deal.includes('serializeJsonLd('));
    assert.ok(serializer.includes(".replace(/</g, '\\\\u003c')"));
    assert.ok(serializer.includes(".replace(/>/g, '\\\\u003e')"));
  });

  console.log(`\nM3 remote-content security tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void run();
