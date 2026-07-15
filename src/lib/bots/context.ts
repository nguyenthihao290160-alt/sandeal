// ===========================================
// Bot Context & Logger Helper
// ===========================================
// Provides context for all bots including logging capability

import type { BotName } from '../types';
import { addBotRunLog } from '../storage/botRuns';
import { sanitizeErrorMessage, sanitizeSensitiveValue } from '../safety/operationGuard';

export class BotContext {
  runId: string;
  botName: BotName;

  constructor(runId: string, botName: BotName) {
    this.runId = runId;
    this.botName = botName;
  }

  async log(
    level: 'info' | 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    const safeMessage = sanitizeErrorMessage(message).slice(0, 1_000);
    const safeData = sanitizeSensitiveValue(data) as Record<string, unknown> | undefined;
    await addBotRunLog(this.runId, this.botName, level, safeMessage, safeData);
    console.log(`[${this.botName}] ${level.toUpperCase()}: ${safeMessage}`, safeData ? JSON.stringify(safeData) : '');
  }

  async info(message: string, data?: Record<string, unknown>): Promise<void> {
    return this.log('info', message, data);
  }

  async warn(message: string, data?: Record<string, unknown>): Promise<void> {
    return this.log('warn', message, data);
  }

  async error(message: string, data?: Record<string, unknown>): Promise<void> {
    return this.log('error', message, data);
  }
}
