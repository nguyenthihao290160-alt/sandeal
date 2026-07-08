import type { Product, ProductKind } from './types';

type ClassifierInput = Partial<Product> & {
  title?: unknown;
  name?: unknown;
  description?: unknown;
  source?: unknown;
  platform?: unknown;

  kind?: unknown;
  sourceItemKind?: unknown;
  rawSourceKind?: unknown;
  rawSourceType?: unknown;
  sourceType?: unknown;
  itemType?: unknown;
  type?: unknown;

  imageUrl?: unknown;
  image?: unknown;
  thumbnail?: unknown;
  logo?: unknown;

  affiliateUrl?: unknown;
  url?: unknown;
  productUrl?: unknown;
  landingUrl?: unknown;

  price?: unknown;
  salePrice?: unknown;
  originalPrice?: unknown;
  finalPrice?: unknown;

  sku?: unknown;
  skuId?: unknown;
  productId?: unknown;
  itemId?: unknown;

  raw?: unknown;
};

const VALID_PRODUCT_KINDS = new Set<string>([
  'product',
  'voucher',
  'campaign',
  'deal',
  'store_offer',
  'unknown',
]);

const VOUCHER_WORDS = [
  'voucher',
  'coupon',
  'ma giam',
  'ma uu dai',
  'giam gia',
  'uu dai',
  'khuyen mai',
  'don hang tu',
  'don toi thieu',
  'toi da',
  'freeship',
  'free ship',
  'mien phi van chuyen',
  'hoan tien',
  'cashback',
  'flash sale',
  'sale off',
];

const CAMPAIGN_WORDS = [
  'campaign',
  'chien dich',
  'collection',
  'bo suu tap',
  'landing page',
  'brand campaign',
  'mega sale',
  'super sale',
];

const STORE_WORDS = [
  'official store',
  'official shop',
  'store',
  'shop',
  'mall',
  'flagship',
];

function normalizeText(value?: unknown): string {
  if (value === null || value === undefined) return '';

  return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getText(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (value !== null && value !== undefined && String(value).trim()) {
      return String(value);
    }
  }

  const raw = asRecord(input.raw);
  if (raw) {
    for (const key of keys) {
      const value = raw[key];
      if (value !== null && value !== undefined && String(value).trim()) {
        return String(value);
      }
    }
  }

  return '';
}

function hasAny(text: string, markers: string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

function toProductKind(value: unknown): ProductKind | undefined {
  if (!value) return undefined;

  const normalized = normalizeText(value);

  if (!VALID_PRODUCT_KINDS.has(normalized)) {
    return undefined;
  }

  return normalized as ProductKind;
}

function hasUsableUrl(input: Record<string, unknown>): boolean {
  const value = getText(input, ['affiliateUrl', 'url', 'productUrl', 'landingUrl']);
  return /^https?:\/\//i.test(value);
}

function hasUsableImage(input: Record<string, unknown>): boolean {
  const value = getText(input, ['imageUrl', 'image', 'thumbnail', 'logo']);
  return /^https?:\/\//i.test(value);
}

function hasProductIdentifier(input: Record<string, unknown>): boolean {
  const value = getText(input, ['sku', 'skuId', 'productId', 'itemId']);
  return Boolean(value);
}

function hasPriceLikeValue(input: Record<string, unknown>): boolean {
  const keys = ['price', 'salePrice', 'originalPrice', 'finalPrice'];

  for (const key of keys) {
    const value = input[key];

    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return true;
    }

    if (typeof value === 'string') {
      const compact = value.trim();
      if (!compact) continue;

      const numeric = Number(compact.replace(/[^\d.]/g, ''));
      if (Number.isFinite(numeric) && numeric > 0) {
        return true;
      }
    }
  }

  const raw = asRecord(input.raw);
  if (!raw) return false;

  for (const key of keys) {
    const value = raw[key];

    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return true;
    }

    if (typeof value === 'string') {
      const compact = value.trim();
      if (!compact) continue;

      const numeric = Number(compact.replace(/[^\d.]/g, ''));
      if (Number.isFinite(numeric) && numeric > 0) {
        return true;
      }
    }
  }

  return false;
}

function rawKindText(input: Record<string, unknown>): string {
  const own = getText(input, [
    'rawSourceKind',
    'rawSourceType',
    'sourceType',
    'itemType',
    'type',
  ]);

  const raw = asRecord(input.raw);
  const rawText = raw
      ? getText(raw, ['kind', 'type', 'sourceType', 'itemType', 'category', 'objectType'])
      : '';

  return normalizeText(`${own} ${rawText}`);
}

function titleTextFromInput(input: unknown): string {
  if (typeof input === 'string') return input;

  const record = asRecord(input);
  if (!record) return '';

  return getText(record, ['title', 'name']);
}

/**
 * Defensive detector for old .data records too.
 * This intentionally catches voucher/campaign/store-offer titles even when sourceItemKind is missing.
 */
export function looksLikeVoucherOrCampaign(input?: unknown): boolean {
  const title = normalizeText(titleTextFromInput(input));

  if (!title) return false;

  const hasVoucherWords = hasAny(title, VOUCHER_WORDS);
  const hasCampaignWords = hasAny(title, CAMPAIGN_WORDS);

  // Examples:
  // [ROCKSPACE OFFICIAL STORE]-Giảm 10K cho đơn hàng từ 100K
  // [Deli Official Store]-Giảm 8% tối đa 45K cho đơn hàng từ 399K
  const bracketedStoreOffer =
      /^\[[^\]]+\]\s*-\s*/.test(title) &&
      (hasVoucherWords || /\d+\s*%/.test(title) || /\bgiam\b/.test(title));

  const officialStoreOffer =
      hasAny(title, STORE_WORDS) &&
      (hasVoucherWords ||
          /\d+\s*%/.test(title) ||
          /\b\d+\s*(k|vnd|d|đ)\b/i.test(title));

  const discountPattern =
      /\b(giam|uu dai|khuyen mai|voucher|coupon)\b/.test(title) &&
      (/\d+\s*%/.test(title) ||
          /\b\d+\s*(k|vnd|d|đ)\b/i.test(title) ||
          title.includes('don hang tu') ||
          title.includes('toi da'));

  return Boolean(
      hasVoucherWords ||
      hasCampaignWords ||
      bracketedStoreOffer ||
      officialStoreOffer ||
      discountPattern,
  );
}

/**
 * Classifies AccessTrade/local/manual source items.
 * Safety rule: when unsure, return "unknown" instead of pretending it is a product.
 */
export function classifyProductKind(
    product: ClassifierInput | Partial<Product> | string | undefined | null,
): ProductKind {
  if (!product) return 'unknown';

  if (typeof product === 'string') {
    return looksLikeVoucherOrCampaign(product) ? 'voucher' : 'unknown';
  }

  const input = asRecord(product);
  if (!input) return 'unknown';

  const explicitKind =
      toProductKind(input.sourceItemKind) ||
      toProductKind(input.kind);

  if (explicitKind) {
    return explicitKind;
  }

  const title = getText(input, ['title', 'name']);
  const normalizedTitle = normalizeText(title);
  const rawKind = rawKindText(input);

  if (rawKind.includes('voucher') || rawKind.includes('coupon')) {
    return 'voucher';
  }

  if (rawKind.includes('campaign')) {
    return 'campaign';
  }

  if (
      rawKind.includes('store_offer') ||
      rawKind.includes('store offer') ||
      rawKind.includes('shop offer')
  ) {
    return 'store_offer';
  }

  const isVoucherLike = looksLikeVoucherOrCampaign(product);

  if (isVoucherLike) {
    const isStoreOffer =
        /^\[[^\]]+\]\s*-\s*/.test(normalizedTitle) ||
        hasAny(normalizedTitle, STORE_WORDS);

    if (isStoreOffer) {
      return 'store_offer';
    }

    if (hasAny(normalizedTitle, CAMPAIGN_WORDS)) {
      return 'campaign';
    }

    return 'voucher';
  }

  if (rawKind.includes('product')) {
    return 'product';
  }

  const hasEnoughProductData =
      Boolean(normalizedTitle) &&
      hasUsableUrl(input) &&
      (hasUsableImage(input) || hasProductIdentifier(input) || hasPriceLikeValue(input));

  if (hasEnoughProductData) {
    return 'product';
  }

  return 'unknown';
}

/**
 * Alias for newer code paths.
 * Keep classifyProductKind for old imports, and use classifySourceItem for clearer naming.
 */
export function classifySourceItem(
    input: ClassifierInput | Partial<Product> | string | undefined | null,
): ProductKind {
  return classifyProductKind(input);
}

export function isNonProductKind(kind: ProductKind | undefined): boolean {
  return (
      !kind ||
      kind === 'voucher' ||
      kind === 'campaign' ||
      kind === 'store_offer' ||
      kind === 'unknown'
  );
}

export function isProductKind(kind: ProductKind | undefined): boolean {
  return kind === 'product' || kind === 'deal';
}

export function getProductKindLabel(kind: ProductKind | undefined): string {
  switch (kind) {
    case 'product':
    case 'deal':
      return 'Sản phẩm';
    case 'voucher':
      return 'Voucher';
    case 'campaign':
      return 'Chiến dịch';
    case 'store_offer':
      return 'Ưu đãi shop';
    case 'unknown':
    default:
      return 'Chưa rõ';
  }
}