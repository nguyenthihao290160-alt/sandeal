// Server-only compatibility facade. All Gemini generation is routed through the
// free credential pool; this module never reads a raw key directly.
import { createHash } from 'crypto';
import { executeGeminiRequest } from './geminiCredentialRouter';

export type GeminiAnalysisResult = {
  name?: string; category?: string; platform?: string; price?: number | null;
  priceNote?: string; benefits?: string[]; audience?: string[]; contentAngle?: string;
  riskNotes?: string[]; checkBeforeBuy?: string[]; affiliateDisclosure?: string; dealScore?: number | null;
};

export async function analyzeWithGemini(sanitized: Record<string, unknown>, model = 'gemini-3.1-flash-lite'): Promise<GeminiAnalysisResult | null> {
  const safe = { title: sanitized.title || null, description: sanitized.description || null, canonical: sanitized.canonical || null, image: sanitized.image || null, price: sanitized.price ?? null, currency: sanitized.currency || null, source: sanitized.source || null, notes: sanitized.notes || null };
  const idempotencyKey = createHash('sha256').update(JSON.stringify({ model, safe, version: 2 })).digest('hex');
  const result = await executeGeminiRequest({ modelId: model, taskType: 'metadata_repair', idempotencyKey, timeoutMs: 20_000, inputTokenEstimate: Math.ceil(JSON.stringify(safe).length / 4), body: { contents: [{ role: 'user', parts: [{ text: JSON.stringify({ instruction: 'Return strict JSON only. Do not invent facts.', input: safe }) }] }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1024 } } });
  if (!result.ok) return null;
  try {
    const root = result.data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = root.candidates?.[0]?.content?.parts?.[0]?.text; return text ? JSON.parse(text) as GeminiAnalysisResult : null;
  } catch { return null; }
}
