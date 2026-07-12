import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { createProduct } from '@/lib/storage/products';
import { analyzeWithGemini } from '@/lib/ai/gemini';
import { normalizePlatformFromUrl } from '@/lib/productScoring';
import type { CreateProductInput, ProductSource } from '@/lib/types';

export const dynamic = 'force-dynamic';

const FETCH_TIMEOUT = 8000;
const PLACEHOLDER_IMAGE = '/images/placeholder-product.png';

interface ExtractedMeta { title?: string; description?: string; ogImage?: string; canonical?: string; jsonLd?: unknown; jsonLdImage?: string; price?: number; currency?: string; }
function asRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }

function extractMeta(html: string): ExtractedMeta {
  const meta: ExtractedMeta = {
    title: undefined,
    description: undefined,
    ogImage: undefined,
    canonical: undefined,
    jsonLd: undefined,
    price: undefined,
    currency: undefined,
  };

  const metaTag = (name: string, prop = 'name') => {
    const re = new RegExp(`<meta[^>]+${prop}=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
    const m = html.match(re);
    return m ? m[1] : undefined;
  };

  meta.title = metaTag('title') || metaTag('og:title', 'property') || undefined;
  meta.description = metaTag('description') || metaTag('og:description', 'property') || undefined;
  meta.ogImage = metaTag('og:image', 'property') || undefined;

  const canon = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  if (canon) meta.canonical = canon[1];

  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jm;
  while ((jm = jsonLdRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(jm[1]);
      if (!meta.jsonLd) meta.jsonLd = parsed;
      else if (!Array.isArray(meta.jsonLd)) meta.jsonLd = [meta.jsonLd, parsed];
      else meta.jsonLd.push(parsed);
    } catch {}
  }

  if (meta.jsonLd) {
    const candidates = Array.isArray(meta.jsonLd) ? meta.jsonLd : [meta.jsonLd];
    const pick = candidates.map(asRecord).find((item) => item?.['@type'] && String(item['@type']).toLowerCase().includes('product')) || asRecord(candidates[0]);
    if (pick) {
      if (pick.image) meta.jsonLdImage = Array.isArray(pick.image) ? String(pick.image[0] || '') : String(pick.image);
      const offers = pick.offers || pick.Offers || pick.aggregateOffer;
      const offer = Array.isArray(offers) ? asRecord(offers[0]) : asRecord(offers);
      if (offer) {
        const price = offer.price;
        const currency = offer.priceCurrency || offer.currency;
        if (price) meta.price = Number(price);
        if (currency) meta.currency = String(currency);
      }
    }
  }

  return meta;
}

async function fetchWithTimeout(url: string, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(id);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const url = body.url;
    const source: ProductSource = body.source === 'accesstrade' ? 'accesstrade' : 'manual';
    const notes = typeof body.notes === 'string' ? body.notes : '';

    if (!url || typeof url !== 'string') return errorResponse('URL sản phẩm là bắt buộc.');
    try { new URL(url); } catch { return errorResponse('URL không hợp lệ.'); }

    const res = await fetchWithTimeout(url);
    const html = res?.text || '';
    const meta = extractMeta(html);

    const image = meta.jsonLdImage || meta.ogImage || PLACEHOLDER_IMAGE;

    const platform = normalizePlatformFromUrl(url) || 'website';

    const sanitized = {
      title: meta.title || undefined,
      description: meta.description || undefined,
      canonical: meta.canonical || url,
      image,
      price: meta.price ?? undefined,
      currency: meta.currency || undefined,
      source,
      notes,
    };

    let aiResult = null;
    try {
      aiResult = await analyzeWithGemini(sanitized);
    } catch { /* local fallback */ }

    const title = aiResult?.name || sanitized.title || 'Sản phẩm';

    const productInput: CreateProductInput = {
      title: String(title).slice(0, 240),
      description: sanitized.description || undefined,
      kind: 'product',
      platform,
      source,
      originalUrl: sanitized.canonical,
      affiliateUrl: typeof body.affiliateUrl === 'string' ? body.affiliateUrl : undefined,
      imageUrl: sanitized.image,
      gallery: [],
      price: aiResult?.price ?? sanitized.price ?? undefined,
      salePrice: undefined,
      currency: 'VND',
      priceNote: aiResult?.priceNote || (sanitized.price ? 'Giá có thể thay đổi' : undefined),
      category: aiResult?.category || undefined,
      tags: [],
      benefits: aiResult?.benefits || [],
      painPoints: [],
      targetAudience: aiResult?.audience || [],
      warnings: aiResult?.riskNotes || [],
      contentAngles: aiResult?.contentAngle ? [aiResult.contentAngle] : [],
      complianceNotes: [],
      affiliateSource: source === 'accesstrade' ? 'accesstrade' : undefined,
      campaignName: undefined,
      commissionNote: undefined,
      affiliateDisclosure: aiResult?.affiliateDisclosure || 'Bài viết có thể chứa link affiliate. Giá và ưu đãi có thể thay đổi.',
      riskLevel: 'unknown',
      status: 'needs_review',
      rawSourceType: 'enriched',
    };

    const saved = await createProduct(productInput);

    const summary = {
      id: saved.id,
      title: saved.title,
      platform: saved.platform,
      status: saved.status,
      aiGenerated: !!aiResult,
      imageUrl: saved.imageUrl,
      price: saved.price,
    };

    return successResponse('Đã phân tích và lưu sản phẩm tạm thời.', { summary, raw: { sanitized, aiResult: aiResult ? aiResult : null } }, 201);
  } catch (err) {
    return serverErrorResponse('Không thể phân tích sản phẩm.', err);
  }
}
