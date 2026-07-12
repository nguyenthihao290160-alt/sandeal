/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

require.extensions['.ts'] = function transpile(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename }).outputText;
  module._compile(output, filename);
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, parent, isMain, options) {
  if (request.startsWith('@/')) request = path.join(process.cwd(), 'src', request.slice(2));
  return originalResolve.call(this, request, parent, isMain, options);
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandeal-tests-'));
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.ACCESS_TRADE_API_KEY = 'test-key-never-sent';
let passed = 0; let failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`✓ ${name}`); } catch (error) { failed++; console.error(`✗ ${name}: ${error.stack || error}`); } }
function assert(value, message = 'assertion failed') { if (!value) throw new Error(message); }
function equal(actual, expected, message) { if (actual !== expected) throw new Error(message || `${actual} !== ${expected}`); }
function response(status, body = {}, headers = {}) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }); }
function imageResponse(status = 200, type = 'image/jpeg') { return new Response('', { status, headers: { 'content-type': type, 'content-length': '2048' } }); }

(async () => {
  const adapter = require('../src/lib/storage/adapter.ts');
  const queue = require('../src/lib/storage/candidateQueue.ts');
  const scheduler = require('../src/lib/bots/automationScheduler.ts');
  const pipeline = require('../src/lib/bots/productPipeline.ts');
  const safe = require('../src/lib/safePublish.ts');
  const products = require('../src/lib/storage/products.ts');
  const health = require('../src/lib/bots/productHealthCheck.ts');
  const access = require('../src/lib/integrations/accesstrade.ts');
  const locks = require('../src/lib/bots/runLock.ts');
  const botRuns = require('../src/lib/storage/botRuns.ts');
  const editorial = require('../src/lib/editorialReview.ts');
  const seo = require('../src/lib/seo/productSeo.ts');
  const sitemapModule = require('../src/app/sitemap.ts');

  const payload = (o = {}) => ({ title: 'Sản phẩm chính hãng đầy đủ', kind: 'product', platform: 'accesstrade', originalUrl: 'https://shop.test/p/1', affiliateUrl: 'https://go.test/a/1', imageUrl: 'https://img.test/1.jpg', price: 100000, currency: 'VND', verifiedSource: true, autoPublishEligible: true, ...o });
  const enqueue = (id, o = {}) => queue.enqueueCandidate({ source: 'accesstrade', sourceId: id, priority: 100, contentHash: `h-${id}`, sourceHash: `h-${id}`, payload: payload(o) });
  const baseProduct = (o = {}) => ({ id: 'p1', title: 'Sản phẩm chính hãng đầy đủ', slug: 'san-pham', kind: 'product', platform: 'accesstrade', source: 'accesstrade', originalUrl: 'https://shop.test/p/1', affiliateUrl: 'https://go.test/a/1', imageUrl: 'https://img.test/1.jpg', price: 100000, currency: 'VND', tags: [], benefits: [], warnings: [], riskLevel: 'low', status: 'needs_review', verifiedSource: true, autoPublishEligible: true, linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok', linkLastCheckedAt: '2026-07-12T00:00:00.000Z', sourceHash: 'source-ready', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z', ...o });
  const indexableProduct = (o = {}) => { const base = baseProduct(o); const reviewContent = editorial.generateEditorialReview(base, []); return safe.applySafePublishDecision({ ...base, reviewContent }); };

  await test('1. bootstrap dưới 100 public', () => equal(pipeline.selectOperationMode(99), 'bootstrap'));
  await test('2. steady từ 100 public', () => equal(pipeline.selectOperationMode(100), 'steady'));
  await test('3. scheduler bỏ job chưa tới hạn', () => equal(scheduler.isJobDue(new Date(Date.now() + 60000).toISOString()), false));
  await test('4. queue claim đúng batch', async () => { await adapter.writeCollection('candidate-queue', []); for (let i = 0; i < 5; i++) await enqueue(`b${i}`); equal((await queue.claimCandidateBatch(2)).length, 2); });
  await test('5. processing hết TTL trở lại pending', async () => { const items = await queue.listCandidateQueue(); items[0].status = 'processing'; items[0].processingStartedAt = new Date(Date.now() - 20 * 60000).toISOString(); await adapter.writeCollection('candidate-queue', items); equal(await queue.recoverStaleProcessing(), 1); });
  await test('6. duplicate không đổi không vào queue', async () => { await adapter.writeCollection('candidate-queue', []); await enqueue('dup'); equal((await enqueue('dup')).queued, false); });
  await test('7. cooldown chưa tới không claim', async () => { const items = await queue.listCandidateQueue(); items[0].status = 'delayed'; items[0].nextAttemptAt = new Date(Date.now() + 60000).toISOString(); await adapter.writeCollection('candidate-queue', items); equal((await queue.claimCandidateBatch(5)).length, 0); });
  await test('8. voucher/store offer bị lọc', () => { equal(pipeline.fastReject(payload({ kind: 'voucher' })), 'not_product'); equal(pipeline.fastReject(payload({ kind: 'store_offer' })), 'not_product'); });
  await test('9. AccessTrade empty khác timeout', async () => { global.fetch = async () => response(200, { data: [] }); equal((await access.searchAccessTrade({ kind: 'product' })).requests[0].resultType, 'success_empty'); global.fetch = async () => { const e = new Error('timeout'); e.name = 'AbortError'; throw e; }; let type; try { await access.searchAccessTrade({ kind: 'product' }); } catch (e) { type = e.resultType; } equal(type, 'timeout'); });
  await test('10. 401 dừng scan', async () => { let calls = 0; global.fetch = async () => { calls++; return response(401); }; let type; try { await access.searchAccessTrade({ kind: 'product' }); } catch (e) { type = e.resultType; } equal(type, 'unauthorized'); equal(calls, 1); });
  await test('11. 429 có retryAfter, không retry', async () => { let calls = 0; global.fetch = async () => { calls++; return response(429, {}, { 'retry-after': '120' }); }; let req; try { await access.searchAccessTrade({ kind: 'product' }); } catch (e) { req = e.requests[0]; } equal(req.resultType, 'rate_limited'); assert(req.retryAfter); equal(calls, 1); });
  await test('12. hai timeout kết thúc source scan', async () => { global.fetch = async () => { const e = new Error('timeout'); e.name = 'AbortError'; throw e; }; const result = await pipeline.scanSourcesToQueue('bootstrap', Date.now() + 10000); equal(result.resultTypes.timeout, 2); });
  await test('13. concurrency review không vượt 3', async () => { await adapter.writeCollection('candidate-queue', []); for (let i = 0; i < 6; i++) await enqueue(`c${i}`, { originalUrl: `https://shop.test/${i}`, affiliateUrl: `https://go.test/${i}`, imageUrl: `https://img.test/${i}.jpg` }); let active = 0; let max = 0; global.fetch = async (url) => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 5)); active--; return String(url).includes('img.test') ? imageResponse() : new Response('', { status: 200, headers: { 'content-type': 'text/html' } }); }; await pipeline.processReviewQueue('bootstrap', Date.now() + 30000); assert(max <= 3, `max=${max}`); });
  await test('14. HTTP 403 không bị gọi broken', async () => { global.fetch = async () => new Response('', { status: 403 }); equal((await health.checkLinkHealth('https://blocked.test/x')).status, 'not_allowed'); });
  await test('15. ảnh HTML 200 không healthy', async () => { global.fetch = async () => imageResponse(200, 'text/html'); equal((await health.checkImageHealth('https://img.test/html')).ok, false); });
  await test('16. thiếu giá không publish', () => equal(safe.evaluateSafePublish(baseProduct({ price: undefined })).eligible, false));
  await test('17. ảnh lỗi không publish', () => equal(safe.evaluateSafePublish(baseProduct({ imageHealthStatus: 'image_broken' })).eligible, false));
  await test('18. product URL lỗi không publish', () => equal(safe.evaluateSafePublish(baseProduct({ linkHealthStatus: 'not_found' })).eligible, false));
  await test('19. đủ health và review được publish', () => equal(safe.evaluateSafePublish(indexableProduct()).eligible, true));
  await test('20. published xuất hiện public selector', async () => { await adapter.writeCollection('products', []); const ready = indexableProduct({ id: 'public', sourceId: 'public' }); await products.upsertCanonicalProduct(ready, { evaluate: true }); equal((await products.getPublicProducts()).length, 1); });
  await test('21. bot-runs không đổi Product', async () => { const before = JSON.stringify(await products.getAllProducts()); const run = await botRuns.createBotRun('source_scan', 'all', 1); await botRuns.updateBotRun(run.id, { status: 'completed' }); equal(JSON.stringify(await products.getAllProducts()), before); });
  await test('22. lock ngăn overlap', async () => { const first = await locks.acquireRunLock('test', 'test'); const second = await locks.acquireRunLock('test', 'test'); equal(first.acquired, true); equal(second.acquired, false); await locks.releaseRunLock(first.runId); });
  await test('23. duplicate không tăng queue quota', async () => { await adapter.writeCollection('candidate-queue', []); await enqueue('quota'); await enqueue('quota'); equal((await queue.getQueueStats()).total, 1); });
  await test('24. queue tồn tại sau reload', async () => { const count = (await queue.listCandidateQueue()).length; delete require.cache[require.resolve('../src/lib/storage/candidateQueue.ts')]; equal((await require('../src/lib/storage/candidateQueue.ts').listCandidateQueue()).length, count); });

  await test('25. không bịa fact ngoài Product', () => { const facts = editorial.extractVerifiedProductFacts(baseProduct({ description: 'Thương hiệu Hư Cấu, titan, tốt nhất thị trường' })); assert(!facts.some((item) => item.id === 'brand')); assert(!JSON.stringify(facts).includes('Hư Cấu')); });
  await test('26. claim thiếu evidence bị loại', () => { const p = baseProduct({ sourceHash: 'claims' }); const review = editorial.generateEditorialReview(p); review.factualClaims.push({ id: 'fake', text: 'Pin 10 ngày.', claimType: 'factual', evidenceFactIds: [], confidence: 'high' }); assert(editorial.validateReviewClaims(review, p).removedClaimIds.includes('fake')); });
  await test('27. inference được đánh dấu nhận định', () => { const review = editorial.generateEditorialReview(baseProduct({ category: 'Gia dụng', sourceHash: 'infer' })); assert(review.inferredClaims.length > 0); assert(review.inferredClaims.every((item) => item.claimType === 'inferred' && /có thể|theo dữ liệu|nên kiểm tra/i.test(item.text))); });
  await test('28. thiếu fact không tạo bài dài', () => { const review = editorial.generateEditorialReview(baseProduct({ price: undefined, originalUrl: undefined, affiliateUrl: undefined, imageUrl: undefined, linkHealthStatus: undefined, affiliateHealthStatus: undefined, imageHealthStatus: undefined, sourceHash: 'thin' })); equal(review.reviewStatus, 'needs_review'); assert(review.reviewBlockReasons.includes('insufficient_facts')); assert(review.reviewSummary.length < 300); });
  await test('29. không dùng hands_on_test giả', () => { const normalized = editorial.normalizeReviewContent({ ...editorial.generateEditorialReview(baseProduct()), reviewMethod: 'hands_on_test' }); equal(normalized.reviewMethod, 'source_data_analysis'); });
  await test('30. không tuyên bố đã dùng thực tế', () => { const text = JSON.stringify(editorial.generateEditorialReview(baseProduct({ sourceHash: 'experience' }))).toLowerCase(); assert(!text.includes('đã sử dụng thực tế')); assert(text.includes('chưa trực tiếp')); });
  await test('31. hai Product giống nhau bị content gate chặn', () => { const p = baseProduct({ sourceHash: 'same-1' }); const first = editorial.generateEditorialReview(p); const second = editorial.generateEditorialReview({ ...p, id: 'p2', sourceHash: 'same-2' }, [{ ...p, reviewContent: first }]); assert(second.reviewBlockReasons.includes('low_originality')); });
  await test('32. qualityScore không thành AggregateRating', () => { const text = JSON.stringify(seo.buildProductJsonLd(indexableProduct({ qualityScore: 99 }))); assert(!text.includes('AggregateRating') && !text.includes('ratingValue')); });
  await test('33. external rating không thành rating SanDeal', () => { const text = JSON.stringify(seo.buildProductJsonLd(indexableProduct({ externalRating: 5, reviewCount: 1000 }))).toLowerCase(); assert(!text.includes('rating')); });
  await test('34. affiliate rel có sponsored', () => assert(fs.readFileSync(path.join(process.cwd(), 'src/app/deals/[slug]/page.tsx'), 'utf8').includes('rel="sponsored noopener noreferrer"')));
  await test('35. needs_review là noindex', () => equal(seo.buildProductMetadata(baseProduct()).robots.index, false));
  await test('36. public đủ chuẩn là index', () => equal(seo.buildProductMetadata(indexableProduct()).robots.index, true));
  await test('37. noindex không vào sitemap', async () => { await adapter.writeCollection('products', [indexableProduct({ id: 'good', slug: 'good', sourceId: 'good' }), baseProduct({ id: 'bad', slug: 'bad', sourceId: 'bad' })]); const map = await sitemapModule.default(); assert(map.some((item) => item.url.endsWith('/deals/good'))); assert(!map.some((item) => item.url.endsWith('/deals/bad'))); });
  await test('38. sitemap chỉ có canonical Product', async () => { const urls = (await sitemapModule.default()).filter((item) => item.url.includes('/deals/')); equal(urls.length, 1); equal(urls[0].url, seo.canonicalProductUrl({ slug: 'good' })); });
  await test('39. lastmod ổn định khi dữ liệu không đổi', () => { const p = indexableProduct(); const first = seo.stableLastModified(p); const second = seo.stableLastModified(p); equal(first, second); assert([p.reviewContent.contentUpdatedAt, p.publishedAt].includes(first)); });
  await test('40. JSON-LD khớp dữ liệu hiển thị', () => { const p = indexableProduct({ title: 'Máy xay kiểm thử', price: 250000 }); const json = seo.buildProductJsonLd(p); equal(json.name, p.title); equal(json.offers.price, 250000); equal(json.description, p.reviewContent.reviewSummary); });
  await test('41. JSON-LD không chứa rating giả', () => { const text = JSON.stringify(seo.buildProductJsonLd(indexableProduct({ price: 320000, qualityScore: 100 }))); assert(text.includes('320000')); assert(!text.toLowerCase().includes('rating')); });
  await test('42. published có canonical URL', () => { const p = indexableProduct({ slug: 'canonical-test' }); equal(seo.buildProductMetadata(p).alternates.canonical, seo.canonicalProductUrl(p)); });
  await test('43. published có related internal link', () => { const p = indexableProduct({ id: 'root', category: 'Gia dụng', price: 200000, sourceHash: 'root' }); const related = seo.selectRelatedProducts(p, [indexableProduct({ id: 'other', slug: 'other', category: 'Gia dụng', price: 210000, sourceHash: 'other' })]); equal(related.length, 1); });
  await test('44. thiếu ảnh không SEO-ready', () => equal(seo.getProductIndexingDecision(indexableProduct({ imageUrl: undefined, imageHealthStatus: 'image_broken' })).indexable, false));
  await test('45. review đủ fact vượt content gate', () => { const review = editorial.generateEditorialReview(baseProduct({ category: 'Phụ kiện', sourceHash: 'complete' })); equal(review.reviewStatus, 'approved'); assert(review.contentQualityScore >= 75); });
  await test('46. nội dung trùng bị chặn', () => { const p = baseProduct({ sourceHash: 'dup-a' }); const first = editorial.generateEditorialReview(p); const duplicate = editorial.generateEditorialReview({ ...p, id: 'dup-b', sourceHash: 'dup-b' }, [{ ...p, reviewContent: first }]); equal(duplicate.reviewStatus, 'needs_review'); assert(duplicate.originalityScore < 70); });
  await test('47. bot-runs không làm review public', async () => { await adapter.writeCollection('products', [baseProduct({ id: 'run-product', sourceId: 'run-product' })]); const before = (await products.getAllProducts())[0].reviewContent; const run = await botRuns.createBotRun('content_review', 'all', 1); await botRuns.updateBotRun(run.id, { status: 'completed' }); equal((await products.getAllProducts())[0].reviewContent, before); });
  await test('48. sourceHash không đổi không viết lại', () => { const p = baseProduct({ sourceHash: 'stable-source' }); const first = editorial.generateEditorialReview(p, [], '2026-01-01T00:00:00.000Z'); const second = editorial.generateEditorialReview({ ...p, reviewContent: first }, [], '2026-02-01T00:00:00.000Z'); equal(second.reviewContentHash, first.reviewContentHash); equal(second.contentUpdatedAt, first.contentUpdatedAt); });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
})();
