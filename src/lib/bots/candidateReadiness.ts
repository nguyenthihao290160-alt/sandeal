import type { CandidateLane } from '../types';
import type { CandidatePayload } from '../storage/candidateQueue';

const HIGH_RISK = /(?:thuốc|thiết bị y tế|giảm cân|chữa bệnh|điều trị)/i;
const PROHIBITED = /(?:thuốc kê đơn|nicotine|vũ khí|chất cấm|cờ bạc|hàng giả)/i;
export function scoreCandidateReadiness(payload: CandidatePayload): { score: number; lane: CandidateLane } {
  const text = `${payload.title} ${payload.category || ''} ${payload.description || ''}`;
  if (payload.kind !== 'product' || PROHIBITED.test(text)) return { score: 0, lane: 'REJECTED_LANE' };
  if (HIGH_RISK.test(text)) return { score: 20, lane: 'HUMAN_REVIEW_LANE' };
  let score = 0;
  if (payload.title.trim().length >= 8) score += 15;
  if (Number(payload.salePrice || payload.price) > 0) score += 20;
  if (payload.originalUrl) score += 15; if (payload.affiliateUrl) score += 15; if (payload.imageUrl) score += 15;
  if (payload.verifiedSource) score += 10; if (payload.autoPublishEligible) score += 10;
  return { score, lane: score >= 90 ? 'FAST_LANE' : 'NORMAL_LANE' };
}

export const LANE_PRIORITY: Record<CandidateLane, number> = { FAST_LANE: 5, NORMAL_LANE: 4, RETRY_LANE: 3, HUMAN_REVIEW_LANE: 2, REJECTED_LANE: 1 };
