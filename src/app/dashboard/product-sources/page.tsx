'use client';

import {
  useCallback,
  useEffect,
  useState,
} from 'react';
import Link from 'next/link';
import { DashboardIcon, type DashboardIconName } from '@/components/dashboard/dashboard-icon';
import type { Product, ProductKind } from '@/lib/types';
import { pollScanJob, type ScanJobResult } from '@/lib/dashboard/scanPolling';

// ---- Tab IDs ----
const TABS = [
  { id: 'accesstrade', label: 'AccessTrade', icon: 'source' },
  { id: 'shopee', label: 'Nguồn Shopee', icon: 'product' },
  { id: 'tiktok', label: 'TikTok Shop', icon: 'external' },
  { id: 'lazada', label: 'Lazada', icon: 'product' },
  { id: 'csv', label: 'Nhập tệp bảng dữ liệu (CSV)', icon: 'content' },
  { id: 'other', label: 'Nguồn khác', icon: 'source' },
] as const;

type TabId = (typeof TABS)[number]['id'];

type Toast = {
  type: 'success' | 'error' | 'info';
  message: string;
};

type AccessTradeItem = Record<string, unknown> & {
  id?: string;
  productId?: string;
  sourceId?: string;
  name?: string;
  title?: string;
  description?: string;
  kind?: ProductKind | string;
  sourceItemKind?: ProductKind | string;
  imageUrl?: string;
  originalUrl?: string;
  affiliateUrl?: string;
  affiliateUrlSource?: string;
  deepLinkSupported?: boolean;
  affiliateLinkReason?: string;
  url?: string;
  price?: number | string;
  salePrice?: number | string;
  currentPrice?: number | string;
  originalPrice?: number | string;
  category?: string;
  campaignName?: string;
  rawSourceKind?: string;
  needsVerification?: boolean;
  verifiedSource?: boolean;
  sourceVerified?: boolean;
  publicHidden?: boolean;
  autoPublishEligible?: boolean;
  publicDecision?: string;
  publicBlockReason?: string;
  nonProductReason?: string;
  autoPublishBlockedReason?: string;
  unpublishedReason?: string;
  linkHealthStatus?: string;
  imageHealthStatus?: string;
  qualityScore?: number | string;
  sourceQualityScore?: number | string;
  rawData?: Record<string, unknown>;
};

type AccessTradeResults = {
  items: AccessTradeItem[];
  products?: AccessTradeItem[];
  vouchers?: AccessTradeItem[];
  campaigns?: AccessTradeItem[];
  storeOffers?: AccessTradeItem[];
  unknown?: AccessTradeItem[];
  summary: {
    total?: number;
    products?: number;
    realProducts?: number;
    vouchers?: number;
    campaigns?: number;
    storeOffers?: number;
    unknown?: number;
    publicEligibleProducts?: number;
    publicCandidates?: number;
    needsReview?: number;
    archived?: number;
    blockedFromPublic?: number;
    nonProducts?: number;
  };
};

type ApiEnvelope<T> = {
  ok?: boolean;
  success?: boolean;
  message?: string;
  error?: string;
  data?: T;
};



const KIND_LABELS: Record<string, string> = {
  product: 'Sản phẩm',
  deal: 'Ưu đãi',
  store_offer: 'Ưu đãi shop',
  voucher: 'Mã giảm giá (voucher)',
  campaign: 'Chiến dịch',
  unknown: 'Chưa rõ',
};

const KIND_BADGES: Record<string, string> = {
  product: 'badge-success',
  deal: 'badge-success',
  store_offer: 'badge-warning',
  voucher: 'badge-warning',
  campaign: 'badge-warning',
  unknown: 'badge-neutral',
};

const PUBLIC_DECISION_LABELS: Record<string, { label: string; badge: string }> =
    {
      public_candidate: { label: 'Ứng viên nguồn', badge: 'badge-info' },
      needs_review: { label: 'Cần xem xét', badge: 'badge-warning' },
      archived: { label: 'Lưu nội bộ', badge: 'badge-neutral' },
      blocked: { label: 'Bị chặn', badge: 'badge-danger' },
    };

const PLATFORM_LABELS: Record<string, string> = {
  shopee: 'Shopee',
  tiktok_shop: 'TikTok Shop',
  lazada: 'Lazada',
  accesstrade: 'AccessTrade',
  website: 'Website',
  tiki: 'Tiki',
  sendo: 'Sendo',
  fahasa: 'Fahasa',
  other: 'Khác',
};

const ACCESS_TRADE_KEYWORD_SUGGESTIONS = [
  'tai nghe',
  'serum',
  'sữa tắm',
  'kem chống nắng',
  'sạc dự phòng',
  'nồi chiên không dầu',
];



function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return '';

  return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'd')
      .toLowerCase()
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseMoneyNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;

  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 1000 ? value : undefined;
  }

  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed || /%/.test(trimmed)) return undefined;

  const normalized = normalizeText(trimmed);

  if (
      normalized.includes('mien phi') ||
      normalized.includes('free') ||
      normalized.includes('lien he') ||
      normalized.includes('contact')
  ) {
    return undefined;
  }

  const millionMatch = normalized.match(
      /(\d+(?:[.,]\d+)?)\s*(trieu|million)\b/i,
  );

  if (millionMatch) {
    const parsed = Number(millionMatch[1].replace(',', '.')) * 1_000_000;
    return Number.isFinite(parsed) && parsed >= 1000
        ? Math.round(parsed)
        : undefined;
  }

  const thousandMatch = normalized.match(
      /(\d+(?:[.,]\d+)?)\s*(k|nghin|ngan)\b/i,
  );

  if (thousandMatch) {
    const parsed = Number(thousandMatch[1].replace(',', '.')) * 1000;
    return Number.isFinite(parsed) && parsed >= 1000
        ? Math.round(parsed)
        : undefined;
  }

  const groupedNumberMatch = trimmed.match(/\d{1,3}(?:[.,]\d{3})+/);

  if (groupedNumberMatch) {
    const parsed = Number(groupedNumberMatch[0].replace(/[^\d]/g, ''));
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : undefined;
  }

  const plainNumberMatch = trimmed.match(/\d{4,}/);

  if (plainNumberMatch) {
    const parsed = Number(plainNumberMatch[0]);
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : undefined;
  }

  return undefined;
}



function getNumber(value: unknown): number | undefined {
  return parseMoneyNumber(value);
}

function getBoolean(value: unknown): boolean {
  const normalized = normalizeText(value);

  return (
      value === true ||
      value === 1 ||
      normalized === 'true' ||
      normalized === 'yes'
  );
}

function isValidHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;

  const url = value.trim();

  if (!/^https?:\/\//i.test(url)) return false;

  try {
    const parsed = new URL(url);

    return (
        Boolean(parsed.hostname) &&
        (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    );
  } catch {
    return false;
  }
}

function isValidImageUrl(value: unknown): boolean {
  if (!isValidHttpUrl(value)) return false;

  const normalized = normalizeText(value);

  return !(
      normalized.includes('placeholder') ||
      normalized.includes('sample') ||
      normalized.includes('demo') ||
      normalized.includes('fake')
  );
}

function getPlatformLabel(platform: unknown): string {
  const value = getString(platform) || 'other';

  return PLATFORM_LABELS[value] || value || 'Khác';
}

function translateInternalReason(value: unknown): string {
  const raw = getString(value);
  const normalized = normalizeText(raw);

  if (!normalized) return '';

  if (normalized === 'auto_mode_disabled') {
    return 'Chế độ tự động đang tắt hoặc chưa cho phép tự đăng.';
  }

  if (normalized === 'free_only_guard_failed') {
    return 'Quy tắc chỉ dùng dịch vụ miễn phí chưa đạt yêu cầu.';
  }

  if (
      normalized.startsWith('blocked_non_product_kind_') ||
      normalized.startsWith('blocked_kind_')
  ) {
    return 'Loại dữ liệu này không phải sản phẩm cụ thể.';
  }

  if (normalized === 'missing_or_too_short_title') {
    return 'Thiếu tên sản phẩm hoặc tên quá ngắn.';
  }

  if (normalized === 'title_not_specific_enough') {
    return 'Tên chưa đủ cụ thể để xác định sản phẩm thật.';
  }

  if (normalized === 'title_looks_like_voucher_campaign_or_store_offer') {
    return 'Tên giống mã giảm giá, chiến dịch hoặc ưu đãi cửa hàng.';
  }

  if (normalized === 'classifier_detected_voucher_or_campaign') {
    return 'Bộ phân loại phát hiện dữ liệu giống mã giảm giá hoặc chiến dịch.';
  }

  if (
      normalized === 'source_not_verified_for_auto_publish' ||
      normalized === 'source_not_verified'
  ) {
    return 'Nguồn sản phẩm chưa được xác minh.';
  }

  if (normalized === 'missing_platform') {
    return 'Thiếu nền tảng hoặc nguồn sản phẩm.';
  }

  if (normalized === 'missing_affiliate_url') {
    return 'Thiếu affiliate link hợp lệ.';
  }

  if (normalized === 'missing_product_url') {
    return 'Thiếu link sản phẩm hợp lệ.';
  }

  if (
      normalized === 'missing_image' ||
      normalized === 'missing_image_before_health_check'
  ) {
    return 'Thiếu ảnh sản phẩm.';
  }

  if (normalized === 'missing_real_price') {
    return 'Thiếu giá sản phẩm thật.';
  }

  if (normalized === 'needs_verification') {
    return 'Sản phẩm đang cần xác minh thêm.';
  }

  if (normalized.startsWith('public_decision_')) {
    return 'Quy trình đăng an toàn hiện đang chặn sản phẩm.';
  }

  if (normalized === 'source_quality_score_too_low') {
    return 'Điểm chất lượng nguồn thấp.';
  }

  if (normalized === 'missing_link_before_health_check') {
    return 'Thiếu link trước khi kiểm tra sức khoẻ sản phẩm.';
  }

  if (normalized.startsWith('health_check_error')) {
    return 'Lỗi khi kiểm tra link hoặc ảnh, cần xem xét lại.';
  }

  return raw;
}

function getKind(value: unknown): ProductKind | 'unknown' {
  const kind = normalizeText(value);

  if (
      kind === 'product' ||
      kind === 'deal' ||
      kind === 'voucher' ||
      kind === 'campaign' ||
      kind === 'store_offer' ||
      kind === 'unknown'
  ) {
    return kind as ProductKind;
  }

  return 'unknown';
}

function isRealProductKind(kind?: ProductKind | string): boolean {
  return kind === 'product' || kind === 'deal';
}

function isNonProductKind(kind?: ProductKind | string): boolean {
  return (
      kind === 'voucher' ||
      kind === 'campaign' ||
      kind === 'store_offer' ||
      kind === 'unknown'
  );
}

function getKindLabel(kind?: ProductKind | string) {
  return KIND_LABELS[kind || 'unknown'] || 'Chưa rõ';
}

function getKindBadge(kind?: ProductKind | string) {
  return KIND_BADGES[kind || 'unknown'] || 'badge-neutral';
}

function getNonProductReason(kind?: ProductKind | string): string {
  if (kind === 'store_offer') return 'Chưa phải sản phẩm cụ thể.';
  if (kind === 'voucher')
    return 'Mã giảm giá (voucher) không được đăng công khai như sản phẩm.';
  if (kind === 'campaign')
    return 'Chiến dịch khuyến mãi không được đăng công khai như sản phẩm.';
  if (kind === 'unknown') return 'Chưa xác định được đây là sản phẩm thật.';
  return '';
}

function getStatusLabel(status?: string) {
  if (status === 'published') return 'Đã xuất bản';
  if (status === 'approved') return 'Đã duyệt';
  if (status === 'needs_review') return 'Cần xem xét';
  if (status === 'draft') return 'Nháp';
  if (status === 'archived') return 'Lưu trữ';

  return status || 'Không rõ';
}

function getStatusBadgeClass(status?: string) {
  if (status === 'published' || status === 'approved') return 'badge-success';
  if (status === 'needs_review') return 'badge-warning';
  if (status === 'archived') return 'badge-neutral';
  if (status === 'draft') return 'badge-info';

  return 'badge-neutral';
}

function formatPrice(value?: number | string) {
  const parsed = getNumber(value);
  if (!parsed) return '—';

  return `${parsed.toLocaleString('vi-VN')}₫`;
}

function getAtItemName(item: AccessTradeItem): string {
  return getString(item.name) || getString(item.title) || 'Không có tên';
}

function getAtItemKind(item: AccessTradeItem): ProductKind | 'unknown' {
  return getKind(item.kind || item.sourceItemKind);
}

function getAtItemMainReason(item: AccessTradeItem): string {
  const kind = getAtItemKind(item);

  return (
      translateInternalReason(item.publicBlockReason) ||
      translateInternalReason(item.nonProductReason) ||
      translateInternalReason(item.autoPublishBlockedReason) ||
      translateInternalReason(item.unpublishedReason) ||
      getNonProductReason(kind) ||
      (getBoolean(item.needsVerification)
          ? 'Nguồn chưa đủ tín hiệu xác minh sản phẩm thật.'
          : isRealProductKind(kind)
              ? 'Đây mới là ứng viên nguồn; vẫn phải qua bước kiểm tra chất lượng trước khi đăng công khai.'
              : 'Không tự động đăng công khai.')
  );
}

function getAtItemId(item: AccessTradeItem, fallbackIndex?: number): string {
  return (
      getString(item.id) ||
      getString(item.productId) ||
      getString(item.sourceId) ||
      getString(item.affiliateUrl) ||
      getString(item.originalUrl) ||
      getString(item.name) ||
      getString(item.title) ||
      `accesstrade-item-${fallbackIndex ?? 0}`
  );
}

function getAtItemValidationIssues(item: AccessTradeItem): string[] {
  const kind = getAtItemKind(item);
  const issues: string[] = [];

  if (!isRealProductKind(kind)) {
    const nonProductReason = getNonProductReason(kind);
    if (nonProductReason) issues.push(nonProductReason);
    return issues;
  }

  if (!getAtItemName(item) || getAtItemName(item) === 'Không có tên') {
    issues.push('Thiếu tên sản phẩm.');
  }

  if (!isValidHttpUrl(item.affiliateUrl) && item.affiliateLinkReason === 'provider_deeplink_not_supported') {
    issues.push('Nhà cung cấp không cho phép deep-link.');
  } else if (!isValidHttpUrl(item.affiliateUrl)) {
    issues.push('Thiếu affiliate link hợp lệ.');
  }

  if (!isValidImageUrl(item.imageUrl)) {
    issues.push('Thiếu ảnh sản phẩm hợp lệ.');
  }

  if (!getNumber(item.salePrice) && !getNumber(item.price)) {
    issues.push('Thiếu giá sản phẩm thật.');
  }

  if (!(item.verifiedSource === true || item.sourceVerified === true)) {
    issues.push('Nguồn chưa được xác minh đầy đủ.');
  }

  const qualityScore = getAtQualityScore(item);

  if (qualityScore === null || qualityScore < 70) {
    issues.push('Điểm chất lượng nguồn chưa đạt 70.');
  }

  return issues;
}

function getAtPublicDecision(item: AccessTradeItem) {
  const rawDecision = normalizeText(item.publicDecision);
  const kind = getAtItemKind(item);

  if (rawDecision && PUBLIC_DECISION_LABELS[rawDecision]) {
    return PUBLIC_DECISION_LABELS[rawDecision];
  }

  if (isNonProductKind(kind)) {
    return { label: 'Lưu nội bộ', badge: 'badge-neutral' };
  }

  if (getBoolean(item.autoPublishEligible)) {
    return { label: 'Ứng viên nguồn', badge: 'badge-info' };
  }

  return { label: 'Cần xem xét', badge: 'badge-warning' };
}

function getAtQualityScore(item: AccessTradeItem): number | null {
  const raw = item.qualityScore ?? item.sourceQualityScore;
  const score =
      typeof raw === 'number'
          ? raw
          : typeof raw === 'string'
              ? Number(raw)
              : undefined;

  if (score === undefined || !Number.isFinite(score)) return null;

  return Math.round(score);
}

function countAtItems(
    items: AccessTradeItem[],
    kind: ProductKind | string,
): number {
  return items.filter((item) => getAtItemKind(item) === kind).length;
}

function normalizeAtResults(
    data: AccessTradeResults | AccessTradeItem[] | undefined,
): AccessTradeResults {
  if (Array.isArray(data)) {
    return {
      items: data,
      products: data.filter((item) => isRealProductKind(getAtItemKind(item))),
      vouchers: data.filter((item) => getAtItemKind(item) === 'voucher'),
      campaigns: data.filter((item) => getAtItemKind(item) === 'campaign'),
      storeOffers: data.filter((item) => getAtItemKind(item) === 'store_offer'),
      unknown: data.filter((item) => getAtItemKind(item) === 'unknown'),
      summary: {
        total: data.length,
        products: data.filter((item) => isRealProductKind(getAtItemKind(item)))
            .length,
        realProducts: data.filter((item) =>
            isRealProductKind(getAtItemKind(item)),
        ).length,
        vouchers: countAtItems(data, 'voucher'),
        campaigns: countAtItems(data, 'campaign'),
        storeOffers: countAtItems(data, 'store_offer'),
        unknown: countAtItems(data, 'unknown'),
        publicEligibleProducts: data.filter((item) =>
            getBoolean(item.autoPublishEligible),
        ).length,
        blockedFromPublic: data.filter(
            (item) => !getBoolean(item.autoPublishEligible),
        ).length,
        nonProducts: data.filter((item) =>
            isNonProductKind(getAtItemKind(item)),
        ).length,
      },
    };
  }

  const items = Array.isArray(data?.items) ? data.items : [];

  return {
    items,
    products: Array.isArray(data?.products)
        ? data.products
        : items.filter((item) => isRealProductKind(getAtItemKind(item))),
    vouchers: Array.isArray(data?.vouchers)
        ? data.vouchers
        : items.filter((item) => getAtItemKind(item) === 'voucher'),
    campaigns: Array.isArray(data?.campaigns)
        ? data.campaigns
        : items.filter((item) => getAtItemKind(item) === 'campaign'),
    storeOffers: Array.isArray(data?.storeOffers)
        ? data.storeOffers
        : items.filter((item) => getAtItemKind(item) === 'store_offer'),
    unknown: Array.isArray(data?.unknown)
        ? data.unknown
        : items.filter((item) => getAtItemKind(item) === 'unknown'),
    summary: {
      total: data?.summary?.total ?? items.length,
      products:
          data?.summary?.products ??
          data?.summary?.realProducts ??
          items.filter((item) => isRealProductKind(getAtItemKind(item))).length,
      realProducts:
          data?.summary?.realProducts ??
          data?.summary?.products ??
          items.filter((item) => isRealProductKind(getAtItemKind(item))).length,
      vouchers: data?.summary?.vouchers ?? countAtItems(items, 'voucher'),
      campaigns: data?.summary?.campaigns ?? countAtItems(items, 'campaign'),
      storeOffers:
          data?.summary?.storeOffers ?? countAtItems(items, 'store_offer'),
      unknown: data?.summary?.unknown ?? countAtItems(items, 'unknown'),
      publicEligibleProducts:
          data?.summary?.publicEligibleProducts ??
          data?.summary?.publicCandidates ??
          items.filter((item) => getBoolean(item.autoPublishEligible)).length,
      publicCandidates:
          data?.summary?.publicCandidates ??
          items.filter(
              (item) => normalizeText(item.publicDecision) === 'public_candidate',
          ).length,
      needsReview:
          data?.summary?.needsReview ??
          items.filter(
              (item) => normalizeText(item.publicDecision) === 'needs_review',
          ).length,
      archived:
          data?.summary?.archived ??
          items.filter(
              (item) => normalizeText(item.publicDecision) === 'archived',
          ).length,
      blockedFromPublic:
          data?.summary?.blockedFromPublic ??
          items.filter((item) => !getBoolean(item.autoPublishEligible)).length,
      nonProducts:
          data?.summary?.nonProducts ??
          items.filter((item) => isNonProductKind(getAtItemKind(item))).length,
    },
  };
}

function getRecentSource(product: Product): string {
  const record = product as Product & Record<string, unknown>;

  return (
      getString(record.source) ||
      getString(record.dataSource) ||
      getString(record.importedFrom) ||
      'unknown'
  );
}

function getRecentKind(product: Product): ProductKind | 'unknown' {
  const record = product as Product & Record<string, unknown>;

  return getKind(record.sourceItemKind || record.kind);
}

function getRecentPublicState(product: Product): {
  label: string;
  badge: string;
} {
  const record = product as Product & Record<string, unknown>;
  const status = normalizeText(product.status);
  const publicDecision = normalizeText(record.publicDecision);

  if (
      status === 'published' &&
      record.publicHidden !== true &&
      record.needsVerification !== true
  ) {
    return { label: 'Đang công khai', badge: 'badge-success' };
  }

  if (status === 'archived' || publicDecision === 'archived') {
    return { label: 'Lưu nội bộ', badge: 'badge-neutral' };
  }

  if (publicDecision === 'blocked' || record.publicHidden === true) {
    return { label: 'Đang bị chặn', badge: 'badge-warning' };
  }

  return { label: 'Cần xem xét', badge: 'badge-warning' };
}

function SafeThumb({
                     src,
                     label = 'S',
                     size = 80,
                   }: {
  src?: string;
  label?: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const cleanSrc = src?.trim() || '';

  useEffect(() => {
    const timer = window.setTimeout(() => setFailed(false), 0);
    return () => window.clearTimeout(timer);
  }, [cleanSrc]);

  if (!cleanSrc || failed) {
    return (
        <div
            style={{
              width: size,
              height: size,
              borderRadius: 'var(--radius-md)',
              overflow: 'hidden',
              background: '#eef2f6',
              color: '#ffffff',
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
              fontWeight: 900,
              fontSize: 14,
            }}
        >
          {label}
        </div>
    );
  }

  return (
      <div
          style={{
            width: size,
            height: size,
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
            background: 'var(--bg-tertiary)',
            flexShrink: 0,
          }}
      >
        <img
            src={cleanSrc}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
        />
      </div>
  );
}

export default function ProductSourcesPage() {
  const [activeTab, setActiveTab] = useState<TabId>('accesstrade');
  const [toast, setToast] = useState<Toast | null>(null);
  const [recentProducts, setRecentProducts] = useState<Product[]>([]);
  const [runningBot, setRunningBot] = useState(false);
  const [scanResult, setScanResult] = useState<(ScanJobResult & { completedAt: string }) | null>(null);

  // AccessTrade state
  const [atKeyword, setAtKeyword] = useState('');
  const [atKind, setAtKind] = useState('product');
  const [atLoading, setAtLoading] = useState(false);
  const [atError, setAtError] = useState('');
  const [atResults, setAtResults] = useState<AccessTradeResults | null>(null);
  const [atSaving, setAtSaving] = useState<string | null>(null);
  const [atConfigured, setAtConfigured] = useState(false);

  const showToast = useCallback((type: Toast['type'], message: string) => {
    setToast({ type, message });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch('/api/products?limit=10', { cache: 'no-store' });
      const data = (await res.json().catch(() => null)) as ApiEnvelope<
          Product[]
      > | null;

      if (res.ok && (data?.ok || data?.success) && Array.isArray(data.data)) {
        setRecentProducts(data.data.slice(0, 10));
      }
    } catch {
      // Ignore recent product preview errors.
    }

    try {
      const healthRes = await fetch('/api/app-health', { cache: 'no-store' });
      const healthData = (await healthRes
          .json()
          .catch(() => null)) as ApiEnvelope<{
        integrations?: {
          accesstrade?: {
            configured?: boolean;
          };
        };
      }> | null;

      if (healthRes.ok && (healthData?.ok || healthData?.success)) {
        setAtConfigured(
            Boolean(healthData.data?.integrations?.accesstrade?.configured),
        );
      } else {
        setAtConfigured(false);
      }
    } catch {
      setAtConfigured(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadRecent(), 0);
    return () => window.clearTimeout(timer);
  }, [loadRecent]);



  const handleProductHealthScan = async () => {
    setRunningBot(true);

    try {
      const res = await fetch('/api/automation/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'RECHECK_PRODUCT_HEALTH',
          payload: { limit: 100, healthTarget: 'all', trigger: 'dashboard' },
          idempotencyKey: `dashboard-product-health:${Date.now()}`,
          dryRun: false,
        }),
      });
      const data = await res.json().catch(() => null) as ApiEnvelope<Record<string, unknown>> | null;
      const jobId = getString(data?.data?.id || data?.data?.jobId);
      if (!res.ok || !data?.ok || !jobId) {
        throw new Error(data?.message || data?.error || `Không tạo được tác vụ quét. HTTP ${res.status}`);
      }
      showToast('info', 'Đã bắt đầu quét');
      const job = await pollScanJob({ jobId });
      if (job.status !== 'SUCCEEDED') {
        throw new Error(job.lastErrorMessage || job.lastErrorCode || `Tác vụ kết thúc với trạng thái ${job.status}.`);
      }
      const result = job.result || {};
      setScanResult({ ...result, completedAt: new Date().toISOString() });
      showToast(
          'success',
          `Quét hoàn tất: đã kiểm tra ${result.checked || result.inspected || 0}, hợp lệ ${result.valid || 0}, bị chặn ${result.blocked || 0}, lỗi ${result.failed || 0}.`,
      );
      await loadRecent();
    } catch (err) {
      showToast(
          'error',
          err instanceof Error ? err.message : 'Không chạy được tác vụ quét.',
      );
    } finally {
      setRunningBot(false);
    }
  };

  const handleAtSearch = async () => {
    if (!atConfigured) {
      showToast(
          'error',
          'AccessTrade chưa được cấu hình. Hãy mở Kết nối bảo mật để thêm khóa kết nối.',
      );
      return;
    }

    const keyword = atKeyword.trim();

    if (keyword.length < 2) {
      showToast(
          'error',
          'Hãy nhập từ khoá sản phẩm cụ thể, ví dụ: serum, sữa tắm, tai nghe.',
      );
      return;
    }

    setAtLoading(true);
    setAtError('');
    setAtResults(null);

    try {
      const res = await fetch('/api/product-sources/accesstrade/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword,
          kind: atKind,
          limit: 20,
          imageOnly: false,
          affiliateLinkOnly: false,
        }),
      });

      const data = (await res.json().catch(() => null)) as ApiEnvelope<
          AccessTradeResults | AccessTradeItem[]
      > | null;

      if (res.ok && (data?.ok || data?.success)) {
        setAtResults(normalizeAtResults(data.data));
      } else {
        setAtError(
            data?.message ||
            data?.error ||
            `Lỗi khi tìm kiếm. HTTP ${res.status}`,
        );
      }
    } catch {
      setAtError('Không thể kết nối đến server.');
    } finally {
      setAtLoading(false);
    }
  };

  const handleAtSave = async (item: AccessTradeItem, runScore = false) => {
    const itemId = getAtItemId(item);
    const kind = getAtItemKind(item);
    const isProduct = isRealProductKind(kind);
    const isNonProduct = isNonProductKind(kind);

    const title = getAtItemName(item);
    const description = getString(item.description);
    const originalUrlCandidate =
        getString(item.originalUrl) || getString(item.url);
    const affiliateUrlCandidate = getString(item.affiliateUrl);
    const imageUrlCandidate = getString(item.imageUrl);

    const originalUrl = isValidHttpUrl(originalUrlCandidate)
        ? originalUrlCandidate
        : undefined;

    const affiliateUrl = isValidHttpUrl(affiliateUrlCandidate)
        ? affiliateUrlCandidate
        : undefined;

    const imageUrl = isValidImageUrl(imageUrlCandidate)
        ? imageUrlCandidate
        : undefined;

    const price = getNumber(item.price) || getNumber(item.originalPrice);
    const salePrice = getNumber(item.salePrice) || getNumber(item.currentPrice);

    const sourceAutoPublishEligible = getBoolean(item.autoPublishEligible);
    const sourcePublicDecision =
        getString(item.publicDecision) || 'needs_review';
    const verifiedSource = Boolean(
        isProduct &&
        (item.verifiedSource === true || item.sourceVerified === true),
    );

    const validationIssues = getAtItemValidationIssues(item);

    const blockReason = isNonProduct
        ? getNonProductReason(kind)
        : validationIssues.length > 0
            ? validationIssues.join(' ')
            : 'Đã lưu ứng viên sản phẩm. Cần chạy kiểm tra chất lượng liên kết và ảnh trước khi đăng công khai.';

    setAtSaving(itemId);

    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: description || undefined,

          kind,
          sourceItemKind: kind,

          platform: 'accesstrade',
          source: 'accesstrade',
          dataSource: 'accesstrade',
          importedFrom: 'accesstrade',
          sourceType: 'affiliate',
          rawSourceKind: getString(item.rawSourceKind) || kind,

          verifiedSource,
          sourceVerified: verifiedSource,

          // Mọi item lưu thủ công từ trang tìm kiếm đều phải ở hàng chờ.
          // Chỉ SourceScout + Product Health Guard mới được mở public.
          needsVerification: true,
          publicHidden: true,
          publicBlocked: true,
          aiApproved: false,
          autoPublished: false,
          autoPublishEligible: false,
          approvalMode: 'manual_or_auto_safe_required',

          originalUrl,
          affiliateUrl,
          affiliateUrlSource: getString(item.affiliateUrlSource) || 'none',
          deepLinkSupported: item.deepLinkSupported === true,
          affiliateLinkReason: getString(item.affiliateLinkReason) || undefined,
          url: affiliateUrl || originalUrl,

          imageUrl,
          price,
          salePrice,

          category: getString(item.category) || undefined,
          campaignName: getString(item.campaignName) || undefined,

          affiliateSource: 'accesstrade',
          priceNote: 'Giá, tồn kho và ưu đãi có thể thay đổi theo thời điểm.',
          affiliateDisclosure:
              'SanDeal có thể nhận hoa hồng affiliate. Giá của bạn không thay đổi.',

          checkBeforeBuy: [
            'Kiểm tra giá, phí vận chuyển và điều kiện ưu đãi trước khi mua.',
            'Giá, tồn kho và ưu đãi có thể thay đổi theo thời điểm.',
            'SanDeal có thể nhận hoa hồng affiliate nếu bạn mua qua liên kết, giá người mua không đổi.',
          ],

          warnings: [
            isNonProduct
                ? getNonProductReason(kind)
                : 'Không fake giá, ảnh, tồn kho, review hoặc trải nghiệm mua hàng.',
          ],

          status: isNonProduct ? 'archived' : 'needs_review',
          publicDecision: isNonProduct ? 'archived' : 'needs_review',
          publicBlockReason: blockReason,
          nonProductReason: isNonProduct
              ? getNonProductReason(kind)
              : undefined,
          autoPublishBlockedReason: blockReason,

          // Lưu lại quyết định từ nguồn để dashboard có thể đối chiếu,
          // nhưng không dùng trực tiếp để public.
          sourceAutoPublishEligible,
          sourcePublicDecision,

          qualityScore: getAtQualityScore(item) ?? undefined,
          sourceQualityScore: getAtQualityScore(item) ?? undefined,

          rawSourceType: 'accesstrade',
          rawData:
              item.rawData && typeof item.rawData === 'object'
                  ? item.rawData
                  : item,
        }),
      });

      const data = (await res
          .json()
          .catch(() => null)) as ApiEnvelope<Product> | null;

      if (res.ok && (data?.ok || data?.success)) {
        if (runScore && data.data?.id) {
          await fetch(`/api/products/${data.data.id}/score`, {
            method: 'POST',
          });
        }

        showToast(
            'success',
            isProduct
                ? 'Đã lưu sản phẩm AccessTrade vào hàng chờ. Chưa đăng công khai cho tới khi liên kết và ảnh đạt kiểm tra chất lượng.'
                : 'Đã lưu dữ liệu AccessTrade trong nội bộ. Mã giảm giá, chiến dịch và ưu đãi cửa hàng không được đăng như sản phẩm.',
        );

        await loadRecent();
      } else {
        showToast(
            'error',
            data?.message ||
            data?.error ||
            `Không thể lưu sản phẩm. HTTP ${res.status}`,
        );
      }
    } catch {
      showToast('error', 'Lỗi kết nối.');
    } finally {
      setAtSaving(null);
    }
  };

  const renderPlaceholderTab = (
      icon: string,
      title: string,
      desc: string,
      keys?: string,
  ) => (
      <div
          className="coming-soon-container"
          style={{ minHeight: 'auto', padding: 'var(--space-xl) 0' }}
      >
        <div className="coming-soon-card" style={{ padding: 'var(--space-xl)' }}>
          <span className="coming-soon-icon">{icon}</span>
          <h3
              className="coming-soon-title"
              style={{ fontSize: 'var(--text-xl)' }}
          >
            {title}
          </h3>
          <p className="coming-soon-desc">{desc}</p>

          <div
              className="disclosure-banner"
              style={{ textAlign: 'left', margin: 'var(--space-lg) 0 0' }}
          >
            Các nguồn này sẽ được thêm sau. Hiện tại nên nhập thủ công vào hàng
            chờ an toàn, không đăng công khai trực tiếp nếu chưa kiểm tra liên kết, ảnh, giá và
            nguồn xác minh.
          </div>

          <div className="coming-soon-actions">
            <button
                className="btn btn-primary"
                onClick={() => setActiveTab('accesstrade')}
            >
              AccessTrade
            </button>
            <Link href="/dashboard/token-vault" className="btn btn-secondary">
              Thiết lập kết nối
            </Link>
          </div>

          {keys && (
              <p
                  style={{
                    fontSize: 'var(--text-xs)',
                    color: 'var(--text-tertiary)',
                    marginTop: 'var(--space-md)',
                  }}
              >
                Cần: {keys}
              </p>
          )}
        </div>
      </div>
  );

  return (
      <div className="page-content">
        {/* Toast */}
        {toast && (
            <div className="toast-container">
              <div className={`toast toast-${toast.type}`}>{toast.message}</div>
            </div>
        )}

        {/* Header */}
        <section
            className="command-hero product-source-hero"
            style={{ marginBottom: 'var(--space-xl)' }}
        >
          <div className="command-hero-content">
            <div
                className="badge badge-purple"
                style={{ marginBottom: 'var(--space-md)' }}
            >
              Nguồn dữ liệu và kết nối
            </div>

            <h1 className="page-title">Trung tâm nguồn sản phẩm</h1>

            <p className="page-subtitle" style={{ maxWidth: 760 }}>
              Kết nối nguồn sản phẩm thật để bot AI tự quét, phân loại, chấm điểm
              và đăng an toàn. Mã giảm giá (voucher), chiến dịch, ưu đãi cửa hàng và dữ liệu thiếu
              link/ảnh/giá chỉ được lưu nội bộ.
            </p>

            <div
                className="flex gap-sm"
                style={{ flexWrap: 'wrap', marginTop: 'var(--space-md)' }}
            >
              <span className="badge badge-success">Chế độ an toàn</span>
              <span className="badge badge-success">Chỉ dùng dịch vụ miễn phí</span>
            </div>

            <div
                className="flex gap-sm"
                style={{ flexWrap: 'wrap', marginTop: 'var(--space-lg)' }}
            >
              <button
                  type="button"
                  className="primary-button"
                  disabled={runningBot}
                  onClick={() => void handleProductHealthScan()}
              >
                {runningBot
                    ? 'Đang chạy...'
                    : 'Quét và kiểm tra sản phẩm'}
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  disabled
                  title="Chế độ tự động đã bị vô hiệu hóa theo chính sách an toàn."
              >
                Chạy chế độ tự động
              </button>

              <Link href="/dashboard/products" className="secondary-button">
                Xem kết quả bot
              </Link>

              <Link href="/dashboard/token-vault" className="secondary-button">
                Kết nối bảo mật
              </Link>
            </div>
          </div>

          {scanResult && (
              <div className="disclosure-banner" style={{ alignSelf: 'center', textAlign: 'left' }}>
                <strong>Kết quả quét gần nhất:</strong>{' '}
                đã kiểm tra {scanResult.checked || scanResult.inspected || 0}, hợp lệ {scanResult.valid || 0},
                {' '}bị chặn {scanResult.blocked || 0}, lỗi {scanResult.failed || 0}.
                {' '}Cập nhật {new Date(scanResult.completedAt).toLocaleString('vi-VN')}.
              </div>
          )}

          <div className="command-hero-panel">
            <div className="card" style={{ minWidth: 280 }}>
              <div className="detail-meta">
                <div className="detail-meta-row">
                  <span>AccessTrade</span>
                  <span
                      style={{
                        color: atConfigured
                            ? 'var(--color-success)'
                            : 'var(--color-warning)',
                      }}
                  >
                  {atConfigured ? 'Đã cấu hình' : 'Cần khóa kết nối'}
                </span>
                </div>

                <div className="detail-meta-row">
                  <span>Ưu tiên</span>
                  <span style={{ color: 'var(--color-success)' }}>
                  Sản phẩm thật từ nguồn dữ liệu
                </span>
                </div>

                <div className="detail-meta-row">
                  <span>Mã giảm giá / chiến dịch</span>
                  <span style={{ color: 'var(--color-warning)' }}>
                  Chỉ lưu nội bộ
                </span>
                </div>

                <div className="detail-meta-row">
                  <span>Chi phí gọi dịch vụ</span>
                  <span style={{ color: 'var(--color-success)' }}>
                  Chỉ dùng dịch vụ miễn phí
                </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Safe Source Rules */}
        <div
            className="card"
            style={{
              padding: 'var(--space-lg)',
              marginBottom: 'var(--space-lg)',
              border: '1px solid rgba(34,211,238,0.12)',
            }}
        >
          <h3
              style={{
                fontWeight: 800,
                fontSize: 'var(--text-base)',
                marginBottom: 'var(--space-sm)',
                color: 'var(--text-primary)',
              }}
          >
            Quy tắc nguồn dữ liệu an toàn
          </h3>

          <div
              className="grid"
              style={{
                gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                gap: 'var(--space-sm)',
              }}
          >
            <div className="metric-card">
              <span className="badge badge-success">Ưu tiên</span>
              <div
                  style={{
                    fontSize: 'var(--text-sm)',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.5,
                  }}
              >
                Sản phẩm thật có tên, liên kết, ảnh, giá và nguồn xác minh.
              </div>
            </div>

            <div className="metric-card">
              <span className="badge badge-warning">Lưu nội bộ</span>
              <div
                  style={{
                    fontSize: 'var(--text-sm)',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.5,
                  }}
              >
                Mã giảm giá (voucher), chiến dịch và ưu đãi cửa hàng không được đăng như sản phẩm.
              </div>
            </div>

            <div className="metric-card">
              <span className="badge badge-info">Kiểm tra chất lượng</span>
              <div
                  style={{
                    fontSize: 'var(--text-sm)',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.5,
                  }}
              >
                Chỉ đăng khi liên kết và ảnh hợp lệ, không gặp lỗi truy cập.
              </div>
            </div>

            <div className="metric-card">
              <span className="badge badge-success">Minh bạch tiếp thị liên kết</span>
              <div
                  style={{
                    fontSize: 'var(--text-sm)',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.5,
                  }}
              >
                Luôn nhắc giá/ưu đãi có thể thay đổi và SanDeal có thể nhận hoa
                hồng.
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="tabs-bar product-source-tabs">
          {TABS.map((tab) => (
              <button
                  key={tab.id}
                  type="button"
                  className={`tab-btn${activeTab === tab.id ? ' tab-btn-active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
              >
                <DashboardIcon name={tab.icon as DashboardIconName} size={17} /> {tab.label}
              </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="tab-content">
          {/* ====== ACCESSTRADE TAB ====== */}
          {activeTab === 'accesstrade' && (
              <div>
                <div
                    className="card"
                    style={{ maxWidth: '960px', marginBottom: 'var(--space-lg)' }}
                >
                  <div
                      className="flex items-start justify-between gap-md"
                      style={{ marginBottom: 'var(--space-md)' }}
                  >
                    <div>
                      <h3 className="card-title">Nguồn sản phẩm AccessTrade</h3>
                      <p
                          className="page-subtitle"
                          style={{ marginTop: 6, maxWidth: 720 }}
                      >
                        Tìm và kiểm tra dữ liệu AccessTrade. Hệ thống sẽ phân loại
                        rõ sản phẩm thật, mã giảm giá, chiến dịch và ưu đãi cửa hàng. Chỉ sản
                        phẩm thật có liên kết, ảnh và giá hợp lệ mới có thể đi tiếp
                        vào quy trình đăng an toàn.
                      </p>
                    </div>

                    <span
                        className={`badge ${atConfigured ? 'badge-success' : 'badge-warning'}`}
                    >
                  {atConfigured ? 'Đã kết nối AccessTrade' : 'Cần thiết lập kết nối'}
                </span>
                  </div>

                  {!atConfigured && (
                      <div
                          style={{
                            background: 'rgba(245,158,11,0.08)',
                            border: '1px solid rgba(245,158,11,0.22)',
                            padding: 'var(--space-xl)',
                            borderRadius: 'var(--radius-lg)',
                            textAlign: 'center',
                            marginBottom: 'var(--space-xl)',
                          }}
                      >
                        <div
                            style={{
                              width: 48,
                              height: 48,
                              borderRadius: 16,
                              display: 'grid',
                              placeItems: 'center',
                              margin: '0 auto var(--space-sm)',
                              background: 'rgba(245,158,11,0.12)',
                              color: 'var(--color-warning)',
                              fontWeight: 900,
                            }}
                        >
                          <DashboardIcon name="source" size={24} />
                        </div>
                        <h4
                            style={{
                              fontSize: 'var(--text-lg)',
                              fontWeight: 800,
                              color: 'var(--color-warning)',
                              marginBottom: 'var(--space-xs)',
                            }}
                        >
                          Chưa thiết lập kết nối AccessTrade
                        </h4>
                        <p
                            style={{
                              color: 'var(--text-secondary)',
                              marginBottom: 'var(--space-lg)',
                            }}
                        >
                          Bạn cần thêm khóa kết nối AccessTrade trong Kết nối bảo mật
                          để tìm kiếm và quét sản phẩm. Không gửi khóa kết nối qua trò chuyện.
                        </p>
                        <Link
                            href="/dashboard/token-vault"
                            className="btn btn-primary"
                        >
                          Mở Kết nối bảo mật
                        </Link>
                      </div>
                  )}

                  <div
                      className="disclosure-banner"
                      style={{
                        textAlign: 'left',
                        marginBottom: 'var(--space-lg)',
                        opacity: atConfigured ? 1 : 0.65,
                      }}
                  >
                    <strong>Luồng an toàn:</strong> ưu tiên sản phẩm thật → lưu nội bộ
                    → kiểm tra liên kết, ảnh và giá → chỉ đăng nếu đạt chuẩn. Mã giảm giá,
                    chiến dịch và ưu đãi cửa hàng không được đăng như sản phẩm.
                  </div>

                  <div
                      className="form-row"
                      style={{
                        padding: atConfigured ? 0 : 'var(--space-md)',
                        background: atConfigured ? 'transparent' : 'var(--ds-surface-muted)',
                        border: atConfigured ? 0 : '1px solid var(--ds-border)',
                        borderRadius: 'var(--ds-radius-md)',
                      }}
                      title={!atConfigured ? 'Được bảo vệ bởi chính sách hệ thống. Chỉ khả dụng sau khi thêm kết nối AccessTrade.' : undefined}
                  >
                    <div className="form-group" style={{ flex: 2 }}>
                      <label className="label">Từ khoá sản phẩm cụ thể</label>
                      <input
                          className="input"
                          value={atKeyword}
                          onChange={(event) => setAtKeyword(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !atLoading) {
                              event.preventDefault();
                              void handleAtSearch();
                            }
                          }}
                          placeholder="Ví dụ: tai nghe, serum, sữa tắm, laptop..."
                          disabled={!atConfigured}
                      />

                      <div
                          className="flex gap-xs"
                          style={{ flexWrap: 'wrap', marginTop: 'var(--space-xs)' }}
                      >
                        {ACCESS_TRADE_KEYWORD_SUGGESTIONS.map((keyword) => (
                            <button
                                key={keyword}
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => setAtKeyword(keyword)}
                                disabled={atLoading || !atConfigured}
                            >
                              {keyword}
                            </button>
                        ))}
                      </div>
                    </div>

                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Loại dữ liệu</label>
                      <select
                          className="select"
                          value={atKind}
                          onChange={(event) => setAtKind(event.target.value)}
                          disabled={!atConfigured}
                      >
                        <option value="product">Ưu tiên sản phẩm thật</option>
                        <option value="all">Tất cả để kiểm tra</option>
                        <option value="voucher">Mã giảm giá (voucher)</option>
                        <option value="campaign">Chiến dịch</option>
                        <option value="store_offer">Ưu đãi shop</option>
                        <option value="unknown">Chưa rõ</option>
                      </select>
                    </div>
                  </div>

                  <div
                      className="flex gap-sm"
                      style={{ flexWrap: 'wrap', marginTop: 'var(--space-md)' }}
                  >
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void handleAtSearch()}
                        disabled={atLoading || !atConfigured}
                        title={!atConfigured ? 'Chỉ khả dụng sau khi thêm kết nối AccessTrade.' : 'Tìm kiếm dữ liệu AccessTrade'}
                    >
                      {atLoading ? 'Đang tìm...' : 'Tìm kiếm AccessTrade'}
                    </button>

                    <button
                        type="button"
                        className="btn btn-accent"
                        onClick={() => void handleProductHealthScan()}
                        disabled={runningBot || !atConfigured}
                        title={!atConfigured ? 'Chỉ khả dụng sau khi thêm kết nối AccessTrade.' : 'Tạo tác vụ quét nguồn an toàn'}
                    >
                      {runningBot ? 'Đang chạy...' : 'Cho bot quét sản phẩm thật'}
                    </button>

                    <Link href="/dashboard/products" className="btn btn-secondary">
                      Xem hàng chờ
                    </Link>
                  </div>
                </div>

                {atError && (
                    <div
                        className="glass-card"
                        style={{
                          borderColor: 'rgba(244, 63, 94, 0.3)',
                          maxWidth: '960px',
                          marginBottom: 'var(--space-lg)',
                        }}
                    >
                      <p style={{ color: 'var(--color-danger)' }}>{atError}</p>
                    </div>
                )}

                {atResults && (
                    <div style={{ maxWidth: '960px' }}>
                      {/* Summary */}
                      <div
                          className="grid"
                          style={{
                            gridTemplateColumns:
                                'repeat(auto-fill, minmax(135px, 1fr))',
                            gap: 'var(--space-sm)',
                            marginBottom: 'var(--space-lg)',
                          }}
                      >
                        <div
                            className="stat-card"
                            style={{ padding: 'var(--space-md)' }}
                        >
                          <div
                              className="stat-card-value"
                              style={{ fontSize: 'var(--text-xl)' }}
                          >
                            {atResults.summary.total ?? atResults.items.length}
                          </div>
                          <div className="stat-card-label">Tổng kết quả</div>
                        </div>

                        <div
                            className="stat-card"
                            style={{ padding: 'var(--space-md)' }}
                        >
                          <div
                              className="stat-card-value"
                              style={{ fontSize: 'var(--text-xl)' }}
                          >
                            {atResults.summary.realProducts ??
                                atResults.summary.products ??
                                0}
                          </div>
                          <div className="stat-card-label">Sản phẩm thật</div>
                        </div>

                        <div
                            className="stat-card"
                            style={{ padding: 'var(--space-md)' }}
                        >
                          <div
                              className="stat-card-value"
                              style={{ fontSize: 'var(--text-xl)' }}
                          >
                            {atResults.summary.storeOffers ?? 0}
                          </div>
                          <div className="stat-card-label">Ưu đãi shop</div>
                        </div>

                        <div
                            className="stat-card"
                            style={{ padding: 'var(--space-md)' }}
                        >
                          <div
                              className="stat-card-value"
                              style={{ fontSize: 'var(--text-xl)' }}
                          >
                            {atResults.summary.vouchers ?? 0}
                          </div>
                          <div className="stat-card-label">Mã giảm giá</div>
                        </div>

                        <div
                            className="stat-card"
                            style={{ padding: 'var(--space-md)' }}
                        >
                          <div
                              className="stat-card-value"
                              style={{ fontSize: 'var(--text-xl)' }}
                          >
                            {atResults.summary.campaigns ?? 0}
                          </div>
                          <div className="stat-card-label">Chiến dịch</div>
                        </div>

                        <div
                            className="stat-card"
                            style={{ padding: 'var(--space-md)' }}
                        >
                          <div
                              className="stat-card-value"
                              style={{ fontSize: 'var(--text-xl)' }}
                          >
                            {atResults.summary.publicEligibleProducts ??
                                atResults.summary.publicCandidates ??
                                0}
                          </div>
                          <div className="stat-card-label">Ứng viên nguồn</div>
                        </div>

                        <div
                            className="stat-card"
                            style={{ padding: 'var(--space-md)' }}
                        >
                          <div
                              className="stat-card-value"
                              style={{ fontSize: 'var(--text-xl)' }}
                          >
                            {atResults.summary.needsReview ?? 0}
                          </div>
                          <div className="stat-card-label">Cần xem xét</div>
                        </div>

                        <div
                            className="stat-card"
                            style={{ padding: 'var(--space-md)' }}
                        >
                          <div
                              className="stat-card-value"
                              style={{ fontSize: 'var(--text-xl)' }}
                          >
                            {atResults.summary.blockedFromPublic ??
                                atResults.summary.nonProducts ??
                                0}
                          </div>
                          <div className="stat-card-label">Chưa được đăng công khai</div>
                        </div>
                      </div>

                      {/* Results */}
                      {atResults.items.map((rawItem, index) => {
                        const item = rawItem as AccessTradeItem;
                        const itemId = getAtItemId(item, index);
                        const name = getAtItemName(item);
                        const kind = getAtItemKind(item);
                        const isProduct = isRealProductKind(kind);
                        const publicDecision = getAtPublicDecision(item);
                        const qualityScore = getAtQualityScore(item);
                        const reason = getAtItemMainReason(item);
                        const validationIssues = getAtItemValidationIssues(item);
                        const imageUrl = getString(item.imageUrl);
                        const affiliateUrl = getString(item.affiliateUrl);
                        const hasAffiliateLink = isValidHttpUrl(affiliateUrl);
                        const hasImage = isValidImageUrl(imageUrl);
                        const hasPrice = Boolean(
                            getNumber(item.salePrice) || getNumber(item.price),
                        );
                        const sourceVerified = Boolean(
                            item.verifiedSource === true ||
                            item.sourceVerified === true,
                        );

                        return (
                            <div
                                key={`${itemId}-${index}`}
                                className="glass-card"
                                style={{
                                  marginBottom: 'var(--space-md)',
                                  display: 'flex',
                                  gap: 'var(--space-md)',
                                }}
                            >
                              <SafeThumb src={imageUrl} label="AT" size={82} />

                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                    className="flex items-center gap-sm"
                                    style={{ marginBottom: '4px', flexWrap: 'wrap' }}
                                >
                                  <strong style={{ fontSize: 'var(--text-sm)' }}>
                                    {name}
                                  </strong>

                                  <span className={`badge ${getKindBadge(kind)}`}>
                            {getKindLabel(kind)}
                          </span>

                                  <span className={`badge ${publicDecision.badge}`}>
                            {publicDecision.label}
                          </span>

                                  {qualityScore != null && (
                                      <span
                                          className={`badge ${
                                              qualityScore >= 70
                                                  ? 'badge-success'
                                                  : qualityScore >= 40
                                                      ? 'badge-warning'
                                                      : 'badge-danger'
                                          }`}
                                      >
                              Điểm nguồn {qualityScore}
                            </span>
                                  )}

                                  <span
                                      className={`badge ${sourceVerified ? 'badge-success' : 'badge-warning'}`}
                                  >
                            {sourceVerified
                                ? 'Nguồn xác minh'
                                : 'Nguồn chưa xác minh'}
                          </span>

                                  {!isProduct && (
                                      <span className="badge badge-neutral">
                              Không tự động đăng công khai
                            </span>
                                  )}

                                  {(getBoolean(item.needsVerification) ||
                                      validationIssues.length > 0) && (
                                      <span className="badge badge-warning">
                              Cần kiểm tra thêm
                            </span>
                                  )}
                                </div>

                                <div
                                    className="flex gap-xs"
                                    style={{
                                      flexWrap: 'wrap',
                                      marginTop: 6,
                                      marginBottom: 4,
                                    }}
                                >
                          <span
                              className={`badge ${hasPrice ? 'badge-success' : 'badge-danger'}`}
                          >
                            Giá:{' '}
                            {hasPrice
                                ? formatPrice(item.salePrice || item.price)
                                : 'Thiếu'}
                          </span>

                                  <span
                                      className={`badge ${hasAffiliateLink ? 'badge-success' : 'badge-danger'}`}
                                  >
                            Liên kết tiếp thị: {hasAffiliateLink ? 'Có' : 'Thiếu'}
                          </span>

                                  <span
                                      className={`badge ${hasImage ? 'badge-success' : 'badge-danger'}`}
                                  >
                            Ảnh: {hasImage ? 'Có' : 'Thiếu'}
                          </span>
                                </div>

                                <p
                                    style={{
                                      fontSize: 'var(--text-xs)',
                                      color: isProduct
                                          ? 'var(--text-secondary)'
                                          : '#f59e0b',
                                      lineHeight: 1.55,
                                      marginTop: 4,
                                    }}
                                >
                                  {validationIssues.length > 0
                                      ? validationIssues.join(' ')
                                      : reason}
                                </p>

                                <div
                                    className="flex gap-sm"
                                    style={{
                                      marginTop: 'var(--space-sm)',
                                      flexWrap: 'wrap',
                                    }}
                                >
                                  <button
                                      type="button"
                                      className="btn btn-sm btn-primary"
                                      disabled={Boolean(atSaving)}
                                      onClick={() => void handleAtSave(item)}
                                  >
                                    {atSaving === itemId
                                        ? 'Đang lưu...'
                                        : 'Lưu vào hàng chờ'}
                                  </button>

                                </div>
                              </div>
                            </div>
                        );
                      })}

                      {atResults.items.length === 0 && (
                          <div className="empty-state">
                            <div
                                className="empty-state-icon"
                                style={{ fontSize: 32, opacity: 0.35 }}
                            >
                              AT
                            </div>
                            <div className="empty-state-title">
                              Không tìm thấy kết quả
                            </div>
                            <div className="empty-state-desc">
                              Thử thay đổi từ khoá hoặc bộ lọc.
                            </div>
                          </div>
                      )}
                    </div>
                )}
              </div>
          )}

          {/* ====== SHOPEE TAB ====== */}
          {activeTab === 'shopee' &&
              renderPlaceholderTab(
                  'SP',
                  'Tiếp thị liên kết Shopee',
                  'Nguồn tiếp thị liên kết Shopee sẽ được kết nối ở bước sau. Hiện tại bạn có thể thêm liên kết Shopee thủ công vào hàng chờ an toàn.',
                  'SHOPEE_AFFILIATE_APP_ID, SHOPEE_AFFILIATE_SECRET',
              )}

          {/* ====== TIKTOK TAB ====== */}
          {activeTab === 'tiktok' &&
              renderPlaceholderTab(
                  'TK',
                  'Tiếp thị liên kết TikTok Shop',
                  'Nguồn tiếp thị liên kết TikTok Shop sẽ được kết nối ở bước sau. Hiện tại bạn có thể thêm liên kết sản phẩm thủ công.',
                  'TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET',
              )}

          {/* ====== LAZADA TAB ====== */}
          {activeTab === 'lazada' &&
              renderPlaceholderTab(
                  'LZ',
                  'Tiếp thị liên kết Lazada',
                  'Nguồn tiếp thị liên kết Lazada sẽ được kết nối ở bước sau.',
                  'LAZADA_AFFILIATE_APP_KEY, LAZADA_AFFILIATE_APP_SECRET',
              )}

          {/* ====== CSV TAB ====== */}
          {activeTab === 'csv' && (
              <div
                  className="coming-soon-container"
                  style={{ minHeight: 'auto', padding: 'var(--space-xl) 0' }}
              >
                <div
                    className="coming-soon-card"
                    style={{ padding: 'var(--space-xl)' }}
                >
                  <span className="coming-soon-icon">CSV</span>
                  <h3
                      className="coming-soon-title"
                      style={{ fontSize: 'var(--text-xl)' }}
                  >
                    Nhập tệp bảng dữ liệu (CSV)
                  </h3>
                  <p className="coming-soon-desc">
                    CSV là tệp bảng dữ liệu. Chức năng nhập tệp sẽ được thêm ở bước sau.
                  </p>

                  <div
                      className="disclosure-banner"
                      style={{ textAlign: 'left', margin: 'var(--space-lg) 0 0' }}
                  >
                    <strong>Các cột dự kiến:</strong>
                    <br />
                    title, originalUrl, affiliateUrl, imageUrl, platform, price,
                    salePrice, category, tags
                  </div>
                </div>
              </div>
          )}

          {/* ====== OTHER TAB ====== */}
          {activeTab === 'other' &&
              renderPlaceholderTab(
                  '+',
                  'Nguồn khác',
                  'Bạn có thể thêm sản phẩm từ bất kỳ nguồn nào bằng cách nhập thủ công. Giao diện tích hợp nội bộ (API) sẽ được hoàn thiện ở bước sau.',
              )}
        </div>

        {/* Recent Products */}
        {recentProducts.length > 0 && (
            <div style={{ marginTop: 'var(--space-xl)' }}>
              <h2 className="section-title">Sản phẩm mới thêm gần đây</h2>

              <div className="table-container">
                <table>
                  <thead>
                  <tr>
                    <th>Sản phẩm</th>
                    <th>Loại</th>
                    <th>Nền tảng</th>
                    <th>Nguồn</th>
                    <th>Trạng thái</th>
                    <th>Đăng an toàn</th>
                    <th>Điểm</th>
                    <th>Cập nhật</th>
                  </tr>
                  </thead>

                  <tbody>
                  {recentProducts.map((product) => {
                    const source = getRecentSource(product);
                    const kind = getRecentKind(product);
                    const publicState = getRecentPublicState(product);

                    return (
                        <tr key={product.id}>
                          <td>
                            <div className="flex items-center gap-sm">
                              <SafeThumb
                                  src={product.imageUrl}
                                  label="S"
                                  size={36}
                              />

                              <Link
                                  href={`/dashboard/products/${product.id}`}
                                  style={{
                                    fontWeight: 600,
                                    fontSize: 'var(--text-sm)',
                                  }}
                              >
                                {product.title}
                              </Link>
                            </div>
                          </td>

                          <td>
                        <span className={`badge ${getKindBadge(kind)}`}>
                          {getKindLabel(kind)}
                        </span>
                          </td>

                          <td>
                        <span className="badge badge-neutral">
                          {getPlatformLabel(product.platform)}
                        </span>
                          </td>

                          <td style={{ fontSize: 'var(--text-xs)' }}>{source}</td>

                          <td>
                        <span
                            className={`badge ${getStatusBadgeClass(product.status)}`}
                        >
                          {getStatusLabel(product.status)}
                        </span>
                          </td>

                          <td>
                        <span className={`badge ${publicState.badge}`}>
                          {publicState.label}
                        </span>
                          </td>

                          <td>{product.score != null ? product.score : '—'}</td>

                          <td
                              style={{
                                fontSize: 'var(--text-xs)',
                                color: 'var(--text-tertiary)',
                              }}
                          >
                            {product.updatedAt
                                ? new Date(product.updatedAt).toLocaleDateString(
                                    'vi-VN',
                                )
                                : '—'}
                          </td>
                        </tr>
                    );
                  })}
                  </tbody>
                </table>
              </div>
            </div>
        )}
      </div>
  );
}
