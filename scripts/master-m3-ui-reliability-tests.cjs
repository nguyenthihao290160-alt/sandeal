/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
require('./register-typescript.cjs');
require.extensions['.tsx'] = function transpileTsx(module, filename) {
  const implementation = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(implementation, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { SafeProductImage } = require('../src/components/safe-product-image.tsx');
const { isDashboardRouteActive } = require('../src/lib/dashboard/navigation.ts');

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
  await test('An unsafe image URL renders the local placeholder with a visible category', () => {
    const html = renderToStaticMarkup(React.createElement(SafeProductImage, {
      originalUrl: 'https://127.0.0.1/private.jpg',
      alt: 'Private image',
      showFailureStatus: true,
    }));
    assert.ok(html.includes('src="/product-placeholder.svg"'));
    assert.ok(html.includes('data-image-failure-category="unsafe_or_invalid_url"'));
    assert.ok(html.includes('URL ảnh không an toàn hoặc không hợp lệ'));
  });

  await test('A public HTTPS image retains useful alt text and privacy controls', () => {
    const html = renderToStaticMarkup(React.createElement(SafeProductImage, {
      originalUrl: 'https://images.example/product.jpg',
      alt: 'Verified product image',
      healthStatus: 'ok',
    }));
    assert.ok(html.includes('src="https://images.example/product.jpg"'));
    assert.ok(html.includes('alt="Verified product image"'));
    assert.ok(html.includes('referrerPolicy="no-referrer"'));
    assert.ok(html.includes('data-image-failure-category="none"'));
  });

  await test('A known-broken legacy image starts on the local placeholder without another remote request', () => {
    const html = renderToStaticMarkup(React.createElement(SafeProductImage, {
      originalUrl: 'https://legacy-images.example/missing.jpg',
      alt: 'Legacy product image',
      healthStatus: 'not_found',
      showFailureStatus: true,
    }));
    assert.ok(html.includes('src="/product-placeholder.svg"'));
    assert.ok(!html.includes('legacy-images.example'));
    assert.ok(html.includes('data-image-failure-category="known_unhealthy"'));
    assert.ok(html.includes('Ảnh nguồn đã thất bại kiểm tra'));
  });

  await test('Dashboard route highlighting includes nested product detail routes only in Products', () => {
    assert.equal(isDashboardRouteActive('/dashboard/products/abc', '/dashboard/products'), true);
    assert.equal(isDashboardRouteActive('/dashboard/products/abc', '/dashboard'), false);
    assert.equal(isDashboardRouteActive('/dashboard/app-health', '/dashboard/app-health'), true);
    assert.equal(isDashboardRouteActive('/dashboard/automation/jobs', '/dashboard/automation'), true);
    assert.equal(isDashboardRouteActive('/dashboard/products-other', '/dashboard/products'), false);
  });

  await test('Product Operations uses bounded requests and cleans every busy state', () => {
    const implementation = source('src/app/dashboard/products/products-dashboard.tsx');
    assert.equal(implementation.includes('void fetch('), false);
    assert.equal(implementation.includes('await fetch('), false);
    assert.ok(implementation.includes('requestClientJson<Envelope<DashboardProductsResult>>'));
    assert.ok(implementation.includes('if (itemBusyRef.current) return'));
    assert.ok(implementation.includes('if (!operationDialog || operationBusyRef.current) return'));
    assert.ok(implementation.includes('if (sourceBusyRef.current) return'));
    assert.ok(implementation.includes('setBusy(null)'));
    assert.ok(implementation.includes('setOperationBusy(false)'));
    assert.ok(implementation.includes('setSourceBusy(false)'));
    assert.ok(implementation.includes('pollAbortRef.current?.abort()'));
  });

  await test('Product Detail keeps product data when operational truth fails and monitors rechecks', () => {
    const implementation = source('src/app/dashboard/products/[id]/page.tsx');
    assert.equal(implementation.includes('await fetch('), false);
    assert.equal(implementation.includes('.then(res =>'), false);
    assert.ok(implementation.includes('Promise.allSettled'));
    assert.ok(implementation.includes('productRef.current = productResult.value.data'));
    assert.ok(implementation.includes('pollScanJob'));
    assert.ok(implementation.includes('verificationFeedback'));
    assert.ok(implementation.includes('if (actionBusyRef.current) return'));
    assert.ok(implementation.includes("setActionBusy('')"));
    assert.ok(implementation.includes('showFailureStatus'));
  });

  await test('App Health refreshes are bounded and stale requests cannot win', () => {
    const implementation = source('src/app/dashboard/app-health/page.tsx');
    assert.equal(implementation.includes("fetch('/api/automation/health'"), false);
    assert.ok(implementation.includes('requestSequenceRef'));
    assert.ok(implementation.includes("requestRef.current?.abort"));
    assert.ok(implementation.includes('setLoading(false)'));
  });

  await test('Product Detail remains compact, responsive, and keyboard-operable', () => {
    const page = source('src/app/dashboard/products/[id]/page.tsx');
    const css = source('src/app/dashboard/products/[id]/product-detail.module.css');
    assert.ok(page.includes('aria-expanded={showTechnical}'));
    assert.ok(page.includes('role="status"'));
    assert.ok(page.includes('role="alert"'));
    assert.ok(css.includes('@media (max-width: 680px)'));
    assert.ok(css.includes('.verificationFeedback'));
  });

  await test('Product Studio renders current server truth and keeps technical codes in Debug', () => {
    const page = source('src/app/dashboard/products/[id]/page.tsx');
    const drawer = source('src/components/dashboard/product-studio-drawer.tsx');
    assert.ok(page.includes('pipelineTruth ? pipelineTruth.lifecycle.blockers'));
    assert.ok(page.includes("pipelineTruth.eligibility?.eligibleForPublish !== true"));
    assert.equal(page.includes('sourceEvidence?.affiliate.reasonCode'), false);
    assert.equal(page.includes('lastEligibilityDecision?.reasonCodes.join'), false);
    assert.ok(page.includes("['Review Quality', product.reviewQuality?.qualityScore]"));
    assert.ok(page.includes("['Content Quality', product.reviewContent?.contentQualityScore]"));
    assert.ok(page.includes('quality_identity'));
    assert.equal(page.includes('Khấu trừ chính:'), false);
    assert.ok(drawer.includes('healthStatus={detail.debug.technicalState.imageHealthStatus || undefined}'));
  });

  await test('mobile navigation and Source Reliability preserve focus and visible diagnostics', () => {
    const layout = source('src/app/dashboard/layout.tsx');
    const globals = source('src/app/globals.css');
    const reliability = source('src/components/dashboard/source-reliability-panel.module.css');
    assert.ok(layout.includes('id="dashboard-primary-navigation"'));
    assert.ok(layout.includes('aria-expanded={sidebarOpen}'));
    assert.ok(layout.includes('aria-controls="dashboard-primary-navigation"'));
    assert.ok(globals.includes('visibility: hidden'));
    assert.ok(globals.includes('pointer-events: none'));
    assert.ok(reliability.includes('overflow-x: auto'));
    assert.ok(reliability.includes('var(--surface-primary, var(--bg-card, #fff))'));
    assert.ok(reliability.includes('var(--border-color, var(--border-primary, #dfe5ec))'));
  });

  console.log(`\nM3 UI reliability tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void run();
