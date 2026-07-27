/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_BASE_URL = 'http://localhost:3100';
const DEFAULT_EVIDENCE_DIR = '.test-tmp/m3-browser-evidence';
const DEFAULT_DEBUG_PORT = 9337;

function parseArgs(argv) {
  return Object.fromEntries(argv
    .filter(argument => argument.startsWith('--') && argument.includes('='))
    .map(argument => {
      const separator = argument.indexOf('=');
      return [argument.slice(2, separator), argument.slice(separator + 1)];
    }));
}

function resolveChromePath() {
  const candidates = [
    process.env.SANDEAL_TEST_CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find(candidate => require('node:fs').existsSync(candidate));
}

function assertLocalTarget(rawBaseUrl) {
  const baseUrl = new URL(rawBaseUrl);
  if (
    baseUrl.protocol !== 'http:'
    || !['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname)
    || !baseUrl.port
  ) {
    throw new Error('Browser verification requires an explicit non-production localhost HTTP port.');
  }
  return baseUrl.origin;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function seedFixture(baseUrl) {
  const healthResponse = await fetch(`${baseUrl}/api/health/live`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!healthResponse.ok) throw new Error(`Local live health returned HTTP ${healthResponse.status}.`);
  const health = await healthResponse.json();
  if (health.status !== 'PASS' || health.releaseMismatch !== false) {
    throw new Error('Local live health is not release-consistent.');
  }

  const response = await fetch(`${baseUrl}/api/products`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'm3-browser-proof-20260726',
    },
    body: JSON.stringify({
      title: 'Fixture Headless M3 - Tai nghe Bluetooth',
      description: 'Synthetic localhost-only browser verification fixture.',
      platform: 'website',
      source: 'manual',
      originalUrl: 'https://example.com/products/m3-fixture',
      imageUrl: 'https://images.example.com/m3-fixture.jpg',
      price: 1_290_000,
      salePrice: 990_000,
      category: 'Cong nghe',
      tags: ['fixture', 'headless'],
      benefits: ['Synthetic UI verification'],
      warnings: ['Isolated test fixture only'],
      riskLevel: 'low',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  const productId = payload?.data?.id || payload?.existingProductId || payload?.data?.existingProductId;
  if ((!response.ok && response.status !== 409) || !productId) {
    throw new Error(`Cannot prepare isolated browser fixture (HTTP ${response.status}).`);
  }
  return { health, productId };
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) entry?.reject(new Error(message.error.message));
        else entry?.resolve(message.result);
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) {
          listener(message.params || {});
        }
      }
    });
  }

  call(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  once(method, predicate = () => true, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      const unsubscribe = this.on(method, params => {
        if (!predicate(params)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(params);
      });
    });
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Browser evaluation failed.');
    }
    return result.result.value;
  }

  async navigate(url) {
    const loaded = this.once('Page.loadEventFired', () => true, 20_000);
    await this.call('Page.navigate', { url });
    await loaded;
    await delay(900);
  }
}

async function waitForJson(url, options) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error('Chrome DevTools endpoint is unavailable.');
}

async function inspectPage(cdp, label) {
  return cdp.evaluate(`(() => {
    const visible = element => Boolean(
      element
      && element.getClientRects().length
      && getComputedStyle(element).visibility !== 'hidden'
    );
    const text = element => (element?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240);
    const active = document.querySelector('[aria-current="page"]');
    const busy = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].filter(visible);
    const alerts = [...document.querySelectorAll('[role="alert"]')].filter(visible);
    const viewportWidth = document.documentElement.clientWidth;
    const overflowElements = [...document.querySelectorAll('body *')]
      .filter(visible)
      .map(element => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ element, rect }) => (
        rect.right > viewportWidth + 1
        || (
          rect.left >= -1
          && element.scrollWidth > Math.max(element.clientWidth + 1, viewportWidth + 1)
        )
      ))
      .sort((left, right) => (
        Math.max(right.rect.right, right.element.scrollWidth)
        - Math.max(left.rect.right, left.element.scrollWidth)
      ))
      .slice(0, 20)
      .map(({ element, rect }) => ({
        tag: element.tagName,
        className: String(element.className || '').slice(0, 180),
        text: text(element),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
    return {
      label: ${JSON.stringify(label)},
      path: location.pathname,
      title: document.title,
      h1: text(document.querySelector('h1')),
      headings: [...document.querySelectorAll('h1,h2')].filter(visible).slice(0, 12).map(text),
      activeNavHref: active?.getAttribute('href') || null,
      activeNavText: text(active),
      viewport: {
        width: innerWidth,
        height: innerHeight,
        bodyWidth: document.body.scrollWidth,
      },
      horizontalOverflow: document.body.scrollWidth > document.documentElement.clientWidth + 1,
      overflowElements,
      busyCount: busy.length,
      busyText: busy.map(text),
      alerts: alerts.map(text).filter(Boolean).slice(0, 8),
      buttons: [...document.querySelectorAll('button')]
        .filter(visible)
        .slice(0, 20)
        .map(element => ({ text: text(element), disabled: element.disabled })),
      links: [...document.querySelectorAll('a')]
        .filter(visible)
        .slice(0, 24)
        .map(element => ({ text: text(element), href: element.getAttribute('href') })),
    };
  })()`);
}

async function takeScreenshot(cdp, evidenceDir, name) {
  const screenshot = await cdp.call('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const target = path.join(evidenceDir, `${name}.png`);
  await fs.writeFile(target, Buffer.from(screenshot.data, 'base64'));
  return target;
}

async function pressTab(cdp) {
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
  });
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
  });
  await delay(50);
  return cdp.evaluate(`(() => {
    const element = document.activeElement;
    const style = element ? getComputedStyle(element) : null;
    return {
      tag: element?.tagName || null,
      text: (element?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
      href: element?.getAttribute?.('href') || null,
      focusVisible: Boolean(element?.matches?.(':focus-visible')),
      outline: style
        ? [style.outlineStyle, style.outlineWidth, style.outlineColor].join(' ')
        : null,
      boxShadow: style?.boxShadow || null,
    };
  })()`);
}

function verifyResults(results) {
  const failures = [];
  const stableChecks = results.checks.filter(check => !check.label.includes('loading'));
  for (const check of stableChecks) {
    if (check.horizontalOverflow) failures.push(`${check.label}: horizontal overflow`);
  }

  for (const label of [
    'desktop-products-success',
    'desktop-product-detail',
    'desktop-app-health',
    'mobile-products',
    'mobile-product-detail',
    'mobile-app-health',
  ]) {
    const check = results.checks.find(item => item.label === label);
    if (!check?.h1) failures.push(`${label}: missing h1`);
    if (check?.busyCount) failures.push(`${label}: stuck busy state`);
  }

  const activeHref = label => results.checks.find(item => item.label === label)?.activeNavHref;
  if (activeHref('desktop-products-success') !== '/dashboard/products') {
    failures.push('products active navigation mismatch');
  }
  if (activeHref('desktop-product-detail') !== '/dashboard/products') {
    failures.push('nested product active navigation mismatch');
  }
  if (activeHref('desktop-app-health') !== '/dashboard/app-health') {
    failures.push('app health active navigation mismatch');
  }

  const loading = results.checks.find(item => item.label === 'desktop-products-loading');
  if (!loading?.busyCount) failures.push('loading feedback not visible');
  const error = results.checks.find(item => item.label === 'desktop-products-error');
  if (!(error?.alerts.length && error?.buttons.some(button => /thử lại|retry/i.test(button.text)))) {
    failures.push('error feedback and retry control not visible');
  }
  const visibleFocus = results.focus.some(item => (
    item.focusVisible
    && (
      (item.outline && !item.outline.startsWith('none 0px'))
      || (item.boxShadow && item.boxShadow !== 'none')
    )
  ));
  if (!visibleFocus) failures.push('no visible keyboard focus');
  if (!results.focus.some(item => item.href === '/dashboard/products')) {
    failures.push('keyboard could not reach products navigation');
  }
  return failures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = assertLocalTarget(args['base-url'] || DEFAULT_BASE_URL);
  const evidenceDir = path.resolve(args['evidence-dir'] || DEFAULT_EVIDENCE_DIR);
  const debugPort = Number(args['debug-port'] || DEFAULT_DEBUG_PORT);
  if (!Number.isInteger(debugPort) || debugPort < 1024 || debugPort > 65_535) {
    throw new Error('Invalid Chrome debugging port.');
  }

  const chromePath = resolveChromePath();
  if (!chromePath) throw new Error('No installed Chrome or Edge executable is available.');
  await fs.mkdir(evidenceDir, { recursive: true });
  const fixture = await seedFixture(baseUrl);
  const profileDir = path.join(evidenceDir, 'chrome-profile');
  await fs.mkdir(profileDir, { recursive: true });
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1440,900',
    'about:blank',
  ], {
    stdio: 'ignore',
    windowsHide: true,
  });

  let socket;
  try {
    const page = await waitForJson(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`${baseUrl}/dashboard/products`)}`,
      { method: 'PUT' },
    );
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const cdp = new CdpClient(socket);
    await cdp.call('Page.enable');
    await cdp.call('Runtime.enable');
    await cdp.call('Network.enable');
    await cdp.call('Accessibility.enable');
    await cdp.call('Network.setBlockedURLs', {
      urls: ['https://images.example.com/*'],
    });
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const results = {
      mode: 'headless-chrome-cdp',
      baseUrl,
      release: fixture.health.releaseId,
      productId: fixture.productId,
      checks: [],
      focus: [],
      screenshots: [],
      accessibility: [],
    };

    await cdp.navigate(`${baseUrl}/dashboard/products`);
    results.checks.push(await inspectPage(cdp, 'desktop-products-success'));
    results.screenshots.push(await takeScreenshot(cdp, evidenceDir, 'desktop-products-success'));
    await cdp.evaluate('document.activeElement?.blur(); document.body.tabIndex = -1; document.body.focus(); true');
    for (let index = 0; index < 10; index += 1) {
      results.focus.push(await pressTab(cdp));
    }
    const accessibility = await cdp.call('Accessibility.getFullAXTree', { depth: 4 });
    results.accessibility.push({
      label: 'products',
      roles: accessibility.nodes
        .map(node => node.role?.value)
        .filter(Boolean)
        .slice(0, 80),
      namedNodes: accessibility.nodes
        .filter(node => node.name?.value)
        .slice(0, 30)
        .map(node => ({ role: node.role?.value, name: node.name?.value })),
    });

    await cdp.call('Fetch.enable', {
      patterns: [{
        urlPattern: `${baseUrl}/api/dashboard/products*`,
        requestStage: 'Request',
      }],
    });
    const loadingPause = cdp.once(
      'Fetch.requestPaused',
      params => params.request?.url.includes('/api/dashboard/products'),
      15_000,
    );
    const loadingPage = cdp.once('Page.loadEventFired', () => true, 20_000);
    await cdp.call('Page.reload', { ignoreCache: true });
    await loadingPage;
    const pausedLoading = await loadingPause;
    await delay(250);
    results.checks.push(await inspectPage(cdp, 'desktop-products-loading'));
    results.screenshots.push(await takeScreenshot(cdp, evidenceDir, 'desktop-products-loading'));
    await cdp.call('Fetch.continueRequest', { requestId: pausedLoading.requestId });
    await delay(1_300);
    results.checks.push(await inspectPage(cdp, 'desktop-products-after-loading'));

    const errorPause = cdp.once(
      'Fetch.requestPaused',
      params => params.request?.url.includes('/api/dashboard/products'),
      15_000,
    );
    const errorPage = cdp.once('Page.loadEventFired', () => true, 20_000);
    await cdp.call('Page.reload', { ignoreCache: true });
    await errorPage;
    const pausedError = await errorPause;
    await cdp.call('Fetch.failRequest', {
      requestId: pausedError.requestId,
      errorReason: 'Failed',
    });
    await delay(1_200);
    results.checks.push(await inspectPage(cdp, 'desktop-products-error'));
    results.screenshots.push(await takeScreenshot(cdp, evidenceDir, 'desktop-products-error'));
    await cdp.call('Fetch.disable');

    await cdp.navigate(`${baseUrl}/dashboard/products/${fixture.productId}`);
    results.checks.push(await inspectPage(cdp, 'desktop-product-detail'));
    results.screenshots.push(await takeScreenshot(cdp, evidenceDir, 'desktop-product-detail'));
    await cdp.navigate(`${baseUrl}/dashboard/app-health`);
    results.checks.push(await inspectPage(cdp, 'desktop-app-health'));
    results.screenshots.push(await takeScreenshot(cdp, evidenceDir, 'desktop-app-health'));

    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 390,
      screenHeight: 844,
    });
    await cdp.navigate(`${baseUrl}/dashboard/products`);
    results.checks.push(await inspectPage(cdp, 'mobile-products'));
    results.screenshots.push(await takeScreenshot(cdp, evidenceDir, 'mobile-products'));
    await cdp.navigate(`${baseUrl}/dashboard/products/${fixture.productId}`);
    results.checks.push(await inspectPage(cdp, 'mobile-product-detail'));
    results.screenshots.push(await takeScreenshot(cdp, evidenceDir, 'mobile-product-detail'));
    await cdp.navigate(`${baseUrl}/dashboard/app-health`);
    results.checks.push(await inspectPage(cdp, 'mobile-app-health'));
    results.screenshots.push(await takeScreenshot(cdp, evidenceDir, 'mobile-app-health'));
    await cdp.navigate(`${baseUrl}/dashboard/products/non-existent-browser-fixture`);
    results.checks.push(await inspectPage(cdp, 'mobile-product-error'));
    results.screenshots.push(await takeScreenshot(cdp, evidenceDir, 'mobile-product-error'));

    results.failures = verifyResults(results);
    results.passed = results.failures.length === 0;
    await fs.writeFile(
      path.join(evidenceDir, 'results.json'),
      JSON.stringify(results, null, 2),
    );
    console.log(JSON.stringify({
      passed: results.passed,
      failures: results.failures,
      release: results.release,
      productId: results.productId,
      checks: results.checks.map(check => ({
        label: check.label,
        path: check.path,
        activeNavHref: check.activeNavHref,
        horizontalOverflow: check.horizontalOverflow,
        busyCount: check.busyCount,
        alertCount: check.alerts.length,
      })),
      focusSteps: results.focus.length,
      screenshotCount: results.screenshots.length,
      evidence: path.join(evidenceDir, 'results.json'),
    }, null, 2));
    if (!results.passed) process.exitCode = 1;
  } finally {
    try {
      socket?.close();
    } catch {
      // The browser process is terminated below.
    }
    chrome.kill();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
