// ===========================================
// POST /api/ai-bots
// Triggers ReviewPilot AI bot orchestration workflow
// AutoPilot mode: safe automation for verified real products only
// ===========================================

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { config } from '@/lib/config';
import {
  createBotRun,
  updateBotRun,
  addBotRunLog,
} from '@/lib/storage/botRuns';
import { listProducts } from '@/lib/storage/products';
import { createOrchestrator } from '@/lib/bots/orchestrator';
import { createSourceScout } from '@/lib/bots/sourceScout';
import { createDealScorer } from '@/lib/bots/dealScorer';
import { createLinkHealthChecker } from '@/lib/bots/linkHealth';
import { createGeminiAnalyst } from '@/lib/bots/geminiAnalyst';
import { createContentReview } from '@/lib/bots/contentReview';
import { createProductCleanup } from '@/lib/bots/productCleanup';
import { createContentPackage } from '@/lib/storage/contentPackages';
import type { BotRunMode, Product } from '@/lib/types';

type BotSource = 'local' | 'accesstrade' | 'manual' | 'all';

interface BotRunRequest {
  mode?: BotRunMode;
  source?: BotSource;
  limit?: number;
  costMode?: string;
  safeMode?: boolean;
  freeOnly?: boolean;
  autoMode?: boolean;
  autoApprove?: boolean;
  autoPublish?: boolean;
  allowPaidAi?: boolean;
}

type WorkflowStats = {
  candidatesFound: number;
  productsSaved: number;
  contentPackagesGenerated: number;
  linksChecked: number;
  productsArchived: number;
};

const VALID_MODES: BotRunMode[] = [
  'source_scan',
  'deal_hunt',
  'gemini_analysis',
  'content_review',
  'link_health',
  'cleanup',
  'score_only',
  'full_safe_run',
];

const VALID_SOURCES: BotSource[] = ['local', 'accesstrade', 'manual', 'all'];

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function normalizeLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;

  return Math.min(Math.max(Math.floor(value), 1), MAX_LIMIT);
}

function isValidMode(value: unknown): value is BotRunMode {
  return typeof value === 'string' && VALID_MODES.includes(value as BotRunMode);
}

function isValidSource(value: unknown): value is BotSource {
  return typeof value === 'string' && VALID_SOURCES.includes(value as BotSource);
}

function getProductKind(product: Product): string {
  const record = product as Product & Record<string, unknown>;
  const kind = record.sourceItemKind || record.kind;

  return typeof kind === 'string' ? kind : '';
}

function isRealProductLike(product: Product): boolean {
  const kind = getProductKind(product);

  return kind === 'product' || kind === 'deal';
}

function isPublishedOrApproved(product: Product): boolean {
  return product.status === 'published' || product.status === 'approved';
}

function shouldUseForPublicAutomation(product: Product): boolean {
  const record = product as Product & Record<string, unknown>;

  if (!isRealProductLike(product)) return false;
  if (!isPublishedOrApproved(product)) return false;

  if (record.publicHidden === true) return false;
  if (record.needsVerification === true) return false;

  const hasTitle = Boolean(product.title);
  const hasImage = Boolean(product.imageUrl);
  
  const recordUrl = typeof record.url === 'string' ? record.url.trim() : '';
  const hasUrl = Boolean(product.affiliateUrl || product.originalUrl || recordUrl);
  
  const hasPrice = Boolean(product.price || product.salePrice);

  return hasTitle && hasImage && hasUrl && hasPrice;
}

function getRunnableProducts(products: Product[], limit: number): Product[] {
  return products
      .filter(shouldUseForPublicAutomation)
      .slice(0, limit);
}

async function generateContentPackagesForProducts(
    runId: string,
    products: Product[],
    limit: number,
): Promise<number> {
  const contentReview = await createContentReview(runId);
  let packageCount = 0;

  for (const product of products.slice(0, limit)) {
    try {
      const content = await contentReview.generateContent(product);

      await createContentPackage(product.id, {
        productId: product.id,
        websiteTitle: content.websiteTitle,
        websiteReview: content.websiteReview,
        bulletPoints: content.bulletPoints,
        shortCaption: content.shortCaption,
        socialCaption: content.socialCaption,
        hashtags: content.hashtags,
        cta: content.cta,
        contentAngle: content.contentAngle,
        affiliateNote: content.affiliateNote,
        imageUrl: content.imageUrl,
        productUrl: content.productUrl,
        affiliateUrl: content.affiliateUrl,
        complianceStatus: content.complianceStatus,
        complianceIssues: content.complianceIssues,
      });

      packageCount += 1;
    } catch (error) {
      await addBotRunLog(runId, 'content_review', 'error', 'Content package generation failed', {
        productId: product.id,
        title: product.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return packageCount;
}

async function checkLinksForProducts(
    runId: string,
    products: Product[],
    limit: number,
): Promise<number> {
  const checker = await createLinkHealthChecker(runId);
  let checkedCount = 0;

  for (const product of products.slice(0, limit)) {
    const record = product as Product & Record<string, unknown>;
    const recordUrl = typeof record.url === 'string' ? record.url : '';
    
    const targetUrl = product.originalUrl || product.affiliateUrl || recordUrl;

    if (!targetUrl) {
      await addBotRunLog(runId, 'link_health', 'warn', 'Skipped product without link', {
        productId: product.id,
        title: product.title,
      });
      continue;
    }

    try {
      await checker.checkProductLink(
          product.id,
          targetUrl,
          product.affiliateUrl,
          product.imageUrl,
      );

      checkedCount += 1;
    } catch (error) {
      await addBotRunLog(runId, 'link_health', 'error', 'Link health check failed', {
        productId: product.id,
        title: product.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return checkedCount;
}

async function scoreProducts(
    runId: string,
    products: Product[],
    limit: number,
): Promise<Product[]> {
  const scorer = await createDealScorer(runId);
  const scoredProducts: Product[] = [];

  for (const product of products.slice(0, limit)) {
    try {
      const scoreResult = await scorer.scoreProduct(product);

      if (scoreResult.score > 50) {
        scoredProducts.push(product);
      }
    } catch (error) {
      await addBotRunLog(runId, 'deal_scorer', 'error', 'Product scoring failed', {
        productId: product.id,
        title: product.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return scoredProducts;
}

export async function POST(req: NextRequest) {
  try {
    const authError = await requireAuth(req);
    if (authError) return authError;

    const body = (await req.json()) as BotRunRequest;

    const mode = isValidMode(body.mode) ? body.mode : 'full_safe_run';
    const source = isValidSource(body.source) ? body.source : 'all';
    const limit = normalizeLimit(body.limit);

    if (body.mode && !isValidMode(body.mode)) {
      return NextResponse.json(
          {
            success: false,
            ok: false,
            error: `Invalid mode. Must be one of: ${VALID_MODES.join(', ')}`,
          },
          { status: 400 },
      );
    }

    if (body.source && !isValidSource(body.source)) {
      return NextResponse.json(
          {
            success: false,
            ok: false,
            error: `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}`,
          },
          { status: 400 },
      );
    }

    const run = await createBotRun(mode, source, limit);

    executeWorkflow(run.id, mode, source, limit, body).catch((err) => {
      console.error('[api/ai-bots] Workflow error:', err);
    });

    return NextResponse.json({
      success: true,
      ok: true,
      data: run,
      message:
          'Bot workflow started. AutoPilot safe mode is enabled for verified real products only.',
    });
  } catch (error) {
    console.error('[api/ai-bots] Error:', error);

    return NextResponse.json(
        {
          success: false,
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        { status: 500 },
    );
  }
}

async function executeWorkflow(
    runId: string,
    mode: BotRunMode,
    source: BotSource,
    limit: number,
    requestBody: BotRunRequest,
): Promise<void> {
  try {
    await updateBotRun(runId, { status: 'running' });

    const orchestrator = await createOrchestrator(runId);

    const safeMode = requestBody.safeMode !== false;
    const freeOnly = requestBody.freeOnly !== false;
    const autoMode = requestBody.autoMode !== false;
    const autoApprove = requestBody.autoApprove !== false;

    // New project principle:
    // Safe AutoPilot publish is enabled by default.
    // SourceScout/public filters still block voucher/campaign/store_offer/unknown/broken/unsafe items.
    const autoPublishEnabled = autoMode;

    const allowPaidAi =
        requestBody.allowPaidAi === true &&
        config.allowPaidAi === true &&
        freeOnly === false;

    const state = await orchestrator.validateState({
      runId,
      mode,
      source,
      limit,
      safeMode,
      freeOnly,
      autoMode,
      autoApprove,
      allowPaidAi,
      costMode: requestBody.costMode || config.costMode || 'safe_free',
      autoPublishEnabled,
    } as any);

    const preflight = await orchestrator.preflightCheck(state);

    if (!preflight) {
      await addBotRunLog(runId, 'orchestrator', 'error', 'Preflight check failed');
      await updateBotRun(runId, {
        status: 'failed',
        errorCount: 1,
      });
      return;
    }

    await orchestrator.startWorkflow(state);

    const stats: WorkflowStats = {
      candidatesFound: 0,
      productsSaved: 0,
      contentPackagesGenerated: 0,
      linksChecked: 0,
      productsArchived: 0,
    };

    await addBotRunLog(runId, 'orchestrator', 'info', 'AutoPilot workflow started', {
      mode,
      source,
      limit,
      safeMode,
      freeOnly,
      autoMode,
      autoApprove,
      autoPublishEnabled,
      allowPaidAi,
      note:
          'Only verified real products can be auto-published. Voucher/campaign/store_offer/unknown items remain internal or archived.',
    });

    switch (mode) {
      case 'source_scan': {
        const scout = await createSourceScout(runId);
        const candidates = await scout.scanSource(source, limit);

        stats.candidatesFound = candidates.length;
        stats.productsSaved = candidates.length;

        await addBotRunLog(runId, 'source_scout', 'info', 'Source scan finished', {
          candidatesFound: candidates.length,
          note:
              'Products may already be auto-published by SourceScout if they passed strict checks.',
        });

        break;
      }

      case 'deal_hunt': {
        const products = await listProducts();
        const runnableProducts = getRunnableProducts(products, limit);
        const scoredProducts = await scoreProducts(runId, runnableProducts, limit);

        stats.candidatesFound = runnableProducts.length;
        stats.productsSaved = scoredProducts.length;

        break;
      }

      case 'gemini_analysis': {
        if (!state.hasGeminiToken) {
          await addBotRunLog(
              runId,
              'orchestrator',
              'warn',
              'Gemini token not available - skipping analysis',
          );
          break;
        }

        const analyst = await createGeminiAnalyst(runId);
        const products = getRunnableProducts(await listProducts(), limit);
        let analyzedCount = 0;

        for (const product of products) {
          try {
            await analyst.analyzeProduct(product);
            analyzedCount += 1;
          } catch (error) {
            await addBotRunLog(runId, 'gemini_analyst', 'error', 'Gemini analysis failed', {
              productId: product.id,
              title: product.title,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        stats.productsSaved = analyzedCount;
        break;
      }

      case 'content_review': {
        const products = getRunnableProducts(await listProducts(), limit);
        const packageCount = await generateContentPackagesForProducts(runId, products, limit);

        stats.candidatesFound = products.length;
        stats.contentPackagesGenerated = packageCount;

        break;
      }

      case 'link_health': {
        const products = getRunnableProducts(await listProducts(), limit);
        const checkedCount = await checkLinksForProducts(runId, products, limit);

        stats.candidatesFound = products.length;
        stats.linksChecked = checkedCount;

        break;
      }

      case 'cleanup': {
        const cleanup = await createProductCleanup(runId);
        const result = await cleanup.cleanupBrokenProducts({
          limit,
          dryRun: false,
        });

        stats.productsArchived = result.archived;
        stats.linksChecked = result.checked;

        break;
      }

      case 'score_only': {
        const products = getRunnableProducts(await listProducts(), limit);
        const scoredProducts = await scoreProducts(runId, products, limit);

        stats.candidatesFound = products.length;
        stats.productsSaved = scoredProducts.length;

        break;
      }

      case 'full_safe_run': {
        const scout = await createSourceScout(runId);

        // Step 1: Scan sources.
        // SourceScout may safely auto-publish verified real products immediately.
        const candidates = await scout.scanSource(source, limit);
        stats.candidatesFound = candidates.length;
        stats.productsSaved = candidates.length;

        // Step 2: Reload products after SourceScout saves/auto-publishes them.
        const afterScanProducts = await listProducts();
        const runnableProducts = getRunnableProducts(afterScanProducts, limit);

        await addBotRunLog(runId, 'orchestrator', 'info', 'Runnable products after scan', {
          runnableProducts: runnableProducts.length,
          note:
              'Runnable products are published/approved, real product-like, not publicHidden, and have title/image/link/price.',
        });

        // Step 3: Score only runnable public-safe products.
        const scoredProducts = await scoreProducts(runId, runnableProducts, limit);

        // Step 4: Check link health.
        const checkedCount = await checkLinksForProducts(runId, scoredProducts, limit);
        stats.linksChecked = checkedCount;

        // Step 5: Generate content package for safe products.
        // This does not fake personal experience and should keep affiliate disclosure.
        const packageCount = await generateContentPackagesForProducts(
            runId,
            scoredProducts,
            limit,
        );
        stats.contentPackagesGenerated = packageCount;

        // Step 6: Cleanup broken/unsafe products.
        const cleanup = await createProductCleanup(runId);
        const cleanupResult = await cleanup.cleanupBrokenProducts({
          limit,
          dryRun: false,
        });

        stats.productsArchived = cleanupResult.archived;
        stats.linksChecked += cleanupResult.checked;

        await addBotRunLog(runId, 'orchestrator', 'info', 'Full safe AutoPilot run complete', {
          candidatesFound: stats.candidatesFound,
          runnableProducts: runnableProducts.length,
          scoredProducts: scoredProducts.length,
          linksChecked: stats.linksChecked,
          contentPackagesGenerated: stats.contentPackagesGenerated,
          productsArchived: stats.productsArchived,
        });

        break;
      }

      default: {
        await addBotRunLog(runId, 'orchestrator', 'warn', `Unknown mode: ${mode}`);
      }
    }

    await orchestrator.completeWorkflow(state);

    await updateBotRun(runId, {
      status: 'completed',
      ...stats,
    });
  } catch (error) {
    console.error(`[executeWorkflow] Error for run ${runId}:`, error);

    await updateBotRun(runId, {
      status: 'failed',
      errorCount: 1,
    });

    await addBotRunLog(
        runId,
        'orchestrator',
        'error',
        error instanceof Error ? error.message : 'Unknown error',
    );
  }
}