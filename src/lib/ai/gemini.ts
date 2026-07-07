// Server-side Gemini helper — safe wrapper
// Does NOT expose keys to frontend.

import { getPrimaryGeminiKey, markGeminiKeyError } from './keyRotation';
import { getServerConfig } from '../config';

export type GeminiAnalysisResult = {
  name?: string;
  category?: string;
  platform?: string;
  price?: number | null;
  priceNote?: string;
  benefits?: string[];
  audience?: string[];
  contentAngle?: string;
  riskNotes?: string[];
  checkBeforeBuy?: string[];
  affiliateDisclosure?: string;
  dealScore?: number | null;
};

/** Analyze sanitized metadata using Gemini if available. Returns null if no key or on error. */
export async function analyzeWithGemini(sanitized: Record<string, any>, model = process.env.GEMINI_MODEL || 'default'):
  Promise<GeminiAnalysisResult | null> {
  try {
    const key = await getPrimaryGeminiKey();
    if (!key) return null; // No key configured

    // Build a safe JSON-only prompt input. Keep it small and structured.
    const payload = {
      model,
      input: {
        // Provide only sanitized text fields and simple metadata
        metadata: {
          title: sanitized.title || null,
          description: sanitized.description || null,
          canonical: sanitized.canonical || null,
          image: sanitized.image || null,
          price: sanitized.price ?? null,
          currency: sanitized.currency || null,
          source: sanitized.source || null,
        },
        notes: sanitized.notes || null,
      },
      instructions: "Return a strict JSON object with the following keys: name, category, platform, price (number or null), priceNote, benefits (array), audience (array), contentAngle, riskNotes (array), checkBeforeBuy (array), affiliateDisclosure, dealScore (number 0-100 or null). Do not include any prose outside the JSON. If information is missing, use null or empty arrays. Do not fabricate prices or claims. Include Vietnamese affiliate disclosure note and price-change note if appropriate."
    };

    // NOTE: provider endpoint may vary. Use a conservative approach: call a generic endpoint if available via env.
    const endpoint = process.env.GEMINI_API_ENDPOINT || 'https://generativeai.googleapis.com/v1beta2/models/' + encodeURIComponent(model) + ':predict';

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      // Mark key error for vault-managed keys
      try { await markGeminiKeyError('unknown', `HTTP ${res.status} ${txt.slice(0,200)}`); } catch(_) {}
      return null;
    }

    const data = await res.json().catch(() => null);
    if (!data) return null;

    // Attempt to find JSON in response — different endpoints vary
    let candidate: any = null;
    if (data.output && typeof data.output === 'object') candidate = data.output;
    if (!candidate && data.prediction) candidate = data.prediction;
    if (!candidate && data[0]) candidate = data[0];

    // If candidate is a string that contains JSON, try parse
    if (typeof candidate === 'string') {
      try { candidate = JSON.parse(candidate); } catch { candidate = null; }
    }

    // Validate shape
    if (!candidate || typeof candidate !== 'object') return null;

    const out: GeminiAnalysisResult = {
      name: typeof candidate.name === 'string' ? candidate.name : undefined,
      category: typeof candidate.category === 'string' ? candidate.category : undefined,
      platform: typeof candidate.platform === 'string' ? candidate.platform : undefined,
      price: typeof candidate.price === 'number' ? candidate.price : null,
      priceNote: typeof candidate.priceNote === 'string' ? candidate.priceNote : undefined,
      benefits: Array.isArray(candidate.benefits) ? candidate.benefits.map(String) : undefined,
      audience: Array.isArray(candidate.audience) ? candidate.audience.map(String) : undefined,
      contentAngle: typeof candidate.contentAngle === 'string' ? candidate.contentAngle : undefined,
      riskNotes: Array.isArray(candidate.riskNotes) ? candidate.riskNotes.map(String) : undefined,
      checkBeforeBuy: Array.isArray(candidate.checkBeforeBuy) ? candidate.checkBeforeBuy.map(String) : undefined,
      affiliateDisclosure: typeof candidate.affiliateDisclosure === 'string' ? candidate.affiliateDisclosure : undefined,
      dealScore: typeof candidate.dealScore === 'number' ? candidate.dealScore : null,
    };

    return out;
  } catch (err: any) {
    // Non-fatal — caller will proceed without AI
    console.warn('[Gemini] Analysis failed:', (err && err.message) || String(err));
    return null;
  }
}
