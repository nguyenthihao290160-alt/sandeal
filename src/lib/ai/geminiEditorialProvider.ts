import { createHash } from 'crypto';
import type { Product, ReviewContent } from '../types';
import { executeGeminiRequest } from './geminiCredentialRouter';
import { routeModel, type TaskProfile } from './geminiModels';

export interface GeminiEditorialResult { review: ReviewContent; modelId: string; promptVersion: string; generationFingerprint: string; responseHash: string; generatedAt: string; }
const PROMPT_VERSION = 'editorial-v2.1';

export function sanitizeProductForGemini(product: Product): Record<string, unknown> {
  return {
    id: product.id, title: product.title, brand: product.brand, category: product.category,
    price: product.price, salePrice: product.salePrice, currency: product.currency,
    specifications: product.specifications, description: product.description,
    benefits: product.benefits, warnings: product.warnings, riskLevel: product.riskLevel,
    health: { product: product.linkHealthStatus, affiliate: product.affiliateHealthStatus, image: product.imageHealthStatus },
    evidenceIds: product.reviewContent?.keyFacts.map((fact) => fact.id) || [],
  };
}

export async function generateGeminiEditorialReview(product: Product, profile: TaskProfile, availableModels: string[], localFallback: () => ReviewContent): Promise<GeminiEditorialResult | null> {
  const model = routeModel(profile, availableModels); if (!model) return null;
  const publicInput = sanitizeProductForGemini(product);
  const fingerprint = createHash('sha256').update(JSON.stringify({ sourceHash: product.sourceHash, promptVersion: PROMPT_VERSION, policyVersion: 'product-policy-v2', modelId: model.modelId, reviewVersion: 2 })).digest('hex');
  let response: Awaited<ReturnType<typeof executeGeminiRequest>>;
  try {
    response = await executeGeminiRequest({ modelId: model.modelId, taskType: profile.taskType, idempotencyKey: fingerprint, timeoutMs: model.timeoutMs, inputTokenEstimate: profile.inputTokenEstimate, maxFailoverGroups: 2, body: {
      contents: [{ role: 'user', parts: [{ text: JSON.stringify({ instruction: 'Write an evidence-bound Vietnamese editorial product review. Return only schema JSON. Never claim hands-on use, ratings, sales, stock, warranty, certification, ingredients or effects without evidence.', product: publicInput }) }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: reviewSchema(), maxOutputTokens: model.maxOutputTokens, temperature: 0.2 },
    } });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const parsed = parseReviewResponse(response.data); if (!parsed) return null;
  const fallback = localFallback();
  if (parsed.reviewTitle!.trim().length < 12 || parsed.reviewSummary!.trim().length < 80) return null;
  const contentUpdatedAt = new Date().toISOString();
  const review: ReviewContent = { ...fallback, ...parsed, reviewVersion: 2, reviewMethod: 'source_data_analysis', reviewerType: 'automated_editorial', sourceHash: product.sourceHash || '', reviewedAt: contentUpdatedAt, contentUpdatedAt, reviewContentHash: '' };
  review.reviewContentHash = createHash('sha256').update(JSON.stringify({ title: review.reviewTitle, summary: review.reviewSummary, verdict: review.reviewVerdict, strengths: review.strengths, limitations: review.limitations, suitableFor: review.suitableFor, buyingConsiderations: review.buyingConsiderations })).digest('hex');
  return { review, modelId: model.modelId, promptVersion: PROMPT_VERSION, generationFingerprint: fingerprint, responseHash: createHash('sha256').update(JSON.stringify(parsed)).digest('hex'), generatedAt: new Date().toISOString() };
}

function parseReviewResponse(data: unknown): Partial<ReviewContent> | null {
  try {
    const root = data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = root.candidates?.[0]?.content?.parts?.[0]?.text; if (!text) return null;
    const parsed = JSON.parse(text) as Partial<ReviewContent>;
    if (typeof parsed.reviewTitle !== 'string' || typeof parsed.reviewSummary !== 'string' || !Array.isArray(parsed.factualClaims) || !Array.isArray(parsed.inferredClaims)) return null;
    return parsed;
  } catch { return null; }
}

function reviewSchema(): Record<string, unknown> {
  const claim = { type: 'OBJECT', properties: { id: { type: 'STRING' }, text: { type: 'STRING' }, claimType: { type: 'STRING', enum: ['factual', 'inferred', 'unknown'] }, evidenceFactIds: { type: 'ARRAY', items: { type: 'STRING' } }, confidence: { type: 'STRING', enum: ['high', 'medium', 'low', 'unknown'] } }, required: ['id', 'text', 'claimType', 'evidenceFactIds', 'confidence'] };
  return { type: 'OBJECT', properties: { reviewTitle: { type: 'STRING' }, reviewSummary: { type: 'STRING' }, reviewVerdict: { type: 'STRING' }, suitableFor: { type: 'ARRAY', items: { type: 'STRING' } }, notSuitableFor: { type: 'ARRAY', items: { type: 'STRING' } }, buyingConsiderations: { type: 'ARRAY', items: { type: 'STRING' } }, factualClaims: { type: 'ARRAY', items: claim }, inferredClaims: { type: 'ARRAY', items: claim }, unknownClaims: { type: 'ARRAY', items: claim } }, required: ['reviewTitle', 'reviewSummary', 'reviewVerdict', 'suitableFor', 'notSuitableFor', 'buyingConsiderations', 'factualClaims', 'inferredClaims', 'unknownClaims'] };
}
