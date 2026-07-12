/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

require.extensions['.ts'] = function transpile(module, filename) {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, parent, isMain, options) {
  if (request.startsWith('@/')) request = path.join(process.cwd(), 'src', request.slice(2));
  return originalResolve.call(this, request, parent, isMain, options);
};

const target = process.argv[2];
if (!target || path.resolve(target) === path.resolve(process.cwd(), '.data')) throw new Error('Chỉ được tạo fixture trong thư mục tạm riêng.');
process.env.SANDEAL_DATA_DIR = target;
const { writeCollection } = require('../src/lib/storage/adapter.ts');
const { generateEditorialReview } = require('../src/lib/editorialReview.ts');
const { applySafePublishDecision } = require('../src/lib/safePublish.ts');
const now = '2026-07-12T00:00:00.000Z';
const base = {
  id: 'smoke-index', title: 'Máy xay sinh tố kiểm tra SEO', slug: 'smoke-index', kind: 'product', platform: 'accesstrade', source: 'accesstrade',
  category: 'Đồ gia dụng', originalUrl: 'https://shop.example/product', affiliateUrl: 'https://affiliate.example/product',
  imageUrl: 'https://down-vn.img.susercontent.com/file/smoke.jpg', price: 450000, salePrice: 399000, currency: 'VND',
  tags: ['máy xay'], benefits: [], warnings: [], riskLevel: 'low', status: 'needs_review', verifiedSource: true, autoPublishEligible: true,
  linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok', linkLastCheckedAt: now,
  sourceHash: 'smoke-source-v1', createdAt: now, updatedAt: now,
};
const reviewContent = generateEditorialReview(base, [], now);
const published = applySafePublishDecision({ ...base, reviewContent }, now);
const thin = { ...base, id: 'smoke-review', slug: 'smoke-review', title: 'Sản phẩm đang chờ xác minh', price: undefined, salePrice: undefined, imageUrl: undefined, imageHealthStatus: 'image_broken', sourceHash: 'thin-v1', status: 'needs_review', publicHidden: true, publicDecision: 'needs_review', needsVerification: true, autoPublished: false, reviewContent: undefined };
thin.reviewContent = generateEditorialReview(thin, [published], now);
writeCollection('products', [published, thin]).catch((error) => { console.error(error); process.exitCode = 1; });
