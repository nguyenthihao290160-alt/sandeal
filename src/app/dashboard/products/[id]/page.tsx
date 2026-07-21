'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Product } from '@/lib/types';
import { classifyProductKind } from '@/lib/sourceItemClassifier';
import { SafeProductImage } from '@/components/safe-product-image';
import styles from './product-detail.module.css';

type PipelineTruth = {
  classification: { type: string; confidence: number | null; reasonCodes: string[] };
  lifecycle: { stage: string; blockers: string[]; reviewed: boolean; dataVerified: boolean; canaryReady: boolean; safePublishRequested: boolean; publishApproved: boolean; published: boolean; publicHidden: boolean };
  automation: { currentJobId: string | null; status: string | null; attempts: number; maxAttempts: number | null; nextRetryAt: string | null; workerOwner: string | null; lastProcessedAt: string | null };
  health: { link: string; productLink: string; affiliateLink: string; image: string; price: string; source: string; content: string };
  requiredAction: string | null;
  remediationAvailable: boolean;
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

function friendlyBlocker(value: string): string {
  const labels: Record<string, string> = {
    missing_product_url: 'Thiếu đường dẫn sản phẩm chính thức',
    product_url_unhealthy: 'Đường dẫn sản phẩm chưa hoạt động',
    product_health_stale: 'Kết quả kiểm tra link sản phẩm đã cũ',
    canonical_provenance_missing: 'Chưa xác minh nguồn của link sản phẩm',
    canonical_url_unverified: 'Link sản phẩm chưa được xác minh',
    missing_affiliate_url: 'Provider chưa cung cấp link affiliate',
    affiliate_url_unhealthy: 'Link affiliate chưa hoạt động',
    affiliate_health_stale: 'Kết quả kiểm tra affiliate đã cũ',
    affiliate_provenance_missing: 'Chưa xác minh nguồn của link affiliate',
    affiliate_url_unverified: 'Link affiliate chưa được xác minh',
    missing_image: 'Thiếu ảnh sản phẩm',
    image_unhealthy: 'Ảnh chưa hoạt động',
    image_http_not_200: 'Ảnh không trả về HTTP 200',
    image_content_type_invalid: 'Phản hồi ảnh không đúng định dạng',
    missing_price: 'Thiếu giá hợp lệ',
    source_unverified: 'Nguồn dữ liệu chưa được xác minh',
  };
  return labels[value] || value.replace(/^stored:/, '').replace(/_/g, ' ');
}

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [product, setProduct] = useState<Product | null>(null);
  const [pipelineTruth, setPipelineTruth] = useState<PipelineTruth | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ type: string; message: string } | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);
  const [actionBusy, setActionBusy] = useState('');

  const showToast = useCallback((type: string, message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const loadProduct = async () => {
    setLoading(true);
    try {
      const [productResponse, truthResponse] = await Promise.all([fetch(`/api/products/${id}`), fetch(`/api/dashboard/products/${id}/truth`)]);
      const [data, truthData] = await Promise.all([productResponse.json(), truthResponse.json()]);
      if (data.ok) setProduct(data.data);
      if (truthData.ok) setPipelineTruth(truthData.data);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetch(`/api/products/${id}`).then(res => res.json()), fetch(`/api/dashboard/products/${id}/truth`).then(res => res.json())])
      .then(([data, truthData]) => { if (!cancelled && data.ok) setProduct(data.data); if (!cancelled && truthData.ok) setPipelineTruth(truthData.data); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const handleAction = async (action: string) => {
    if (actionBusy) return;
    setActionBusy(action);
    const semanticActions = new Set(['reviewed', 'data_verified', 'canary_ready', 'safe_publish_requested']);
    const url = action === 'score' ? `/api/products/${id}/score`
      : action === 'archive' ? `/api/products/${id}/archive`
      : semanticActions.has(action) ? `/api/dashboard/products/${id}/actions` : '';

    const method = 'POST';
    const body = semanticActions.has(action) ? JSON.stringify({ action, operationId: `product-ui:${id}:${action}` }) : undefined;
    const headers: Record<string, string> = body ? { 'Content-Type': 'application/json' } : {};

    try {
      const res = await fetch(url, { method, body, headers });
      const data = await res.json();
      if (data.ok) {
        const messages: Record<string, string> = {
        reviewed: 'Đã ghi nhận admin đã xem; dữ liệu và publish state không đổi.',
        data_verified: 'Đã ghi nhận xác minh dữ liệu; chưa đưa ra public.',
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
        showToast('error', data.message);
      }
    } catch {
      showToast('error', 'Không thể thực hiện thao tác.');
    } finally {
      setActionBusy('');
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
        <div className="page-content"><div className="loading-state"><div className="spinner"></div></div></div>
      </>
    );
  }

  if (!product) {
    return (
      <>
        <div className="topbar"><div className="topbar-title">Chi tiết sản phẩm</div></div>
        <div className="page-content">
          <div className="empty-state">
            <div className="empty-state-icon">❌</div>
            <div className="empty-state-title">Không tìm thấy sản phẩm</div>
            <div className="empty-state-desc">Sản phẩm này có thể đã được lưu trữ hoặc không tồn tại.</div>
            <Link href="/dashboard/products" className="btn btn-primary" style={{ marginTop: 'var(--space-lg)' }}>← Quay lại danh sách</Link>
          </div>
        </div>
      </>
    );
  }

  const inferredKind = product.kind || classifyProductKind(product);
  const statusLabel = product.status === 'approved' ? 'Đã duyệt' : product.status === 'needs_review' ? 'Cần xem xét' : product.status === 'draft' ? 'Nháp' : product.status === 'published' ? 'Đã xuất bản' : product.status;
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
  const blockers = pipelineTruth?.lifecycle.blockers || [];
  const blockerGroups = blockers.reduce<Record<string, string[]>>((groups, blocker) => {
    const group = /link|url/i.test(blocker) ? 'Liên kết' : /image|ảnh/i.test(blocker) ? 'Hình ảnh' : /price|giá/i.test(blocker) ? 'Giá'
      : /duplicate|trùng/i.test(blocker) ? 'Trùng lặp' : /content|claim|evidence|review/i.test(blocker) ? 'Nội dung & bằng chứng' : 'Dữ liệu & chính sách';
    (groups[group] ||= []).push(blocker);
    return groups;
  }, {});
  const canaryDisabledReason = pipelineTruth?.lifecycle.canaryReady ? 'Sản phẩm đã ở danh sách xét CANARY.' : blockers.length ? `Còn ${blockers.length} blocker cần xử lý.` : '';
  const publishDisabledReason = pipelineTruth?.lifecycle.safePublishRequested ? 'Đã có yêu cầu Safe Publish.' : blockers.length ? `Còn ${blockers.length} blocker cần xử lý.`
    : pipelineTruth && !pipelineTruth.safety.publishingEnabled ? 'Publishing đang bị khóa bởi chính sách vận hành.' : '';

  return (
    <main className={styles.page}>
      {toast && <div className="toast-container"><div className={`toast toast-${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}><span>{toast.message}</span><button className="toast-close" onClick={() => setToast(null)} aria-label="Đóng thông báo">×</button></div></div>}
      <header className={styles.topbar}><div><span>Danh mục sản phẩm</span><h1>Chi tiết vận hành</h1></div><Link href="/dashboard/products" className="btn btn-secondary btn-sm">← Quay lại danh sách</Link></header>

      <section className={styles.hero}>
        <SafeProductImage originalUrl={product.imageUrl} candidates={product.gallery} healthStatus={product.imageHealthStatus} alt={product.title} className={styles.heroImage} />
        <div className={styles.heroMain}>
          <div className={styles.badges}><span className="badge badge-neutral">{product.platform}</span><span className="badge badge-neutral">{inferredKind}</span><span className={`badge ${product.status === 'approved' ? 'badge-success' : product.status === 'needs_review' ? 'badge-warning' : product.status === 'published' ? 'badge-info' : 'badge-neutral'}`}>{statusLabel}</span>{inferredKind !== 'product' && <span className="badge badge-warning">Chưa phải sản phẩm cụ thể</span>}</div>
          <h2>{product.title}</h2>
          <p>{product.description || 'Chưa có mô tả sản phẩm.'}</p>
          <div className={styles.priceRow}><strong>{formatPrice(product.salePrice || product.price)}</strong>{product.salePrice && product.price && product.price !== product.salePrice && <del>{formatPrice(product.price)}</del>}{product.priceNote && <span className="badge badge-warning">{product.priceNote}</span>}</div>
          <dl className={styles.heroFacts}><div><dt>Nguồn</dt><dd>{product.source || '—'}</dd></div><div><dt>Danh mục</dt><dd>{product.category || '—'}</dd></div><div><dt>Trạng thái public</dt><dd>{pipelineTruth?.lifecycle.publicHidden === false ? 'Đang hiển thị' : 'Đang ẩn'}</dd></div><div><dt>Rủi ro</dt><dd>{product.riskLevel === 'low' ? 'Thấp' : product.riskLevel === 'medium' ? 'Trung bình' : product.riskLevel === 'high' ? 'Cao' : 'Chưa rõ'}</dd></div></dl>
          <div className={styles.linkActions} aria-label="Liên kết sản phẩm đã kiểm tra">
            <div data-link-state={affiliateLinkEnabled ? 'enabled' : 'disabled'}><span>Affiliate</span>{affiliateLinkEnabled
              ? <a href={product.affiliateUrl!} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm">Mở link affiliate</a>
              : <button type="button" className="btn btn-primary btn-sm" disabled aria-disabled="true">Link affiliate bị khóa</button>}<small>{affiliateLinkEnabled ? 'Đã xác minh và sẵn sàng mở.' : affiliateLinkReason}</small></div>
            <div data-link-state={canonicalLinkEnabled ? 'enabled' : 'disabled'}><span>Sản phẩm</span>{canonicalLinkEnabled
              ? <a href={canonicalUrl!} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm">Mở trang sản phẩm</a>
              : <button type="button" className="btn btn-secondary btn-sm" disabled aria-disabled="true">Link sản phẩm bị khóa</button>}<small>{canonicalLinkEnabled ? 'Đã xác minh và sẵn sàng mở.' : canonicalLinkReason}</small></div>
          </div>
        </div>
        <aside className={styles.scoreSummary}><span>Điểm đánh giá</span><strong className={product.score != null && product.score >= 75 ? styles.goodScore : product.score != null && product.score >= 45 ? styles.mediumScore : styles.lowScore}>{product.score ?? '—'}</strong><small>{product.scoreLabel || 'Chưa có nhãn điểm'}</small><button className="btn btn-accent btn-sm" onClick={() => handleAction('score')} disabled={Boolean(actionBusy)}>{actionBusy === 'score' ? 'Đang chấm…' : 'Chấm điểm lại'}</button></aside>
      </section>

      <section className={styles.operationGrid}>
        <article className={styles.card}>
          <div className={styles.cardHeader}><div><span>Runtime & policy</span><h3>Operational truth</h3></div><span className={`badge ${blockers.length ? 'badge-warning' : 'badge-success'}`}>{blockers.length ? `${blockers.length} blocker` : 'Không có blocker'}</span></div>
          {pipelineTruth ? <>
            <dl className={styles.truthGrid}><div><dt>Phân loại</dt><dd>{pipelineTruth.classification.type}</dd></div><div><dt>Lifecycle</dt><dd>{pipelineTruth.lifecycle.stage}</dd></div><div><dt>Job hiện tại</dt><dd>{pipelineTruth.automation.status || 'Không có'}</dd></div><div><dt>Worker owner</dt><dd>{pipelineTruth.automation.workerOwner || 'Không có owner active'}</dd></div><div><dt>Retry</dt><dd>{pipelineTruth.automation.attempts}/{pipelineTruth.automation.maxAttempts ?? '—'}</dd></div><div><dt>Publishing</dt><dd>{pipelineTruth.safety.publishingEnabled ? 'Enabled' : 'Disabled'}</dd></div></dl>
            <div className={styles.healthStrip}>
              <span>Link sản phẩm <strong>{pipelineTruth.health.productLink}</strong><small>{product.productUrlFinalDomain || 'Chưa có final domain'} · {product.productUrlHttpStatus ? `HTTP ${product.productUrlHttpStatus}` : product.productUrlErrorCode || 'Chưa có HTTP status'} · {product.canonicalUrlSourceField || 'chưa có provenance'} · {product.linkLastCheckedAt ? new Date(product.linkLastCheckedAt).toLocaleString('vi-VN') : 'Chưa kiểm tra'}</small></span>
              <span>Affiliate <strong>{pipelineTruth.health.affiliateLink}</strong><small>{product.affiliateUrlFinalDomain || 'Chưa có final domain'} · {product.affiliateUrlHttpStatus ? `HTTP ${product.affiliateUrlHttpStatus}` : product.affiliateUrlErrorCode || 'Chưa có HTTP status'} · {product.affiliateUrlVerifiedAt ? new Date(product.affiliateUrlVerifiedAt).toLocaleString('vi-VN') : 'Chưa xác minh'}</small></span>
              <span>Ảnh <strong>{pipelineTruth.health.image}</strong><small>{product.imageUrlHttpStatus ? `HTTP ${product.imageUrlHttpStatus}` : 'Chưa có HTTP status'} · {product.imageContentType || 'Chưa có Content-Type'}</small></span><span>Giá <strong>{pipelineTruth.health.price}</strong></span><span>Nguồn <strong>{pipelineTruth.health.source}</strong></span>
            </div>
            {blockers.length ? <div className={styles.blockerGroups}>{Object.entries(blockerGroups).map(([group, items]) => <div key={group}><strong>{group}</strong><div>{items.map(blocker => <span key={blocker} className={styles.blockerBadge} title={blocker}>{friendlyBlocker(blocker)}</span>)}</div></div>)}</div> : <p className={styles.clearState}>Không có blocker được ghi nhận trong snapshot hiện tại.</p>}<p className={styles.requiredAction}>Hành động cần thiết: <strong>{pipelineTruth.requiredAction ? friendlyBlocker(pipelineTruth.requiredAction) : 'Không có'}</strong></p>
          </> : <p className={styles.clearState}>Chưa tải được operational truth. Các hành động nhạy cảm vẫn bị khóa.</p>}
        </article>

        <article className={styles.card}>
          <div className={styles.cardHeader}><div><span>Theo mức độ rủi ro</span><h3>Hành động vận hành</h3></div></div>
          <div className={styles.actionGroup}><strong>Kiểm tra</strong><div><button className="btn btn-secondary" onClick={() => handleAction('score')} disabled={Boolean(actionBusy)}>Chấm điểm lại</button><button className="btn btn-secondary" onClick={() => handleAction('reviewed')} disabled={Boolean(actionBusy) || pipelineTruth?.lifecycle.reviewed} title={pipelineTruth?.lifecycle.reviewed ? 'Đã ghi nhận xem xét.' : undefined}>Đánh dấu đã xem</button></div></div>
          <div className={styles.actionGroup}><strong>Xác nhận dữ liệu</strong><div><button className="btn btn-secondary" onClick={() => handleAction('data_verified')} disabled={Boolean(actionBusy) || pipelineTruth?.lifecycle.dataVerified} title={pipelineTruth?.lifecycle.dataVerified ? 'Dữ liệu đã được xác nhận.' : undefined}>Xác nhận dữ liệu</button></div></div>
          <div className={styles.actionGroup}><strong>Canary & Safe Publish</strong><div><button className="btn btn-secondary" onClick={() => handleAction('canary_ready')} disabled={Boolean(actionBusy) || Boolean(canaryDisabledReason)} title={canaryDisabledReason || undefined}>Đưa vào danh sách xét CANARY</button><button className="btn btn-primary" onClick={() => handleAction('safe_publish_requested')} disabled={Boolean(actionBusy) || Boolean(publishDisabledReason)} title={publishDisabledReason || undefined}>Yêu cầu kiểm tra Safe Publish</button></div>{(canaryDisabledReason || publishDisabledReason) && <p className={styles.disabledReason}>{publishDisabledReason || canaryDisabledReason}</p>}</div>
          <div className={`${styles.actionGroup} ${styles.archiveGroup}`}><strong>Lưu trữ</strong><div><button className="btn btn-secondary" onClick={() => handleAction('archive')} disabled={Boolean(actionBusy)}>Lưu trữ sản phẩm</button><Link href="/dashboard/content" className="btn btn-ghost" aria-disabled="true" title="Tính năng tạo nội dung chưa sẵn sàng.">Tạo nội dung (sắp có)</Link></div></div>
        </article>
      </section>

      <section className={styles.contentGrid}>
        <article className={styles.card}><div className={styles.cardHeader}><h3>Lợi ích & cảnh báo</h3></div>{product.benefits?.length ? <div><h4>Lợi ích chính</h4><ul className="detail-list">{product.benefits.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : <p className={styles.emptyText}>Chưa có lợi ích được xác minh.</p>}{product.warnings?.length ? <div className={styles.warningList}><h4>Cảnh báo / không được nói quá</h4><ul className="detail-list detail-list-warning">{product.warnings.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}</article>
        <article className={styles.card}><div className={styles.cardHeader}><h3>Content intelligence</h3></div><div className={styles.intelligenceGrid}><div><h4>Pain points</h4>{product.painPoints?.length ? <ul className="detail-list">{product.painPoints.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>Chưa có</p>}</div><div><h4>Đối tượng</h4>{product.targetAudience?.length ? <ul className="detail-list">{product.targetAudience.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>Chưa có</p>}</div><div><h4>Góc nội dung</h4>{product.contentAngles?.length ? <ul className="detail-list">{product.contentAngles.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>Chưa có</p>}</div><div><h4>Ghi chú kiểm duyệt</h4>{product.complianceNotes?.length ? <ul className="detail-list">{product.complianceNotes.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>Chưa có</p>}</div></div></article>
        <article className={styles.card}><div className={styles.cardHeader}><h3>Thông tin bổ sung</h3></div><dl className={styles.metaList}><div><dt>Tags</dt><dd>{product.tags?.join(', ') || '—'}</dd></div><div><dt>Chiến dịch</dt><dd>{product.campaignName || '—'}</dd></div><div><dt>Hoa hồng</dt><dd>{product.commissionNote || '—'}</dd></div><div><dt>Disclosure</dt><dd>{product.affiliateDisclosure || '—'}</dd></div><div><dt>Tạo lúc</dt><dd>{new Date(product.createdAt).toLocaleString('vi-VN')}</dd></div><div><dt>Cập nhật</dt><dd>{new Date(product.updatedAt).toLocaleString('vi-VN')}</dd></div></dl></article>
      </section>

      <section className={styles.technical}><button className="btn btn-ghost btn-sm" onClick={() => setShowTechnical(!showTechnical)}>{showTechnical ? 'Ẩn' : 'Hiện'} chi tiết kỹ thuật</button>{showTechnical && <pre>{JSON.stringify(product, null, 2)}</pre>}</section>
    </main>
  );
}
