'use client';

import { type ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Product, ProductKind } from '@/lib/types';

// ---- Tab IDs ----
const TABS = [
  { id: 'manual', label: 'Thêm thủ công', icon: 'M' },
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
  name?: string;
  title?: string;
  description?: string;
  kind?: ProductKind | string;
  sourceItemKind?: ProductKind | string;
  imageUrl?: string;
  originalUrl?: string;
  affiliateUrl?: string;
  price?: number | string;
  salePrice?: number | string;
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

// ---- Form Default ----
const EMPTY_FORM = {
  title: '',
  description: '',
  platform: 'shopee',
  category: '',
  tags: '',
  originalUrl: '',
  affiliateUrl: '',
  imageUrl: '',
  gallery: '',
  price: '',
  salePrice: '',
  priceNote: 'Giá có thể thay đổi theo thời gian',
  affiliateSource: '',
  campaignName: '',
  commissionNote: '',
  affiliateDisclosure: 'Bài viết có thể chứa link affiliate. Giá của bạn không thay đổi.',
  benefits: '',
  painPoints: '',
  targetAudience: '',
  warnings: '',
  contentAngles: '',
  complianceNotes: '',
  kind: 'product',
  status: 'needs_review',
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

const PUBLIC_DECISION_LABELS: Record<string, { label: string; badge: string }> = {
  public_candidate: { label: 'Ứng viên public', badge: 'badge-info' },
  needs_review: { label: 'Cần xem xét', badge: 'badge-warning' },
  archived: { label: 'Lưu nội bộ', badge: 'badge-neutral' },
  blocked: { label: 'Bị chặn', badge: 'badge-danger' },
};

function splitLines(value: string): string[] {
  return value
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
}

function splitTags(value: string): string[] {
  return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
}

function parsePrice(value: string): number | undefined {
  if (!value.trim()) return undefined;

  const digitsOnly = value.replace(/[^\d]/g, '');
  if (!digitsOnly) return undefined;

  const parsed = Number(digitsOnly);

  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : undefined;
}

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

function getNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1000) return value;

  if (typeof value === 'string') {
    if (/%/.test(value)) return undefined;

    const parsed = Number(value.replace(/[^\d]/g, ''));
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : undefined;
  }

  return undefined;
}

function getBoolean(value: unknown): boolean {
  return value === true || value === 'true';
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
  return kind === 'voucher' || kind === 'campaign' || kind === 'store_offer' || kind === 'unknown';
}

function getKindLabel(kind?: ProductKind | string) {
  return KIND_LABELS[kind || 'unknown'] || 'Chưa rõ';
}

function getKindBadge(kind?: ProductKind | string) {
  return KIND_BADGES[kind || 'unknown'] || 'badge-neutral';
}

function getNonProductReason(kind?: ProductKind | string): string {
  if (kind === 'store_offer') return 'Chưa phải sản phẩm cụ thể.';
  if (kind === 'voucher') return 'Voucher/mã giảm giá không public như sản phẩm.';
  if (kind === 'campaign') return 'Campaign/chương trình khuyến mãi không public như sản phẩm.';
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
      getString(item.publicBlockReason) ||
      getString(item.nonProductReason) ||
      getNonProductReason(kind) ||
      (getBoolean(item.needsVerification)
          ? 'Nguồn chưa đủ tín hiệu xác minh sản phẩm thật.'
          : isRealProductKind(kind)
              ? 'Sản phẩm sẽ được kiểm link/ảnh/giá trước khi public.'
              : 'Không public tự động.')
  );
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
    return { label: 'Ứng viên public', badge: 'badge-info' };
  }

  return { label: 'Cần xem xét', badge: 'badge-warning' };
}

function getAtQualityScore(item: AccessTradeItem): number | null {
  const raw = item.qualityScore ?? item.sourceQualityScore;
  const score = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : undefined;

  if (score === undefined || !Number.isFinite(score)) return null;

  return Math.round(score);
}

function countAtItems(items: AccessTradeItem[], kind: ProductKind | string): number {
  return items.filter((item) => getAtItemKind(item) === kind).length;
}

function normalizeAtResults(data: AccessTradeResults | AccessTradeItem[] | undefined): AccessTradeResults {
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
        products: data.filter((item) => isRealProductKind(getAtItemKind(item))).length,
        realProducts: data.filter((item) => isRealProductKind(getAtItemKind(item))).length,
        vouchers: countAtItems(data, 'voucher'),
        campaigns: countAtItems(data, 'campaign'),
        storeOffers: countAtItems(data, 'store_offer'),
        unknown: countAtItems(data, 'unknown'),
        publicEligibleProducts: data.filter((item) => getBoolean(item.autoPublishEligible)).length,
        blockedFromPublic: data.filter((item) => !getBoolean(item.autoPublishEligible)).length,
      },
    };
  }

  const items = Array.isArray(data?.items) ? data.items : [];

  return {
    items,
    products: Array.isArray(data?.products) ? data.products : items.filter((item) => isRealProductKind(getAtItemKind(item))),
    vouchers: Array.isArray(data?.vouchers) ? data.vouchers : items.filter((item) => getAtItemKind(item) === 'voucher'),
    campaigns: Array.isArray(data?.campaigns) ? data.campaigns : items.filter((item) => getAtItemKind(item) === 'campaign'),
    storeOffers: Array.isArray(data?.storeOffers)
        ? data.storeOffers
        : items.filter((item) => getAtItemKind(item) === 'store_offer'),
    unknown: Array.isArray(data?.unknown) ? data.unknown : items.filter((item) => getAtItemKind(item) === 'unknown'),
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
      storeOffers: data?.summary?.storeOffers ?? countAtItems(items, 'store_offer'),
      unknown: data?.summary?.unknown ?? countAtItems(items, 'unknown'),
      publicEligibleProducts:
          data?.summary?.publicEligibleProducts ??
          data?.summary?.publicCandidates ??
          items.filter((item) => getBoolean(item.autoPublishEligible)).length,
      publicCandidates:
          data?.summary?.publicCandidates ??
          items.filter((item) => normalizeText(item.publicDecision) === 'public_candidate').length,
      needsReview:
          data?.summary?.needsReview ??
          items.filter((item) => normalizeText(item.publicDecision) === 'needs_review').length,
      archived:
          data?.summary?.archived ??
          items.filter((item) => normalizeText(item.publicDecision) === 'archived').length,
      blockedFromPublic:
          data?.summary?.blockedFromPublic ??
          items.filter((item) => !getBoolean(item.autoPublishEligible)).length,
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
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </div>
  );
}

export default function ProductSourcesPage() {
  const [activeTab, setActiveTab] = useState<TabId>('manual');
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
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
          note: atConfigured ? 'Đang hoạt động — ưu tiên sản phẩm thật' : 'Cần cấu hình API key',
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
          name: 'Thủ công',
          tab: 'manual',
          status: 'active',
          note: 'Luôn vào hàng chờ an toàn',
          icon: 'M',
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
      const data = (await res.json()) as ApiEnvelope<Product[]>;

      if ((data.ok || data.success) && Array.isArray(data.data)) {
        setRecentProducts(data.data.slice(0, 10));
      }
    } catch {
      // Ignore recent product preview errors.
    }

    try {
      const healthRes = await fetch('/api/app-health', { cache: 'no-store' });
      const healthData = (await healthRes.json()) as ApiEnvelope<{
        integrations?: {
          accesstrade?: {
            configured?: boolean;
          };
        };
      }>;

      if (healthData.ok || healthData.success) {
        setAtConfigured(Boolean(healthData.data?.integrations?.accesstrade?.configured));
      }
    } catch {
      setAtConfigured(false);
    }
  }, []);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const handleChange = (
      event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => {
    setForm((prev) => ({ ...prev, [event.target.name]: event.target.value }));
  };

  const handleSave = async (status: string, runScore = false) => {
    if (!form.title.trim()) {
      showToast('error', 'Tên sản phẩm là bắt buộc.');
      return;
    }

    if (!form.platform) {
      showToast('error', 'Nền tảng là bắt buộc.');
      return;
    }

    if (!form.originalUrl.trim() && !form.affiliateUrl.trim()) {
      showToast('error', 'Cần ít nhất link sản phẩm gốc hoặc link affiliate.');
      return;
    }

    const kind = getKind(form.kind);
    const isNonProduct = isNonProductKind(kind);
    const finalStatus = status === 'draft' ? 'draft' : isNonProduct ? 'archived' : 'needs_review';
    const blockReason = isNonProduct
        ? getNonProductReason(kind)
        : 'Sản phẩm thủ công cần xác minh nguồn trước khi public.';

    setSaving(true);

    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          source: 'manual',
          dataSource: 'manual',
          importedFrom: 'manual',
          sourceType: 'manual',
          kind,
          sourceItemKind: kind,
          status: finalStatus,
          verifiedSource: false,
          sourceVerified: false,
          needsVerification: true,
          publicHidden: true,
          aiApproved: false,
          autoPublished: false,
          approvalMode: 'manual_review_required',
          publicDecision: isNonProduct ? 'archived' : 'needs_review',
          publicBlockReason: blockReason,
          nonProductReason: isNonProduct ? blockReason : undefined,
          autoPublishBlockedReason: blockReason,
          price: parsePrice(form.price),
          salePrice: parsePrice(form.salePrice),
          gallery: splitLines(form.gallery),
          tags: splitTags(form.tags),
          benefits: splitLines(form.benefits),
          warnings: [
            ...splitLines(form.warnings),
            'Không fake giá, ảnh, tồn kho, review hoặc trải nghiệm mua hàng.',
          ],
          painPoints: splitLines(form.painPoints),
          targetAudience: splitLines(form.targetAudience),
          contentAngles: splitLines(form.contentAngles),
          checkBeforeBuy: [
            'Kiểm tra giá, phí vận chuyển và điều kiện ưu đãi trước khi mua.',
            'Giá, tồn kho và ưu đãi có thể thay đổi theo thời điểm.',
            'SanDeal có thể nhận hoa hồng affiliate nếu bạn mua qua liên kết, giá người mua không đổi.',
          ],
        }),
      });

      const data = (await res.json()) as ApiEnvelope<Product>;

      if (data.ok || data.success) {
        showToast(
            'success',
            status === 'draft'
                ? 'Đã lưu nháp sản phẩm.'
                : isNonProduct
                    ? 'Đã lưu nội bộ. Voucher/campaign/ưu đãi shop sẽ không public như sản phẩm.'
                    : 'Đã thêm sản phẩm thủ công vào hàng chờ an toàn.',
        );

        setForm(EMPTY_FORM);

        if (runScore && data.data?.id) {
          await fetch(`/api/products/${data.data.id}/score`, { method: 'POST' });
        }

        await loadRecent();
      } else {
        showToast('error', data.message || data.error || 'Không thể thêm sản phẩm.');
      }
    } catch {
      showToast('error', 'Lỗi kết nối. Vui lòng thử lại.');
    } finally {
      setSaving(false);
    }
  };

  const handleRunAutoPilot = async (mode: 'source_scan' | 'full_safe_run' = 'source_scan') => {
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

      const data = (await res.json()) as ApiEnvelope<unknown>;

      if (!res.ok || (!data.ok && !data.success)) {
        throw new Error(data.message || data.error || `Không chạy được bot. HTTP ${res.status}`);
      }

      showToast(
          'success',
          mode === 'full_safe_run'
              ? 'Đã khởi chạy AutoPilot toàn bộ. Chỉ sản phẩm thật đạt chuẩn mới được public.'
              : 'Đã khởi chạy Source Scout. Bot sẽ ưu tiên sản phẩm thật và giữ voucher/campaign nội bộ.',
      );

      await loadRecent();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Không chạy được AutoPilot.');
    } finally {
      setRunningBot(false);
    }
  };

  const handleAtSearch = async () => {
    if (!atConfigured) {
      showToast('error', 'AccessTrade chưa được cấu hình. Hãy mở Token Vault để thêm API key.');
      return;
    }

    setAtLoading(true);
    setAtError('');
    setAtResults(null);

    try {
      const res = await fetch('/api/product-sources/accesstrade/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: atKeyword, kind: atKind, limit: 20 }),
      });

      const data = (await res.json()) as ApiEnvelope<AccessTradeResults | AccessTradeItem[]>;

      if (data.ok || data.success) {
        setAtResults(normalizeAtResults(data.data));
      } else {
        setAtError(data.message || data.error || 'Lỗi khi tìm kiếm.');
      }
    } catch {
      setAtError('Không thể kết nối đến server.');
    } finally {
      setAtLoading(false);
    }
  };

  const handleAtSave = async (item: AccessTradeItem, runScore = false) => {
    const itemId =
        getString(item.id) ||
        getString(item.productId) ||
        getString(item.sourceId) ||
        getString(item.name) ||
        getString(item.title);

    setAtSaving(itemId);

    const kind = getAtItemKind(item);
    const isProduct = isRealProductKind(kind);
    const isPublicCandidate = getBoolean(item.autoPublishEligible);
    const verifiedSource = Boolean(item.verifiedSource === true || item.sourceVerified === true);
    const needsVerification =
        typeof item.needsVerification === 'boolean'
            ? item.needsVerification
            : !verifiedSource || !isProduct || !isPublicCandidate;

    const blockReason = getAtItemMainReason(item);
    const publicDecision =
        getString(item.publicDecision) ||
        (isProduct && isPublicCandidate ? 'needs_review' : isNonProductKind(kind) ? 'archived' : 'needs_review');

    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: getString(item.name) || getString(item.title) || '',
          description: getString(item.description) || '',
          kind,
          sourceItemKind: kind,

          platform: 'accesstrade',
          source: 'accesstrade',
          dataSource: 'accesstrade',
          importedFrom: 'accesstrade',
          sourceType: 'affiliate',
          rawSourceKind: getString(item.rawSourceKind) || kind,

          verifiedSource: isProduct && verifiedSource,
          sourceVerified: isProduct && verifiedSource,
          needsVerification,
          publicHidden: true,
          aiApproved: false,
          autoPublished: false,
          approvalMode: 'manual_or_auto_safe_required',

          originalUrl: getString(item.originalUrl) || getString(item.url) || '',
          affiliateUrl: getString(item.affiliateUrl) || '',
          url: getString(item.affiliateUrl) || getString(item.originalUrl) || getString(item.url) || '',

          imageUrl: getString(item.imageUrl) || '',
          price: getNumber(item.price),
          salePrice: getNumber(item.salePrice),
          category: getString(item.category) || '',
          campaignName: getString(item.campaignName) || '',

          affiliateSource: 'accesstrade',
          priceNote: 'Giá, tồn kho và ưu đãi có thể thay đổi theo thời điểm.',
          affiliateDisclosure: 'SanDeal có thể nhận hoa hồng affiliate. Giá của bạn không thay đổi.',
          checkBeforeBuy: [
            'Kiểm tra giá, phí vận chuyển và điều kiện ưu đãi trước khi mua.',
            'Giá, tồn kho và ưu đãi có thể thay đổi theo thời điểm.',
            'SanDeal có thể nhận hoa hồng affiliate nếu bạn mua qua liên kết, giá người mua không đổi.',
          ],
          warnings: [
            isNonProductKind(kind)
                ? getNonProductReason(kind)
                : 'Không fake giá, ảnh, tồn kho, review hoặc trải nghiệm mua hàng.',
          ],

          status: isNonProductKind(kind) ? 'archived' : 'needs_review',
          publicDecision,
          publicBlockReason: blockReason,
          nonProductReason: isNonProductKind(kind) ? getNonProductReason(kind) : undefined,
          autoPublishBlockedReason: blockReason,

          autoPublishEligible: isPublicCandidate,
          qualityScore: getAtQualityScore(item) || undefined,
          sourceQualityScore: getAtQualityScore(item) || undefined,

          rawSourceType: 'accesstrade',
          rawData: item.rawData && typeof item.rawData === 'object' ? item.rawData : item,
        }),
      });

      const data = (await res.json()) as ApiEnvelope<Product>;

      if (data.ok || data.success) {
        if (runScore && data.data?.id) {
          await fetch(`/api/products/${data.data.id}/score`, { method: 'POST' });
        }

        showToast(
            'success',
            isProduct
                ? 'Đã lưu sản phẩm AccessTrade vào hàng chờ an toàn. Bot/Health Guard sẽ kiểm link, ảnh, giá trước khi public.'
                : 'Đã lưu item AccessTrade nội bộ. Voucher/campaign/ưu đãi shop sẽ không public như sản phẩm.',
        );

        await loadRecent();
      } else {
        showToast('error', data.message || data.error || 'Không thể lưu sản phẩm.');
      }
    } catch {
      showToast('error', 'Lỗi kết nối.');
    } finally {
      setAtSaving(null);
    }
  };

  const renderPlaceholderTab = (icon: string, title: string, desc: string, keys?: string) => (
      <div className="coming-soon-container" style={{ minHeight: 'auto', padding: 'var(--space-xl) 0' }}>
        <div className="coming-soon-card" style={{ padding: 'var(--space-xl)' }}>
          <span className="coming-soon-icon">{icon}</span>
          <h3 className="coming-soon-title" style={{ fontSize: 'var(--text-xl)' }}>
            {title}
          </h3>
          <p className="coming-soon-desc">{desc}</p>

          <div
              className="disclosure-banner"
              style={{ textAlign: 'left', margin: 'var(--space-lg) 0 0' }}
          >
            Các nguồn này sẽ được thêm sau. Hiện tại nên nhập thủ công vào hàng chờ an toàn,
            không public trực tiếp nếu chưa kiểm link, ảnh, giá và nguồn xác minh.
          </div>

          <div className="coming-soon-actions">
            <button className="btn btn-primary" onClick={() => setActiveTab('manual')}>
              Thêm thủ công
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
        <section className="command-hero" style={{ marginBottom: 'var(--space-xl)' }}>
          <div className="command-hero-content">
            <div className="badge badge-purple" style={{ marginBottom: 'var(--space-md)' }}>
              Data Source Center
            </div>

            <h1 className="page-title">Trung tâm nguồn dữ liệu</h1>

            <p className="page-subtitle" style={{ maxWidth: 760 }}>
              Kết nối nguồn sản phẩm thật để bot AI tự quét, phân loại, chấm điểm và public an toàn.
              Voucher, campaign, ưu đãi shop và dữ liệu thiếu link/ảnh/giá chỉ được lưu nội bộ.
            </p>

            <div className="flex gap-sm" style={{ flexWrap: 'wrap', marginTop: 'var(--space-md)' }}>
              <span className="badge badge-success">Safe Mode ON</span>
              <span className="badge badge-success">Free Only ON</span>
              <span className="badge badge-info">AutoPilot ON</span>
              <span className="badge badge-success">Safe Publish ON</span>
            </div>

            <div className="flex gap-sm" style={{ flexWrap: 'wrap', marginTop: 'var(--space-lg)' }}>
              <button
                  type="button"
                  className="primary-button"
                  disabled={runningBot}
                  onClick={() => void handleRunAutoPilot('source_scan')}
              >
                {runningBot ? 'Đang chạy...' : 'Quét sản phẩm thật & tự public an toàn'}
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
                  <span style={{ color: atConfigured ? 'var(--color-success)' : 'var(--color-warning)' }}>
                  {atConfigured ? 'Đã cấu hình' : 'Cần API key'}
                </span>
                </div>

                <div className="detail-meta-row">
                  <span>Ưu tiên</span>
                  <span style={{ color: 'var(--color-success)' }}>Sản phẩm thật/datafeed</span>
                </div>

                <div className="detail-meta-row">
                  <span>Voucher/campaign</span>
                  <span style={{ color: 'var(--color-warning)' }}>Chỉ lưu nội bộ</span>
                </div>

                <div className="detail-meta-row">
                  <span>Chi phí API</span>
                  <span style={{ color: 'var(--color-success)' }}>0đ Free Only</span>
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
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                Sản phẩm thật/datafeed có tên, link, ảnh, giá và nguồn xác minh.
              </div>
            </div>

            <div className="metric-card">
              <span className="badge badge-warning">Lưu nội bộ</span>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                Voucher, campaign, store offer không được public như sản phẩm.
              </div>
            </div>

            <div className="metric-card">
              <span className="badge badge-info">Health Guard</span>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                Chỉ public khi link và ảnh kiểm tra OK, không 404/403/timeout.
              </div>
            </div>

            <div className="metric-card">
              <span className="badge badge-success">Affiliate minh bạch</span>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                Luôn nhắc giá/ưu đãi có thể thay đổi và SanDeal có thể nhận hoa hồng.
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
          {/* ====== MANUAL TAB ====== */}
          {activeTab === 'manual' && (
              <div className="card" style={{ maxWidth: '900px' }}>
                <div className="flex items-start justify-between gap-md" style={{ marginBottom: 'var(--space-lg)' }}>
                  <div>
                    <h3 className="card-title">Thêm sản phẩm thủ công</h3>
                    <p className="page-subtitle" style={{ marginTop: 6 }}>
                      Sản phẩm thủ công sẽ được lưu vào hàng chờ, không tự public cho tới khi nguồn, link,
                      ảnh và giá được kiểm tra.
                    </p>
                  </div>
                  <span className="badge badge-warning">Manual cần duyệt</span>
                </div>

                {/* Basic Info */}
                <fieldset className="form-fieldset">
                  <legend className="form-legend">Thông tin cơ bản</legend>

                  <div className="form-row">
                    <div className="form-group" style={{ flex: 2 }}>
                      <label className="label">Tên sản phẩm *</label>
                      <input
                          className="input"
                          name="title"
                          value={form.title}
                          onChange={handleChange}
                          placeholder="VD: Tai nghe Bluetooth ABC 500mAh"
                      />
                    </div>

                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Nền tảng *</label>
                      <select className="select" name="platform" value={form.platform} onChange={handleChange}>
                        <option value="shopee">Shopee</option>
                        <option value="tiktok_shop">TikTok Shop</option>
                        <option value="lazada">Lazada</option>
                        <option value="accesstrade">AccessTrade</option>
                        <option value="website">Website khác</option>
                      </select>
                    </div>
                  </div>

                  <div className="form-group">
                    <label className="label">Mô tả ngắn</label>
                    <textarea
                        className="textarea"
                        name="description"
                        value={form.description}
                        onChange={handleChange}
                        rows={2}
                        placeholder="Mô tả ngắn gọn về sản phẩm..."
                    />
                  </div>

                  <div className="form-row">
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Loại</label>
                      <select className="select" name="kind" value={form.kind} onChange={handleChange}>
                        <option value="product">Sản phẩm</option>
                        <option value="deal">Deal</option>
                        <option value="voucher">Voucher</option>
                        <option value="campaign">Campaign</option>
                        <option value="store_offer">Ưu đãi shop</option>
                      </select>
                    </div>

                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Danh mục</label>
                      <input
                          className="input"
                          name="category"
                          value={form.category}
                          onChange={handleChange}
                          placeholder="VD: Công nghệ"
                      />
                    </div>

                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Tags</label>
                      <input
                          className="input"
                          name="tags"
                          value={form.tags}
                          onChange={handleChange}
                          placeholder="VD: tai nghe, bluetooth"
                      />
                    </div>
                  </div>
                </fieldset>

                {/* Links & Images */}
                <fieldset className="form-fieldset">
                  <legend className="form-legend">Liên kết & hình ảnh</legend>

                  <div className="form-row">
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Link sản phẩm gốc</label>
                      <input
                          className="input"
                          name="originalUrl"
                          value={form.originalUrl}
                          onChange={handleChange}
                          placeholder="https://..."
                      />
                    </div>

                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Link affiliate *</label>
                      <input
                          className="input"
                          name="affiliateUrl"
                          value={form.affiliateUrl}
                          onChange={handleChange}
                          placeholder="https://..."
                      />
                    </div>
                  </div>

                  <div className="form-row">
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Link ảnh sản phẩm</label>
                      <input
                          className="input"
                          name="imageUrl"
                          value={form.imageUrl}
                          onChange={handleChange}
                          placeholder="https://..."
                      />
                    </div>

                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Link ảnh phụ, mỗi dòng một URL</label>
                      <textarea
                          className="textarea"
                          name="gallery"
                          value={form.gallery}
                          onChange={handleChange}
                          rows={2}
                          placeholder={'https://image1.jpg\nhttps://image2.jpg'}
                          style={{ minHeight: '60px' }}
                      />
                    </div>
                  </div>
                </fieldset>

                {/* Price */}
                <fieldset className="form-fieldset">
                  <legend className="form-legend">Giá & ưu đãi</legend>

                  <div className="form-row">
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Giá gốc, VND</label>
                      <input
                          className="input"
                          name="price"
                          type="number"
                          value={form.price}
                          onChange={handleChange}
                          placeholder="VD: 299000"
                      />
                    </div>

                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Giá khuyến mãi, VND</label>
                      <input
                          className="input"
                          name="salePrice"
                          type="number"
                          value={form.salePrice}
                          onChange={handleChange}
                          placeholder="VD: 199000"
                      />
                    </div>

                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Ghi chú giá</label>
                      <input
                          className="input"
                          name="priceNote"
                          value={form.priceNote}
                          onChange={handleChange}
                      />
                    </div>
                  </div>
                </fieldset>

                {/* Content Intelligence */}
                <fieldset className="form-fieldset">
                  <legend className="form-legend">Góc nội dung</legend>

                  <div className="form-row">
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Lợi ích chính, mỗi dòng một lợi ích</label>
                      <textarea
                          className="textarea"
                          name="benefits"
                          value={form.benefits}
                          onChange={handleChange}
                          rows={3}
                          placeholder={'Chống ồn chủ động\nPin 30 giờ\nBluetooth 5.3'}
                      />
                    </div>

                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Cảnh báo / Không được nói quá</label>
                      <textarea
                          className="textarea"
                          name="warnings"
                          value={form.warnings}
                          onChange={handleChange}
                          rows={3}
                          placeholder={'Không cam kết chất lượng tuyệt đối\nKhông khẳng định chữa bệnh'}
                      />
                    </div>
                  </div>

                  <div className="form-row">
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Pain point khách hàng</label>
                      <textarea
                          className="textarea"
                          name="painPoints"
                          value={form.painPoints}
                          onChange={handleChange}
                          rows={2}
                          placeholder={'Muốn tai nghe không dây\nCần tai nghe cho họp online'}
                      />
                    </div>

                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Đối tượng phù hợp</label>
                      <textarea
                          className="textarea"
                          name="targetAudience"
                          value={form.targetAudience}
                          onChange={handleChange}
                          rows={2}
                          placeholder={'Dân văn phòng\nSinh viên'}
                      />
                    </div>
                  </div>

                  <div className="form-row">
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Gợi ý góc nội dung</label>
                      <textarea
                          className="textarea"
                          name="contentAngles"
                          value={form.contentAngles}
                          onChange={handleChange}
                          rows={2}
                          placeholder={'Review trung thực\nSo sánh với sản phẩm khác'}
                      />
                    </div>

                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Ghi chú kiểm duyệt</label>
                      <textarea
                          className="textarea"
                          name="complianceNotes"
                          value={form.complianceNotes}
                          onChange={handleChange}
                          rows={2}
                      />
                    </div>
                  </div>
                </fieldset>

                {/* Kiểm duyệt & rủi ro */}
                <fieldset className="form-fieldset">
                  <legend className="form-legend">Kiểm duyệt & rủi ro</legend>

                  <div className="form-row">
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Nguồn affiliate</label>
                      <input
                          className="input"
                          name="affiliateSource"
                          value={form.affiliateSource}
                          onChange={handleChange}
                      />
                    </div>

                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Tên chiến dịch</label>
                      <input
                          className="input"
                          name="campaignName"
                          value={form.campaignName}
                          onChange={handleChange}
                      />
                    </div>
                  </div>

                  <div className="form-row">
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Ghi chú hoa hồng</label>
                      <input
                          className="input"
                          name="commissionNote"
                          value={form.commissionNote}
                          onChange={handleChange}
                      />
                    </div>

                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="label">Affiliate disclosure</label>
                      <input
                          className="input"
                          name="affiliateDisclosure"
                          value={form.affiliateDisclosure}
                          onChange={handleChange}
                          placeholder="VD: Bài viết có chứa link liên kết..."
                      />
                    </div>
                  </div>
                </fieldset>

                {/* Actions */}
                <div className="form-actions">
                  <button
                      className="btn btn-primary"
                      disabled={saving}
                      onClick={() => void handleSave('needs_review')}
                  >
                    {saving ? 'Đang lưu...' : 'Lưu vào hàng chờ'}
                  </button>

                  <button
                      className="btn btn-secondary"
                      disabled={saving}
                      onClick={() => void handleSave('draft')}
                  >
                    Lưu nháp
                  </button>

                  <button
                      className="btn btn-accent"
                      disabled={saving}
                      onClick={() => void handleSave('needs_review', true)}
                  >
                    Lưu và chấm điểm
                  </button>

                  <Link href="/dashboard/products" className="btn btn-ghost">
                    Xem danh sách
                  </Link>
                </div>
              </div>
          )}

          {/* ====== ACCESSTRADE TAB ====== */}
          {activeTab === 'accesstrade' && (
              <div>
                <div className="card" style={{ maxWidth: '960px', marginBottom: 'var(--space-lg)' }}>
                  <div className="flex items-start justify-between gap-md" style={{ marginBottom: 'var(--space-md)' }}>
                    <div>
                      <h3 className="card-title">AccessTrade Real Product Feed</h3>
                      <p className="page-subtitle" style={{ marginTop: 6, maxWidth: 720 }}>
                        Tìm và kiểm tra dữ liệu AccessTrade. Hệ thống sẽ phân loại rõ sản phẩm thật,
                        voucher, campaign và ưu đãi shop. Chỉ sản phẩm thật có link/ảnh/giá hợp lệ mới
                        có thể đi tiếp vào Safe Publish.
                      </p>
                    </div>

                    <span className={`badge ${atConfigured ? 'badge-success' : 'badge-warning'}`}>
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
                        <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-lg)' }}>
                          Bạn cần cấu hình API key của AccessTrade trong Token Vault để tìm kiếm và quét sản phẩm.
                          Không gửi API key vào chat.
                        </p>
                        <Link href="/dashboard/token-vault" className="btn btn-primary">
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
                    <strong>Luồng an toàn:</strong> ưu tiên sản phẩm thật/datafeed → lưu nội bộ →
                    kiểm link/ảnh/giá → chỉ public nếu đạt chuẩn. Voucher/campaign/store offer không public như sản phẩm.
                  </div>

                  <div
                      className="form-row"
                      style={{
                        opacity: atConfigured ? 1 : 0.5,
                        pointerEvents: atConfigured ? 'auto' : 'none',
                      }}
                  >
                    <div className="form-group" style={{ flex: 2 }}>
                      <label className="label">Từ khoá</label>
                      <input
                          className="input"
                          value={atKeyword}
                          onChange={(event) => setAtKeyword(event.target.value)}
                          placeholder="VD: tai nghe, serum, sữa tắm, laptop..."
                      />
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

                  <div className="flex gap-sm" style={{ flexWrap: 'wrap', marginTop: 'var(--space-md)' }}>
                    <button className="btn btn-primary" onClick={() => void handleAtSearch()} disabled={atLoading}>
                      {atLoading ? 'Đang tìm...' : 'Tìm kiếm AccessTrade'}
                    </button>

                    <button
                        className="btn btn-accent"
                        onClick={() => void handleRunAutoPilot('source_scan')}
                        disabled={runningBot}
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
                            gridTemplateColumns: 'repeat(auto-fill, minmax(135px, 1fr))',
                            gap: 'var(--space-sm)',
                            marginBottom: 'var(--space-lg)',
                          }}
                      >
                        <div className="stat-card" style={{ padding: 'var(--space-md)' }}>
                          <div className="stat-card-value" style={{ fontSize: 'var(--text-xl)' }}>
                            {atResults.summary.total ?? atResults.items.length}
                          </div>
                          <div className="stat-card-label">Tổng kết quả</div>
                        </div>

                        <div className="stat-card" style={{ padding: 'var(--space-md)' }}>
                          <div className="stat-card-value" style={{ fontSize: 'var(--text-xl)' }}>
                            {atResults.summary.realProducts ?? atResults.summary.products ?? 0}
                          </div>
                          <div className="stat-card-label">Sản phẩm thật</div>
                        </div>

                        <div className="stat-card" style={{ padding: 'var(--space-md)' }}>
                          <div className="stat-card-value" style={{ fontSize: 'var(--text-xl)' }}>
                            {atResults.summary.storeOffers ?? 0}
                          </div>
                          <div className="stat-card-label">Ưu đãi shop</div>
                        </div>

                        <div className="stat-card" style={{ padding: 'var(--space-md)' }}>
                          <div className="stat-card-value" style={{ fontSize: 'var(--text-xl)' }}>
                            {atResults.summary.vouchers ?? 0}
                          </div>
                          <div className="stat-card-label">Voucher</div>
                        </div>

                        <div className="stat-card" style={{ padding: 'var(--space-md)' }}>
                          <div className="stat-card-value" style={{ fontSize: 'var(--text-xl)' }}>
                            {atResults.summary.campaigns ?? 0}
                          </div>
                          <div className="stat-card-label">Campaign</div>
                        </div>

                        <div className="stat-card" style={{ padding: 'var(--space-md)' }}>
                          <div className="stat-card-value" style={{ fontSize: 'var(--text-xl)' }}>
                            {atResults.summary.publicEligibleProducts ?? atResults.summary.publicCandidates ?? 0}
                          </div>
                          <div className="stat-card-label">Ứng viên public</div>
                        </div>
                      </div>

                      {/* Results */}
                      {atResults.items.map((rawItem, index) => {
                        const item = rawItem as AccessTradeItem;
                        const itemId = getString(item.id) || `${index}`;
                        const name = getAtItemName(item);
                        const kind = getAtItemKind(item);
                        const isProduct = isRealProductKind(kind);
                        const publicDecision = getAtPublicDecision(item);
                        const qualityScore = getAtQualityScore(item);
                        const reason = getAtItemMainReason(item);
                        const imageUrl = getString(item.imageUrl);
                        const affiliateUrl = getString(item.affiliateUrl);

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
                                  <strong style={{ fontSize: 'var(--text-sm)' }}>{name}</strong>

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

                                  {!isProduct && (
                                      <span className="badge badge-neutral">Không public tự động</span>
                                  )}

                                  {getBoolean(item.needsVerification) && (
                                      <span className="badge badge-warning">Cần xác minh</span>
                                  )}
                                </div>

                                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.55 }}>
                                  {formatPrice(item.salePrice || item.price)}
                                  {affiliateUrl ? ' • Có link affiliate' : ' • Chưa có link affiliate'}
                                  {imageUrl ? ' • Có ảnh' : ' • Chưa có ảnh'}
                                </p>

                                <p
                                    style={{
                                      fontSize: 'var(--text-xs)',
                                      color: isProduct ? 'var(--text-secondary)' : '#f59e0b',
                                      lineHeight: 1.55,
                                      marginTop: 4,
                                    }}
                                >
                                  {reason}
                                </p>

                                <div className="flex gap-sm" style={{ marginTop: 'var(--space-sm)', flexWrap: 'wrap' }}>
                                  <button
                                      className="btn btn-sm btn-primary"
                                      disabled={atSaving === itemId}
                                      onClick={() => void handleAtSave(item)}
                                  >
                                    {atSaving === itemId ? 'Đang lưu...' : 'Lưu vào hàng chờ'}
                                  </button>

                                  <button
                                      className="btn btn-sm btn-accent"
                                      disabled={atSaving === itemId}
                                      onClick={() => void handleAtSave(item, true)}
                                  >
                                    Lưu và chấm điểm
                                  </button>
                                </div>
                              </div>
                            </div>
                        );
                      })}

                      {atResults.items.length === 0 && (
                          <div className="empty-state">
                            <div className="empty-state-icon" style={{ fontSize: 32, opacity: 0.35 }}>
                              AT
                            </div>
                            <div className="empty-state-title">Không tìm thấy kết quả</div>
                            <div className="empty-state-desc">Thử thay đổi từ khoá hoặc bộ lọc.</div>
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
              <div className="coming-soon-container" style={{ minHeight: 'auto', padding: 'var(--space-xl) 0' }}>
                <div className="coming-soon-card" style={{ padding: 'var(--space-xl)' }}>
                  <span className="coming-soon-icon">CSV</span>
                  <h3 className="coming-soon-title" style={{ fontSize: 'var(--text-xl)' }}>
                    Nhập từ CSV
                  </h3>
                  <p className="coming-soon-desc">Tính năng nhập CSV sẽ được thêm ở bước sau.</p>

                  <div
                      className="disclosure-banner"
                      style={{ textAlign: 'left', margin: 'var(--space-lg) 0 0' }}
                  >
                    <strong>Các cột dự kiến:</strong>
                    <br />
                    title, originalUrl, affiliateUrl, imageUrl, platform, price, salePrice, category, tags
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
                    <th>Nền tảng</th>
                    <th>Nguồn</th>
                    <th>Trạng thái</th>
                    <th>Điểm</th>
                    <th>Cập nhật</th>
                  </tr>
                  </thead>

                  <tbody>
                  {recentProducts.map((product) => {
                    const source = getRecentSource(product);

                    return (
                        <tr key={product.id}>
                          <td>
                            <div className="flex items-center gap-sm">
                              <SafeThumb src={product.imageUrl} label="S" size={36} />

                              <Link
                                  href={`/dashboard/products/${product.id}`}
                                  style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}
                              >
                                {product.title}
                              </Link>
                            </div>
                          </td>

                          <td>
                            <span className="badge badge-neutral">{product.platform}</span>
                          </td>

                          <td style={{ fontSize: 'var(--text-xs)' }}>{source}</td>

                          <td>
                        <span className={`badge ${getStatusBadgeClass(product.status)}`}>
                          {getStatusLabel(product.status)}
                        </span>
                          </td>

                          <td>{product.score != null ? product.score : '—'}</td>

                          <td style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                            {product.updatedAt
                                ? new Date(product.updatedAt).toLocaleDateString('vi-VN')
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