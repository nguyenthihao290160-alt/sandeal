// ===========================================
// AI Boss Orchestrator Bot
// ===========================================
// Controls the entire workflow, checks constraints,
// decides which bot runs next, ensures Safe Mode compliance

import type { BotRunMode } from '../types';
import { BotContext } from './context';
import { config } from '../config';
import { getPrimaryCredential } from '../storage/tokenVault';
import { getBotRunById, updateBotRun } from '../storage/botRuns';

export interface OrchestratorConfig {
  runId: string;
  mode: BotRunMode;
  source: 'local' | 'accesstrade' | 'manual' | 'all';
  limit: number;
  allowPaidAi?: boolean;
  costMode?: string;
  autoPublishEnabled?: boolean;
}

export interface OrchestratorState {
  runId: string;
  mode: BotRunMode;
  source: 'local' | 'accesstrade' | 'manual' | 'all';
  limit: number;
  safeMode: boolean;
  freeOnly: boolean;
  autoPublish: boolean;
  hasGeminiToken: boolean;
  hasAccessTradeToken: boolean;
  canProceed: boolean;
  blockReasons: string[];
}

export class Orchestrator {
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  async validateState(config: OrchestratorConfig): Promise<OrchestratorState> {
    const state: OrchestratorState = {
      runId: config.runId,
      mode: config.mode,
      source: config.source,
      limit: Math.min(config.limit, 50), // Max 50 items per run
      safeMode: !(config.allowPaidAi ?? true),
      freeOnly: config.costMode === 'free_only',
      autoPublish: config.autoPublishEnabled ?? false,
      hasGeminiToken: false,
      hasAccessTradeToken: false,
      canProceed: true,
      blockReasons: [],
    };

    // Check if we have required tokens
    const geminiToken = await getPrimaryCredential('gemini');
    state.hasGeminiToken = !!geminiToken && geminiToken.status === 'valid';

    const atToken = await getPrimaryCredential('accesstrade');
    state.hasAccessTradeToken = !!atToken && atToken.status === 'valid';

    // Validation rules
    if (config.source === 'accesstrade' && !state.hasAccessTradeToken) {
      state.blockReasons.push('AccessTrade source selected but no valid AccessTrade token in vault');
      state.canProceed = false;
    }

    if (
      config.mode === 'gemini_analysis' &&
      !state.hasGeminiToken
    ) {
      state.blockReasons.push('Gemini analysis mode selected but no valid Gemini token in vault');
      state.canProceed = false;
    }

    await this.ctx.info('Orchestrator validation complete', {
      canProceed: state.canProceed,
      blockReasons: state.blockReasons,
      safeMode: state.safeMode,
      freeOnly: state.freeOnly,
      autoPublish: state.autoPublish,
    });

    return state;
  }

  async preflightCheck(state: OrchestratorState): Promise<boolean> {
    if (!state.canProceed) {
      await this.ctx.error('Orchestrator preflight check failed', {
        blockReasons: state.blockReasons,
      });
      return false;
    }

    // Warn about disabled features
    if (state.safeMode) {
      await this.ctx.info('Safe Mode is ON - using free APIs only');
    }

    if (state.freeOnly) {
      await this.ctx.info('Free Only mode is ON - no paid AI services will be used');
    }

    if (state.autoPublish) {
      await this.ctx.warn('Auto Publish is ENABLED - be careful!');
    } else {
      await this.ctx.info('Auto Publish is OFF - all content requires manual approval');
    }

    await this.ctx.info('Orchestrator preflight checks passed');
    return true;
  }

  async startWorkflow(state: OrchestratorState): Promise<void> {
    const run = await getBotRunById(state.runId);
    if (!run) {
      await this.ctx.error('Bot run not found', { runId: state.runId });
      return;
    }

    await updateBotRun(state.runId, {
      status: 'running',
    });

    await this.ctx.info('Orchestrator starting workflow', {
      mode: state.mode,
      source: state.source,
      limit: state.limit,
    });
  }

  async scheduleNextBot(state: OrchestratorState): Promise<BotRunMode | null> {
    // Simplified scheduling logic - in production this would be more sophisticated
    const modeSequence: Record<BotRunMode, BotRunMode | null> = {
      source_scan: 'deal_hunt',
      deal_hunt: 'gemini_analysis',
      gemini_analysis: 'content_review',
      content_review: 'link_health',
      link_health: 'cleanup',
      cleanup: 'full_safe_run', // Would be null normally
      score_only: null,
      full_safe_run: null,
    };

    const next = modeSequence[state.mode];
    if (next) {
      await this.ctx.info(`Scheduling next bot mode: ${next}`);
    } else {
      await this.ctx.info('Workflow complete - no more bots to schedule');
    }
    return next;
  }

  async completeWorkflow(state: OrchestratorState, error?: string): Promise<void> {
    const run = await getBotRunById(state.runId);
    if (!run) return;

    const status = error ? 'failed' : 'completed';
    await updateBotRun(state.runId, {
      status: status as any,
      completedAt: new Date().toISOString(),
    });

    if (error) {
      await this.ctx.error('Workflow failed', { error });
    } else {
      await this.ctx.info('Workflow completed successfully');
    }
  }
}

export async function createOrchestrator(runId: string): Promise<Orchestrator> {
  return new Orchestrator(new BotContext(runId, 'orchestrator'));
}
