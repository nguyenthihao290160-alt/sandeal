'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Product } from '@/lib/types';
import { classifyProductKind } from '@/lib/sourceItemClassifier';
import { SafeProductImage } from '@/components/safe-product-image';
import {
  deriveProductRemediationSummary,
  localizeProductBlocker,
  sanitizeProductTechnicalDetails,
} from '@/lib/dashboard/productDetailStatus';
import styles from './product-detail.module.css';
import { canonicalBlockerCodes } from '@/lib/productBlockers';

type PipelineTruth = {
  classification: { type: string; confidence: number | null; reasonCodes: string[] };
  lifecycle: { stage: string; blockers: string[]; reviewed: boolean; dataVerified: boolean; canaryReady: boolean; safePublishRequested: boolean; publishApproved: boolean; published: boolean; publicHidden: boolean };
  automation: { currentJobId: string | null; status: string | null; attempts: number; maxAttempts: number | null; nextRetryAt: string | null; workerOwner: string | null; lastProcessedAt: string | null };
  health: { link: string; productLink: string; affiliateLink: string; image: string; price: string; source: string; content: string };
  requiredAction: string | null;
  remediationAvailable: boolean;
  eligibility?: { criticalBlockers: string[]; warningBlockers: string[]; nextRequiredAction: string };
  safety: { publishingEnabled: boolean; launchEnabled: boolean; effectiveMode: string };
};

const HEALTHY_LINK = new Set(['ok', 'healthy', 'redirect_ok', 'redirected']);
const LINK_VERIFICATION_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

function verificationIsFresh(value?: string): boolean {
  const checkedAt = Date.parse(value || '');
  const now = Date.now();
  return Number.isFinite(checkedAt) && checkedAt <= now + 60_000 && now - checkedAt <= LINK_VERIFICATION_MAX_AGE_MS;
}

function isPublicHttpUrl(value?: string): boolean {
  try {
    const parsed = new URL(value || '');
    const host = parsed.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(parsed.protocol) || !host || parsed.username || parsed.password) return false;
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (/^(?:127|10|0|169\.254)\./.test(host) || /^192\.168\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (/^\[?(?:::1|fc|fd|fe8|fe9|fea|feb)/i.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

const STATUS_LABELS: Record<string, string> = {
  QUARANTINED: 'Đang cách ly theo chính sách',
  UNVERIFIED: 'Chưa xác minh',
  UNHEALTHY: 'Không đạt kiểm tra',
  HEALTHY: 'Hoạt động tốt',
  FAILED: 'Thất bại',
  SUCCEEDED: 'Hoàn tất',
  RUNNING: 'Đang chạy',
  PENDING: 'Đang chờ',
  RETRY_SCHEDULED: 'Đã lên lịch thử lại',
  STALE: 'Đã quá hạn',
  MISSING: 'Chưa có dữ liệu',
  DISABLED: 'Đang tắt',
  ENABLED: 'Đang bật',
  STAGED: 'Đang chờ xử lý',
  DISCOVERED: 'Mới phát hiện',
  CLASSIFIED: 'Đã phân loại',
  NORMALIZED: 'Đã chuẩn hóa',
  VERIFYING: 'Đang xác minh',
  RECHECKING: 'Đang kiểm tra lại',
  DEGRADED: 'Suy giảm',
  HIDDEN: 'Đang ẩn',
  PRODUCT: 'Sản phẩm',
  VOUCHER: 'Voucher',
  CAMPAIGN: 'Chiến dịch',
  good: 'Tốt',
  fair: 'Khá',
  needs_data: 'Cần bổ sung dữ liệu',
  poor: 'Kém',
  insufficient_data: 'Chưa đủ dữ liệu nội dung',
  needs_verification: 'Cần xác minh nội dung',
  pending_review: 'Đang chờ duyệt nội dung',
  blocked: 'Nội dung đang bị chặn',
  approved: 'Nội dung đã duyệt',
};

const SCORE_DIMENSION_LABELS: Record<string, string> = {
  provenance: 'Nguồn gốc dữ liệu',
  dataCompleteness: 'Độ đầy đủ dữ liệu',
  completeness: 'Độ đầy đủ dữ liệu',
  quality: 'Chất lượng dữ liệu',
  image: 'Hình ảnh',
  price: 'Giá',
  link: 'Liên kết',
  content: 'Nội dung',
  review: 'Review',
  originality: 'Tính nguyên bản',
  seo: 'Mức sẵn sàng SEO',
};

function localizeStatus(value?: string | null): string {
  const normalized = String(value || '').trim();
  if (!normalized) return 'Chưa có dữ liệu';
  return STATUS_LABELS[normalized] || 'Trạng thái kỹ thuật khác';
}

function formatTimestamp(value?: string | null): string {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('vi-VN') : 'Chưa kiểm tra';
}

function truncateIdentifier(value?: string | null): string {
  const text = String(value || '');
  if (!text) return 'Không có';
  return text.length <= 22 ? text : `${text.slice(0, 11)}…${text.slice(-7)}`;
}

function imageFailureReason(product: Product): string {
  if (product.imageUrlHttpStatus && product.imageUrlHttpStatus !== 200) return `Máy chủ ảnh trả về HTTP ${product.imageUrlHttpStatus}.`;
  if (product.imageContentType && !product.imageContentType.toLowerCase().startsWith('image/')) return 'Phản hồi không có định dạng nội dung ảnh hợp lệ.';
  if (product.imageValidationState === 'TIMEOUT') return 'Kiểm tra ảnh đã hết thời gian chờ.';
  if (product.imageValidationState === 'TOO_SMALL') return 'Ảnh không đạt kích thước tối thiểu.';
  if (product.imageValidationState === 'HOTLINK_BLOCKED') return 'Máy chủ ảnh chặn truy cập từ hệ thống.';
  if (!product.imageLastCheckedAt) return 'Ảnh chưa được kiểm tra.';
  return HEALTHY_LINK.has(String(product.imageHealthStatus || '')) ? 'Ảnh đã vượt kiểm tra gần nhất.' : 'Ảnh chưa vượt kiểm tra an toàn.';
}

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [product, setProduct] = useState<Product | null>(null);
  const [pipelineTruth, setPipelineTruth] = useState<PipelineTruth | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState<{ type: string; message: string } | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);
  const [actionBusy, setActionBusy] = useState('');
  const mountedRef = useRef(true);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [archivePending, setArchivePending] = useState(false);

  const showToast = useCallback((type: string, message: string) => {
    if (!mountedRef.current) return;
    setToast({ type, message });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => { if (mountedRef.current) setToast(null); }, 4000);
  }, []);

  const loadProduct = async () => {
    if (!mountedRef.current) return;
    if (!product) setLoading(true);
    setLoadError('');
    try {
      const [productResponse, truthResponse] = await Promise.all([fetch(`/api/products/${id}`), fetch(`/api/dashboard/products/${id}/truth`)]);
      if (!productResponse.ok || !truthResponse.ok) throw new Error('PRODUCT_LOAD_FAILED');
      const [data, truthData] = await Promise.all([productResponse.json(), truthResponse.json()]);
      if (!mountedRef.current) return;
      if (data.ok) setProduct(data.data);
      if (truthData.ok) setPipelineTruth(truthData.data);
    } catch {
      if (mountedRef.current) setLoadError('Không thể tải trạng thái vận hành mới nhất. Dữ liệu hợp lệ gần nhất vẫn được giữ lại.');
    }
    if (mountedRef.current) setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/products/${id}`).then(res => {
        if (!res.ok) throw new Error('PRODUCT_LOAD_FAILED');
        return res.json();
      }),
      fetch(`/api/dashboard/products/${id}/truth`).then(res => {
        if (!res.ok) throw new Error('TRUTH_LOAD_FAILED');
        return res.json();
      }),
    ])
      .then(([data, truthData]) => { if (!cancelled && data.ok) setProduct(data.data); if (!cancelled && truthData.ok) setPipelineTruth(truthData.data); })
      .catch(() => { if (!cancelled) setLoadError('Không thể tải chi tiết sản phẩm. Vui lòng thử lại.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const handleAction = async (action: string) => {
    if (actionBusy) return;
    setActionBusy(action);
    const semanticActions = new Set(['reviewed', 'data_verified', 'price_verified', 'canary_ready', 'safe_publish_requested']);
    const verificationTargets: Record<string, 'link' | 'affiliate' | 'image'> = {
      recheck_product_url: 'link',
      recheck_affiliate_url: 'affiliate',
      recheck_image: 'image',
    };
    const url = action === 'score' ? `/api/products/${id}/score`
      : action === 'archive' ? `/api/products/${id}/archive`
      : semanticActions.has(action) ? `/api/dashboard/products/${id}/actions`
        : verificationTargets[action] ? '/api/products/link-health/check' : '';

    const method = 'POST';
    const body = semanticActions.has(action)
      ? JSON.stringify({ action, operationId: `product-ui:${id}:${action}:${action === 'price_verified' ? product?.updatedAt || 'unknown' : 'v1'}` })
      : verificationTargets[action]
        ? JSON.stringify({ productId: id, target: verificationTargets[action] })
        : undefined;
    const headers: Record<string, string> = body ? { 'Content-Type': 'application/json' } : {};

    try {
      if (!url) throw new Error('UNSUPPORTED_ACTION');
      const res = await fetch(url, { method, body, headers });
      const data = await res.json();
      if (!mountedRef.current) return;
      if (data.ok) {
        const messages: Record<string, string> = {
        reviewed: 'Đã ghi nhận admin đã xem; dữ liệu và publish state không đổi.',
        data_verified: 'Đã ghi nhận xác minh dữ liệu; chưa đưa ra public.',
        price_verified: 'Đã ghi nhận xác minh giá; Safe Publish vẫn tiếp tục kiểm tra các blocker khác.',
        recheck_product_url: 'Đã đưa kiểm tra URL sản phẩm vào hàng đợi.',
        recheck_affiliate_url: 'Đã đưa kiểm tra URL affiliate vào hàng đợi.',
        recheck_image: 'Đã đưa kiểm tra ảnh vào hàng đợi.',
        canary_ready: 'Đã đưa vào danh sách xét CANARY; CANARY chưa được bật.',
        safe_publish_requested: 'Đã tạo yêu cầu kiểm tra Safe Publish; chưa phê duyệt hoặc publish.',
        score: 'Đã chấm điểm sản phẩm.',
        approve: 'Đã duyệt sản phẩm.',
        archive: 'Đã lưu trữ sản phẩm.',
        needs_review: 'Đã chuyển về cần xem xét.',
      };
        showToast('success', messages[action] || 'Thành công.');
        await loadProduct();
      } else {
        showToast('error', data.message || 'Không thể thực hiện thao tác.');
      }
    } catch {
      showToast('error', 'Không thể thực hiện thao tác.');
    } finally {
      if (mountedRef.current) setActionBusy('');
    }
  };

  const formatPrice = (price?: number) => {
    if (!price) return '—';
    return price.toLocaleString('vi-VN') + '₫';
  };

  if (loading) {
    return (
      <>
        <div className="topbar"><div className="topbar-title">Chi tiết sản phẩm</div></div>
        <div className="page-content"><div className="loading-state" role="status" aria-label="Đang tải chi tiết sản phẩm"><div className="spinner"></div><span>Đang tải dữ liệu và trạng thái vận hành…</span></div></div>
      </>
    );
  }

  if (!product) {
    return (
      <>
        <div className="topbar"><div className="topbar-title">Chi tiết sản phẩm</div></div>
        <div className="page-content">
          <div className="empty-state">
            <div className="empty-state-icon">{loadError ? '⚠️' : '❌'}</div>
            <div className="empty-state-title">{loadError ? 'Không thể tải sản phẩm' : 'Không tìm thấy sản phẩm'}</div>
            <div className="empty-state-desc">{loadError || 'Sản phẩm này có thể đã được lưu trữ hoặc không tồn tại.'}</div>
            {loadError && <button type="button" className="btn btn-primary" onClick={() => void loadProduct()} style={{ marginTop: 'var(--space-lg)' }}>Thử lại</button>}
            <Link href="/dashboard/products" className="btn btn-primary" style={{ marginTop: 'var(--space-lg)' }}>← Quay lại danh sách</Link>
          </div>
        </div>
      </>
    );
  }

  const inferredKind = product.kind || classifyProductKind(product);
  const statusLabel = product.status === 'approved' ? 'Đã duyệt' : product.status === 'needs_review' ? 'Cần xem xét' : product.status === 'draft' ? 'Nháp' : product.status === 'published' ? 'Đã xuất bản' : product.status === 'archived' ? 'Đã lưu trữ' : 'Trạng thái khác';
  const canonicalUrl = product.canonicalProductUrl || product.originalUrl;
  const canonicalProvenanceValid = product.source !== 'accesstrade'
    || (product.canonicalUrlSource === 'provider_api' && product.canonicalUrlProvider === 'accesstrade'
      && product.canonicalUrlSourceEndpoint === 'datafeed' && Boolean(product.canonicalUrlSourceField));
  const canonicalLinkEnabled = isPublicHttpUrl(canonicalUrl)
    && HEALTHY_LINK.has(String(product.linkHealthStatus || product.productHealthStatus || ''))
    && product.canonicalUrlStatus === 'verified'
    && verificationIsFresh(product.canonicalUrlVerifiedAt)
    && verificationIsFresh(product.linkLastCheckedAt)
    && canonicalProvenanceValid;
  const affiliateProvenanceValid = product.source !== 'accesstrade'
    || (product.affiliateUrlSource === 'provider_api' && product.affiliateUrlProvider === 'accesstrade'
      && product.affiliateUrlSourceEndpoint === 'datafeed' && Boolean(product.affiliateUrlSourceField)
      && product.deepLinkSupported !== false);
  const affiliateLinkEnabled = isPublicHttpUrl(product.affiliateUrl)
    && HEALTHY_LINK.has(String(product.affiliateHealthStatus || ''))
    && product.affiliateUrlStatus === 'verified'
    && verificationIsFresh(product.affiliateUrlVerifiedAt)
    && verificationIsFresh(product.affiliateLastCheckedAt)
    && affiliateProvenanceValid;
  const canonicalLinkReason = !canonicalUrl ? 'Provider chưa cung cấp đường dẫn sản phẩm.'
    : !isPublicHttpUrl(canonicalUrl) ? 'Đường dẫn sản phẩm không hợp lệ.'
      : !canonicalProvenanceValid ? 'Chưa xác minh được nguồn của đường dẫn sản phẩm.'
        : !verificationIsFresh(product.canonicalUrlVerifiedAt) || !verificationIsFresh(product.linkLastCheckedAt)
          ? 'Kết quả xác minh đường dẫn sản phẩm đã cũ hoặc chưa có.'
          : product.canonicalUrlStatus !== 'verified' || !HEALTHY_LINK.has(String(product.linkHealthStatus || product.productHealthStatus || ''))
          ? 'Đường dẫn sản phẩm chưa vượt qua kiểm tra an toàn.' : '';
  const affiliateLinkReason = !product.affiliateUrl ? 'Provider chưa cung cấp link affiliate hợp lệ.'
    : !isPublicHttpUrl(product.affiliateUrl) ? 'Link affiliate không hợp lệ.'
      : !affiliateProvenanceValid ? 'Chưa xác minh được provenance của link affiliate.'
        : !verificationIsFresh(product.affiliateUrlVerifiedAt) || !verificationIsFresh(product.affiliateLastCheckedAt)
          ? 'Kết quả xác minh link affiliate đã cũ hoặc chưa có.'
          : product.affiliateUrlStatus !== 'verified' || !HEALTHY_LINK.has(String(product.affiliateHealthStatus || ''))
          ? 'Link affiliate chưa vượt qua kiểm tra an toàn.' : '';
  const blockers = canonicalBlockerCodes(product.currentBlockers?.length ? product.currentBlockers : pipelineTruth?.lifecycle.blockers || []);
  const publicStateExplanation = pipelineTruth?.lifecycle.publicHidden === false ? 'Đang hiển thị công khai'
    : product.status === 'archived' ? `Đã lưu trữ${product.archivedReason ? ` · ${localizeProductBlocker(product.archivedReason)}` : ''}`
      : product.lifecycleState === 'QUARANTINED' ? `Đang cách ly · ${product.quarantineReasons?.map(localizeProductBlocker).join(', ') || 'chờ xác minh'}`
        : `Đang ẩn · ${blockers.length} blocker hiện hành`;
  const criticalBlockers = pipelineTruth?.eligibility?.criticalBlockers || product.eligibility?.criticalBlockers || blockers;
  const remediation = deriveProductRemediationSummary(blockers, criticalBlockers, pipelineTruth?.requiredAction);
  // Preserve the established grouped-blocker view contract while each group
  // now carries root-cause priority and downstream-impact metadata.
  const blockerGroups = remediation.rootCauses;
  const canaryDisabledReason = !pipelineTruth ? 'Chưa tải được operational truth; CANARY vẫn bị khóa.'
    : pipelineTruth.lifecycle.canaryReady ? 'Sản phẩm đã ở danh sách xét CANARY.' : blockers.length ? `Còn ${blockers.length} blocker cần xử lý.` : '';
  const publishDisabledReason = !pipelineTruth ? 'Chưa tải được operational truth; Safe Publish vẫn bị khóa.'
    : pipelineTruth.lifecycle.safePublishRequested ? 'Đã có yêu cầu Safe Publish.' : blockers.length ? `Còn ${blockers.length} blocker cần xử lý.`
      : !pipelineTruth.safety.publishingEnabled ? 'Publishing đang bị khóa bởi chính sách vận hành.' : '';
  const reviewedDisabledReason = !pipelineTruth ? 'Chưa tải được operational truth.' : pipelineTruth.lifecycle.reviewed ? 'Đã ghi nhận người vận hành xem sản phẩm.' : '';
  const dataVerifiedDisabledReason = !pipelineTruth ? 'Chưa tải được operational truth.' : pipelineTruth.lifecycle.dataVerified ? 'Dữ liệu đã được xác nhận.' : '';
  const priceVerified = product.priceVerificationStatus === 'VERIFIED' && verificationIsFresh(product.priceObservedAt);
  const priceVerificationDisabledReason = priceVerified ? 'Giá đã được xác minh và còn mới.'
    : !(Number(product.salePrice || product.price || 0) > 0) || product.currency !== 'VND' ? 'Không có giá VND hợp lệ để xác minh.' : '';
  const productRecheckDisabledReason = isPublicHttpUrl(canonicalUrl) ? '' : 'Không có URL sản phẩm công khai hợp lệ để kiểm tra.';
  const affiliateRecheckDisabledReason = isPublicHttpUrl(product.affiliateUrl) ? '' : 'Không có URL affiliate công khai hợp lệ; cần sửa hoặc tạo lại từ nguồn.';
  const imageRecheckDisabledReason = isPublicHttpUrl(product.imageUrl) ? '' : 'Không có URL ảnh công khai hợp lệ để kiểm tra.';
  const publishingLabel = pipelineTruth?.lifecycle.published ? 'Đã đăng'
    : pipelineTruth?.lifecycle.publishApproved ? 'Đã phê duyệt'
      : pipelineTruth?.lifecycle.safePublishRequested ? 'Đang chờ kiểm tra Safe Publish'
        : blockers.length ? 'Đang bị chặn' : 'Chưa yêu cầu đăng';
  const riskLabel = product.riskLevel === 'low' ? 'Thấp' : product.riskLevel === 'medium' ? 'Trung bình' : product.riskLevel === 'high' ? 'Cao' : 'Chưa xác định';
  const blockerSeverityLabel = remediation.critical > 0 ? `${remediation.critical} blocker nghiêm trọng`
    : remediation.total > 0 ? `${remediation.total} cảnh báo/blocker` : 'Không có blocker hiện hành';
  const scoreBreakdown = Object.entries(product.scoreBreakdown || {})
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .sort((left, right) => left[1] - right[1])
    .slice(0, 5);
  const technicalJson = JSON.stringify(sanitizeProductTechnicalDetails({ product, operationalTruth: pipelineTruth }), null, 2);

  return (
    <main className={styles.page}>
      {toast && <div className="toast-container"><div className={`toast toast-${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}><span>{toast.message}</span><button className="toast-close" onClick={() => setToast(null)} aria-label="Đóng thông báo">×</button></div></div>}
      <header className={styles.topbar}><div><span>Danh mục sản phẩm</span><h1>Chi tiết vận hành</h1></div><Link href="/dashboard/products" className="btn btn-secondary btn-sm">← Quay lại danh sách</Link></header>
      {loadError && <div className={styles.refreshError} role="alert"><span>{loadError}</span><button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadProduct()}>Thử tải lại</button></div>}

      <section className={styles.hero}>
        <figure className={styles.imagePanel}>
          <SafeProductImage originalUrl={product.imageUrl} candidates={product.gallery} healthStatus={product.imageHealthStatus} alt={product.title} className={styles.heroImage} />
          <figcaption>
            <strong>{imageFailureReason(product)}</strong>
            <span>Kiểm tra gần nhất: {formatTimestamp(product.imageLastCheckedAt)}</span>
          </figcaption>
        </figure>
        <div className={styles.heroMain}>
          <div className={styles.badges}><span className="badge badge-neutral">{product.platform}</span><span className="badge badge-neutral">{inferredKind === 'product' ? 'Sản phẩm' : inferredKind === 'voucher' ? 'Voucher' : inferredKind === 'campaign' ? 'Chiến dịch' : 'Chưa phân loại'}</span><span className={`badge ${product.status === 'approved' ? 'badge-success' : product.status === 'needs_review' ? 'badge-warning' : product.status === 'published' ? 'badge-info' : 'badge-neutral'}`}>{statusLabel}</span>{inferredKind !== 'product' && <span className="badge badge-warning">Chưa phải sản phẩm cụ thể</span>}</div>
          <h2>{product.title}</h2>
          <p>{product.description || 'Chưa có mô tả sản phẩm.'}</p>
          <div className={styles.priceRow}><strong>{formatPrice(product.salePrice || product.price)}</strong>{product.salePrice && product.price && product.price !== product.salePrice && <del>{formatPrice(product.price)}</del>}<span className={`badge ${priceVerified ? 'badge-success' : 'badge-warning'}`}>{priceVerified ? 'Giá đã xác minh' : 'Giá chưa xác minh'}</span>{product.priceNote && <span className="badge badge-warning">{product.priceNote}</span>}</div>
          <dl className={styles.heroFacts}>
            <div><dt>Nguồn / merchant</dt><dd>{product.source || '—'} · {product.merchant || product.identity?.merchant || product.campaignName || 'chưa rõ'}</dd></div>
            <div><dt>ID sản phẩm</dt><dd className={styles.identifier}>{truncateIdentifier(product.id)}</dd></div>
            <div><dt>Vòng đời</dt><dd>{localizeStatus(pipelineTruth?.lifecycle.stage || product.lifecycleState)}</dd></div>
            <div><dt>Sẵn sàng xuất bản</dt><dd>{publishingLabel}</dd></div>
            <div><dt>Trạng thái public</dt><dd>{publicStateExplanation}</dd></div>
            <div><dt>Rủi ro nội dung</dt><dd>{riskLabel} <small>— không phải trạng thái sẵn sàng đăng</small></dd></div>
            <div><dt>Mức blocker</dt><dd className={remediation.critical ? styles.criticalText : undefined}>{blockerSeverityLabel}</dd></div>
            <div><dt>Danh mục</dt><dd>{product.category || '—'}</dd></div>
          </dl>
          <div className={styles.linkActions} aria-label="Liên kết sản phẩm đã kiểm tra">
            <div data-link-state={affiliateLinkEnabled ? 'enabled' : 'disabled'}><span>Affiliate</span>{affiliateLinkEnabled
              ? <a href={product.affiliateUrl!} target="_blank" rel="noopener noreferrer nofollow sponsored" className="btn btn-primary btn-sm">Mở link affiliate</a>
              : <button type="button" className="btn btn-primary btn-sm" disabled aria-disabled="true">Link affiliate bị khóa</button>}<small>{affiliateLinkEnabled ? 'Đã xác minh và sẵn sàng mở.' : affiliateLinkReason}</small></div>
            <div data-link-state={canonicalLinkEnabled ? 'enabled' : 'disabled'}><span>Sản phẩm</span>{canonicalLinkEnabled
              ? <a href={canonicalUrl!} target="_blank" rel="noopener noreferrer nofollow" className="btn btn-secondary btn-sm">Mở trang sản phẩm</a>
              : <button type="button" className="btn btn-secondary btn-sm" disabled aria-disabled="true">Link sản phẩm bị khóa</button>}<small>{canonicalLinkEnabled ? 'Đã xác minh và sẵn sàng mở.' : canonicalLinkReason}</small></div>
          </div>
        </div>
        <aside className={styles.scoreSummary}>
          <span>Điểm chất lượng</span>
          <strong className={product.score != null && product.score >= 75 ? styles.goodScore : product.score != null && product.score >= 45 ? styles.mediumScore : styles.lowScore}>{product.score ?? '—'}</strong>
          <small>{product.scoreLabel || 'Chưa có nhãn điểm'}</small>
          <div className={styles.scoreExplanation}>
            <b>Giải thích điểm</b>
            {scoreBreakdown.length ? scoreBreakdown.map(([key, value]) => <span key={key}>{SCORE_DIMENSION_LABELS[key] || 'Thành phần khác'}: {value}</span>)
              : blockerGroups.slice(0, 3).map(rootCause => <span key={rootCause.id}>Khấu trừ chính: {rootCause.label}</span>)}
            {!scoreBreakdown.length && !blockerGroups.length && <span>Chưa có breakdown được lưu.</span>}
          </div>
          <small>Chấm lại chỉ cập nhật điểm; không sửa link, ảnh, giá hay bằng chứng.</small>
        </aside>
      </section>

      <section className={styles.remediationSummary} aria-labelledby="remediation-title">
        <div className={styles.remediationHeader}>
          <div><span>Tóm tắt cần xử lý theo nguyên nhân gốc</span><h2 id="remediation-title">Việc cần sửa trước</h2></div>
          <div className={styles.remediationCounts}>
            <span><strong>{remediation.total}</strong> blocker</span>
            <span className={remediation.critical ? styles.criticalCount : styles.clearCount}><strong>{remediation.critical}</strong> nghiêm trọng</span>
          </div>
        </div>
        {remediation.merchantQuarantined && (
          <div className={styles.merchantNotice}>
            Merchant đang bị quarantine theo policy. Đây là blocker merchant/chính sách, không phải lỗi worker hay scheduler.
          </div>
        )}
        {blockerGroups.length ? (
          <div className={styles.rootCauseList}>
            {blockerGroups.map((rootCause, index) => (
              <article key={rootCause.id} className={styles.rootCause}>
                <div className={styles.rootCauseOrder} aria-label={`Ưu tiên ${index + 1}`}>{index + 1}</div>
                <div>
                  <header><strong>{rootCause.label}</strong><span>{rootCause.blockers.length} blocker · {rootCause.criticalCount} nghiêm trọng</span></header>
                  <p>{rootCause.explanation}</p>
                  <small>{rootCause.downstreamEffect}</small>
                  <ul>
                    {rootCause.blockers.slice(0, 6).map(blocker => <li key={blocker.code} className={blocker.critical ? styles.criticalBlocker : undefined}>{blocker.label}</li>)}
                    {rootCause.blockers.length > 6 && <li>{rootCause.blockers.length - 6} blocker khác vẫn được giữ trong chi tiết kỹ thuật bên dưới.</li>}
                  </ul>
                  <details className={styles.technicalCodes}>
                    <summary>Mã kỹ thuật ({rootCause.blockers.length})</summary>
                    <div>{rootCause.blockers.map(blocker => <code key={blocker.code}>{blocker.code}</code>)}</div>
                  </details>
                </div>
              </article>
            ))}
          </div>
        ) : <p className={styles.clearState}>Không có blocker được ghi nhận trong snapshot hiện tại.</p>}
        <p className={styles.nextAction}>Hành động được khuyến nghị tiếp theo: <strong>{remediation.nextAction}</strong></p>
      </section>

      <section className={styles.operationGrid}>
        <article className={styles.card}>
          <div className={styles.cardHeader}><div><span>Runtime và bằng chứng</span><h3>Trạng thái vận hành</h3></div><span className={`badge ${blockers.length ? 'badge-warning' : 'badge-success'}`}>{blockers.length ? `${blockers.length} blocker` : 'Không có blocker'}</span></div>
          {pipelineTruth ? <>
            <dl className={styles.truthGrid}>
              <div><dt>Vận hành / job</dt><dd>{pipelineTruth.automation.status ? localizeStatus(pipelineTruth.automation.status) : 'Không có job hiện tại'}</dd></div>
              <div><dt>Retry</dt><dd>{pipelineTruth.automation.attempts}/{pipelineTruth.automation.maxAttempts ?? '—'}</dd></div>
              <div><dt>Worker</dt><dd className={styles.identifier}>{truncateIdentifier(pipelineTruth.automation.workerOwner)}</dd></div>
              <div><dt>Chất lượng dữ liệu</dt><dd>{localizeStatus(product.qualityBand || (remediation.critical ? 'blocked' : 'good'))}</dd></div>
              <div><dt>Chính sách</dt><dd>{remediation.merchantQuarantined ? 'Đang cách ly; cần quyết định chính sách' : 'Không có quarantine merchant hiện hành'}</dd></div>
              <div><dt>Sẵn sàng xuất bản</dt><dd>{publishingLabel}</dd></div>
              <div><dt>AI / nội dung</dt><dd>{localizeStatus(pipelineTruth.health.content)}</dd></div>
              <div><dt>Publishing gate</dt><dd>{pipelineTruth.safety.publishingEnabled ? 'Đang bật' : 'Đang khóa; dịch vụ vẫn có thể hoạt động'}</dd></div>
              <div><dt>Nguồn dữ liệu</dt><dd>{localizeStatus(pipelineTruth.health.source)}</dd></div>
            </dl>
            <div className={styles.healthStrip}>
              <span>URL sản phẩm <strong>{localizeStatus(pipelineTruth.health.productLink)}</strong><small>{product.productUrlFinalDomain || 'Chưa có tên miền đích'} · {product.productUrlHttpStatus ? `HTTP ${product.productUrlHttpStatus}` : 'Chưa có phản hồi HTTP'} · Kiểm tra: {formatTimestamp(product.linkLastCheckedAt)}</small></span>
              <span>URL affiliate <strong>{localizeStatus(pipelineTruth.health.affiliateLink)}</strong><small>{product.affiliateUrlFinalDomain || 'Chưa có tên miền đích'} · {product.affiliateUrlHttpStatus ? `HTTP ${product.affiliateUrlHttpStatus}` : 'Chưa có phản hồi HTTP'} · Kiểm tra: {formatTimestamp(product.affiliateLastCheckedAt)}</small></span>
              <span>Ảnh <strong>{localizeStatus(pipelineTruth.health.image)}</strong><small>{imageFailureReason(product)} Kiểm tra: {formatTimestamp(product.imageLastCheckedAt)}</small></span>
              <span>Giá <strong>{priceVerified ? 'Đã xác minh' : localizeStatus(pipelineTruth.health.price)}</strong><small>Quan sát/xác minh: {formatTimestamp(product.priceObservedAt)}</small></span>
              <span>Nguồn <strong>{localizeStatus(pipelineTruth.health.source)}</strong><small>Nhận dữ liệu: {formatTimestamp(product.sourceFetchedAt || product.providerUpdatedAt)}</small></span>
            </div>
            <p className={styles.requiredAction}>Hành động được khuyến nghị: <strong>{remediation.nextAction}</strong></p>
          </> : <p className={styles.clearState}>Chưa tải được operational truth. Các hành động nhạy cảm vẫn bị khóa.</p>}
        </article>

        <article className={styles.card}>
          <div className={styles.cardHeader}><div><span>Không bỏ qua cổng an toàn</span><h3>Hành động theo ngữ cảnh</h3></div></div>
          <div className={styles.actionGroup}><strong>Xác minh bằng chứng ngoài</strong><div>
            <div className={styles.actionItem}><button className="btn btn-secondary" onClick={() => handleAction('recheck_product_url')} disabled={Boolean(actionBusy) || Boolean(productRecheckDisabledReason)} title={productRecheckDisabledReason || undefined}>{actionBusy === 'recheck_product_url' ? 'Đang tạo job…' : 'Kiểm tra lại URL sản phẩm'}</button>{productRecheckDisabledReason && <small>{productRecheckDisabledReason}</small>}</div>
            <div className={styles.actionItem}><button className="btn btn-secondary" onClick={() => handleAction('recheck_affiliate_url')} disabled={Boolean(actionBusy) || Boolean(affiliateRecheckDisabledReason)} title={affiliateRecheckDisabledReason || undefined}>{actionBusy === 'recheck_affiliate_url' ? 'Đang tạo job…' : 'Kiểm tra lại affiliate'}</button>{affiliateRecheckDisabledReason && <small>{affiliateRecheckDisabledReason}</small>}</div>
            <div className={styles.actionItem}><button className="btn btn-secondary" onClick={() => handleAction('recheck_image')} disabled={Boolean(actionBusy) || Boolean(imageRecheckDisabledReason)} title={imageRecheckDisabledReason || undefined}>{actionBusy === 'recheck_image' ? 'Đang tạo job…' : 'Kiểm tra lại ảnh'}</button>{imageRecheckDisabledReason && <small>{imageRecheckDisabledReason}</small>}</div>
            <div className={styles.actionItem}><button className="btn btn-secondary" onClick={() => handleAction('price_verified')} disabled={Boolean(actionBusy) || Boolean(priceVerificationDisabledReason)} title={priceVerificationDisabledReason || undefined}>{actionBusy === 'price_verified' ? 'Đang ghi nhận…' : 'Xác minh giá hiện tại'}</button>{priceVerificationDisabledReason && <small>{priceVerificationDisabledReason}</small>}</div>
          </div></div>
          <div className={styles.actionGroup}><strong>Chính sách, bằng chứng và review</strong><div>
            <Link href="/dashboard/compliance" className="btn btn-secondary">Xem chính sách merchant</Link>
            <Link href="/dashboard/quality" className="btn btn-secondary">Xem bằng chứng chất lượng</Link>
            <Link href="/dashboard/content" className="btn btn-secondary">Xem trạng thái review</Link>
            <button className="btn btn-secondary" onClick={() => handleAction('score')} disabled={Boolean(actionBusy)}>{actionBusy === 'score' ? 'Đang chấm…' : 'Chấm lại điểm'}</button>
          </div><small>Chấm lại điểm không sửa dữ liệu, liên kết, ảnh, bằng chứng hoặc quarantine.</small></div>
          <div className={styles.actionGroup}><strong>Xác nhận của người vận hành</strong><div><div className={styles.actionItem}><button className="btn btn-secondary" onClick={() => handleAction('reviewed')} disabled={Boolean(actionBusy) || Boolean(reviewedDisabledReason)} title={reviewedDisabledReason || undefined}>Đánh dấu đã xem</button>{reviewedDisabledReason && <small>{reviewedDisabledReason}</small>}</div><div className={styles.actionItem}><button className="btn btn-secondary" onClick={() => handleAction('data_verified')} disabled={Boolean(actionBusy) || Boolean(dataVerifiedDisabledReason)} title={dataVerifiedDisabledReason || undefined}>Xác nhận dữ liệu</button>{dataVerifiedDisabledReason ? <small>{dataVerifiedDisabledReason}</small> : <small>Xác nhận này áp dụng cho toàn bộ dữ liệu bắt buộc; không tự xuất bản.</small>}</div></div></div>
          <div className={styles.actionGroup}><strong>Canary & Safe Publish</strong><div><div className={styles.actionItem}><button className="btn btn-secondary" onClick={() => handleAction('canary_ready')} disabled={Boolean(actionBusy) || Boolean(canaryDisabledReason)} title={canaryDisabledReason || undefined}>Đưa vào danh sách xét CANARY</button>{canaryDisabledReason && <small>{canaryDisabledReason}</small>}</div><div className={styles.actionItem}><button className="btn btn-primary" onClick={() => handleAction('safe_publish_requested')} disabled={Boolean(actionBusy) || Boolean(publishDisabledReason)} title={publishDisabledReason || undefined}>Yêu cầu kiểm tra Safe Publish</button>{publishDisabledReason && <small>{publishDisabledReason}</small>}</div></div></div>
          <div className={`${styles.actionGroup} ${styles.archiveGroup}`}><strong>Lưu trữ</strong>{archivePending ? <div className={styles.inlineConfirm}><span>Lưu trữ sản phẩm này? Sản phẩm sẽ không được đăng.</span><button className="btn btn-secondary" onClick={() => { setArchivePending(false); void handleAction('archive'); }} disabled={Boolean(actionBusy)}>Xác nhận lưu trữ</button><button className="btn btn-ghost" onClick={() => setArchivePending(false)}>Huỷ</button></div> : <div><button className="btn btn-secondary" onClick={() => setArchivePending(true)} disabled={Boolean(actionBusy)}>Lưu trữ sản phẩm</button></div>}</div>
        </article>
      </section>

      <section className={styles.contentGrid}>
        <article className={styles.card}><div className={styles.cardHeader}><h3>Lợi ích & cảnh báo</h3></div>{product.benefits?.length ? <div><h4>Lợi ích chính</h4><ul className="detail-list">{product.benefits.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : <p className={styles.emptyText}>Chưa có lợi ích được xác minh.</p>}{product.warnings?.length ? <div className={styles.warningList}><h4>Cảnh báo / không được nói quá</h4><ul className="detail-list detail-list-warning">{product.warnings.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}</article>
        <article className={styles.card}><div className={styles.cardHeader}><h3>Content intelligence</h3></div><div className={styles.intelligenceGrid}><div><h4>Pain points</h4>{product.painPoints?.length ? <ul className="detail-list">{product.painPoints.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>Chưa có</p>}</div><div><h4>Đối tượng</h4>{product.targetAudience?.length ? <ul className="detail-list">{product.targetAudience.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>Chưa có</p>}</div><div><h4>Góc nội dung</h4>{product.contentAngles?.length ? <ul className="detail-list">{product.contentAngles.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>Chưa có</p>}</div><div><h4>Ghi chú kiểm duyệt</h4>{product.complianceNotes?.length ? <ul className="detail-list">{product.complianceNotes.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>Chưa có</p>}</div></div></article>
        <article className={styles.card}><div className={styles.cardHeader}><h3>Thông tin bổ sung</h3></div><dl className={styles.metaList}><div><dt>Tags</dt><dd>{product.tags?.join(', ') || '—'}</dd></div><div><dt>Chiến dịch</dt><dd>{product.campaignName || '—'}</dd></div><div><dt>Hoa hồng</dt><dd>{product.commissionNote || '—'}</dd></div><div><dt>Disclosure</dt><dd>{product.affiliateDisclosure || '—'}</dd></div><div><dt>Tạo lúc</dt><dd>{new Date(product.createdAt).toLocaleString('vi-VN')}</dd></div><div><dt>Cập nhật</dt><dd>{new Date(product.updatedAt).toLocaleString('vi-VN')}</dd></div></dl></article>
      </section>

      <section className={styles.technical}>
        <div className={styles.technicalActions}>
          <strong>Chi tiết kỹ thuật</strong>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowTechnical(!showTechnical)} aria-expanded={showTechnical}>{showTechnical ? 'Thu gọn' : 'Mở'} chi tiết kỹ thuật</button>
          <button className="btn btn-ghost btn-sm" onClick={async () => {
            try {
              await navigator.clipboard.writeText(technicalJson);
              showToast('success', 'Đã sao chép chi tiết kỹ thuật đã loại bỏ secret.');
            } catch {
              showToast('error', 'Không thể sao chép chi tiết kỹ thuật.');
            }
          }}>Sao chép JSON an toàn</button>
        </div>
        {showTechnical && <pre data-secret-sanitized="true">{technicalJson}</pre>}
      </section>
    </main>
  );
}
