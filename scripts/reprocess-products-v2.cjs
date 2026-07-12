/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Reprocess Products V2 — Safe CLI Tool
 *
 * Reprocesses existing products with Health Check V2 and Editorial Review V2.
 * Default: dry-run mode. Must pass --apply to make changes.
 *
 * Usage:
 *   node scripts/reprocess-products-v2.cjs [options]
 *
 * Options:
 *   --apply          Actually write changes (default: dry-run)
 *   --limit N        Max products to process (default: 20)
 *   --concurrency N  Max concurrent operations (default: 3, max: 3)
 *   --data-dir DIR   Data directory (default: SANDEAL_DATA_DIR or .data)
 *
 * Safety:
 *   - Does NOT publish products — Safe Publish must be evaluated separately
 *   - Does NOT modify vouchers, store_offers, or campaigns
 *   - Does NOT call production URLs during unit tests
 *   - Creates backup before any writes
 *   - Atomic write with temp file
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const ts = require('typescript');

// ---- TypeScript loader ----
require.extensions['.ts'] = function transpile(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, parent, isMain, options) {
  if (request.startsWith('@/')) request = path.join(process.cwd(), 'src', request.slice(2));
  return originalResolve.call(this, request, parent, isMain, options);
};

// ---- Parse args ----
const args = process.argv.slice(2);
const isApply = args.includes('--apply');
const limitArg = args.find((_, i) => args[i - 1] === '--limit');
const concurrencyArg = args.find((_, i) => args[i - 1] === '--concurrency');
const dataDirArg = args.find((_, i) => args[i - 1] === '--data-dir');
const limit = Math.max(1, Math.min(200, parseInt(limitArg || '20', 10) || 20));
const concurrency = Math.max(1, Math.min(3, parseInt(concurrencyArg || '3', 10) || 3));

// ---- Setup data dir ----
if (dataDirArg) {
  process.env.SANDEAL_DATA_DIR = dataDirArg;
} else if (!process.env.SANDEAL_DATA_DIR) {
  process.env.SANDEAL_DATA_DIR = path.join(process.cwd(), '.data');
}

// ---- Main ----
(async () => {
  const { generateEditorialReview, shouldRegenerateReview, isReviewIndexable, REVIEW_THRESHOLDS } = require('../src/lib/editorialReview.ts');
  const { evaluateSafePublish } = require('../src/lib/safePublish.ts');
  const { getAllProducts, saveCanonicalProduct } = require('../src/lib/storage/products.ts');

  console.log('=== Reprocess Products V2 ===');
  console.log(`Mode: ${isApply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Limit: ${limit}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Data dir: ${process.env.SANDEAL_DATA_DIR}`);
  console.log('');

  // Load all products
  const allProducts = await getAllProducts();

  // Filter: only process valid products (not vouchers, campaigns, store_offers)
  const validProducts = allProducts.filter((p) =>
    p.kind === 'product' || p.kind === 'deal'
  );

  console.log(`Total products in storage: ${allProducts.length}`);
  console.log(`Valid products (product/deal): ${validProducts.length}`);
  console.log(`Skipped (voucher/store_offer/campaign): ${allProducts.length - validProducts.length}`);
  console.log('');

  // ---- Before stats ----
  const beforeStats = computeStats(validProducts);
  console.log('--- BEFORE ---');
  printStats(beforeStats);
  console.log('');

  // ---- Process ----
  const toProcess = validProducts.slice(0, limit);
  const results = { processed: 0, regenerated: 0, unchanged: 0, errors: 0 };

  // Backup before apply
  if (isApply) {
    const backupDir = path.join(process.env.SANDEAL_DATA_DIR, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const productsFile = path.join(process.env.SANDEAL_DATA_DIR, 'products.json');
    if (fs.existsSync(productsFile)) {
      const backupFile = path.join(backupDir, `products-backup-${Date.now()}.json`);
      fs.copyFileSync(productsFile, backupFile);
      console.log(`Backup created: ${backupFile}`);
    }
  }

  // Process with concurrency limit
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, toProcess.length) }, async () => {
    while (cursor < toProcess.length) {
      const product = toProcess[cursor++];
      try {
        results.processed++;

        if (shouldRegenerateReview(product)) {
          const otherProducts = allProducts.filter((p) => p.id !== product.id);
          const review = generateEditorialReview(product, otherProducts);

          if (isApply) {
            // Atomic write via saveCanonicalProduct
            await saveCanonicalProduct(product.id, { reviewContent: review }, { evaluate: true });
          }

          results.regenerated++;
          console.log(`${isApply ? '✓' : '○'} [${results.processed}/${toProcess.length}] ${product.title?.slice(0, 50)} → ${review.reviewStatus} (v${review.reviewVersion}, orig=${review.originalityScore}, seo=${review.seoReadinessScore})`);
        } else {
          results.unchanged++;
        }
      } catch (error) {
        results.errors++;
        console.error(`✗ [${results.processed}/${toProcess.length}] ${product.title?.slice(0, 50)} → Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }));

  console.log('');
  console.log('--- PROCESSING RESULTS ---');
  console.log(`Processed: ${results.processed}`);
  console.log(`Regenerated: ${results.regenerated}`);
  console.log(`Unchanged: ${results.unchanged}`);
  console.log(`Errors: ${results.errors}`);
  console.log('');

  // ---- After stats ----
  if (isApply) {
    const updatedProducts = await getAllProducts();
    const updatedValid = updatedProducts.filter((p) => p.kind === 'product' || p.kind === 'deal');
    const afterStats = computeStats(updatedValid);
    console.log('--- AFTER ---');
    printStats(afterStats);
    console.log('');

    // ---- Delta ----
    console.log('--- DELTA ---');
    for (const key of Object.keys(beforeStats)) {
      const before = beforeStats[key];
      const after = afterStats[key];
      if (before !== after) {
        const delta = after - before;
        console.log(`  ${key}: ${before} → ${after} (${delta >= 0 ? '+' : ''}${delta})`);
      }
    }
  } else {
    console.log('DRY-RUN complete. Use --apply to write changes.');
  }

  console.log('');
  console.log('=== Done ===');
})();

function computeStats(products) {
  const stats = {
    total: products.length,
    health_ok: 0,
    health_retryable: 0,
    health_broken: 0,
    review_approved: 0,
    review_needs_review: 0,
    low_originality: 0,
    low_seo_readiness: 0,
    public_eligible: 0,
  };

  const retryableStatuses = new Set(['timeout', 'rate_limited', 'server_error', 'dns_error', 'not_allowed', 'forbidden', 'error', 'unknown']);
  const brokenStatuses = new Set(['broken', 'image_broken', 'not_found', 'product_unavailable']);

  for (const p of products) {
    const statuses = [p.linkHealthStatus, p.affiliateHealthStatus, p.imageHealthStatus].filter(Boolean);
    const hasBroken = statuses.some((s) => brokenStatuses.has(s));
    const hasRetryable = statuses.some((s) => retryableStatuses.has(s));
    const allOk = statuses.every((s) => s === 'ok' || s === 'redirect_ok');

    if (allOk || statuses.length === 0) stats.health_ok++;
    else if (hasBroken) stats.health_broken++;
    else if (hasRetryable) stats.health_retryable++;

    const review = p.reviewContent;
    if (review) {
      if (review.reviewStatus === 'approved') stats.review_approved++;
      else stats.review_needs_review++;
      if (review.originalityScore < 70) stats.low_originality++;
      if (review.seoReadinessScore < 80) stats.low_seo_readiness++;
    }

    try {
      const { evaluateSafePublish } = require('../src/lib/safePublish.ts');
      if (evaluateSafePublish(p).eligible) stats.public_eligible++;
    } catch { /* ignore */ }
  }

  return stats;
}

function printStats(stats) {
  for (const [key, value] of Object.entries(stats)) {
    console.log(`  ${key}: ${value}`);
  }
}
