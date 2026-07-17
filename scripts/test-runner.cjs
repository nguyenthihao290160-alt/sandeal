/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
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

const tempDir = path.join(process.cwd(), '.test-tmp', `sandeal-tests-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
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
  const readiness = require('../src/lib/bots/candidateReadiness.ts');
  const geminiModels = require('../src/lib/ai/geminiModels.ts');
  const geminiRouter = require('../src/lib/ai/geminiCredentialRouter.ts');
  const geminiPool = require('../src/lib/ai/geminiQuotaGroupManager.ts');
  const geminiProbe = require('../src/lib/ai/geminiCredentialProbe.ts');

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
  await test('12. hai timeout kết thúc source scan', async () => { await adapter.writeCollection('domain-circuit-breakers', []); global.fetch = async () => { const e = new Error('timeout'); e.name = 'AbortError'; throw e; }; const result = await pipeline.scanSourcesToQueue('bootstrap', Date.now() + 10000); equal(result.resultTypes.timeout, 2); });
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

  // ============================================================
  // V2: Product Health Check Tests
  // ============================================================

  await test('V2-01. HEAD timeout, GET 200 => link ok', async () => {
    let callCount = 0;
    global.fetch = async (url, opts) => {
      callCount++;
      if (opts && opts.method === 'HEAD') {
        const e = new Error('timeout'); e.name = 'TimeoutError'; throw e;
      }
      return new Response('<html>OK</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const result = await health.checkLinkHealth('https://shop.test/v2-timeout');
    equal(result.status, 'ok');
    equal(result.ok, true);
    assert(callCount >= 2, 'Should have made HEAD then GET');
  });

  await test('V2-02. HEAD 403, GET 200 => link ok', async () => {
    global.fetch = async (url, opts) => {
      if (opts && opts.method === 'HEAD') return new Response('', { status: 403 });
      return new Response('<html>OK</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const result = await health.checkLinkHealth('https://shop.test/v2-403');
    equal(result.status, 'ok');
    equal(result.ok, true);
  });

  await test('V2-03. HEAD 405, GET 200 => link ok', async () => {
    global.fetch = async (url, opts) => {
      if (opts && opts.method === 'HEAD') return new Response('', { status: 405 });
      return new Response('<html>OK</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const result = await health.checkLinkHealth('https://shop.test/v2-405');
    equal(result.status, 'ok');
    equal(result.ok, true);
  });

  await test('V2-04. GET 404 => broken', async () => {
    global.fetch = async () => new Response('', { status: 404 });
    const result = await health.checkLinkHealth('https://shop.test/v2-404');
    equal(result.status, 'broken');
    equal(result.ok, false);
  });

  await test('V2-05. GET 410 => broken', async () => {
    global.fetch = async () => new Response('', { status: 410 });
    const result = await health.checkLinkHealth('https://shop.test/v2-410');
    equal(result.status, 'broken');
    equal(result.ok, false);
  });

  await test('V2-06. GET 429 => rate_limited, không broken', async () => {
    global.fetch = async () => new Response('', { status: 429 });
    const result = await health.checkLinkHealth('https://shop.test/v2-429');
    equal(result.status, 'rate_limited');
    equal(result.ok, false);
    assert(result.status !== 'broken', 'Should NOT be broken');
  });

  await test('V2-07. GET 500 => server_error, không broken', async () => {
    global.fetch = async () => new Response('', { status: 500 });
    const result = await health.checkLinkHealth('https://shop.test/v2-500');
    equal(result.status, 'server_error');
    equal(result.ok, false);
    assert(result.status !== 'broken', 'Should NOT be broken');
  });

  await test('V2-08. timeout cả HEAD và GET => timeout, retryable', async () => {
    global.fetch = async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; };
    const result = await health.checkLinkHealth('https://shop.test/v2-both-timeout');
    equal(result.status, 'timeout');
    equal(result.ok, false);
    assert(result.status !== 'broken', 'Should NOT be broken');
  });

  await test('V2-09. Affiliate HTML 200 không redirect ngay => không bị broken', async () => {
    global.fetch = async () => new Response('<html><script>window.location="https://merchant.test"</script></html>', {
      status: 200, headers: { 'content-type': 'text/html' }
    });
    const result = await health.checkLinkHealth('https://pub.accesstrade.vn/deep/link/123');
    equal(result.status, 'ok');
    equal(result.ok, true);
  });

  await test('V2-10. Image HEAD 429, GET image 200 => image ok', async () => {
    global.fetch = async (url, opts) => {
      if (opts && opts.method === 'HEAD') return new Response('', { status: 429 });
      return new Response('', { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '2048' } });
    };
    const result = await health.checkImageHealth('https://img.test/v2-429-then-ok.jpg');
    equal(result.status, 'ok');
    equal(result.ok, true);
  });

  await test('V2-11. Image 429 => rate_limited, không image_broken', async () => {
    global.fetch = async () => new Response('', { status: 429 });
    const result = await health.checkImageHealth('https://img.test/v2-429.jpg');
    equal(result.status, 'rate_limited');
    equal(result.ok, false);
    assert(result.status !== 'image_broken', 'Should NOT be image_broken');
  });

  await test('V2-12. Image 500 => server_error, không image_broken', async () => {
    global.fetch = async () => new Response('', { status: 500 });
    const result = await health.checkImageHealth('https://img.test/v2-500.jpg');
    equal(result.status, 'server_error');
    equal(result.ok, false);
    assert(result.status !== 'image_broken', 'Should NOT be image_broken');
  });

  await test('V2-13. Image 404 => image_broken', async () => {
    global.fetch = async () => new Response('', { status: 404 });
    const result = await health.checkImageHealth('https://img.test/v2-404.jpg');
    equal(result.status, 'image_broken');
    equal(result.ok, false);
  });

  await test('V2-14. Content-Type không phải image/* => invalid_image', async () => {
    global.fetch = async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const result = await health.checkImageHealth('https://img.test/v2-html-response.jpg');
    equal(result.status, 'invalid_image');
    equal(result.ok, false);
  });

  await test('V2-15. SSRF/private IP vẫn bị chặn', async () => {
    global.fetch = async () => new Response('', { status: 200 });
    const result1 = await health.checkLinkHealth('https://localhost/admin');
    equal(result1.status, 'forbidden');
    const result2 = await health.checkLinkHealth('https://127.0.0.1/secret');
    equal(result2.status, 'forbidden');
    const result3 = await health.checkLinkHealth('https://192.168.1.1/internal');
    equal(result3.status, 'forbidden');
    const result4 = await health.checkImageHealth('https://10.0.0.1/img.jpg');
    equal(result4.status, 'forbidden');
  });

  // ============================================================
  // V2: Editorial Review Tests
  // ============================================================

  await test('V2-16. Review không bịa claims', () => {
    const review = editorial.generateEditorialReview(baseProduct({
      sourceHash: 'v2-no-fabricate',
      title: 'Máy hút bụi XYZ Pro',
      category: 'Gia dụng',
      brand: 'XYZ',
    }));
    const text = JSON.stringify(review).toLowerCase();
    // Should NOT contain fabricated experience claims
    assert(!text.includes('đã sử dụng thực tế'), 'Should not claim hands-on experience');
    assert(!text.includes('chắc chắn'), 'Should not use absolute claims');
    assert(!text.includes('tốt nhất'), 'Should not claim best');
    assert(!text.includes('an toàn tuyệt đối'), 'Should not claim absolute safety');
    // Should contain disclosure
    assert(text.includes('chưa trực tiếp'), 'Should contain no-hands-on disclosure');
  });

  await test('V2-17. Review V1 được regenerate thành V2', () => {
    const p = baseProduct({ sourceHash: 'v2-regen' });
    // Simulate V1 review
    const v1Review = { ...editorial.generateEditorialReview(p), reviewVersion: 1, sourceHash: 'v2-regen' };
    const productWithV1 = { ...p, reviewContent: v1Review };
    // shouldRegenerateReview should return true for V1
    assert(editorial.shouldRegenerateReview(productWithV1), 'Should regenerate V1 review');
    // Generate V2
    const v2Review = editorial.generateEditorialReview(productWithV1);
    equal(v2Review.reviewVersion, editorial.CURRENT_REVIEW_VERSION);
    assert(v2Review.reviewVersion >= 2, 'Should be V2 or later');
  });

  await test('V2-18. Nhiều sản phẩm khác nhau có nội dung đặc trưng khác nhau', () => {
    const products = [
      baseProduct({ id: 'elec-1', title: 'Laptop Dell XPS 15 inch', category: 'Điện tử', brand: 'Dell', sourceHash: 'v2-unique-1', specifications: { RAM: '16GB', CPU: 'Intel i7', SSD: '512GB' } }),
      baseProduct({ id: 'beauty-1', title: 'Kem chống nắng Anessa SPF50+', category: 'Làm đẹp', brand: 'Anessa', sourceHash: 'v2-unique-2', specifications: { SPF: '50+', 'Dung tích': '60ml' } }),
      baseProduct({ id: 'home-1', title: 'Máy xay sinh tố Philips HR2118', category: 'Gia dụng', brand: 'Philips', sourceHash: 'v2-unique-3', specifications: { 'Công suất': '600W', 'Dung tích': '2L' } }),
    ];
    const reviews = products.map((p) => editorial.generateEditorialReview(p));
    // Each review title should contain the product name
    for (let i = 0; i < products.length; i++) {
      assert(reviews[i].reviewTitle.includes(products[i].title), `Review ${i} title should contain product name`);
    }
    // Reviews should have different content
    const summaries = reviews.map((r) => r.reviewSummary);
    for (let i = 0; i < summaries.length; i++) {
      for (let j = i + 1; j < summaries.length; j++) {
        const similarity = editorial.textSimilarity(summaries[i], summaries[j]);
        assert(similarity < 0.8, `Reviews ${i} and ${j} are too similar (${similarity.toFixed(2)})`);
      }
    }
  });

  await test('V2-19. Sản phẩm thiếu facts vẫn bị needs_review', () => {
    const thinProduct = baseProduct({
      sourceHash: 'v2-thin-facts',
      price: undefined,
      originalUrl: undefined,
      affiliateUrl: undefined,
      imageUrl: undefined,
      linkHealthStatus: undefined,
      affiliateHealthStatus: undefined,
      imageHealthStatus: undefined,
      category: undefined,
      brand: undefined,
    });
    const review = editorial.generateEditorialReview(thinProduct);
    equal(review.reviewStatus, 'needs_review');
    assert(review.reviewBlockReasons.includes('insufficient_facts'), 'Should have insufficient_facts block reason');
    assert(review.reviewSummary.length < 400, 'Thin product should have short summary');
  });

  await test('V2-20. Safe Publish vẫn chặn sản phẩm không đủ điều kiện', () => {
    // Product with retryable health status should NOT be eligible
    const retryableProduct = baseProduct({
      linkHealthStatus: 'timeout',
      affiliateHealthStatus: 'rate_limited',
      imageHealthStatus: 'server_error',
    });
    equal(safe.evaluateSafePublish(retryableProduct).eligible, false);

    // Product with broken status should NOT be eligible
    const brokenProduct = baseProduct({
      linkHealthStatus: 'not_found',
    });
    equal(safe.evaluateSafePublish(brokenProduct).eligible, false);

    // Product without review should NOT be eligible
    const noReviewProduct = baseProduct({
      reviewContent: undefined,
    });
    equal(safe.evaluateSafePublish(noReviewProduct).eligible, false);
  });

  // ============================================================
  // V2: Additional edge case tests
  // ============================================================

  await test('V2-21. isRetryableLinkStatus correctly classifies statuses', () => {
    assert(health.isRetryableLinkStatus('timeout'), 'timeout should be retryable');
    assert(health.isRetryableLinkStatus('rate_limited'), 'rate_limited should be retryable');
    assert(health.isRetryableLinkStatus('server_error'), 'server_error should be retryable');
    assert(health.isRetryableLinkStatus('not_allowed'), 'not_allowed should be retryable');
    assert(health.isRetryableLinkStatus('dns_error'), 'dns_error should be retryable');
    assert(!health.isRetryableLinkStatus('broken'), 'broken should NOT be retryable');
    assert(!health.isRetryableLinkStatus('ok'), 'ok should NOT be retryable');
  });

  await test('V2-22. isRetryableImageStatus correctly classifies statuses', () => {
    assert(health.isRetryableImageStatus('timeout'), 'timeout should be retryable');
    assert(health.isRetryableImageStatus('rate_limited'), 'rate_limited should be retryable');
    assert(health.isRetryableImageStatus('server_error'), 'server_error should be retryable');
    assert(health.isRetryableImageStatus('forbidden'), 'forbidden should be retryable');
    assert(!health.isRetryableImageStatus('image_broken'), 'image_broken should NOT be retryable');
    assert(!health.isRetryableImageStatus('invalid_image'), 'invalid_image should NOT be retryable');
    assert(!health.isRetryableImageStatus('ok'), 'ok should NOT be retryable');
  });

  await test('V4-01. high-risk không auto-publish và giữ risk gốc', () => {
    const result = safe.applySafePublishDecision(indexableProduct({ riskLevel: 'high', category: 'Thiết bị y tế' }));
    equal(result.status, 'needs_review'); equal(result.riskLevel, 'high');
    assert(result.publicBlockReasons.includes('human_review_required'));
  });

  await test('V4-02. publicBlockReasons tương thích publicBlockReason', () => {
    const result = safe.applySafePublishDecision(baseProduct({ linkHealthStatus: 'timeout' }));
    assert(Array.isArray(result.publicBlockReasons) && result.publicBlockReasons.length > 0);
    assert(result.publicBlockReason.includes('product_url_unhealthy'));
  });

  await test('V4-03. readiness lane phân loại deterministic', () => {
    equal(readiness.scoreCandidateReadiness(payload()).lane, 'FAST_LANE');
    equal(readiness.scoreCandidateReadiness(payload({ kind: 'voucher' })).lane, 'REJECTED_LANE');
    equal(readiness.scoreCandidateReadiness(payload({ title: 'Thiết bị y tế điều trị tại nhà' })).lane, 'HUMAN_REVIEW_LANE');
  });

  await test('V4-04. FAST_LANE được claim trước NORMAL_LANE', async () => {
    await adapter.writeCollection('candidate-queue', []);
    await queue.enqueueCandidate({ source: 'accesstrade', sourceId: 'normal', priority: 999, readinessScore: 70, lane: 'NORMAL_LANE', contentHash: 'normal', sourceHash: 'normal', payload: payload({ title: 'Sản phẩm normal đầy đủ' }) });
    await queue.enqueueCandidate({ source: 'accesstrade', sourceId: 'fast', priority: 1, readinessScore: 100, lane: 'FAST_LANE', contentHash: 'fast', sourceHash: 'fast', payload: payload({ title: 'Sản phẩm fast đầy đủ' }) });
    equal((await queue.claimCandidateBatch(1))[0].sourceId, 'fast');
  });

  await test('V4-05. model router chỉ chọn stable Free allowlist còn hạn', () => {
    const profile = { taskType: 'metadata_repair', riskLevel: 'low', complexityScore: 10, factCount: 4, inputTokenEstimate: 100, candidateLane: 'FAST_LANE', priority: 100, previousFailures: 0, requiredQuality: 80 };
    equal(geminiModels.routeModel(profile, ['models/gemini-3.1-flash-lite'], Date.parse('2026-07-12')).modelId, 'gemini-3.1-flash-lite');
    equal(geminiModels.routeModel(profile, ['gemini-preview'], Date.parse('2026-07-12')), null);
  });

  const geminiCredential = (id, group, billingMode, healthScore, role = 'backup') => ({ id, platform: 'gemini', credentialType: 'api_key', role, label: id, encryptedValue: `b64:${Buffer.from(`secret-${id}`).toString('base64')}`, maskedValue: 'secr****test', status: 'valid', metadata: { billingMode, keyType: 'auth', quotaGroupId: group, supportedModels: ['gemini-3.1-flash-lite'], lightTestStatus: 'available', generationStatus: 'available', failureStreak: 0, requestsTodayEstimated: 0, inputTokensTodayEstimated: 0, outputTokensTodayEstimated: 0, healthScore }, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' });

  await test('V4-06. paid/unknown billing key không được chọn', async () => {
    await adapter.writeCollection('token-vault', [geminiCredential('paid', 'paid-group', 'paid', 100), geminiCredential('unknown', 'unknown-group', 'unknown', 100)]);
    await adapter.writeCollection('gemini-pool-state', []);
    equal((await geminiRouter.selectGeminiCredentials('gemini-3.1-flash-lite', Date.parse('2026-07-12'))).length, 0);
  });

  await test('V4-07. 429 chuyển quotaGroup, không chuyển key cùng group', async () => {
    await adapter.writeCollection('token-vault', [geminiCredential('g1a', 'group-1', 'free_confirmed', 100, 'primary'), geminiCredential('g1b', 'group-1', 'free_confirmed', 90), geminiCredential('g2', 'group-2', 'free_confirmed', 80)]);
    await adapter.writeCollection('gemini-pool-state', []);
    let calls = 0; const urls = []; const headers = [];
    const mockFetch = async (url, init) => { calls++; urls.push(String(url)); headers.push(init.headers); return calls === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '60' } }) : response(200, { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }); };
    const result = await geminiRouter.executeGeminiRequest({ modelId: 'gemini-3.1-flash-lite', taskType: 'metadata_repair', idempotencyKey: 'failover-groups', body: {}, timeoutMs: 1000 }, mockFetch);
    equal(result.ok, true); equal(result.quotaGroupId, 'group-2'); equal(calls, 2);
    assert(urls.every((url) => !url.includes('key='))); assert(headers.every((header) => Boolean(header['x-goog-api-key'])));
  });

  await test('V4-08. idempotency cache ngăn generation trùng', async () => {
    let calls = 0; const mockFetch = async () => { calls++; return response(200, { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }); };
    const request = { modelId: 'gemini-3.1-flash-lite', taskType: 'metadata_repair', idempotencyKey: 'cache-once', body: {}, timeoutMs: 1000 };
    await geminiRouter.executeGeminiRequest(request, mockFetch); await geminiRouter.executeGeminiRequest(request, mockFetch); equal(calls, 1);
  });

  await test('V4-09. hết Free groups chuyển persistent LOCAL_ONLY', async () => {
    await adapter.writeCollection('token-vault', [geminiCredential('paid-only', 'paid-only', 'paid', 100)]); await adapter.writeCollection('gemini-pool-state', []);
    const result = await geminiRouter.executeGeminiRequest({ modelId: 'gemini-3.1-flash-lite', taskType: 'metadata_repair', idempotencyKey: 'local-only', body: {}, timeoutMs: 1000 }, async () => { throw new Error('must_not_call'); });
    equal(result.errorCode, 'local_only'); equal((await geminiPool.getGeminiPoolState()).state, 'LOCAL_ONLY');
  });

  await test('V4-10. HEAD 429/500 đều fallback GET 200', async () => {
    for (const status of [429, 500]) { let calls = 0; global.fetch = async () => ++calls === 1 ? new Response('', { status }) : new Response('', { status: 200, headers: { 'content-type': 'text/html' } }); const result = await health.checkLinkHealth(`https://fallback-${status}.test/p`); equal(result.ok, true); equal(calls, 2); }
  });

  await test('V4-11. redirect sang private IP bị SSRF chặn', async () => {
    global.fetch = async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    const result = await health.checkLinkHealth('https://public.test/redirect'); equal(result.ok, false); assert(['not_allowed', 'forbidden'].includes(result.status));
  });

  await test('V4-12. generation probe strict JSON và 429 không invalid', async () => {
    const credential = geminiCredential('probe', 'probe-group', 'free_confirmed', 100, 'primary'); await adapter.writeCollection('token-vault', [credential]); await adapter.writeCollection('gemini-pool-state', []);
    let result = await geminiProbe.generationProbeCredential('probe', async () => response(200, { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] })); equal(result.generationStatus, 'available');
    result = await geminiProbe.generationProbeCredential('probe', async () => new Response('{}', { status: 429 })); equal(result.generationStatus, 'quota_exhausted'); assert(result.status !== 'invalid');
  });

  await test('V4-13. invalid input không failover mọi key', async () => {
    await adapter.writeCollection('token-vault', [geminiCredential('bad1', 'bad-group-1', 'free_confirmed', 100, 'primary'), geminiCredential('bad2', 'bad-group-2', 'free_confirmed', 90)]); await adapter.writeCollection('gemini-pool-state', []);
    let calls = 0; const result = await geminiRouter.executeGeminiRequest({ modelId: 'gemini-3.1-flash-lite', taskType: 'metadata_repair', idempotencyKey: 'invalid-no-failover', body: {}, timeoutMs: 1000 }, async () => { calls++; return new Response('{}', { status: 400 }); });
    equal(result.ok, false); equal(calls, 1);
  });

  await test('V4-14. Gemini concurrency không vượt 2', async () => {
    await adapter.writeCollection('token-vault', [geminiCredential('concurrent', 'concurrent-group', 'free_confirmed', 100, 'primary')]); await adapter.writeCollection('gemini-pool-state', []);
    let active = 0; let maximum = 0; const mockFetch = async () => { active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 10)); active--; return response(200, { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }); };
    await Promise.all([1, 2, 3].map((id) => geminiRouter.executeGeminiRequest({ modelId: 'gemini-3.1-flash-lite', taskType: 'metadata_repair', idempotencyKey: `concurrency-${id}`, body: {}, timeoutMs: 1000 }, mockFetch))); assert(maximum <= 2, `maximum=${maximum}`);
  });

  await test('V4-15. direct duplicate slug publication bị gate chặn và không làm mất canonical', async () => {
    const first = indexableProduct({ id: 'slug-first', sourceId: 'slug-first', slug: 'same-slug', sourceHash: 'slug-first' });
    const second = indexableProduct({ id: 'slug-second', sourceId: 'slug-second', slug: 'same-slug', sourceHash: 'slug-second' });
    await adapter.writeCollection('products', [first, second]); let blockedCode;
    try {
      await products.publishCanonicalProductTransaction('slug-second', { reviewContent: second.reviewContent }, { approval: true, environment: 'test', idempotencyKey: 'duplicate-slug-test' });
    } catch (error) {
      blockedCode = error instanceof Error ? error.message : String(error);
    }
    equal(blockedCode, 'SAFE_PUBLISH_JOB_REQUIRED');
    const stored = await products.getAllProducts();
    equal(stored.length, 2); assert(stored.some(item => item.id === 'slug-first')); assert(stored.some(item => item.id === 'slug-second'));
  });

  await test('V4-16. canonical JSON corrupt không bị coi là collection rỗng', async () => {
    const corruptDir = path.join(process.cwd(), '.test-tmp', `sandeal-corrupt-${process.pid}-${Date.now()}`); fs.mkdirSync(corruptDir, { recursive: true }); const previous = process.env.SANDEAL_DATA_DIR; process.env.SANDEAL_DATA_DIR = corruptDir;
    fs.writeFileSync(path.join(corruptDir, 'products.json'), '{broken', 'utf8'); let threw = false;
    try { await adapter.readCollection('products'); } catch { threw = true; }
    process.env.SANDEAL_DATA_DIR = previous; assert(threw, 'corrupt JSON must fail closed');
  });

  await test('V4-17. scheduler tick uses an exact Basic Auth exemption and still checks its secret', () => {
    const proxySource = fs.readFileSync(path.join(process.cwd(), 'src/proxy.ts'), 'utf8');
    const tickSource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/ai-bots/scheduler/tick/route.ts'), 'utf8');
    assert(proxySource.includes("pathname === '/api/ai-bots/scheduler/tick'"));
    assert(!proxySource.includes("pathname.startsWith('/api/ai-bots/scheduler')"));
    assert(tickSource.includes('process.env.SCHEDULER_SECRET'));
    assert(tickSource.includes("request.headers.get('x-sandeal-scheduler-secret')"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
