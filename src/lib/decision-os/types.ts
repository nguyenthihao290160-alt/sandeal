import type { AiProvider, ProviderId } from '../automation/providerRegistry';
import type { DealEvaluation, DealPriority, PublishRecommendation } from '../deal-intelligence/types';
import type { EvidenceOrigin, ProviderObservation } from '../affiliate/money/types';
import type { Product } from '../types';

export const DECISION_ACTIONS = ['NO_ACTION', 'HOLD', 'REJECT', 'REQUEST_REFRESH_PRICE', 'REQUEST_REFRESH_OFFER',
  'REQUEST_REEVALUATION', 'REQUEST_PROVIDER_RECHECK', 'MARK_PUBLISH_CANDIDATE', 'MARK_CONTENT_CANDIDATE',
  'MARK_HIGH_PRIORITY', 'MARK_REVIEW_REQUIRED', 'QUARANTINE'] as const;
export type DecisionAction = typeof DECISION_ACTIONS[number];
export const POLICY_OUTCOMES = ['ALLOW', 'ALLOW_WITH_REVIEW', 'HOLD', 'BLOCK', 'QUARANTINE'] as const;
export type DecisionOutcome = typeof POLICY_OUTCOMES[number];
export const DECISION_REASONS = ['DEAL_SCORE_HIGH', 'DEAL_SCORE_LOW', 'DEAL_CONFIDENCE_LOW', 'PRICE_STALE', 'OFFER_STALE',
  'SAFE_MONETIZATION_AVAILABLE', 'NO_SAFE_MONETIZATION_PATH', 'PUBLICATION_GATE_PASS', 'PUBLICATION_GATE_BLOCK',
  'PROVIDER_HEALTHY', 'PROVIDER_DEGRADED', 'PROVIDER_UNAVAILABLE', 'ACCESSTRADE_SHOPEE_VALID', 'DIRECT_SHOPEE_DISABLED',
  'REVENUE_EVIDENCE_POSITIVE', 'REVENUE_EVIDENCE_UNKNOWN', 'MANUAL_REVIEW_REQUIRED', 'UNSAFE_DESTINATION', 'OFFER_EXPIRED',
  'MERCHANT_IDENTITY_REQUIRED', 'CAMPAIGN_IDENTITY_REQUIRED', 'INVALID_CURRENCY', 'INVALID_PRICE', 'INVALID_OFFER_VALIDITY', 'CORRUPT_DEAL_EVALUATION',
  'CONFIDENCE_SCALE_MISMATCH', 'CRITICAL_EVIDENCE_EXPIRED', 'SECURITY_RISK', 'QUARANTINED_EVIDENCE', 'INVALID_RUNTIME_CONFIGURATION',
  'SYSTEM_UNAVAILABLE', 'SYSTEM_DEGRADED', 'EVIDENCE_CHANGED', 'DEAL_REJECTED', 'AI_UNAVAILABLE', 'AI_DISABLED',
  'AI_ADVICE_ACCEPTED', 'AI_ADVICE_REJECTED_BY_POLICY', 'AI_INVALID_OUTPUT', 'AI_PROVIDER_SELECTED', 'AI_FALLBACK_USED',
  'AI_NOT_NEEDED', 'AI_BUDGET_EXHAUSTED', 'AI_COOLDOWN', 'AI_IN_FLIGHT', 'AI_CACHE_HIT'] as const;
export type DecisionReason = typeof DECISION_REASONS[number];
export type DecisionRisk = DecisionReason;
export type DecisionHealth = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'COOLDOWN';
export interface DecisionConstraints {
  executionMode: 'SHADOW'; systemHealth: DecisionHealth; systemVersion: string;
  securityRisk: boolean; quarantined: boolean; runtimeValid: boolean;
}
export interface DecisionInput {
  product: Product; deal: DealEvaluation; providers: ProviderObservation[]; allowedHosts: readonly string[];
  now: number; evidenceRevision: number; constraints: DecisionConstraints; testOnly?: boolean;
}
export interface DecisionEvidence {
  dealEvaluationId: string; dealScore: number; dealConfidence: number; dealPriority: DealPriority;
  publishRecommendation: PublishRecommendation; dealAlgorithmVersion: string;
  money: { status: 'SAFE' | 'UNAVAILABLE'; selectedOfferId: string | null; provider: string | null; platform: string | null; version: string };
  publication: { ready: boolean; version: string };
  priceFreshness: string; offerFreshness: string; providerHealth: DecisionHealth;
  revenue: { state: 'POSITIVE' | 'UNKNOWN'; version: number };
  constraints: DecisionConstraints;
}
export interface DecisionContext extends DecisionEvidence {
  decisionId: string; productId: string; origin: EvidenceOrigin; decisionTimestamp: string; validUntil: number;
  evidenceFingerprint: string; decisionPolicyVersion: string; promptVersion: string | null;
  gates: { outcome: DecisionOutcome; reason: DecisionReason }[];
}
export interface PolicyDecision {
  outcome: DecisionOutcome; policyVersion: string; reasonCodes: DecisionReason[]; riskCodes: DecisionRisk[];
  reviewRequired: boolean; allowedActions: DecisionAction[]; blockedActions: DecisionAction[];
}
export const AI_ROLES = ['FAST_CLASSIFIER', 'REASONER', 'OPTIONAL_REVIEWER'] as const;
export type AiRole = typeof AI_ROLES[number];
export const AI_RATIONALES = ['DEAL_SCORE_HIGH', 'DEAL_SCORE_LOW', 'DEAL_CONFIDENCE_LOW', 'PRICE_STALE', 'OFFER_STALE',
  'SAFE_MONETIZATION_AVAILABLE', 'MANUAL_REVIEW_REQUIRED', 'REVENUE_EVIDENCE_UNKNOWN'] as const;
export const AI_UNCERTAINTIES = ['LOW_CONFIDENCE', 'CONFLICTING_SIGNALS', 'STALE_EVIDENCE', 'UNKNOWN_REVENUE', 'PROVIDER_HEALTH'] as const;
export const REQUESTED_EVIDENCE = ['PRICE', 'OFFER', 'DEAL', 'PROVIDER_HEALTH', 'REVENUE'] as const;
export interface AiDecisionAdvice {
  recommendedAction: DecisionAction; confidence: number; rationaleCodes: typeof AI_RATIONALES[number][];
  uncertaintyCodes: typeof AI_UNCERTAINTIES[number][]; requestedEvidence: typeof REQUESTED_EVIDENCE[number][]; summary: string;
}
export interface DecisionEvidencePack {
  schemaVersion: 'decision-evidence-v1'; productKey: string;
  trustedSignals: DecisionEvidence; allowedActions: DecisionAction[]; blockedActions: DecisionAction[];
  untrustedExternalText: { productTitle: 'OMITTED'; merchantText: 'OMITTED'; campaignName: 'OMITTED'; offerDescription: 'OMITTED' };
}
export interface DecisionAiRequest {
  system: string; evidence: DecisionEvidencePack; role: AiRole; model: string; promptVersion: string;
  signal: AbortSignal; tools: readonly never[];
}
export interface DecisionAiResponse { output: string; usage?: { inputTokens?: number; outputTokens?: number } }
export interface DecisionModelBinding { provider: AiProvider<DecisionAiRequest, DecisionAiResponse>; model: string; origin: 'CONFIGURED_RUNTIME' | 'TEST_FIXTURE' }
export type DecisionModelRoles = Partial<Record<AiRole, readonly DecisionModelBinding[]>>;
export interface AiAttempt {
  provider: ProviderId; model: string; health: DecisionHealth; status: 'SUCCEEDED' | 'FAILED';
  latencyMs: number; inputTokens: number | null; outputTokens: number | null; cost: 'UNKNOWN';
}
export interface DecisionAiResult {
  status: 'DISABLED' | 'AVOIDED' | 'UNAVAILABLE' | 'INVALID' | 'VALID'; reasonCodes: DecisionReason[];
  advice: AiDecisionAdvice | null; provider: ProviderId | null; model: string | null; role: AiRole;
  promptVersion: string | null; attempts: AiAttempt[]; cacheHit: boolean;
}
export interface DecisionPlan {
  executionMode: 'SHADOW'; outcome: DecisionOutcome; actions: DecisionAction[]; reviewRequired: boolean;
  reasonCodes: DecisionReason[]; riskCodes: DecisionRisk[];
}
export interface DecisionAuditRecord {
  decisionId: string; productId: string; origin: EvidenceOrigin; evidenceFingerprint: string; dealEvaluationId: string;
  dealScore: number; dealConfidence: number; dealPriority: DealPriority; provider: string | null; platform: string | null;
  policyVersion: string; dealAlgorithmVersion: string; promptVersion: string | null;
  policy: PolicyDecision; ai: DecisionAiResult; plan: DecisionPlan; createdAt: string; validUntil: number;
}
