// ===========================================
// AutoPilot Runner — Central execution entry point
// Wraps all bot modes with lock, logging, and error handling
// ===========================================

import { acquireRunLock, releaseRunLock } from './runLock';
import { createRunLog, updateRunLog, type RunSummary } from './runLogs';
import { runProductHealthCleanup } from './productHealth';

// Re-export for convenience
export type { RunSummary } from './runLogs';

export type AutoPilotMode =
  | 'full_safe_run'
  | 'source_scan'
  | 'health_check'
  | 'cleanup_broken_products';

export type AutoPilotTrigger = 'manual' | 'dashboard' | 'scheduler' | 'api';

export interface AutoPilotOptions {
  mode: AutoPilotMode;
  trigger: AutoPilotTrigger;
}

export interface AutoPilotResult {
  runId: string;
  mode: string;
  trigger: string;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  summary: RunSummary;
  message?: string;
  error?: string;
}

// Map our modes to BotRunMode values used by existing POST /api/ai-bots
function toBotRunMode(mode: AutoPilotMode): string {
  switch (mode) {
    case 'full_safe_run': return 'full_safe_run';
    case 'source_scan': return 'source_scan';
    case 'health_check': return 'link_health';
    case 'cleanup_broken_products': return 'cleanup';
    default: return 'full_safe_run';
  }
}

/**
 * Central AutoPilot execution function.
 *
 * 1. Acquire run lock
 * 2. Create run log
 * 3. Execute the correct bot/health/cleanup function
 * 4. Catch errors
 * 5. Release lock in finally
 * 6. Update log
 * 7. Return clean summary
 *
 * Safety config is always forced:
 *   safeMode: true, freeOnly: true, autoMode: true,
 *   autoPublish: true, allowPaidAi: false
 */
export async function runAutoPilot(options: AutoPilotOptions): Promise<AutoPilotResult> {
  const { mode, trigger } = options;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // Step 1: Acquire lock
  const lockResult = await acquireRunLock(mode, trigger);

  if (!lockResult.acquired) {
    // Create a skipped log entry
    const skipLog = await createRunLog('skipped', mode, trigger);
    await updateRunLog(skipLog.runId, {
      status: 'skipped',
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      message: lockResult.reason || 'AutoPilot đang chạy, không thể chạy song song.',
    });

    return {
      runId: '',
      mode,
      trigger,
      status: 'skipped',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      summary: {},
      message: lockResult.reason || 'AutoPilot đang chạy, không thể chạy song song.',
    };
  }

  const runId = lockResult.runId;

  // Step 2: Create run log
  await createRunLog(runId, mode, trigger);

  try {
    // Step 3: Execute based on mode
    let summary: RunSummary = {};
    let message = '';

    switch (mode) {
      case 'full_safe_run':
      case 'source_scan': {
        // Delegate to existing POST /api/ai-bots workflow via direct import
        // This avoids HTTP self-call and reuses the exact same executeWorkflow logic.
        const { createBotRun, updateBotRun, addBotRunLog } = await import('../storage/botRuns');
        const { createOrchestrator } = await import('./orchestrator');
        const { createSourceScout } = await import('./sourceScout');
        const { createDealScorer } = await import('./dealScorer');
        const { createLinkHealthChecker } = await import('./linkHealth');
        const { createContentReview } = await import('./contentReview');
        const { createProductCleanup } = await import('./productCleanup');
        const { createContentPackage } = await import('../storage/contentPackages');
        const { listProducts } = await import('../storage/products');

        const botMode = toBotRunMode(mode);
        const botRun = await createBotRun(botMode as Parameters<typeof createBotRun>[0], 'all', 20);
        await updateBotRun(botRun.id, { status: 'running' });

        const orchestrator = await createOrchestrator(botRun.id);
        const state = await orchestrator.validateState({
          runId: botRun.id,
          mode: botMode,
          source: 'all',
          limit: 20,
          safeMode: true,
          freeOnly: true,
          autoMode: true,
          autoApprove: true,
          allowPaidAi: false,
          costMode: 'safe_free',
          autoPublishEnabled: true,
        } as any);

        const preflight = await orchestrator.preflightCheck(state);
        if (!preflight) {
          await updateBotRun(botRun.id, { status: 'failed', errorCount: 1 });
          throw new Error('Preflight check thất bại.');
        }

        await orchestrator.startWorkflow(state);

        const stats = {
          candidatesFound: 0,
          productsSaved: 0,
          contentPackagesGenerated: 0,
          linksChecked: 0,
          productsArchived: 0,
        };

        if (mode === 'source_scan') {
          const scout = await createSourceScout(botRun.id);
          const candidates = await scout.scanSource('all', 20);
          stats.candidatesFound = candidates.length;
          stats.productsSaved = candidates.length;
        } else {
          // full_safe_run
          const scout = await createSourceScout(botRun.id);
          const candidates = await scout.scanSource('all', 20);
          stats.candidatesFound = candidates.length;
          stats.productsSaved = candidates.length;

          const allProducts = await listProducts();
          const runnableProducts = allProducts
            .filter((p) => {
              const rec = p as any;
              const kind = rec.sourceItemKind || rec.kind || '';
              if (kind !== 'product' && kind !== 'deal') return false;
              if (p.status !== 'published' && p.status !== 'approved') return false;
              if (rec.publicHidden) return false;
              if (!p.title || !p.imageUrl) return false;
              const hasUrl = p.affiliateUrl || p.originalUrl || (typeof rec.url === 'string' && rec.url.trim());
              if (!hasUrl) return false;
              return Boolean(p.price || p.salePrice);
            })
            .slice(0, 20);

          // Score
          const scorer = await createDealScorer(botRun.id);
          const scored: any[] = [];
          for (const p of runnableProducts) {
            try {
              const result = await scorer.scoreProduct(p);
              if (result.score > 50) scored.push(p);
            } catch { /* skip */ }
          }

          // Link check
          const checker = await createLinkHealthChecker(botRun.id);
          for (const p of scored) {
            try {
              const rec = p as any;
              const url = p.originalUrl || p.affiliateUrl || (typeof rec.url === 'string' ? rec.url : '');
              if (url) {
                await checker.checkProductLink(p.id, url, p.affiliateUrl, p.imageUrl);
                stats.linksChecked++;
              }
            } catch { /* skip */ }
          }

          // Content packages
          const contentReview = await createContentReview(botRun.id);
          for (const p of scored) {
            try {
              const content = await contentReview.generateContent(p);
              await createContentPackage(p.id, {
                productId: p.id,
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
              stats.contentPackagesGenerated++;
            } catch { /* skip */ }
          }

          // Cleanup
          const cleanup = await createProductCleanup(botRun.id);
          const cleanupResult = await cleanup.cleanupBrokenProducts({ limit: 20, dryRun: false });
          stats.productsArchived = cleanupResult.archived;
          stats.linksChecked += cleanupResult.checked;
        }

        await orchestrator.completeWorkflow(state);
        await updateBotRun(botRun.id, { status: 'completed', ...stats });

        summary = {
          found: stats.candidatesFound,
          saved: stats.productsSaved,
          checked: stats.linksChecked,
          cleaned: stats.productsArchived,
        };
        message = `${mode === 'source_scan' ? 'Quét nguồn' : 'AutoPilot full'} hoàn tất. Tìm ${stats.candidatesFound}, lưu ${stats.productsSaved}.`;

        break;
      }

      case 'health_check': {
        const healthResult = await runProductHealthCleanup();

        summary = {
          checked: healthResult.checked,
          hidden: healthResult.hidden,
          blockedByLink: healthResult.linkBroken,
          blockedByImage: healthResult.imageBroken,
          errors: healthResult.errors,
        };
        message = `Health check hoàn tất. Kiểm tra ${healthResult.checked}, ẩn ${healthResult.hidden}.`;
        break;
      }

      case 'cleanup_broken_products': {
        const { createProductCleanup } = await import('./productCleanup');
        const { createBotRun, updateBotRun } = await import('../storage/botRuns');
        const cleanupBotRun = await createBotRun('cleanup', 'all', 50);
        await updateBotRun(cleanupBotRun.id, { status: 'running' });

        const cleanup = await createProductCleanup(cleanupBotRun.id);
        const result = await cleanup.cleanupBrokenProducts({ limit: 50, dryRun: false });

        await updateBotRun(cleanupBotRun.id, {
          status: 'completed',
          productsArchived: result.archived,
          linksChecked: result.checked,
        });

        summary = {
          checked: result.checked,
          cleaned: result.archived,
        };
        message = `Dọn sản phẩm lỗi hoàn tất. Kiểm tra ${result.checked}, dọn ${result.archived}.`;
        break;
      }

      default:
        throw new Error(`Mode không hợp lệ: ${mode}`);
    }

    // Step 4: Success
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;

    await updateRunLog(runId, {
      status: 'completed',
      finishedAt,
      durationMs,
      summary,
      message,
    });

    return {
      runId,
      mode,
      trigger,
      status: 'completed',
      startedAt,
      finishedAt,
      durationMs,
      summary,
      message,
    };
  } catch (err) {
    // Step 5: Error handling
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;
    const errorMessage = err instanceof Error ? err.message : 'Lỗi không xác định';

    await updateRunLog(runId, {
      status: 'failed',
      finishedAt,
      durationMs,
      summary: {},
      error: errorMessage,
    });

    return {
      runId,
      mode,
      trigger,
      status: 'failed',
      startedAt,
      finishedAt,
      durationMs,
      summary: {},
      error: errorMessage,
    };
  } finally {
    // Step 6: Always release lock
    await releaseRunLock(runId);
  }
}
