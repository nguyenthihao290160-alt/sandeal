import type { OutboundEvent, PriceSnapshot } from '@/lib/product-intelligence/types';
import type { AutomationJobListItem, AutomationJobStatus, AutomationJobType } from '@/lib/automation/types';
import type { Product, ProductLifecycleState, ProductOffer } from '@/lib/types';

export type AutomationPresentationTone = 'info' | 'active' | 'warning' | 'success' | 'danger' | 'unknown';

export interface AutomationJobPresentation {
  workflowLabel: string;
  statusLabel: string;
  tone: AutomationPresentationTone;
  progressLabel: string;
  nextAction: string;
  humanActionRequired: boolean;
  technicalReason: string;
}

const AUTOMATION_WORKFLOW_LABELS: Partial<Record<AutomationJobType, string>> = {
  AUTO_PILOT: 'AUTO_PILOT',
  PRODUCT_SCAN: 'Khám phá sản phẩm',
  PROCESS_CANDIDATE: 'Xử lý candidate',
  SCORE_PRODUCTS: 'Chấm điểm sản phẩm',
  RECHECK_PRODUCT_HEALTH: 'Kiểm tra sức khỏe sản phẩm',
  SAFE_PUBLISH: 'Safe Publish',
  AUTO_SAFE_PUBLISH: 'Safe Publish tự động',
  RECONCILE_AUTOMATION: 'Đối soát workflow',
  RUNTIME_GUARDIAN: 'Runtime Guardian',
};

const AUTOMATION_STATUS_PRESENTATION: Record<AutomationJobStatus, Pick<AutomationJobPresentation, 'statusLabel' | 'tone'>> = {
  PENDING: { statusLabel: 'Đang chờ Worker', tone: 'info' },
  WAITING_APPROVAL: { statusLabel: 'Chờ phê duyệt', tone: 'warning' },
  WAITING_FOR_MANUAL_INPUT: { statusLabel: 'Chờ thông tin từ operator', tone: 'warning' },
  WAITING_CHILDREN: { statusLabel: 'Đang chờ các tác vụ con', tone: 'active' },
  RUNNING: { statusLabel: 'Đang xử lý', tone: 'active' },
  RETRY_SCHEDULED: { statusLabel: 'Đã lên lịch thử lại', tone: 'warning' },
  SUCCEEDED: { statusLabel: 'Hoàn thành', tone: 'success' },
  FAILED: { statusLabel: 'Thất bại', tone: 'danger' },
  CANCELLED: { statusLabel: 'Đã hủy', tone: 'unknown' },
  BLOCKED: { statusLabel: 'Bị chặn bởi chính sách/an toàn', tone: 'warning' },
  PAUSED: { statusLabel: 'Đang tạm dừng', tone: 'warning' },
};

export function presentAutomationJob(job: AutomationJobListItem): AutomationJobPresentation {
  const status = AUTOMATION_STATUS_PRESENTATION[job.status];
  const progress = job.progress;
  const percentage = progress?.percentage ?? (progress?.total
    ? Math.round((progress.processed / progress.total) * 100)
    : 0);
  const progressLabel = progress?.total
    ? `${Math.min(progress.processed, progress.total)}/${progress.total} · ${Math.max(0, Math.min(100, percentage))}%`
    : progress
      ? `${Math.max(0, Math.min(100, percentage))}%`
      : 'Chưa có tiến độ';
  const nextAction = job.status === 'WAITING_CHILDREN'
    ? 'SanDeal sẽ tự đối soát khi các tác vụ con kết thúc.'
    : job.status === 'RETRY_SCHEDULED'
      ? 'SanDeal sẽ tự thử lại theo lịch đã lưu.'
      : job.status === 'PENDING'
        ? 'Worker sẽ nhận tác vụ khi có capacity.'
        : job.status === 'RUNNING'
          ? 'Worker đang tiếp tục xử lý; không cần can thiệp.'
          : job.status === 'WAITING_APPROVAL'
            ? 'Cần operator phê duyệt theo policy hiện hành.'
            : job.status === 'WAITING_FOR_MANUAL_INPUT'
              ? 'Cần operator cung cấp thông tin được yêu cầu.'
              : job.status === 'PAUSED'
                ? 'Chỉ tiếp tục qua quyền vận hành hiện hành.'
                : 'Xem chi tiết kỹ thuật để xác minh bước tiếp theo.';
  return {
    workflowLabel: AUTOMATION_WORKFLOW_LABELS[job.type] || job.type.replaceAll('_', ' '),
    ...status,
    progressLabel,
    nextAction,
    humanActionRequired: ['WAITING_APPROVAL', 'WAITING_FOR_MANUAL_INPUT', 'PAUSED'].includes(job.status),
    technicalReason: job.lastErrorCode || job.shortStatusReason || job.status,
  };
}

export type ProductPipelinePresentationStage =
  | 'discovered'
  | 'checking'
  | 'review'
  | 'safe_publish'
  | 'public'
  | 'unclassified';

export const PRODUCT_PIPELINE_STAGES: ReadonlyArray<{
  id: ProductPipelinePresentationStage;
  label: string;
  technicalLabel: string;
}> = [
  { id: 'discovered', label: 'Đã tìm thấy', technicalLabel: 'Discovered' },
  { id: 'checking', label: 'Đang kiểm tra', technicalLabel: 'Verification in progress' },
  { id: 'review', label: 'Cần xem lại', technicalLabel: 'Review required' },
  { id: 'safe_publish', label: 'Safe Publish', technicalLabel: 'Safe Publish eligible' },
  { id: 'public', label: 'Công khai', technicalLabel: 'Published' },
  { id: 'unclassified', label: 'Chưa phân loại', technicalLabel: 'Unclassified' },
] as const;

const CHECKING_LIFECYCLES = new Set<ProductLifecycleState>([
  'STAGED',
  'CLASSIFIED',
  'NORMALIZED',
  'VERIFYING',
  'CONTENT_PREPARING',
  'RETRY_SCHEDULED',
  'RECHECKING',
]);
const REVIEW_LIFECYCLES = new Set<ProductLifecycleState>([
  'QUARANTINED',
  'DEGRADED',
  'CONFIRMED_BROKEN',
  'HIDDEN',
]);

export function mapProductPipelineStage(
  product: Pick<Product, 'lifecycleState' | 'status' | 'publicHidden' | 'publicBlocked'>,
): ProductPipelinePresentationStage {
  if (product.lifecycleState === 'PUBLISHED' && product.status === 'published' && !product.publicHidden && !product.publicBlocked) {
    return 'public';
  }
  if (product.lifecycleState === 'READY_FOR_PUBLISH' || product.lifecycleState === 'PUBLISHING' || product.status === 'approved') {
    return 'safe_publish';
  }
  if (product.status === 'needs_review' || (product.lifecycleState && REVIEW_LIFECYCLES.has(product.lifecycleState))) {
    return 'review';
  }
  if (product.lifecycleState && CHECKING_LIFECYCLES.has(product.lifecycleState)) return 'checking';
  if (product.lifecycleState === 'DISCOVERED' || (product.status === 'draft' && !product.lifecycleState)) return 'discovered';
  return 'unclassified';
}

const REASON_TRANSLATIONS: Readonly<Record<string, string>> = {
  JOB_PICKUP_LATENCY_SLO_FAILED: 'Độ trễ xử lý job chưa đạt',
  JOB_READ_MODEL_INCOMPLETE: 'Dữ liệu trạng thái job chưa đầy đủ',
  JOB_READ_MODEL_UNAVAILABLE: 'Chưa thể đọc trạng thái job',
  WORKER_HEARTBEAT_STALE: 'Worker chưa gửi nhịp hoạt động mới',
  SCHEDULER_HEARTBEAT_STALE: 'Scheduler chưa gửi nhịp hoạt động mới',
  WORKER_RELEASE_MISMATCH: 'Release Identity của Worker không khớp với Web',
  SCHEDULER_RELEASE_MISMATCH: 'Release Identity của Scheduler không khớp với Web',
  WORKER_RELEASE_UNVERIFIED: 'Chưa xác minh Release Identity của Worker',
  SCHEDULER_RELEASE_UNVERIFIED: 'Chưa xác minh Release Identity của Scheduler',
  PRODUCT_SELECTION_SOURCE_CHANGED: 'Kho sản phẩm thay đổi trong lúc chọn dữ liệu; SanDeal sẽ thử lại an toàn',
  WAITING_CHILDREN: 'Workflow đang chờ các bước con hoàn tất',
  RETRY_SCHEDULED: 'SanDeal đã lên lịch thử lại tự động',
  RUNTIME_GUARDIAN_BLOCKED: 'Runtime Guardian đang giữ hệ thống ở chế độ an toàn',
  SAFE_PUBLISH_DISABLED: 'Safe Publish chưa được bật',
  KILL_SWITCH_ACTIVE: 'Kill switch đang hoạt động',
  PUBLISH_PAUSED: 'Publication đang tạm dừng',
};

export function explainTechnicalReason(reasonCode: string): { label: string; technicalCode: string } {
  const technicalCode = String(reasonCode || 'UNKNOWN').trim() || 'UNKNOWN';
  return {
    label: REASON_TRANSLATIONS[technicalCode] || 'Hệ thống cần kiểm tra thêm thông tin kỹ thuật',
    technicalCode,
  };
}

const PRODUCT_REASON_TRANSLATIONS: Readonly<Record<string, string>> = {
  review_not_indexable: 'Nội dung review chưa đủ điều kiện lập chỉ mục',
  affiliate_url_unhealthy: 'Liên kết affiliate chưa vượt qua kiểm tra an toàn',
  affiliate_url_missing: 'Chưa có liên kết affiliate',
  product_url_unhealthy: 'Liên kết sản phẩm chưa vượt qua kiểm tra an toàn',
  image_unhealthy: 'Ảnh sản phẩm chưa vượt qua kiểm tra',
  price_missing: 'Chưa có giá được xác minh',
  price_not_verified: 'Giá hiện tại chưa được xác minh',
  duplicate_unresolved: 'Danh tính trùng lặp chưa được xử lý',
  source_not_verified: 'Nguồn sản phẩm chưa được xác minh',
  runtime_publish_blocked: 'Runtime Guardian đang giữ publication ở chế độ an toàn',
};

export function explainProductReason(reasonCode: string): { label: string; technicalCode: string } {
  const technicalCode = String(reasonCode || 'UNKNOWN').trim() || 'UNKNOWN';
  return {
    label: PRODUCT_REASON_TRANSLATIONS[technicalCode]
      || REASON_TRANSLATIONS[technicalCode]
      || 'Sản phẩm cần thêm bằng chứng trước khi tiếp tục',
    technicalCode,
  };
}

export type ProductFunnelId =
  | 'workspace'
  | 'travel'
  | 'gifts'
  | 'technology'
  | 'family'
  | 'personal_care'
  | 'unclassified';

export interface ProductFunnelPresentation {
  id: ProductFunnelId;
  label: string;
  confidence: number;
  matchedTerms: string[];
}

const FUNNEL_RULES: ReadonlyArray<{
  id: Exclude<ProductFunnelId, 'unclassified'>;
  label: string;
  terms: string[];
}> = [
  { id: 'workspace', label: 'Góc làm việc văn phòng', terms: ['van phong', 'ban lam viec', 'ghe cong thai hoc', 'may in', 'webcam', 'ban phim'] },
  { id: 'travel', label: 'Hành trang du lịch', terms: ['du lich', 'vali', 'tui du lich', 'goi co', 'adapter du lich', 'chong nang'] },
  { id: 'gifts', label: 'Quà tặng sinh nhật', terms: ['qua tang', 'sinh nhat', 'gift', 'hop qua'] },
  { id: 'technology', label: 'Đồ công nghệ đáng mua', terms: ['cong nghe', 'dien thoai', 'laptop', 'tai nghe', 'loa bluetooth', 'smartwatch', 'may tinh bang'] },
  { id: 'family', label: 'Deal gia đình', terms: ['gia dinh', 'nha bep', 'noi chien', 'may hut bui', 'do gia dung', 'me va be'] },
  { id: 'personal_care', label: 'Chăm sóc cá nhân', terms: ['cham soc ca nhan', 'my pham', 'duong da', 'dau goi', 'may say toc', 'kem chong nang'] },
] as const;

function searchableText(value: unknown): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('vi')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function classifyProductFunnel(
  product: Pick<Product, 'title' | 'category' | 'tags' | 'description'>,
): ProductFunnelPresentation {
  const category = searchableText(product.category);
  const title = searchableText(product.title);
  const supplemental = searchableText([...(product.tags || []), product.description || ''].join(' '));
  const candidates = FUNNEL_RULES.map(rule => {
    const categoryMatches = rule.terms.filter(term => category.includes(term));
    const titleMatches = rule.terms.filter(term => title.includes(term));
    const supplementalMatches = rule.terms.filter(term => supplemental.includes(term));
    const matchedTerms = [...new Set([...categoryMatches, ...titleMatches, ...supplementalMatches])];
    const score = categoryMatches.length * 4 + titleMatches.length * 3 + supplementalMatches.length;
    return { rule, matchedTerms, score, strong: categoryMatches.length > 0 || titleMatches.length > 0 };
  }).sort((left, right) => right.score - left.score || left.rule.id.localeCompare(right.rule.id));
  const winner = candidates[0];
  if (!winner || winner.score < 3 || !winner.strong) {
    return { id: 'unclassified', label: 'Chưa phân loại', confidence: 0, matchedTerms: [] };
  }
  return {
    id: winner.rule.id,
    label: winner.rule.label,
    confidence: Math.min(0.98, Number((0.7 + Math.min(0.28, winner.score * 0.035)).toFixed(2))),
    matchedTerms: winner.matchedTerms,
  };
}

export interface DealMatrixRow {
  offerId: string;
  platform: string;
  seller: string;
  currentPrice: number | null;
  originalPrice: number | null;
  verifiedDiscountPercent: number | null;
  affiliateAvailable: boolean;
  affiliateUrl: string | null;
  health: ProductOffer['health'];
  lastCheckedAt: string;
  expiresAt: string | null;
}

export interface DealMatrixPresentation {
  available: boolean;
  reason: 'READY' | 'IDENTITY_UNVERIFIED' | 'NO_VERIFIED_OFFERS';
  identityHash: string | null;
  rows: DealMatrixRow[];
}

function positiveMoney(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function verifiedDiscount(current: number | null, original: number | null): number | null {
  if (!current || !original || original <= current) return null;
  return Number((((original - current) / original) * 100).toFixed(2));
}

export function buildDealMatrix(
  product: Pick<Product, 'identity' | 'offers'>,
): DealMatrixPresentation {
  const identityHash = product.identity?.identityHash?.trim() || null;
  if (!identityHash) return { available: false, reason: 'IDENTITY_UNVERIFIED', identityHash: null, rows: [] };
  const seen = new Set<string>();
  const rows = (product.offers || []).filter(offer => {
    if (!offer.id || seen.has(offer.id) || offer.sourceVerified !== true || offer.confidence < 0.8) return false;
    seen.add(offer.id);
    return true;
  }).map((offer): DealMatrixRow => {
    const currentPrice = positiveMoney(offer.price);
    const originalPrice = positiveMoney(offer.originalPrice);
    return {
      offerId: offer.id,
      platform: offer.source,
      seller: offer.merchant,
      currentPrice,
      originalPrice,
      verifiedDiscountPercent: verifiedDiscount(currentPrice, originalPrice),
      affiliateAvailable: Boolean(offer.affiliateUrl && offer.affiliateHealth !== 'BROKEN'),
      affiliateUrl: offer.affiliateUrl && offer.affiliateHealth !== 'BROKEN' ? offer.affiliateUrl : null,
      health: offer.health,
      lastCheckedAt: offer.observedAt,
      expiresAt: offer.expiresAt || null,
    };
  }).sort((left, right) => (left.currentPrice ?? Number.MAX_SAFE_INTEGER) - (right.currentPrice ?? Number.MAX_SAFE_INTEGER));
  return {
    available: rows.length > 0,
    reason: rows.length ? 'READY' : 'NO_VERIFIED_OFFERS',
    identityHash,
    rows,
  };
}

export interface ThirtyDayPriceHistory {
  sufficient: boolean;
  points: Array<{ capturedAt: string; price: number }>;
  current: number | null;
  low: number | null;
  high: number | null;
  average: number | null;
  currentIsLow: boolean;
}

export function buildThirtyDayPriceHistory(
  snapshots: ReadonlyArray<Pick<PriceSnapshot, 'capturedAt' | 'price' | 'salePrice'>>,
  now = Date.now(),
): ThirtyDayPriceHistory {
  const cutoff = now - 30 * 86_400_000;
  const points = snapshots.map(snapshot => ({
    capturedAt: snapshot.capturedAt,
    timestamp: Date.parse(snapshot.capturedAt),
    price: positiveMoney(snapshot.salePrice) ?? positiveMoney(snapshot.price),
  })).filter((point): point is { capturedAt: string; timestamp: number; price: number } => (
    Number.isFinite(point.timestamp) && point.timestamp >= cutoff && point.timestamp <= now && point.price !== null
  )).sort((left, right) => left.timestamp - right.timestamp)
    .map(({ capturedAt, price }) => ({ capturedAt, price }));
  if (points.length < 2) {
    return { sufficient: false, points, current: points.at(-1)?.price ?? null, low: null, high: null, average: null, currentIsLow: false };
  }
  const prices = points.map(point => point.price);
  const current = prices.at(-1)!;
  const low = Math.min(...prices);
  return {
    sufficient: true,
    points,
    current,
    low,
    high: Math.max(...prices),
    average: Math.round(prices.reduce((total, price) => total + price, 0) / prices.length),
    currentIsLow: current === low,
  };
}

export interface VerifiedPaymentPromotion {
  id: string;
  issuer: string;
  productName: string;
  cashbackRate?: number;
  cashbackAmount?: number;
  cap?: number;
  minimumSpend?: number;
  eligiblePlatforms: string[];
  validFrom: string;
  validUntil: string;
  sourceUrl: string;
  verifiedAt: string;
  verified: boolean;
}

export function currentVerifiedPaymentPromotions(
  promotions: ReadonlyArray<VerifiedPaymentPromotion>,
  platform: string,
  now = Date.now(),
): VerifiedPaymentPromotion[] {
  return promotions.filter(promotion => {
    const verifiedAt = Date.parse(promotion.verifiedAt);
    const from = Date.parse(promotion.validFrom);
    const until = Date.parse(promotion.validUntil);
    const rate = Number(promotion.cashbackRate);
    const hasBenefit = positiveMoney(promotion.cashbackAmount) !== null
      || (Number.isFinite(rate) && rate > 0 && rate <= 100);
    return promotion.verified === true
      && Boolean(promotion.issuer.trim() && promotion.productName.trim() && promotion.sourceUrl.trim())
      && promotion.eligiblePlatforms.includes(platform)
      && hasBenefit
      && Number.isFinite(verifiedAt)
      && verifiedAt <= now
      && now - verifiedAt <= 7 * 86_400_000
      && Number.isFinite(from)
      && Number.isFinite(until)
      && from <= now
      && until >= now;
  });
}

export interface DealEconomicsInput {
  platformDiscount?: number | null;
  voucherDiscount?: number | null;
  verifiedCashback?: number | null;
  affiliateCommission?: number | null;
  simulation?: boolean;
}

export interface DealEconomicsResult {
  customerSavings: number | null;
  publisherRevenue: number | null;
  totalEconomicValue: number | null;
  simulation: boolean;
}

function optionalNonNegative(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

export function calculateDealEconomics(input: DealEconomicsInput): DealEconomicsResult {
  const customerParts = [input.platformDiscount, input.voucherDiscount, input.verifiedCashback]
    .map(optionalNonNegative)
    .filter((value): value is number => value !== null);
  const customerSavings = customerParts.length ? customerParts.reduce((total, value) => total + value, 0) : null;
  const publisherRevenue = optionalNonNegative(input.affiliateCommission);
  return {
    customerSavings,
    publisherRevenue,
    totalEconomicValue: customerSavings === null && publisherRevenue === null
      ? null
      : (customerSavings || 0) + (publisherRevenue || 0),
    simulation: input.simulation === true,
  };
}

export type VerifiedUrgency =
  | { kind: 'promotion_expiry'; expiresAt: string; remainingMs: number }
  | { kind: 'low_stock'; remaining: number; verifiedAt: string }
  | { kind: 'interest'; count: number; windowMinutes: number; verifiedAt: string };

export function buildVerifiedUrgency(input: {
  promotionExpiresAt?: string | null;
  stockRemaining?: number | null;
  stockVerifiedAt?: string | null;
  activeInterestCount?: number | null;
  interestWindowMinutes?: number | null;
  interestVerifiedAt?: string | null;
}, now = Date.now()): VerifiedUrgency[] {
  const urgency: VerifiedUrgency[] = [];
  const expiration = Date.parse(input.promotionExpiresAt || '');
  if (Number.isFinite(expiration) && expiration > now) {
    urgency.push({ kind: 'promotion_expiry', expiresAt: new Date(expiration).toISOString(), remainingMs: expiration - now });
  }
  const stockVerifiedAt = Date.parse(input.stockVerifiedAt || '');
  if (Number.isInteger(input.stockRemaining) && Number(input.stockRemaining) >= 0 && Number(input.stockRemaining) <= 10
    && Number.isFinite(stockVerifiedAt) && stockVerifiedAt <= now && now - stockVerifiedAt <= 60 * 60_000) {
    urgency.push({ kind: 'low_stock', remaining: Number(input.stockRemaining), verifiedAt: new Date(stockVerifiedAt).toISOString() });
  }
  const interestVerifiedAt = Date.parse(input.interestVerifiedAt || '');
  if (Number.isInteger(input.activeInterestCount) && Number(input.activeInterestCount) >= 5
    && Number.isInteger(input.interestWindowMinutes) && Number(input.interestWindowMinutes) > 0
    && Number.isFinite(interestVerifiedAt) && interestVerifiedAt <= now && now - interestVerifiedAt <= Number(input.interestWindowMinutes) * 60_000) {
    urgency.push({
      kind: 'interest',
      count: Number(input.activeInterestCount),
      windowMinutes: Number(input.interestWindowMinutes),
      verifiedAt: new Date(interestVerifiedAt).toISOString(),
    });
  }
  return urgency;
}

export interface TrendingDeal {
  productId: string;
  title: string;
  rank: number;
  score: number;
  signals: { outboundClicks: number; detailViews: number; cardClicks: number };
}

export interface TrendingDealLeaderboard {
  available: boolean;
  evidenceEvents: number;
  items: TrendingDeal[];
}

function startOfVietnamDayMs(now: number): number {
  const shifted = new Date(now + 7 * 60 * 60_000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 7 * 60 * 60_000;
}

export function buildTrendingDealLeaderboard(
  products: ReadonlyArray<Pick<Product, 'id' | 'title' | 'qualityScore' | 'dealScore'>>,
  events: ReadonlyArray<Pick<OutboundEvent, 'eventType' | 'productId' | 'timestamp'>>,
  now = Date.now(),
  limit = 10,
): TrendingDealLeaderboard {
  const today = startOfVietnamDayMs(now);
  const counts = new Map<string, { outboundClicks: number; detailViews: number; cardClicks: number }>();
  let evidenceEvents = 0;
  for (const event of events) {
    const occurredAt = Date.parse(event.timestamp);
    if (!event.productId || !Number.isFinite(occurredAt) || occurredAt < today || occurredAt > now) continue;
    const signal = counts.get(event.productId) || { outboundClicks: 0, detailViews: 0, cardClicks: 0 };
    if (event.eventType === 'OUTBOUND_CLICK' || event.eventType === 'click') signal.outboundClicks += 1;
    else if (event.eventType === 'PRODUCT_DETAIL_VIEW') signal.detailViews += 1;
    else if (event.eventType === 'PRODUCT_CARD_CLICK') signal.cardClicks += 1;
    else continue;
    evidenceEvents += 1;
    counts.set(event.productId, signal);
  }
  if (evidenceEvents < 3) return { available: false, evidenceEvents, items: [] };
  const items = products.flatMap(product => {
    const signals = counts.get(product.id);
    if (!signals) return [];
    const behavioralScore = signals.outboundClicks * 12 + signals.detailViews * 3 + signals.cardClicks * 2;
    const qualityTieBreaker = Math.max(0, Math.min(100, Number(product.qualityScore || 0))) / 1_000;
    const dealTieBreaker = Math.max(0, Math.min(100, Number(product.dealScore || 0))) / 10_000;
    return [{ productId: product.id, title: product.title, score: Number((behavioralScore + qualityTieBreaker + dealTieBreaker).toFixed(4)), signals }];
  }).sort((left, right) => right.score - left.score || left.productId.localeCompare(right.productId))
    .slice(0, Math.max(1, Math.min(10, limit)))
    .map((item, index) => ({ ...item, rank: index + 1 }));
  return { available: items.length > 0, evidenceEvents, items };
}

export interface VerifiedConversionEvent {
  id: string;
  eventType: 'VERIFIED_CONVERSION';
  productId?: string;
  occurredAt: string;
  privacySafe: true;
}

export function buildPublicSocialProof(
  events: ReadonlyArray<VerifiedConversionEvent>,
  now = Date.now(),
): { enabled: boolean; events: Array<{ id: string; message: string; occurredAt: string }> } {
  const safeEvents = events.filter(event => event.eventType === 'VERIFIED_CONVERSION'
    && event.privacySafe === true
    && Number.isFinite(Date.parse(event.occurredAt))
    && Date.parse(event.occurredAt) <= now
    && now - Date.parse(event.occurredAt) <= 24 * 60 * 60_000)
    .slice(-10)
    .map(event => ({ id: event.id, message: 'Một đơn hàng vừa được ghi nhận qua deal này.', occurredAt: event.occurredAt }));
  return { enabled: safeEvents.length > 0, events: safeEvents };
}

export function buildAffiliateBroadcastCopy(input: {
  title: string;
  price?: number | null;
  verifiedPromotion?: string | null;
  affiliateUrl?: string | null;
}): string | null {
  if (!input.title.trim() || !input.affiliateUrl?.trim()) return null;
  const lines = [input.title.trim()];
  if (positiveMoney(input.price) !== null) lines.push(`Giá hiện tại: ${new Intl.NumberFormat('vi-VN').format(Number(input.price))} ₫`);
  if (input.verifiedPromotion?.trim()) lines.push(input.verifiedPromotion.trim());
  lines.push('Xem deal: ' + input.affiliateUrl.trim());
  lines.push('SanDeal có thể nhận hoa hồng khi bạn mua qua liên kết.');
  return lines.join('\n');
}

export type SourcePresentationStatus = 'healthy' | 'degraded' | 'failed' | 'unknown' | 'not_connected';

export function aggregateSourceDiscoveryStatus(
  sources: ReadonlyArray<{ id: string; status: SourcePresentationStatus }>,
): { status: SourcePresentationStatus; activeSourceIds: string[]; degradedSourceIds: string[] } {
  const activeSourceIds = sources.filter(source => source.status === 'healthy').map(source => source.id);
  const degradedSourceIds = sources.filter(source => source.status === 'degraded' || source.status === 'failed').map(source => source.id);
  if (activeSourceIds.length) return { status: 'healthy', activeSourceIds, degradedSourceIds };
  if (sources.some(source => source.status === 'degraded')) return { status: 'degraded', activeSourceIds, degradedSourceIds };
  if (sources.some(source => source.status === 'failed')) return { status: 'failed', activeSourceIds, degradedSourceIds };
  if (sources.some(source => source.status === 'unknown')) return { status: 'unknown', activeSourceIds, degradedSourceIds };
  return { status: 'not_connected', activeSourceIds, degradedSourceIds };
}
