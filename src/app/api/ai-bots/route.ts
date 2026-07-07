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
import { createOrchestrator } from '@/lib/bots/orchestrator';
import { createSourceScout } from '@/lib/bots/sourceScout';
import { createDealScorer } from '@/lib/bots/dealScorer';
import { createLinkHealthChecker } from '@/lib/bots/linkHealth';
import type { BotRunMode } from '@/lib/types';

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

    // Execute workflow based on mode
    switch (mode) {
      case 'source_scan': {
        const scout = await createSourceScout(runId);
        const candidates = await scout.scanSource(source, limit);
        await updateBotRun(runId, {
          candidatesFound: candidates.length,
        });
        break;
      }

      case 'score_only': {
        // Example: score products
        const scorer = await createDealScorer(runId);
        // In production, this would iterate over products
        break;
      }

      case 'link_health': {
        const checker = await createLinkHealthChecker(runId);
        // In production, this would check products
        break;
      }

      default: {
        // Other modes
        break;
      }
    }

    // Complete workflow
    await orchestrator.completeWorkflow(state);
    await updateBotRun(runId, {
      status: 'completed',
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
