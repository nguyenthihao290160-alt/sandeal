/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
process.env.NODE_ENV = 'test';
process.env.SITE_URL = 'http://localhost:3000';
require('./register-typescript.cjs');

const manifest = require('../src/app/manifest.ts').default;
const productSeo = require('../src/lib/seo/productSeo.ts');
const taxonomySeo = require('../src/lib/seo/taxonomySeo.ts');

let passed = 0;
let failed = 0;

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function test(name, work) {
  try {
    work();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error instanceof Error ? error.stack : error}`);
  }
}

test('web manifest owns the exact Windows installed-app identity', () => {
  const value = manifest();
  assert.equal(value.name, 'SanDeal');
  assert.equal(value.short_name, 'SanDeal');
  assert.equal(value.start_url, '/');
  assert.equal(value.scope, '/');
  assert.equal(value.display, 'standalone');
});

test('custom S icon routes remain unchanged', () => {
  const value = manifest();
  assert.deepEqual(value.icons, [
    { src: '/icon', sizes: '32x32', type: 'image/png', purpose: 'any' },
    { src: '/apple-icon', sizes: '180x180', type: 'image/png', purpose: 'any' },
  ]);
  assert.equal(fs.existsSync(path.join(root, 'src/app/icon.tsx')), true);
  assert.equal(fs.existsSync(path.join(root, 'src/app/apple-icon.tsx')), true);
});

test('root metadata keeps application identity separate from descriptive page titles', () => {
  const layout = read('src/app/layout.tsx');
  assert.match(layout, /applicationName: 'SanDeal'/);
  assert.match(layout, /manifest: '\/manifest\.webmanifest'/);
  assert.match(layout, /template: '%s \| SanDeal'/);
});

test('affected child routes delegate the single browser-title suffix to the root template', () => {
  const files = [
    'src/app/deals/page.tsx',
    'src/app/compare/page.tsx',
    'src/app/deals/brand/[slug]/page.tsx',
    'src/app/deals/category/[slug]/page.tsx',
  ];
  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /title:\s*['"`][^'"\r\n]*\|\s*SanDeal/);
  }

  const deals = read('src/app/deals/page.tsx');
  assert.match(deals, /const socialTitle = `\$\{pageTitle\} \| SanDeal`/);
  assert.match(deals, /title: pageTitle/);
  assert.match(deals, /openGraph: \{ title: socialTitle/);
});

test('SEO metadata helpers keep document titles unbranded and social titles branded once', () => {
  const taxonomy = taxonomySeo.buildTaxonomyMetadata({
    kind: 'category',
    name: 'Điện tử',
    slug: 'dien-tu',
    totalItems: 3,
    page: 1,
    totalPages: 1,
    curated: true,
  });
  assert.equal(taxonomy.title, 'Deal Điện tử đã kiểm tra');
  assert.equal(taxonomy.openGraph.title, 'Deal Điện tử đã kiểm tra | SanDeal');
  assert.equal(taxonomy.twitter.title, 'Deal Điện tử đã kiểm tra | SanDeal');

  const missingProduct = productSeo.buildProductMetadata(null);
  assert.equal(missingProduct.title, 'Không tìm thấy sản phẩm');
});

console.log(`\nPWA metadata tests: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
