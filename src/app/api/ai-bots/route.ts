// ===========================================
// GET /api/ai-bots
// Returns safe automation capabilities and current in-process workflow status
//
// POST /api/ai-bots
// Triggers ReviewPilot AI bot orchestration workflow
// AutoPilot mode: guarded automation for verified real products only
// ===========================================
// Hard policy:
// - Safe Mode is always ON.
// - Free Only is always ON.
// - Paid AI is always blocked in this route.
// - Voucher/campaign/store_offer/unknown items are never public candidates.
// - Public automation always reuses the central publicProductFilter.
// - Concurrent workflows are blocked in the current PM2/Node process.

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
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
import {
  getPublicProductBlockReason,
  isPublicSafeProduct,
} from '@/lib/publicProductFilter';
import type { BotRunMode, Product } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type BotSource = 'local' | 'accesstrade' | 'manual' | 'all';
type BotTrigger = 'manual' | 'scheduler' | 'system';

interface BotRunRequest {
  mode?: BotRunMode;
  source?: BotSource;
  limit?: number | string;
  trigger?: BotTrigger;

  // These flags are accepted for UI compatibility, but hard safety policy
  // below always wins for safeMode/freeOnly/allowPaidAi/costMode.
  costMode?: string;
  safeMode?: boolean;
  freeOnly?: boolean;
  autoMode?: boolean;
  autoApprove?: boolean;
  autoPublish?: boolean;
  allowPaidAi?: boolean;
}

interface EnforcedRunPolicy {
  safeMode: true;
  freeOnly: true;
  allowPaidAi: false;
  costMode: 'safe_free';
  autoMode: boolean;
  autoApprove: boolean;
  autoPublishEnabled: boolean;
}

type WorkflowStats = {
  candidatesFound: number;
  productsSaved: number;
  contentPackagesGenerated: number;
  linksChecked: number;
  productsArchived: number;
};

type ActiveWorkflowLock = {
  runId: string;
  mode: BotRunMode;
  source: BotSource;
  trigger: BotTrigger;
  startedAt: string;
};

type PublicSafetySummary = {
  total: number;
  publicSafe: number;
  blocked: number;
  topBlockedReasons: Array<{
    reason: string;
    count: number;
  }>;
};

declare global {
  // eslint-disable-next-line no-var
  var __sandealAiBotWorkflowLock: ActiveWorkflowLock | undefined;
}

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
const VALID_TRIGGERS: BotTrigger[] = ['manual', 'scheduler', 'system'];

const DEFAULT_MODE: BotRunMode = 'full_safe_run';
const DEFAULT_SOURCE: BotSource = 'accesstrade';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const WORKFLOW_LOCK_TTL_MS = 2 * 60 * 60 * 1000;

function normalizeLimit(value: unknown): number {
  const parsed =
      typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim()
              ? Number(value)
              : Number.NaN;

  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;

  return Math.min(Math.max(Math.floor(parsed), 1), MAX_LIMIT);
}

function isValidMode(value: unknown): value is BotRunMode {
  return typeof value === 'string' && VALID_MODES.includes(value as BotRunMode);
}

function isValidSource(value: unknown): value is BotSource {
  return typeof value === 'string' && VALID_SOURCES.includes(value as BotSource);
}

function isValidTrigger(value: unknown): value is BotTrigger {
  return typeof value === 'string' && VALID_TRIGGERS.includes(value as BotTrigger);
}

function buildEnforcedPolicy(body: BotRunRequest): EnforcedRunPolicy {
  const autoMode = body.autoMode !== false;
  const autoApprove = autoMode && body.autoApprove !== false;
  const autoPublishEnabled = autoMode && autoApprove && body.autoPublish !== false;

  return {
    safeMode: true,
    freeOnly: true,
    allowPaidAi: false,
    costMode: 'safe_free',
    autoMode,
    autoApprove,
    autoPublishEnabled,
  };
}

async function parseRequestBody(req: NextRequest): Promise<BotRunRequest> {
  const rawBody = await req.text();

  if (!rawBody.trim()) return {};

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error('INVALID_JSON_BODY');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('INVALID_JSON_BODY');
  }

  return parsed as BotRunRequest;
}

function getActiveWorkflowLock(): ActiveWorkflowLock | null {
  const current = globalThis.__sandealAiBotWorkflowLock;

  if (!current) return null;

  const startedAt = Date.parse(current.startedAt);
  const isStale = !Number.isFinite(startedAt) || Date.now() - startedAt > WORKFLOW_LOCK_TTL_MS;

  if (isStale) {
    globalThis.__sandealAiBotWorkflowLock = undefined;
    return null;
  }

  return current;
}

function reserveWorkflowLock(
    mode: BotRunMode,
    source: BotSource,
    trigger: BotTrigger,
): ActiveWorkflowLock {
  const lock: ActiveWorkflowLock = {
    runId: 'pending',
    mode,
    source,
    trigger,
    startedAt: new Date().toISOString(),
  };

  globalThis.__sandealAiBotWorkflowLock = lock;
  return lock;
}

function attachRunIdToWorkflowLock(runId: string): void {
  const current = globalThis.__sandealAiBotWorkflowLock;

  if (!current) return;

  globalThis.__sandealAiBotWorkflowLock = {
    ...current,
    runId,
  };
}

function clearWorkflowLock(runId?: string): void {
  const current = globalThis.__sandealAiBotWorkflowLock;

  if (!current) return;

  if (!runId || current.runId === runId || current.runId === 'pending') {
    globalThis.__sandealAiBotWorkflowLock = undefined;
  }
}

function isValidHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;

  const url = value.trim();
  if (!/^https?:\/\//i.test(url)) return false;

  try {
    const parsed = new URL(url);
    return Boolean(parsed.hostname) && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
}

function shouldUseForPublicAutomation(product: Product): boolean {
  return isPublicSafeProduct(product);
}

function getRunnableProducts(products: Product[], limit: number): Product[] {
  return products
      .filter(shouldUseForPublicAutomation)
      .slice(0, limit);
}

function summarizePublicSafety(products: Product[]): PublicSafetySummary {
  const reasonCounts = new Map<string, number>();
  let publicSafe = 0;

  for (const product of products) {
    const reason = getPublicProductBlockReason(product);

    if (!reason) {
      publicSafe += 1;
      continue;
    }

    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  }

  const topBlockedReasons = [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

  return {
    total: products.length,
    publicSafe,
    blocked: products.length - publicSafe,
    topBlockedReasons,
  };
}

async function generateContentPackagesForProducts(
    runId: string,
    products: Product[],
    limit: number,
): Promise<number> {
  if (!products.length) return 0;

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
  if (!products.length) return 0;

  const checker = await createLinkHealthChecker(runId);
  let checkedCount = 0;

  for (const product of products.slice(0, limit)) {
    const record = product as Product & Record<string, unknown>;
    const recordUrl = typeof record.url === 'string' ? record.url.trim() : '';

    // Affiliate link is preferred because this is the link visitors will open.
    const targetUrl = product.affiliateUrl || product.originalUrl || recordUrl;

    if (!isValidHttpUrl(targetUrl)) {
      await addBotRunLog(runId, 'link_health', 'warn', 'Skipped product without a valid HTTP link', {
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
  if (!products.length) return [];

  const scorer = await createDealScorer(runId);
  const scoredProducts: Product[] = [];

  for (const product of products.slice(0, limit)) {
    try {
      const scoreResult = await scorer.scoreProduct(product);

      if (scoreResult.score >= 50) {
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

export async function GET(req: NextRequest) {
  const authError = await requireAuth(req);
  if (authError) return authError;

  return NextResponse.json(
      {
        success: true,
        ok: true,
        data: {
          activeWorkflow: getActiveWorkflowLock(),
          supportedModes: VALID_MODES,
          supportedSources: VALID_SOURCES,
          defaults: {
            mode: DEFAULT_MODE,
            source: DEFAULT_SOURCE,
            limit: DEFAULT_LIMIT,
          },
          enforcedPolicy: {
            safeMode: true,
            freeOnly: true,
            allowPaidAi: false,
            costMode: 'safe_free',
            safePublish: true,
          },
        },
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      },
  );
}

export async function POST(req: NextRequest) {
  let reserved = false;
  let runId: string | undefined;

  try {
    const authError = await requireAuth(req);
    if (authError) return authError;

    let body: BotRunRequest;

    try {
      body = await parseRequestBody(req);
    } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_JSON_BODY') {
        return NextResponse.json(
            {
              success: false,
              ok: false,
              error: 'Request body must be a valid JSON object.',
            },
            { status: 400 },
        );
      }

      throw error;
    }

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

    if (body.trigger && !isValidTrigger(body.trigger)) {
      return NextResponse.json(
          {
            success: false,
            ok: false,
            error: `Invalid trigger. Must be one of: ${VALID_TRIGGERS.join(', ')}`,
          },
          { status: 400 },
      );
    }

    const activeWorkflow = getActiveWorkflowLock();

    if (activeWorkflow) {
      return NextResponse.json(
          {
            success: false,
            ok: false,
            error: 'Another AI bot workflow is already running.',
            data: {
              activeWorkflow,
            },
          },
          { status: 409 },
      );
    }

    const mode = isValidMode(body.mode) ? body.mode : DEFAULT_MODE;
    const source = isValidSource(body.source) ? body.source : DEFAULT_SOURCE;
    const trigger = isValidTrigger(body.trigger) ? body.trigger : 'manual';
    const limit = normalizeLimit(body.limit);
    const policy = buildEnforcedPolicy(body);

    reserveWorkflowLock(mode, source, trigger);
    reserved = true;

    const run = await createBotRun(mode, source, limit);
    runId = run.id;
    attachRunIdToWorkflowLock(run.id);

    void executeWorkflow(
        run.id,
        mode,
        source,
        limit,
        trigger,
        policy,
        body,
    )
        .catch((error) => {
          console.error('[api/ai-bots] Unhandled workflow error:', error);
        })
        .finally(() => {
          clearWorkflowLock(run.id);
        });

    return NextResponse.json(
        {
          success: true,
          ok: true,
          data: {
            run,
            trigger,
            enforcedPolicy: policy,
          },
          message:
              'Bot workflow started. Safe Mode and Free Only are hard-enforced. Only verified real products can pass Safe Publish.',
        },
        {
          status: 202,
          headers: {
            'Cache-Control': 'no-store, max-age=0',
          },
        },
    );
  } catch (error) {
    if (reserved) {
      clearWorkflowLock(runId);
    }

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
    trigger: BotTrigger,
    policy: EnforcedRunPolicy,
    requestBody: BotRunRequest,
): Promise<void> {
  try {
    await updateBotRun(runId, { status: 'running' });

    const orchestrator = await createOrchestrator(runId);

    const state = await orchestrator.validateState({
      runId,
      mode,
      source,
      limit,
      safeMode: policy.safeMode,
      freeOnly: policy.freeOnly,
      autoMode: policy.autoMode,
      autoApprove: policy.autoApprove,
      allowPaidAi: policy.allowPaidAi,
      costMode: policy.costMode,
      autoPublishEnabled: policy.autoPublishEnabled,
    });

    const preflight = await orchestrator.preflightCheck(state);

    if (!preflight) {
      await addBotRunLog(runId, 'orchestrator', 'error', 'Preflight check failed', {
        trigger,
        enforcedPolicy: policy,
      });

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
      trigger,
      safeMode: policy.safeMode,
      freeOnly: policy.freeOnly,
      autoMode: policy.autoMode,
      autoApprove: policy.autoApprove,
      autoPublishEnabled: policy.autoPublishEnabled,
      allowPaidAi: policy.allowPaidAi,
      costMode: policy.costMode,
      requestedFlags: {
        safeMode: requestBody.safeMode,
        freeOnly: requestBody.freeOnly,
        autoMode: requestBody.autoMode,
        autoApprove: requestBody.autoApprove,
        autoPublish: requestBody.autoPublish,
        allowPaidAi: requestBody.allowPaidAi,
        costMode: requestBody.costMode,
      },
      note:
          'Hard policy wins over request flags. Only verified real products can be auto-published. Voucher/campaign/store_offer/unknown items remain internal or archived.',
    });

    switch (mode) {
      case 'source_scan': {
        const scout = await createSourceScout(runId);
        const { candidates, summary } = await scout.scanSource(source, limit);
        const afterScanProducts = await listProducts();

        stats.candidatesFound = summary.found || candidates.length;
        stats.productsSaved = summary.saved || 0;

        await addBotRunLog(runId, 'source_scout', 'info', 'Source scan finished', {
          candidatesFound: stats.candidatesFound,
          newRecordsSaved: stats.productsSaved,
          publicSafety: summarizePublicSafety(afterScanProducts),
          note:
              'SourceScout may already auto-publish verified real products that passed strict source, price, link and image checks.',
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

        stats.candidatesFound = products.length;
        stats.productsSaved = analyzedCount;
        break;
      }

      case 'content_review': {
        if (!state.hasGeminiToken) {
          await addBotRunLog(
              runId,
              'orchestrator',
              'warn',
              'Gemini token not available - skipping content package generation',
          );
          break;
        }

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
        const { candidates, summary } = await scout.scanSource(source, limit);
        const afterScanProducts = await listProducts();

        stats.candidatesFound = summary.found || candidates.length;
        stats.productsSaved = summary.saved || 0;

        // Step 2: Central filter decides which products are truly public-safe.
        const runnableProducts = getRunnableProducts(afterScanProducts, limit);

        await addBotRunLog(runId, 'orchestrator', 'info', 'Runnable products after scan', {
          candidatesReturned: candidates.length,
          newRecordsSaved: stats.productsSaved,
          runnableProducts: runnableProducts.length,
          publicSafety: summarizePublicSafety(afterScanProducts),
          note:
              'Runnable products must pass the central publicProductFilter, including product kind, source verification, price, affiliate link, image, quality score and link/image health.',
        });

        // Step 3: Score only products that are already public-safe.
        const scoredProducts = await scoreProducts(runId, runnableProducts, limit);

        // Step 4: Re-check visitor-facing links.
        const checkedCount = await checkLinksForProducts(runId, scoredProducts, limit);
        stats.linksChecked = checkedCount;

        // Step 5: Reload after link checks because the checker may archive/unpublish items.
        const afterHealthProducts = await listProducts();
        const scoredIds = new Set(scoredProducts.map((product) => product.id));
        const contentEligibleProducts = getRunnableProducts(afterHealthProducts, limit)
            .filter((product) => scoredIds.has(product.id));

        // Step 6: Generate content only when a Gemini token exists.
        // Paid AI is still blocked by the hard route policy.
        if (state.hasGeminiToken) {
          const packageCount = await generateContentPackagesForProducts(
              runId,
              contentEligibleProducts,
              limit,
          );
          stats.contentPackagesGenerated = packageCount;
        } else {
          await addBotRunLog(
              runId,
              'content_review',
              'warn',
              'Gemini token not available - content generation skipped',
          );
        }

        // Step 7: Cleanup broken/unavailable/unsafe products.
        const cleanup = await createProductCleanup(runId);
        const cleanupResult = await cleanup.cleanupBrokenProducts({
          limit,
          dryRun: false,
        });

        stats.productsArchived = cleanupResult.archived;
        stats.linksChecked += cleanupResult.checked;

        const finalProducts = await listProducts();

        await addBotRunLog(runId, 'orchestrator', 'info', 'Full safe AutoPilot run complete', {
          candidatesFound: stats.candidatesFound,
          newRecordsSaved: stats.productsSaved,
          runnableProductsBeforeHealth: runnableProducts.length,
          scoredProducts: scoredProducts.length,
          contentEligibleProducts: contentEligibleProducts.length,
          linksChecked: stats.linksChecked,
          contentPackagesGenerated: stats.contentPackagesGenerated,
          productsArchived: stats.productsArchived,
          finalPublicSafety: summarizePublicSafety(finalProducts),
          safeMode: policy.safeMode,
          freeOnly: policy.freeOnly,
          allowPaidAi: policy.allowPaidAi,
          costMode: policy.costMode,
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
