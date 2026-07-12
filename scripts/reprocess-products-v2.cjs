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
const laneArg = args.find((_, i) => args[i - 1] === '--lane');
const limit = Math.max(1, Math.min(200, parseInt(limitArg || '20', 10) || 20));
const concurrency = Math.max(1, Math.min(3, parseInt(concurrencyArg || '3', 10) || 3));

// ---- Setup data dir ----
if (dataDirArg) {
  process.env.SANDEAL_DATA_DIR = path.resolve(dataDirArg);
} else if (!process.env.SANDEAL_DATA_DIR) {
  process.env.SANDEAL_DATA_DIR = path.join(process.cwd(), '.data');
}
assertSafeDataDir(process.env.SANDEAL_DATA_DIR, isApply);

// ---- Main ----
(async () => {
  const { generateEditorialReview, shouldRegenerateReview } = require('../src/lib/editorialReview.ts');
  const { getAllProducts, saveCanonicalProduct } = require('../src/lib/storage/products.ts');
  const { scoreCandidateReadiness } = require('../src/lib/bots/candidateReadiness.ts');
  const { getGeminiPoolState } = require('../src/lib/ai/geminiQuotaGroupManager.ts');

  console.log('=== Reprocess Products V2 ===');
  console.log(`Mode: ${isApply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Limit: ${limit}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Data dir: ${process.env.SANDEAL_DATA_DIR}`);
  console.log(`Lane: ${laneArg || 'all'}`);
  console.log('');

  // Load all products
  const allProducts = await getAllProducts();

  // Filter: only process valid products (not vouchers, campaigns, store_offers)
  let validProducts = allProducts.filter((p) =>
    p.kind === 'product' || p.kind === 'deal'
  );
  if (laneArg) validProducts = validProducts.filter((product) => laneForProduct(product, scoreCandidateReadiness) === laneArg.toUpperCase());

  console.log(`Total products in storage: ${allProducts.length}`);
  console.log(`Valid products (product/deal): ${validProducts.length}`);
  console.log(`Skipped (voucher/store_offer/campaign): ${allProducts.length - validProducts.length}`);
  console.log('');

  // ---- Before stats ----
  const pool = await getGeminiPoolState();
  const beforeStats = computeStats(allProducts, validProducts, pool);
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
      const source = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
      const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
      if (!Array.isArray(source) || !Array.isArray(backup) || source.length !== backup.length) throw new Error('Backup validation failed.');
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
    const afterStats = computeStats(updatedProducts, updatedValid, await getGeminiPoolState());
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

function computeStats(allProducts, products, pool) {
  const stats = {
    totalRecords: allProducts.length, realProducts: products.length,
    invalidTypes: allProducts.length - products.length, duplicates: 0,
    fastLane: 0, normalLane: 0, retryLane: 0, humanReviewLane: 0, rejectedLane: 0,
    healthOk: 0, healthRetryable: 0, confirmedBroken: 0,
    reviewV1: 0, reviewV2: 0, reviewApproved: 0, reviewNeedsReview: 0,
    lowOriginality: 0, lowSeoReadiness: 0, claimBlocked: 0, safePublishEligible: 0,
    estimatedWaves: 0, topBlockReasons: {}, GeminiPoolState: pool.state,
    GeminiAvailableGroups: Object.values(pool.groups || {}).filter((group) => !group.cooldownUntil || Date.parse(group.cooldownUntil) <= Date.now()).length,
    localFallbackCount: 0,
  };

  const retryableStatuses = new Set(['timeout', 'rate_limited', 'server_error', 'dns_error', 'not_allowed', 'forbidden', 'error', 'unknown']);
  const brokenStatuses = new Set(['broken', 'image_broken', 'not_found', 'product_unavailable']);

  for (const p of products) {
    const statuses = [p.linkHealthStatus, p.affiliateHealthStatus, p.imageHealthStatus].filter(Boolean);
    const hasBroken = statuses.some((s) => brokenStatuses.has(s));
    const hasRetryable = statuses.some((s) => retryableStatuses.has(s));
    const allOk = statuses.every((s) => s === 'ok' || s === 'redirect_ok');

    if (allOk || statuses.length === 0) stats.healthOk++;
    else if (hasBroken) stats.confirmedBroken++;
    else if (hasRetryable) stats.healthRetryable++;

    const lane = p.riskLevel === 'high' ? 'humanReviewLane' : hasBroken ? 'rejectedLane' : hasRetryable ? 'retryLane' : p.verifiedSource && p.autoPublishEligible ? 'fastLane' : 'normalLane';
    stats[lane]++;

    const review = p.reviewContent;
    if (review) {
      if (review.reviewVersion >= 2) stats.reviewV2++; else stats.reviewV1++;
      if (review.reviewStatus === 'approved') stats.reviewApproved++;
      else stats.reviewNeedsReview++;
      if (review.originalityScore < 70) stats.lowOriginality++;
      if (review.seoReadinessScore < 80) stats.lowSeoReadiness++;
      if ((review.reviewBlockReasons || []).some((reason) => String(reason).includes('claim'))) stats.claimBlocked++;
      if (!review.provider || review.provider === 'local') stats.localFallbackCount++;
    }

    try {
      const { evaluateSafePublish } = require('../src/lib/safePublish.ts');
      if (evaluateSafePublish(p).eligible) stats.safePublishEligible++;
    } catch { /* ignore */ }
  }

  const seen = new Set(); for (const product of products) { const key = product.sourceId || product.externalId || product.originalUrl || product.affiliateUrl; if (key && seen.has(key)) stats.duplicates++; else if (key) seen.add(key); for (const reason of product.publicBlockReasons || String(product.publicBlockReason || '').split(',')) { const clean = String(reason).trim(); if (clean) stats.topBlockReasons[clean] = (stats.topBlockReasons[clean] || 0) + 1; } }
  stats.estimatedWaves = Math.ceil(stats.safePublishEligible / 25);
  stats.topBlockReasons = Object.fromEntries(Object.entries(stats.topBlockReasons).sort((a, b) => b[1] - a[1]).slice(0, 10));

  return stats;
}

function laneForProduct(product, scoreCandidateReadiness) {
  const statuses = [product.linkHealthStatus, product.affiliateHealthStatus, product.imageHealthStatus];
  if (product.riskLevel === 'high') return 'HUMAN_REVIEW_LANE';
  if (statuses.some((status) => ['broken', 'image_broken', 'not_found'].includes(status))) return 'REJECTED_LANE';
  if (statuses.some((status) => ['timeout', 'rate_limited', 'server_error', 'dns_error', 'not_allowed'].includes(status))) return 'RETRY_LANE';
  return scoreCandidateReadiness({ title: product.title || '', description: product.description, kind: product.kind, platform: product.platform, originalUrl: product.originalUrl || '', affiliateUrl: product.affiliateUrl || '', imageUrl: product.imageUrl || '', price: product.price, salePrice: product.salePrice, currency: 'VND', category: product.category, verifiedSource: product.verifiedSource === true, autoPublishEligible: product.autoPublishEligible === true }).lane;
}

function assertSafeDataDir(value, apply) {
  const resolved = path.resolve(value); const root = path.parse(resolved).root; const cwd = path.resolve(process.cwd());
  if (resolved === root || resolved === cwd || resolved.includes(`${path.sep}.git${path.sep}`) || resolved.includes(`${path.sep}node_modules${path.sep}`) || ['src', 'scripts'].includes(path.basename(resolved).toLowerCase())) throw new Error(`Unsafe data directory: ${resolved}`);
  if (apply && !fs.existsSync(path.join(resolved, 'products.json'))) throw new Error('Apply requires an existing products.json file.');
}

function printStats(stats) {
  for (const [key, value] of Object.entries(stats)) {
    console.log(`  ${key}: ${value && typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
}
