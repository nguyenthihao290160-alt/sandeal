'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import Link from 'next/link';
import type { Product, ProductKind } from '@/lib/types';

// ---- Tab IDs ----
const TABS = [
  { id: 'accesstrade', label: 'AccessTrade', icon: 'AT' },
  { id: 'shopee', label: 'Shopee Affiliate', icon: 'SP' },
  { id: 'tiktok', label: 'TikTok Shop', icon: 'TK' },
  { id: 'lazada', label: 'Lazada', icon: 'LZ' },
  { id: 'csv', label: 'CSV Import', icon: 'CS' },
  { id: 'other', label: 'Nguồn khác', icon: '+' },
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

type SourceStatus = {
  name: string;
  tab: TabId;
  status: 'active' | 'pending' | 'placeholder' | 'coming';
  note: string;
  icon: string;
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
  deal: 'Deal',
  store_offer: 'Ưu đãi shop',
  voucher: 'Voucher',
  campaign: 'Campaign',
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
    return 'AutoPilot đang tắt hoặc chưa cho phép tự public.';
  }

  if (normalized === 'free_only_guard_failed') {
    return 'Free Only Guard chưa đạt yêu cầu.';
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
    return 'Tên giống voucher/campaign/ưu đãi shop.';
  }

  if (normalized === 'classifier_detected_voucher_or_campaign') {
    return 'Bộ phân loại phát hiện dữ liệu giống voucher hoặc campaign.';
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
    return 'Quyết định Safe Publish hiện đang chặn sản phẩm.';
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
    return 'Voucher/mã giảm giá không public như sản phẩm.';
  if (kind === 'campaign')
    return 'Campaign/chương trình khuyến mãi không public như sản phẩm.';
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
              ? 'Đây mới là ứng viên nguồn; vẫn phải qua Health Guard trước khi public.'
              : 'Không public tự động.')
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

  if (!isValidHttpUrl(item.affiliateUrl)) {
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
    return { label: 'Đang public', badge: 'badge-success' };
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
    setFailed(false);
  }, [cleanSrc]);

  if (!cleanSrc || failed) {
    return (
        <div
            style={{
              width: size,
              height: size,
              borderRadius: 'var(--radius-md)',
              overflow: 'hidden',
              background:
                  'radial-gradient(circle at 50% 20%, rgba(14,165,233,0.18), transparent 38%), linear-gradient(135deg, rgba(15,23,42,0.7), rgba(30,41,59,0.95))',
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

  // AccessTrade state
  const [atKeyword, setAtKeyword] = useState('');
  const [atKind, setAtKind] = useState('product');
  const [atLoading, setAtLoading] = useState(false);
  const [atError, setAtError] = useState('');
  const [atResults, setAtResults] = useState<AccessTradeResults | null>(null);
  const [atSaving, setAtSaving] = useState<string | null>(null);
  const [atConfigured, setAtConfigured] = useState(false);

  const sourceStatuses = useMemo<SourceStatus[]>(
      () => [
        {
          name: 'AccessTrade',
          tab: 'accesstrade',
          status: atConfigured ? 'active' : 'pending',
          note: atConfigured
              ? 'Đang hoạt động — ưu tiên sản phẩm thật'
              : 'Cần cấu hình API key',
          icon: 'AT',
        },
        {
          name: 'Shopee',
          tab: 'shopee',
          status: 'placeholder',
          note: 'Sắp kết nối',
          icon: 'SP',
        },
        {
          name: 'TikTok Shop',
          tab: 'tiktok',
          status: 'placeholder',
          note: 'Sắp kết nối',
          icon: 'TK',
        },
        {
          name: 'Lazada',
          tab: 'lazada',
          status: 'placeholder',
          note: 'Sắp kết nối',
          icon: 'LZ',
        },
        {
          name: 'CSV',
          tab: 'csv',
          status: 'coming',
          note: 'Sắp có',
          icon: 'CS',
        },
      ],
      [atConfigured],
  );

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
    void loadRecent();
  }, [loadRecent]);



  const handleRunAutoPilot = async (
      mode: 'source_scan' | 'full_safe_run' = 'source_scan',
  ) => {
    setRunningBot(true);

    try {
      const res = await fetch('/api/ai-bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          source: 'all',
          limit: 10,
          costMode: 'safe_free',
          safeMode: true,
          freeOnly: true,
          autoMode: true,
          autoApprove: true,
          autoPublish: true,
          allowPaidAi: false,
        }),
      });

      const data = (await res
          .json()
          .catch(() => null)) as ApiEnvelope<unknown> | null;

      if (!res.ok || (!data?.ok && !data?.success)) {
        throw new Error(
            data?.message ||
            data?.error ||
            `Không chạy được bot. HTTP ${res.status}`,
        );
      }

      showToast(
          'success',
          mode === 'full_safe_run'
              ? 'Đã khởi chạy AutoPilot toàn bộ. Chỉ sản phẩm thật đạt chuẩn mới được public.'
              : 'Đã khởi chạy Source Scout. Bot sẽ ưu tiên sản phẩm thật và giữ voucher/campaign nội bộ.',
      );

      await loadRecent();
    } catch (err) {
      showToast(
          'error',
          err instanceof Error ? err.message : 'Không chạy được AutoPilot.',
      );
    } finally {
      setRunningBot(false);
    }
  };

  const handleAtSearch = async () => {
    if (!atConfigured) {
      showToast(
          'error',
          'AccessTrade chưa được cấu hình. Hãy mở Token Vault để thêm API key.',
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
            : 'Đã lưu ứng viên sản phẩm. Cần chạy Product Health Guard để kiểm link và ảnh trước khi public.';

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
          aiApproved: false,
          autoPublished: false,
          autoPublishEligible: false,
          approvalMode: 'manual_or_auto_safe_required',

          originalUrl,
          affiliateUrl,
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
                ? 'Đã lưu sản phẩm AccessTrade vào hàng chờ. Chưa public cho tới khi Health Guard kiểm link và ảnh OK.'
                : 'Đã lưu item AccessTrade nội bộ. Voucher/campaign/ưu đãi shop sẽ không public như sản phẩm.',
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
            chờ an toàn, không public trực tiếp nếu chưa kiểm link, ảnh, giá và
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
              Cấu hình API
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
            className="command-hero"
            style={{ marginBottom: 'var(--space-xl)' }}
        >
          <div className="command-hero-content">
            <div
                className="badge badge-purple"
                style={{ marginBottom: 'var(--space-md)' }}
            >
              Data Source Center
            </div>

            <h1 className="page-title">Trung tâm nguồn dữ liệu</h1>

            <p className="page-subtitle" style={{ maxWidth: 760 }}>
              Kết nối nguồn sản phẩm thật để bot AI tự quét, phân loại, chấm điểm
              và public an toàn. Voucher, campaign, ưu đãi shop và dữ liệu thiếu
              link/ảnh/giá chỉ được lưu nội bộ.
            </p>

            <div
                className="flex gap-sm"
                style={{ flexWrap: 'wrap', marginTop: 'var(--space-md)' }}
            >
              <span className="badge badge-success">Safe Mode ON</span>
              <span className="badge badge-success">Free Only ON</span>
              <span className="badge badge-info">AutoPilot ON</span>
              <span className="badge badge-success">Safe Publish ON</span>
            </div>

            <div
                className="flex gap-sm"
                style={{ flexWrap: 'wrap', marginTop: 'var(--space-lg)' }}
            >
              <button
                  type="button"
                  className="primary-button"
                  disabled={runningBot}
                  onClick={() => void handleRunAutoPilot('source_scan')}
              >
                {runningBot
                    ? 'Đang chạy...'
                    : 'Quét sản phẩm thật & tự public an toàn'}
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  disabled={runningBot}
                  onClick={() => void handleRunAutoPilot('full_safe_run')}
              >
                Chạy AutoPilot toàn bộ
              </button>

              <Link href="/dashboard/products" className="secondary-button">
                Xem kết quả bot
              </Link>

              <Link href="/dashboard/token-vault" className="secondary-button">
                Token Vault
              </Link>
            </div>
          </div>

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
                  {atConfigured ? 'Đã cấu hình' : 'Cần API key'}
                </span>
                </div>

                <div className="detail-meta-row">
                  <span>Ưu tiên</span>
                  <span style={{ color: 'var(--color-success)' }}>
                  Sản phẩm thật/datafeed
                </span>
                </div>

                <div className="detail-meta-row">
                  <span>Voucher/campaign</span>
                  <span style={{ color: 'var(--color-warning)' }}>
                  Chỉ lưu nội bộ
                </span>
                </div>

                <div className="detail-meta-row">
                  <span>Chi phí API</span>
                  <span style={{ color: 'var(--color-success)' }}>
                  0đ Free Only
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
                Sản phẩm thật/datafeed có tên, link, ảnh, giá và nguồn xác minh.
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
                Voucher, campaign, store offer không được public như sản phẩm.
              </div>
            </div>

            <div className="metric-card">
              <span className="badge badge-info">Health Guard</span>
              <div
                  style={{
                    fontSize: 'var(--text-sm)',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.5,
                  }}
              >
                Chỉ public khi link và ảnh kiểm tra OK, không 404/403/timeout.
              </div>
            </div>

            <div className="metric-card">
              <span className="badge badge-success">Affiliate minh bạch</span>
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

        {/* Source Status Cards */}
        <div className="source-cards">
          {sourceStatuses.map((source) => (
              <button
                  key={source.name}
                  type="button"
                  className={`source-card${activeTab === source.tab ? ' active' : ''}`}
                  onClick={() => setActiveTab(source.tab)}
                  style={{ textAlign: 'left', cursor: 'pointer' }}
              >
                <div className="source-card-icon">{source.icon}</div>
                <div className="source-card-name">{source.name}</div>
                <div
                    style={{
                      color: 'var(--text-tertiary)',
                      fontSize: 11,
                      marginTop: 4,
                      minHeight: 28,
                      lineHeight: 1.35,
                    }}
                >
                  {source.note}
                </div>
                <div className="source-card-status" style={{ marginTop: 8 }}>
              <span
                  className={`badge ${
                      source.status === 'active'
                          ? 'badge-success'
                          : source.status === 'pending'
                              ? 'badge-warning'
                              : 'badge-neutral'
                  }`}
                  style={{ fontSize: '9px', padding: '2px 6px' }}
              >
                {source.status === 'active'
                    ? 'Khả dụng'
                    : source.status === 'pending'
                        ? 'Cần cấu hình'
                        : 'Sắp có'}
              </span>
                </div>
              </button>
          ))}
        </div>

        {/* Tabs */}
        <div className="tabs-bar">
          {TABS.map((tab) => (
              <button
                  key={tab.id}
                  type="button"
                  className={`tab-btn${activeTab === tab.id ? ' tab-btn-active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
              >
                <span>{tab.icon}</span> {tab.label}
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
                      <h3 className="card-title">AccessTrade Real Product Feed</h3>
                      <p
                          className="page-subtitle"
                          style={{ marginTop: 6, maxWidth: 720 }}
                      >
                        Tìm và kiểm tra dữ liệu AccessTrade. Hệ thống sẽ phân loại
                        rõ sản phẩm thật, voucher, campaign và ưu đãi shop. Chỉ sản
                        phẩm thật có link/ảnh/giá hợp lệ mới có thể đi tiếp vào Safe
                        Publish.
                      </p>
                    </div>

                    <span
                        className={`badge ${atConfigured ? 'badge-success' : 'badge-warning'}`}
                    >
                  {atConfigured ? 'AccessTrade Ready' : 'Cần API Key'}
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
                          AT
                        </div>
                        <h4
                            style={{
                              fontSize: 'var(--text-lg)',
                              fontWeight: 800,
                              color: 'var(--color-warning)',
                              marginBottom: 'var(--space-xs)',
                            }}
                        >
                          Thiếu API Key AccessTrade
                        </h4>
                        <p
                            style={{
                              color: 'var(--text-secondary)',
                              marginBottom: 'var(--space-lg)',
                            }}
                        >
                          Bạn cần cấu hình API key của AccessTrade trong Token Vault
                          để tìm kiếm và quét sản phẩm. Không gửi API key vào chat.
                        </p>
                        <Link
                            href="/dashboard/token-vault"
                            className="btn btn-primary"
                        >
                          Mở Token Vault
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
                    <strong>Luồng an toàn:</strong> ưu tiên sản phẩm thật/datafeed →
                    lưu nội bộ → kiểm link/ảnh/giá → chỉ public nếu đạt chuẩn.
                    Voucher/campaign/store offer không public như sản phẩm.
                  </div>

                  <div
                      className="form-row"
                      style={{
                        opacity: atConfigured ? 1 : 0.5,
                        pointerEvents: atConfigured ? 'auto' : 'none',
                      }}
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
                          placeholder="VD: tai nghe, serum, sữa tắm, laptop..."
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
                                disabled={atLoading}
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
                      >
                        <option value="product">Ưu tiên sản phẩm thật</option>
                        <option value="all">Tất cả để kiểm tra</option>
                        <option value="voucher">Voucher</option>
                        <option value="campaign">Campaign</option>
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
                    >
                      {atLoading ? 'Đang tìm...' : 'Tìm kiếm AccessTrade'}
                    </button>

                    <button
                        type="button"
                        className="btn btn-accent"
                        onClick={() => void handleRunAutoPilot('source_scan')}
                        disabled={runningBot || !atConfigured}
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
                          <div className="stat-card-label">Voucher</div>
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
                          <div className="stat-card-label">Campaign</div>
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
                          <div className="stat-card-label">Chưa được public</div>
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
                              Không public tự động
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
                            Link affiliate: {hasAffiliateLink ? 'Có' : 'Thiếu'}
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
                  'Shopee Affiliate',
                  'Shopee Affiliate sẽ được kết nối ở bước sau. Hiện tại bạn có thể thêm link Shopee thủ công vào hàng chờ an toàn.',
                  'SHOPEE_AFFILIATE_APP_ID, SHOPEE_AFFILIATE_SECRET',
              )}

          {/* ====== TIKTOK TAB ====== */}
          {activeTab === 'tiktok' &&
              renderPlaceholderTab(
                  'TK',
                  'TikTok Shop Affiliate',
                  'TikTok Shop Affiliate sẽ được kết nối ở bước sau. Hiện tại bạn có thể thêm link sản phẩm thủ công.',
                  'TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET',
              )}

          {/* ====== LAZADA TAB ====== */}
          {activeTab === 'lazada' &&
              renderPlaceholderTab(
                  'LZ',
                  'Lazada Affiliate',
                  'Lazada Affiliate sẽ được kết nối ở bước sau.',
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
                    Nhập từ CSV
                  </h3>
                  <p className="coming-soon-desc">
                    Tính năng nhập CSV sẽ được thêm ở bước sau.
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
                  'Bạn có thể thêm sản phẩm từ bất kỳ nguồn nào bằng cách nhập thủ công hoặc sử dụng API nội bộ ở bước sau.',
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
                    <th>Safe Publish</th>
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
