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

function hasExternalUrl(product: Product): boolean {
  const p = product as Product & {
    url?: unknown;
    originalUrl?: unknown;
    affiliateUrl?: unknown;
    productUrl?: unknown;
    landingUrl?: unknown;
  };

  const urls = [
    p.affiliateUrl,
    p.originalUrl,
    p.url,
    p.productUrl,
    p.landingUrl,
  ];

  return urls.some((url) => typeof url === 'string' && /^https?:\/\//i.test(url));
}

function hasPlatformOrSource(product: Product): boolean {
  const p = product as Product & {
    platform?: unknown;
    source?: unknown;
    dataSource?: unknown;
  };

  return Boolean(
      normalizeText(p.platform) ||
      normalizeText(p.source) ||
      normalizeText(p.dataSource),
  );
}

function getEffectiveKind(product: Product): ProductKind {
  const p = product as Product & {
    sourceItemKind?: ProductKind;
    kind?: ProductKind;
  };

  return classifyProductKind({
    ...product,
    kind: p.sourceItemKind || p.kind,
  });
}

function hasUnsafeFlags(product: Product): boolean {
  const p = product as Product & {
    isDemo?: boolean;
    isSample?: boolean;
    isTest?: boolean;
    isInternal?: boolean;
    publicHidden?: boolean;
    archived?: boolean;
    deleted?: boolean;
    hidden?: boolean;
  };

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

export function isPublicSafeProduct(product?: Product | null): boolean {
  if (!product) return false;

  const p = product as Product & {
    source?: unknown;
    dataSource?: unknown;
    linkHealthStatus?: unknown;
    sourceItemKind?: ProductKind;
    kind?: ProductKind;
    verifiedSource?: boolean;
  };

  const status = normalizeText(p.status);

  // Public chỉ cho approved hoặc published.
  if (status !== 'approved' && status !== 'published') {
    return false;
  }

  // Không cho dữ liệu bị ẩn/lưu trữ/demo/test/sample lọt ra public.
  if (hasUnsafeFlags(product)) {
    return false;
  }

  // Title phải có và không được là demo/test.
  if (!p.title || looksLikeDemoTitle(p.title)) {
    return false;
  }

  // Chặn voucher/campaign/store offer bằng cả kind và heuristic title.
  const effectiveKind = getEffectiveKind(product);

  if (isUnsafePublicKind(effectiveKind)) {
    return false;
  }

  // Dữ liệu cũ có thể chưa có kind/sourceItemKind, nên vẫn phải soi theo title.
  if (looksLikeVoucherOrCampaign(product) || looksLikeVoucherOrCampaign(p.title)) {
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

  // Manual source phải được xác minh.
  if (normalizeText(p.source) === 'manual' && p.verifiedSource !== true) {
    return false;
  }

  // Chặn link lỗi/hết hàng/unavailable.
  const linkHealthStatus = normalizeText(p.linkHealthStatus);

  if (linkHealthStatus && BROKEN_LINK_STATUSES.has(linkHealthStatus)) {
    return false;
  }

  return true;
}