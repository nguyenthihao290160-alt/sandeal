// ===========================================
// POST /api/ai-bots/run
// Triggers bot orchestration workflow
// ===========================================

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { config } from '@/lib/config';
import {
  createBotRun,
  getBotRunById,
  updateBotRun,
  addBotRunLog,
} from '@/lib/storage/botRuns';
import { listProducts, createProduct } from '@/lib/storage/products';
import { createOrchestrator } from '@/lib/bots/orchestrator';
import { createSourceScout } from '@/lib/bots/sourceScout';
import { createDealScorer } from '@/lib/bots/dealScorer';
import { createLinkHealthChecker } from '@/lib/bots/linkHealth';
import { createProductNormalizer } from '@/lib/bots/productNormalizer';
import { createGeminiAnalyst } from '@/lib/bots/geminiAnalyst';
import { createContentReview } from '@/lib/bots/contentReview';
import { createProductCleanup } from '@/lib/bots/productCleanup';
import { createContentPackage } from '@/lib/storage/contentPackages';
import type { BotRunMode, Product } from '@/lib/types';

interface BotRunRequest {
  mode: BotRunMode;
  source: 'local' | 'accesstrade' | 'manual' | 'all';
  limit?: number;
}

export async function POST(req: NextRequest) {
  try {
    // Check auth
    const authError = await requireAuth(req);
    if (authError) return authError;

    const body = await req.json() as BotRunRequest;

    // Validate input
    const modes: BotRunMode[] = ['source_scan', 'deal_hunt', 'gemini_analysis', 'content_review', 'link_health', 'cleanup', 'score_only', 'full_safe_run'];
    if (!modes.includes(body.mode)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid mode. Must be one of: ${modes.join(', ')}`,
        },
        { status: 400 }
      );
    }

    const sources = ['local', 'accesstrade', 'manual', 'all'];
    if (!sources.includes(body.source)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid source. Must be one of: ${sources.join(', ')}`,
        },
        { status: 400 }
      );
    }

    const limit = Math.min(body.limit || 10, 50);

    // Create bot run record
    const run = await createBotRun(body.mode, body.source, limit);

    // Start workflow asynchronously
    executeWorkflow(run.id, body.mode, body.source, limit).catch(err => {
      console.error('[ai-bots/run] Workflow error:', err);
    });

    return NextResponse.json({
      success: true,
      data: run,
      message: 'Bot workflow started. Check status with run ID.',
    });
  } catch (error) {
    console.error('[ai-bots/run] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

async function executeWorkflow(
  runId: string,
  mode: BotRunMode,
  source: 'local' | 'accesstrade' | 'manual' | 'all',
  limit: number
): Promise<void> {
  try {
    // Update run status to running
    await updateBotRun(runId, { status: 'running' });

    // Create orchestrator
    const orchestrator = await createOrchestrator(runId);

    // Validate state
    const state = await orchestrator.validateState({
      runId,
      mode,
      source,
      limit,
      allowPaidAi: config.allowPaidAi,
      costMode: config.costMode,
      autoPublishEnabled: config.autoPublishEnabled,
    } as any);

    // Check preflight
    const preflight = await orchestrator.preflightCheck(state);
    if (!preflight) {
      await updateBotRun(runId, {
        status: 'failed',
        errorCount: 1,
      });
      return;
    }

    // Start workflow
    await orchestrator.startWorkflow(state);

    let stats = {
      candidatesFound: 0,
      productsSaved: 0,
      contentPackagesGenerated: 0,
      linksChecked: 0,
      productsArchived: 0,
    };

    // Execute workflow based on mode
    switch (mode) {
      case 'source_scan': {
        const scout = await createSourceScout(runId);
        const candidates = await scout.scanSource(source, limit);
        stats.candidatesFound = candidates.length;
        break;
      }

      case 'deal_hunt': {
        const scorer = await createDealScorer(runId);
        const products = await listProducts();
        let savedCount = 0;

        for (const product of products.slice(0, limit)) {
          const scoreResult = await scorer.scoreProduct(product);
          
          // Save score to product
          if (scoreResult.score > 50) {
            // High quality product - update with score
            await updateBotRun(runId, {
              productsSaved: ++savedCount,
            });
          }
        }
        stats.productsSaved = savedCount;
        break;
      }

      case 'gemini_analysis': {
        if (!state.hasGeminiToken) {
          await addBotRunLog(runId, 'orchestrator', 'warn', 'Gemini token not available - skipping analysis');
          break;
        }

        const analyst = await createGeminiAnalyst(runId);
        const products = await listProducts({ status: 'draft' });

        for (const product of products.slice(0, limit)) {
          const analysis = await analyst.analyzeProduct(product);
          // Analysis is merged into product
        }
        break;
      }

      case 'content_review': {
        const contentReview = await createContentReview(runId);
        const products = await listProducts({ status: 'approved' });
        let packageCount = 0;

        for (const product of products.slice(0, limit)) {
          const content = await contentReview.generateContent(product);
          
          // Save content package
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
          packageCount++;
        }
        stats.contentPackagesGenerated = packageCount;
        break;
      }

      case 'link_health': {
        const checker = await createLinkHealthChecker(runId);
        const products = await listProducts();
        let checkedCount = 0;

        for (const product of products.slice(0, limit)) {
          if (product.originalUrl) {
            await checker.checkProductLink(
              product.id,
              product.originalUrl,
              product.affiliateUrl,
              product.imageUrl
            );
            checkedCount++;
          }
        }
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
        const scorer = await createDealScorer(runId);
        const products = await listProducts();

        for (const product of products.slice(0, limit)) {
          const scoreResult = await scorer.scoreProduct(product);
          // Score is logged but not saved
        }
        break;
      }

      case 'full_safe_run': {
        // Run all steps in safe mode
        const scout = await createSourceScout(runId);
        const normalizer = await createProductNormalizer(runId);
        const scorer = await createDealScorer(runId);
        const checker = await createLinkHealthChecker(runId);
        const contentReview = await createContentReview(runId);

        // Step 1: Scan sources
        const candidates = await scout.scanSource(source, limit);
        stats.candidatesFound = candidates.length;

        // Step 2: Score candidates
        const scoredProducts = [];
        for (const candidate of candidates) {
          const scoreResult = await scorer.scoreProduct(candidate);
          if (scoreResult.score > 50) {
            scoredProducts.push(candidate);
          }
        }

        // Step 3: Check link health
        let checkedCount = 0;
        for (const product of scoredProducts) {
          if (product.originalUrl) {
            await checker.checkProductLink(
              product.id,
              product.originalUrl,
              product.affiliateUrl,
              product.imageUrl
            );
            checkedCount++;
          }
        }
        stats.linksChecked = checkedCount;

        // Step 4: Generate content for approved products
        let packageCount = 0;
        for (const product of scoredProducts) {
          if (product.status === 'approved') {
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
            packageCount++;
          }
        }
        stats.contentPackagesGenerated = packageCount;
        stats.productsSaved = scoredProducts.length;
        break;
      }

      default: {
        await addBotRunLog(runId, 'orchestrator', 'warn', `Unknown mode: ${mode}`);
      }
    }

    // Complete workflow with stats
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
      error instanceof Error ? error.message : 'Unknown error'
    );
  }
}
