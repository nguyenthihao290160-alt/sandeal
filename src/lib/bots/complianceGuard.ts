// ===========================================
// Compliance Guard Bot
// Checks generated content for compliance issues
// ===========================================

import type { ContentPackage, ComplianceCheckResult, ComplianceIssue } from '../types';
import { BotContext } from './context';

export class ComplianceGuardBot {
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  async checkContent(content: ContentPackage): Promise<ComplianceCheckResult> {
    const issues: ComplianceIssue[] = [];

    // Check for fake personal experience
    if (this.containsFakeExperience(content.websiteReview + ' ' + content.shortCaption)) {
      issues.push('fake_personal_experience');
    }

    // Check for exaggerated claims
    if (this.containsExaggeration(content.websiteReview)) {
      issues.push('exaggerated_claims');
    }

    // Check for missing affiliate disclosure
    if (!content.affiliateNote || content.affiliateNote.trim().length === 0) {
      issues.push('missing_affiliate_disclosure');
    }

    // Check for missing price change note
    if (!content.websiteReview.includes('thay đổi') && !content.websiteReview.includes('có thể')) {
      issues.push('missing_price_change_note');
    }

    const status = issues.length === 0 ? 'safe' : issues.length <= 2 ? 'needs_edit' : 'blocked';

    const result: ComplianceCheckResult = {
      status,
      issues,
      checkedAt: new Date().toISOString(),
    };

    await this.ctx.info('Compliance check complete', {
      contentId: content.id,
      status,
      issueCount: issues.length,
    });

    return result;
  }

  private containsFakeExperience(text: string): boolean {
    const patterns = [
      /tôi.*đã.*dùng/i,
      /mình.*đã.*thử/i,
      /tôi.*yêu thích/i,
      /tôi.*khuyến nghị/i,
    ];
    return patterns.some(p => p.test(text));
  }

  private containsExaggeration(text: string): boolean {
    const patterns = [
      /đảm bảo.*kết quả/i,
      /chắc chắn.*sẽ/i,
      /tất cả.*đều/i,
      /100%.*hiệu quả/i,
    ];
    return patterns.some(p => p.test(text));
  }
}

export async function createComplianceGuard(runId: string): Promise<ComplianceGuardBot> {
  return new ComplianceGuardBot(new BotContext(runId, 'compliance_guard'));
}
