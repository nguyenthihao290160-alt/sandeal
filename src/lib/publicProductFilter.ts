import type { Product, ProductKind } from './types';
import {
  classifyProductKind,
  looksLikeVoucherOrCampaign,
} from './sourceItemClassifier';

const DEMO_TITLES = [
  'Tai nghe Bluetooth TWS Pro Max',
  'Balo laptop chống nước 15.6 inch',
];

const BROKEN_LINK_STATUSES = new Set<string>([
  'broken',
  'broken_link',
  'not_found',
  'affiliate_error',
  'image_broken',
  'product_unavailable',
  'server_error',
  'error',
  'failed',
  'dead',
  'redirect_error',
  'unavailable',
  'out_of_stock',
]);

const UNSAFE_SOURCE_VALUES = new Set<string>([
  'demo',
  'sample',
  'test',
  'internal',
  'mock',
  'placeholder',
]);

const NON_PUBLIC_KINDS = new Set<ProductKind | string>([
  'voucher',
  'campaign',
  'store_offer',
  'unknown',
]);

type ProductRecord = Product &
    Record<string, unknown> & {
  sourceItemKind?: ProductKind;
  kind?: ProductKind;
  source?: unknown;
  dataSource?: unknown;
  platform?: unknown;
  verifiedSource?: boolean;
  sourceVerified?: boolean;
  needsVerification?: boolean;
  publicHidden?: boolean;
  archived?: boolean;
  deleted?: boolean;
  hidden?: boolean;
  isDemo?: boolean;
  isSample?: boolean;
  isTest?: boolean;
  isInternal?: boolean;
  linkHealthStatus?: unknown;
  linkHealth?: unknown;
  affiliateUrl?: unknown;
  originalUrl?: unknown;
  url?: unknown;
  productUrl?: unknown;
  landingUrl?: unknown;
  currentPrice?: unknown;
  originalPrice?: unknown;
};

function asRecord(product: Product): ProductRecord {
  return product as ProductRecord;
}

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

function parsePositiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const digitsOnly = trimmed.replace(/[^\d]/g, '');
  if (!digitsOnly) return undefined;

  const parsed = Number(digitsOnly);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function hasExternalUrl(product: Product): boolean {
  const p = asRecord(product);

  const urls = [
    p.affiliateUrl,
    p.originalUrl,
    p.url,
    p.productUrl,
    p.landingUrl,
  ];

  return urls.some((url) => typeof url === 'string' && /^https?:\/\//i.test(url.trim()));
}

function hasPlatformOrSource(product: Product): boolean {
  const p = asRecord(product);

  return Boolean(
      normalizeText(p.platform) ||
      normalizeText(p.source) ||
      normalizeText(p.dataSource),
  );
}

function hasRealImage(product: Product): boolean {
  return Boolean(product.imageUrl && String(product.imageUrl).trim());
}

function hasRealPrice(product: Product): boolean {
  const p = asRecord(product);

  const priceCandidates = [
    product.price,
    product.salePrice,
    p.currentPrice,
    p.originalPrice,
  ];

  return priceCandidates.some((value) => Boolean(parsePositiveNumber(value)));
}

function getEffectiveKind(product: Product): ProductKind {
  const p = asRecord(product);

  const explicitKind = p.sourceItemKind || p.kind;

  if (explicitKind && explicitKind !== 'unknown') {
    const looksUnsafe =
        looksLikeVoucherOrCampaign({
          title: product.title,
          description: product.description,
          rawSourceKind: p.rawSourceKind,
          source: p.source,
          raw: product,
        }) || looksLikeVoucherOrCampaign(product.title);

    if ((explicitKind === 'product' || explicitKind === 'deal') && looksUnsafe) {
      return classifyProductKind({
        ...product,
        kind: undefined,
        sourceItemKind: undefined,
      } as Partial<Product>);
    }

    return explicitKind;
  }

  return classifyProductKind({
    ...product,
    kind: undefined,
    sourceItemKind: undefined,
  } as Partial<Product>);
}

function hasUnsafeFlags(product: Product): boolean {
  const p = asRecord(product);

  return Boolean(
      p.publicHidden === true ||
      p.archived === true ||
      p.deleted === true ||
      p.hidden === true ||
      p.isDemo === true ||
      p.isSample === true ||
      p.isTest === true ||
      p.isInternal === true,
  );
}

export function looksLikeDemoTitle(title?: string): boolean {
  if (!title) return false;

  const normalizedTitle = normalizeText(title);

  if (DEMO_TITLES.some((demoTitle) => normalizeText(demoTitle) === normalizedTitle)) {
    return true;
  }

  return (
      normalizedTitle.includes('demo') ||
      normalizedTitle.includes('sample') ||
      normalizedTitle.includes('test product') ||
      normalizedTitle.includes('test san pham') ||
      normalizedTitle.includes('san pham test') ||
      normalizedTitle.includes('du lieu test') ||
      normalizedTitle.includes('placeholder')
  );
}

export function isUnsafeSourceValue(source?: unknown): boolean {
  const normalizedSource = normalizeText(source);
  if (!normalizedSource) return false;

  return UNSAFE_SOURCE_VALUES.has(normalizedSource);
}

export function isUnsafePublicKind(kind?: ProductKind | string): boolean {
  if (!kind) return true;
  return NON_PUBLIC_KINDS.has(kind);
}

function isBrokenOrUnavailable(product: Product): boolean {
  const p = asRecord(product);

  const linkHealthStatus =
      normalizeText(p.linkHealthStatus) ||
      normalizeText(p.linkHealth);

  if (!linkHealthStatus) return false;

  return BROKEN_LINK_STATUSES.has(linkHealthStatus);
}

function looksUnsafeForPublic(product: Product): boolean {
  const p = asRecord(product);

  return Boolean(
      looksLikeVoucherOrCampaign({
        title: product.title,
        description: product.description,
        rawSourceKind: p.rawSourceKind,
        source: p.source,
        raw: product,
      }) || looksLikeVoucherOrCampaign(product.title),
  );
}

function isManualUnverified(product: Product): boolean {
  const p = asRecord(product);

  return (
      normalizeText(p.source) === 'manual' &&
      p.verifiedSource !== true &&
      p.sourceVerified !== true
  );
}

function isSourceExplicitlyUnverified(product: Product): boolean {
  const p = asRecord(product);

  return p.verifiedSource === false || p.sourceVerified === false || p.needsVerification === true;
}

export function isPublicSafeProduct(product?: Product | null): boolean {
  if (!product) return false;

  const p = asRecord(product);
  const status = normalizeText(product.status);

  // Public chỉ cho sản phẩm đã duyệt hoặc đã publish.
  // AutoPilot SourceScout có thể tự set status = published nếu đạt chuẩn.
  if (status !== 'approved' && status !== 'published') {
    return false;
  }

  // Không cho dữ liệu bị ẩn/lưu trữ/demo/test/sample lọt ra public.
  if (hasUnsafeFlags(product)) {
    return false;
  }

  // Title phải có và không được là demo/test.
  if (!product.title || !String(product.title).trim() || looksLikeDemoTitle(product.title)) {
    return false;
  }

  // Chặn voucher/campaign/store offer/unknown bằng kind và heuristic.
  const effectiveKind = getEffectiveKind(product);

  if (isUnsafePublicKind(effectiveKind)) {
    return false;
  }

  if (effectiveKind !== 'product' && effectiveKind !== 'deal') {
    return false;
  }

  if (looksUnsafeForPublic(product)) {
    return false;
  }

  // Không cho source demo/sample/test/internal.
  if (isUnsafeSourceValue(p.source) || isUnsafeSourceValue(p.dataSource)) {
    return false;
  }

  // Phải có nền tảng hoặc nguồn dữ liệu.
  if (!hasPlatformOrSource(product)) {
    return false;
  }

  // Phải có link mua hàng/affiliate thật.
  if (!hasExternalUrl(product)) {
    return false;
  }

  // Phải có ảnh thật.
  if (!hasRealImage(product)) {
    return false;
  }

  // Phải có giá thật.
  if (!hasRealPrice(product)) {
    return false;
  }

  // Manual source phải được xác minh.
  if (isManualUnverified(product)) {
    return false;
  }

  // Nếu source báo rõ chưa verified / needsVerification thì không public.
  if (isSourceExplicitlyUnverified(product)) {
    return false;
  }

  // Chặn link lỗi/hết hàng/unavailable.
  if (isBrokenOrUnavailable(product)) {
    return false;
  }

  return true;
}