/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
require('./register-typescript.cjs');

const {
  ClientRequestError,
  clientRequestMessage,
  requestClientJson,
} = require('../src/lib/dashboard/clientRequest.ts');

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

async function expectCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error instanceof ClientRequestError, true);
    assert.equal(error.code, code);
    return true;
  });
}

async function run() {
  await test('A valid bounded JSON response is returned', async () => {
    const value = await requestClientJson('https://client.test/success', {
      fetchImpl: async () => new Response(JSON.stringify({ ok: true, data: { id: 'one' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    assert.deepEqual(value, { ok: true, data: { id: 'one' } });
  });

  await test('A non-success response retains a safe server message', async () => {
    let issue;
    try {
      await requestClientJson('https://client.test/rejected', {
        fetchImpl: async () => new Response(JSON.stringify({ message: 'Request cannot be completed.' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      });
    } catch (error) {
      issue = error;
    }
    assert.equal(issue.code, 'HTTP_ERROR');
    assert.equal(issue.status, 409);
    assert.equal(clientRequestMessage(issue, 'fallback'), 'Request cannot be completed.');
  });

  await test('Invalid JSON fails explicitly', async () => {
    await expectCode(requestClientJson('https://client.test/invalid-json', {
      fetchImpl: async () => new Response('{invalid', { status: 200 }),
    }), 'INVALID_JSON');
  });

  await test('An empty response fails explicitly', async () => {
    await expectCode(requestClientJson('https://client.test/empty', {
      fetchImpl: async () => new Response(null, { status: 200 }),
    }), 'EMPTY_RESPONSE');
  });

  await test('A declared oversized response is rejected before parsing', async () => {
    await expectCode(requestClientJson('https://client.test/declared-large', {
      maximumResponseBytes: 128,
      fetchImpl: async () => new Response('{}', {
        status: 200,
        headers: { 'content-length': '129' },
      }),
    }), 'RESPONSE_TOO_LARGE');
  });

  await test('A streamed oversized response is rejected', async () => {
    await expectCode(requestClientJson('https://client.test/stream-large', {
      maximumResponseBytes: 128,
      fetchImpl: async () => new Response(JSON.stringify({ value: 'x'.repeat(200) }), { status: 200 }),
    }), 'RESPONSE_TOO_LARGE');
  });

  await test('A request timeout settles even when the transport ignores abort', async () => {
    await expectCode(requestClientJson('https://client.test/timeout', {
      timeoutMs: 5,
      fetchImpl: async () => new Promise(() => {}),
    }), 'REQUEST_TIMEOUT');
  });

  await test('Timeout aborts a cooperative transport', async () => {
    let observedAbort = false;
    await expectCode(requestClientJson('https://client.test/cooperative-timeout', {
      timeoutMs: 5,
      fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          observedAbort = true;
          reject(init.signal.reason);
        }, { once: true });
      }),
    }), 'REQUEST_TIMEOUT');
    assert.equal(observedAbort, true);
  });

  await test('A superseded request is classified as cancelled', async () => {
    const controller = new AbortController();
    const request = requestClientJson('https://client.test/superseded', {
      signal: controller.signal,
      fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      }),
    });
    controller.abort(new DOMException('Superseded', 'AbortError'));
    await expectCode(request, 'REQUEST_ABORTED');
  });

  await test('Cancellation settles even when the transport ignores abort', async () => {
    const controller = new AbortController();
    const request = requestClientJson('https://client.test/ignored-abort', {
      timeoutMs: 1_000,
      signal: controller.signal,
      fetchImpl: async () => new Promise(() => {}),
    });
    controller.abort(new DOMException('Superseded', 'AbortError'));
    await expectCode(request, 'REQUEST_ABORTED');
  });

  await test('A network failure is classified without exposing transport details', async () => {
    await expectCode(requestClientJson('https://client.test/network', {
      fetchImpl: async () => {
        throw new Error('socket details that must not become a UI message');
      },
    }), 'NETWORK_ERROR');
  });

  console.log(`\nM3 client request tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void run();
