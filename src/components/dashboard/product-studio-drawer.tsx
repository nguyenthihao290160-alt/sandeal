'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCommandCenter } from './command-center-provider';
import { DashboardIcon } from './dashboard-icon';
import { SafeProductImage } from '@/components/safe-product-image';
import { clientRequestMessage, requestClientJson } from '@/lib/dashboard/clientRequest';
import type { ProductStudioDetail } from '@/lib/dashboard/productStudio';
import { calculateDealEconomics } from '@/lib/dashboard/v4';
import styles from './product-studio-drawer.module.css';

type Envelope<T> = { ok: boolean; code: string; message?: string; data?: T };
type DrawerTab = 'overview' | 'review' | 'affiliate' | 'history' | 'debug';

const TABS: Array<{ id: DrawerTab; label: string; technicalLabel: string }> = [
  { id: 'overview', label: 'Tổng quan', technicalLabel: 'Overview' },
  { id: 'review', label: 'Review', technicalLabel: 'Review' },
  { id: 'affiliate', label: 'Affiliate', technicalLabel: 'Affiliate' },
  { id: 'history', label: 'Lịch sử', technicalLabel: 'History' },
  { id: 'debug', label: 'Debug', technicalLabel: 'Debug' },
];

function money(value: number | null): string {
  return value === null ? '—' : `${new Intl.NumberFormat('vi-VN').format(value)} ₫`;
}

function percentage(value: number | null): string {
  return value === null ? '—' : `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(value)}%`;
}

function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function PriceChart({ data }: { data: ProductStudioDetail['overview']['priceHistory30d'] }) {
  if (!data.sufficient) return <p className={styles.emptyState}>Chưa đủ dữ liệu lịch sử giá</p>;
  const prices = data.points.map(point => point.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const range = Math.max(1, high - low);
  const points = data.points.map((point, index) => {
    const x = data.points.length === 1 ? 50 : (index / (data.points.length - 1)) * 100;
    const y = 42 - ((point.price - low) / range) * 34;
    return `${x},${y}`;
  }).join(' ');
  return <div className={styles.priceHistory}>
    <svg viewBox="0 0 100 48" role="img" aria-label="Biểu đồ lịch sử giá thật trong 30 ngày" preserveAspectRatio="none">
      <defs><linearGradient id="studio-price-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4f46e5" stopOpacity=".24" /><stop offset="1" stopColor="#4f46e5" stopOpacity="0" /></linearGradient></defs>
      <polygon points={`0,48 ${points} 100,48`} fill="url(#studio-price-fill)" />
      <polyline points={points} fill="none" stroke="#4f46e5" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
    <dl><div><dt>Hiện tại</dt><dd>{money(data.current)}</dd></div><div><dt>Thấp nhất</dt><dd>{money(data.low)}</dd></div><div><dt>Cao nhất</dt><dd>{money(data.high)}</dd></div><div><dt>Trung bình</dt><dd>{money(data.average)}</dd></div></dl>
    {data.currentIsLow && <span className={styles.lowestBadge}>Giá thấp nhất 30 ngày</span>}
  </div>;
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = Math.max(0, Date.parse(expiresAt) - now);
  if (!remaining) return null;
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return <span className={styles.urgencyBadge}>Khuyến mãi còn {String(hours).padStart(2, '0')}:{String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}</span>;
}

function OverviewTab({ detail }: { detail: ProductStudioDetail }) {
  const { showAdminToast } = useCommandCenter();
  const [simulationOpen, setSimulationOpen] = useState(false);
  const [simulation, setSimulation] = useState({ platform: '', voucher: '', cashback: '', commission: '' });
  const simulatedEconomics = useMemo(() => calculateDealEconomics({
    platformDiscount: simulation.platform === '' ? null : Number(simulation.platform),
    voucherDiscount: simulation.voucher === '' ? null : Number(simulation.voucher),
    verifiedCashback: simulation.cashback === '' ? null : Number(simulation.cashback),
    affiliateCommission: simulation.commission === '' ? null : Number(simulation.commission),
    simulation: true,
  }), [simulation]);
  const urgencyExpiry = detail.overview.urgency.find(item => item.kind === 'promotion_expiry');
  return <div className={styles.tabStack}>
    {urgencyExpiry?.kind === 'promotion_expiry' && <Countdown expiresAt={urgencyExpiry.expiresAt} />}

    <section className={styles.drawerSection}>
      <div className={styles.sectionHeading}><div><h3>Thông tin sản phẩm</h3><p>Chỉ hiển thị các trường đang tồn tại trong product contract.</p></div><DashboardIcon name="product" size={18} /></div>
      <dl className={styles.keyValueList}>
        <div><dt>Danh mục</dt><dd>{detail.product.category || '—'}</dd></div>
        <div><dt>Thương hiệu</dt><dd>{detail.product.brand || '—'}</dd></div>
        <div><dt>SKU</dt><dd>{detail.product.sku || '—'}</dd></div>
        <div><dt>Giá gốc</dt><dd>{money(detail.product.originalPrice)}</dd></div>
        <div><dt>Commission rate</dt><dd>{percentage(detail.product.commissionRate)}</dd></div>
        <div><dt>Ngày phát hiện</dt><dd>{new Date(detail.product.createdAt).toLocaleString('vi-VN')}</dd></div>
      </dl>
    </section>

    <section className={styles.drawerSection}>
      <div className={styles.sectionHeading}><div><h3>Deal Matrix</h3><p>Chỉ so sánh offer nằm trong cùng canonical identity đã xác minh.</p></div><DashboardIcon name="compare" size={18} /></div>
      {detail.overview.dealMatrix.available ? <div className={styles.matrixTable}><table><thead><tr><th>Nền tảng</th><th>Giá</th><th>Giảm</th><th>Shop</th><th>Affiliate</th></tr></thead><tbody>{detail.overview.dealMatrix.rows.map(row => <tr key={row.offerId}><td>{row.platform}</td><td>{money(row.currentPrice)}</td><td>{row.verifiedDiscountPercent === null ? '—' : `${row.verifiedDiscountPercent}%`}</td><td>{row.seller || '—'}</td><td>{row.affiliateAvailable && safeExternalUrl(row.affiliateUrl) ? <a href={safeExternalUrl(row.affiliateUrl)!} target="_blank" rel="noopener noreferrer">Mở deal</a> : '—'}</td></tr>)}</tbody></table></div> : <p className={styles.emptyState}>{detail.overview.dealMatrix.reason === 'IDENTITY_UNVERIFIED' ? 'Chưa đủ dữ liệu để so sánh chính xác.' : 'Chưa có offer đã xác minh để so sánh.'}</p>}
    </section>

    <section className={styles.drawerSection}>
      <div className={styles.sectionHeading}><div><h3>Lịch sử giá · 30 ngày</h3><p>Không nội suy điểm dữ liệu còn thiếu.</p></div><DashboardIcon name="price" size={18} /></div>
      <PriceChart data={detail.overview.priceHistory30d} />
      <button type="button" className={styles.comingSoonButton} disabled title="Chưa có backend subscription">Theo dõi giảm giá <span>Sắp có</span></button>
    </section>

    <section className={styles.drawerSection}>
      <div className={styles.sectionHeading}><div><h3>Tối ưu thanh toán</h3><p>Chỉ hiển thị ưu đãi còn hạn từ nguồn đã xác minh.</p></div><DashboardIcon name="price" size={18} /></div>
      {detail.overview.paymentOptimization.available ? <div className={styles.paymentList}>{detail.overview.paymentOptimization.promotions.map(promotion => <article key={promotion.id}><strong>{promotion.issuer} · {promotion.productName}</strong><span>{promotion.cashbackRate ? `Cashback ${promotion.cashbackRate}%` : money(promotion.cashbackAmount || null)}</span><small>{detail.overview.paymentOptimization.disclaimer}</small></article>)}</div> : <p className={styles.emptyState}>Chưa có dữ liệu ưu đãi thẻ/cashback đã xác minh và còn hiệu lực.</p>}
    </section>

    <section className={styles.drawerSection}>
      <div className={styles.sectionHeading}><div><h3>Deal Economics</h3><p>Customer Benefit và Publisher Revenue luôn tách riêng.</p></div><DashboardIcon name="analytics" size={18} /></div>
      <div className={styles.economicsGrid}><article><span>Tiết kiệm dự kiến của khách</span><strong>{money(detail.overview.economics.customerSavings)}</strong><small>Không bao gồm affiliate commission</small></article><article><span>Doanh thu affiliate dự kiến của SanDeal</span><strong>{money(detail.overview.economics.publisherRevenue)}</strong><small>Không phải khoản hoàn cho khách</small></article></div>
      <button type="button" className={styles.simulationToggle} aria-expanded={simulationOpen} onClick={() => setSimulationOpen(value => !value)}>Mô phỏng what-if (không lưu)</button>
      {simulationOpen && <div className={styles.simulationPanel}><div className={styles.simulationInputs}>{([
        ['platform', 'Giảm giá nền tảng'], ['voucher', 'Voucher'], ['cashback', 'Cashback đã giả định'], ['commission', 'Affiliate commission'],
      ] as const).map(([field, label]) => <label key={field}><span>{label}</span><input type="number" min="0" value={simulation[field]} onChange={event => setSimulation(current => ({ ...current, [field]: event.target.value }))} /></label>)}</div><div className={styles.economicsGrid}><article><span>Customer Benefit · Mô phỏng</span><strong>{money(simulatedEconomics.customerSavings)}</strong></article><article><span>Publisher Revenue · Mô phỏng</span><strong>{money(simulatedEconomics.publisherRevenue)}</strong></article></div><button type="button" onClick={() => { setSimulation({ platform: '', voucher: '', cashback: '', commission: '' }); showAdminToast('Đã xóa giá trị mô phỏng.', 'info'); }}>Xóa mô phỏng</button></div>}
    </section>
  </div>;
}

function ReviewTab({ detail }: { detail: ProductStudioDetail }) {
  return <div className={styles.tabStack}><section className={styles.drawerSection}><div className={styles.reviewScores}><div><span>Approval</span><strong>{detail.review.approval ? 'Approved' : detail.review.status}</strong></div><div><span>Quality</span><strong>{detail.review.quality ?? '—'}</strong></div><div><span>Originality</span><strong>{detail.review.originality ?? '—'}</strong></div><div><span>Confidence</span><strong>{detail.review.confidence ?? '—'}</strong></div></div></section><section className={styles.drawerSection}><h3>Eligibility & blockers</h3>{detail.review.reasons.length ? <div className={styles.reviewReasons}>{detail.review.reasons.map(reason => <article key={`${reason.severity}:${reason.technicalCode}`} data-severity={reason.severity}><strong>{reason.label}</strong><code>{reason.technicalCode}</code></article>)}</div> : <p className={styles.emptyState}>Không có blocker review trong snapshot hiện tại.</p>}</section></div>;
}

function AffiliateTab({ detail }: { detail: ProductStudioDetail }) {
  const { showAdminToast } = useCommandCenter();
  const copy = async (value: string | null, success: string) => {
    if (!value) return;
    try { await navigator.clipboard.writeText(value); showAdminToast(success); }
    catch { showAdminToast('Không thể truy cập clipboard.', 'error'); }
  };
  const original = safeExternalUrl(detail.affiliate.originalProductUrl);
  const affiliate = safeExternalUrl(detail.affiliate.affiliateUrl);
  return <div className={styles.tabStack}><section className={styles.drawerSection}><dl className={styles.keyValueList}><div><dt>Network / provider</dt><dd>{detail.affiliate.network || '—'}</dd></div><div><dt>Source</dt><dd>{detail.affiliate.source}</dd></div><div><dt>Affiliate state</dt><dd>{detail.affiliate.state || 'UNKNOWN'}</dd></div><div><dt>Link health</dt><dd>{detail.affiliate.linkHealth || 'UNKNOWN'}</dd></div><div><dt>Last validation</dt><dd>{detail.affiliate.lastValidation ? new Date(detail.affiliate.lastValidation).toLocaleString('vi-VN') : '—'}</dd></div><div><dt>Commission amount</dt><dd>{money(detail.affiliate.commissionAmount)}</dd></div><div><dt>Commission rate</dt><dd>{percentage(detail.affiliate.commissionRate)}</dd></div></dl></section><section className={styles.drawerSection}><h3>Links</h3><div className={styles.linkRows}><div><span>Original product URL</span><code>{original || '—'}</code><div>{original && <><button type="button" onClick={() => void copy(original, 'Đã copy link sản phẩm.')}>Copy</button><a href={original} target="_blank" rel="noopener noreferrer">Mở</a></>}</div></div><div><span>Affiliate URL</span><code>{affiliate || '—'}</code><div>{affiliate && <><button type="button" onClick={() => void copy(affiliate, 'Đã copy link affiliate.')}>Copy</button><a href={affiliate} target="_blank" rel="noopener noreferrer">Mở</a></>}</div></div></div></section><p className={styles.disclosure}>{detail.affiliate.disclosure}</p></div>;
}

function HistoryTab({ detail }: { detail: ProductStudioDetail }) {
  return detail.history.length ? <ol className={styles.historyList}>{detail.history.map(event => <li key={event.id}><span aria-hidden="true" /><div><strong>{event.label}</strong><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString('vi-VN')}</time><details><summary>Technical event</summary><code>{event.technicalType}{event.state ? ` · ${event.state}` : ''}</code></details></div></li>)}</ol> : <p className={styles.emptyState}>Chưa có lifecycle event có timestamp được xác minh.</p>;
}

function DebugTab({ detail }: { detail: ProductStudioDetail }) {
  return <div className={`${styles.tabStack} ${styles.technicalView}`} lang="en"><section className={styles.drawerSection}><h3>Internal identity</h3><dl className={styles.keyValueList}><div><dt>productId</dt><dd>{detail.debug.internalId}</dd></div><div><dt>relatedJobId</dt><dd>{detail.debug.relatedJobId || '—'}</dd></div><div><dt>publicationJobId</dt><dd>{detail.debug.publicationJobId || '—'}</dd></div>{Object.entries(detail.debug.sourceIdentity).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || '—'}</dd></div>)}</dl></section><section className={styles.drawerSection}><h3>Reason codes</h3>{detail.debug.reasonCodes.length ? <div className={styles.codeList}>{detail.debug.reasonCodes.map(code => <code key={code}>{code}</code>)}</div> : <p className={styles.emptyState}>No reason codes in the current snapshot.</p>}</section><section className={styles.drawerSection}><h3>Diagnostic state</h3><dl className={styles.keyValueList}>{Object.entries(detail.debug.technicalState).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || '—'}</dd></div>)}</dl><details className={styles.rawJson}><summary>Sanitized JSON</summary><pre>{JSON.stringify({ technicalState: detail.debug.technicalState, timestamps: detail.debug.timestamps }, null, 2)}</pre></details></section></div>;
}

export function ProductStudioDrawer({ productId, onClose }: { productId: string | null; onClose: () => void }) {
  const { technicalMode, showAdminToast } = useCommandCenter();
  const [detail, setDetail] = useState<ProductStudioDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<DrawerTab>('overview');
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!productId) return;
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setTab('overview');
      setDetail(null);
      setError('');
      setLoading(true);
      void requestClientJson<Envelope<ProductStudioDetail>>(`/api/dashboard/products/${encodeURIComponent(productId)}/studio`, {
        cache: 'no-store',
        signal: controller.signal,
        timeoutMs: 12_000,
        maximumResponseBytes: 768 * 1024,
      }).then(body => {
        if (!body.ok || !body.data) throw new Error(body.message || 'Không thể tải Product Studio.');
        setDetail(body.data);
      }).catch(reason => {
        if (!controller.signal.aborted) setError(clientRequestMessage(reason, 'Không thể tải Product Studio.'));
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
      closeRef.current?.focus();
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [productId]);

  useEffect(() => {
    if (!productId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), summary, [tabindex="0"]') || []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, productId]);

  useEffect(() => {
    if (productId) return;
    triggerRef.current?.focus();
    triggerRef.current = null;
  }, [productId]);

  const copyBroadcast = useCallback(async () => {
    if (!detail?.broadcast.copy) return;
    try {
      await navigator.clipboard.writeText(detail.broadcast.copy);
      showAdminToast('✅ Đã copy Nội dung & Link Affiliate');
    } catch {
      showAdminToast('Không thể truy cập clipboard.', 'error');
    }
  }, [detail, showAdminToast]);

  const moveTabFocus = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = TABS.length - 1;
    else return;
    event.preventDefault();
    const nextTab = TABS[nextIndex];
    setTab(nextTab.id);
    drawerRef.current?.querySelector<HTMLButtonElement>(`#studio-tab-${nextTab.id}`)?.focus();
  }, []);

  if (!productId) return null;
  return <div className={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <aside ref={drawerRef} className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="studio-drawer-title">
      <header className={styles.drawerHeader}>
        <div><span>PRODUCT STUDIO PRO</span><h2 id="studio-drawer-title">{detail?.product.title || 'Chi tiết sản phẩm'}</h2></div>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Đóng Product Studio"><DashboardIcon name="close" size={19} /></button>
      </header>

      {loading && <div className={styles.drawerSkeleton} aria-label="Đang tải"><span /><span /><span /></div>}
      {!loading && error && <div className={styles.drawerError} role="alert"><DashboardIcon name="warning" size={22} /><h3>Không thể tải chi tiết nhanh</h3><p>{error}</p><button type="button" onClick={onClose}>Đóng</button></div>}
      {!loading && detail && <>
        <section className={styles.productHero}>
          <SafeProductImage originalUrl={detail.product.image} alt={`Ảnh ${detail.product.title}`} className={styles.heroImage} showFailureStatus />
          <div><div className={styles.heroBadges}><span>{detail.product.source}</span><span>{detail.presentation.funnel.label}</span><span>Affiliate {detail.affiliate.state || 'UNKNOWN'}</span></div><h2>{detail.product.title}</h2><p>{detail.product.shop || 'Chưa có shop'} · {detail.product.platform}</p><div className={styles.heroMetrics}><strong>{money(detail.product.price)}</strong><span>Score {detail.product.score ?? '—'}</span><span>Commission {money(detail.product.commissionAmount)}</span></div></div>
        </section>

        <div className={styles.broadcastBar}><p><strong>1-Click Copy</strong><span>Chỉ dùng giá, promotion và affiliate URL có thật.</span></p><button type="button" disabled={!detail.broadcast.available} onClick={() => void copyBroadcast()}><DashboardIcon name="content" size={16} />Copy nội dung + Affiliate</button></div>

        <div className={styles.tabs} role="tablist" aria-label="Product Studio tabs">{TABS.map((item, index) => <button key={item.id} id={`studio-tab-${item.id}`} type="button" role="tab" tabIndex={tab === item.id ? 0 : -1} aria-selected={tab === item.id} aria-controls={`studio-panel-${item.id}`} onClick={() => setTab(item.id)} onKeyDown={event => moveTabFocus(event, index)}>{technicalMode ? item.technicalLabel : item.label}</button>)}</div>
        <div className={styles.tabPanel} id={`studio-panel-${tab}`} role="tabpanel" aria-labelledby={`studio-tab-${tab}`}>
          {tab === 'overview' && <OverviewTab detail={detail} />}
          {tab === 'review' && <ReviewTab detail={detail} />}
          {tab === 'affiliate' && <AffiliateTab detail={detail} />}
          {tab === 'history' && <HistoryTab detail={detail} />}
          {tab === 'debug' && <DebugTab detail={detail} />}
        </div>
      </>}
    </aside>
  </div>;
}
