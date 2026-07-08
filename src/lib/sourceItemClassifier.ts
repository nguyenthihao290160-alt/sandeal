import type { Product, ProductKind } from './types';

export function looksLikeVoucherOrCampaign(title?: string): boolean {
  if (!title) return false;
  const t = title.toLowerCase();

  // Common Vietnamese/English markers for vouchers/coupons/offers
  const voucherMarkers = ['giảm', 'mã', 'voucher', 'coupon', 'ưu đãi', 'khuyến mãi', 'khuyen mai', 'off', '% giảm', '%off'];
  for (const m of voucherMarkers) {
    if (t.includes(m)) return true;
  }

  // Titles containing percent or numbers followed by 'k' or 'đ' often indicate discounts
  if (/\d+\s*(k|₫|vnd|đ)/i.test(t)) return true;
  if (/\d+%/.test(t)) return true;

  // Bracketed store prefixes like [ROCKSPACE OFFICIAL STORE]
  if (/\[.*official.*store.*\]/i.test(title) || /official store/i.test(title) || /official shop/i.test(title)) return true;

  return false;
}

export function classifyProductKind(p: Partial<Product> | { title?: string; rawSourceType?: string; rawSourceKind?: string; source?: string } ): ProductKind {
  // Prefer explicit kind if present and valid
  const maybeKind = (p as any).kind as ProductKind | undefined;
  if (maybeKind && ['product','voucher','campaign','deal','store_offer','unknown'].includes(maybeKind)) return maybeKind;

  const rawKind = ((p as any).rawSourceKind || (p as any).rawSourceType || '').toString().toLowerCase();
  if (rawKind.includes('voucher') || rawKind.includes('coupon')) return 'voucher';
  if (rawKind.includes('campaign') || rawKind.includes('offer')) return 'campaign';
  if (rawKind.includes('product')) return 'product';
  if (rawKind.includes('store') || rawKind.includes('shop')) return 'store_offer';

  const title = (p && (p as any).title) ? (p as any).title.toString() : '';
  if (looksLikeVoucherOrCampaign(title)) {
    // Further distinguish store_offer if title contains 'store' or 'shop' prefix
    if (/\[.*store.*\]/i.test(title) || /official store/i.test(title) || /official shop/i.test(title) || (/official/i.test(title) && /store|shop/i.test(title))) {
      return 'store_offer';
    }

    // If title contains keywords for campaign
    if (/campaign|chiến dịch|chiến-dịch/i.test(title)) return 'campaign';

    return 'voucher';
  }

  // Heuristic: if title has a clear price and image/affiliate links would be better detected upstream;
  // For safety, fall back to unknown
  return 'unknown';
}
