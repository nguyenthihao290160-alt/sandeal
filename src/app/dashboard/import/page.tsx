'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import {
  DashboardPageHeader,
  DashboardState,
  MetricCard,
  Panel,
  StatusBadge,
  dashboardRequest,
  intelligenceStyles as styles,
  useDashboardResource,
} from '@/components/dashboard/intelligence-ui';
import type { ImportPreview, ManualUrlPreview, PendingManualSource } from '@/lib/product-intelligence/types';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAPPING_FIELDS = [
  ['title', 'Tên sản phẩm'],
  ['originalUrl', 'Link gốc'],
  ['affiliateUrl', 'Link affiliate'],
  ['imageUrl', 'Link ảnh'],
  ['price', 'Giá gốc'],
  ['salePrice', 'Giá bán'],
  ['platform', 'Nền tảng'],
  ['source', 'Nguồn'],
  ['category', 'Danh mục'],
  ['brand', 'Thương hiệu'],
  ['sku', 'SKU'],
  ['externalId', 'Mã ngoài'],
] as const;

type MappingField = (typeof MAPPING_FIELDS)[number][0];
type ImportApplyResult = {
  jobId: string;
  operationId: string;
  status: string;
};

type ManualMetadata = {
  title: string;
  affiliateUrl: string;
  imageUrl: string;
  price: string;
  salePrice: string;
  platform: string;
  category: string;
  brand: string;
  sku: string;
  externalId: string;
};

type ManualSubmitResult = {
  source: PendingManualSource;
  created: boolean;
  operationId: string;
};

type VaultHealth = {
  accessTradeConfigured?: boolean;
  lastCheckTime?: string;
};

const EMPTY_MANUAL_METADATA: ManualMetadata = {
  title: '', affiliateUrl: '', imageUrl: '', price: '', salePrice: '', platform: '',
  category: '', brand: '', sku: '', externalId: '',
};

function readHeader(csv: string): string[] {
  const firstLine = csv.split(/\r?\n/, 1)[0] || '';
  const values: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < firstLine.length; index += 1) {
    const character = firstLine[index];
    if (character === '"') {
      if (quoted && firstLine[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(value.trim());
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values.filter(Boolean).slice(0, 100);
}

function automaticMapping(headers: string[]): Partial<Record<MappingField, string>> {
  const aliases: Record<MappingField, string[]> = {
    title: ['title', 'name', 'product_name', 'ten_san_pham'],
    originalUrl: ['originalurl', 'original_url', 'url', 'product_url'],
    affiliateUrl: ['affiliateurl', 'affiliate_url', 'tracking_url'],
    imageUrl: ['imageurl', 'image_url', 'image', 'thumbnail'],
    price: ['price', 'original_price', 'regular_price'],
    salePrice: ['saleprice', 'sale_price', 'current_price'],
    platform: ['platform', 'marketplace'],
    source: ['source', 'provider'],
    category: ['category', 'category_name'],
    brand: ['brand', 'manufacturer'],
    sku: ['sku', 'model'],
    externalId: ['externalid', 'external_id', 'product_id'],
  };
  const normalized = headers.map((header) => header.toLowerCase().replace(/[^a-z0-9_]/g, ''));
  return Object.fromEntries(MAPPING_FIELDS.flatMap(([field]) => {
    const index = normalized.findIndex((header) => aliases[field].includes(header));
    return index >= 0 ? [[field, headers[index]]] : [];
  })) as Partial<Record<MappingField, string>>;
}

function normalizePreview(value: ImportPreview | { preview?: ImportPreview }): ImportPreview {
  return 'preview' in value && value.preview ? value.preview : value as ImportPreview;
}

export default function ImportProductsPage() {
  const [activeTab, setActiveTab] = useState<'csv' | 'manual' | 'accesstrade'>('csv');
  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Partial<Record<MappingField, string>>>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [applyResult, setApplyResult] = useState<ImportApplyResult | null>(null);
  const [busy, setBusy] = useState<'reading' | 'preview' | 'apply' | null>(null);
  const [error, setError] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [manualPreview, setManualPreview] = useState<ManualUrlPreview | null>(null);
  const [manualMetadata, setManualMetadata] = useState<ManualMetadata>(EMPTY_MANUAL_METADATA);
  const [manualResult, setManualResult] = useState<ManualSubmitResult | null>(null);
  const [manualBusy, setManualBusy] = useState<'preview' | 'submit' | null>(null);
  const [manualError, setManualError] = useState('');
  const vaultHealth = useDashboardResource<VaultHealth>('/api/token-vault/health');

  const visibleRows = useMemo(() => preview?.rows.slice(0, 50) || [], [preview]);

  const chooseFile = async (file?: File) => {
    setError('');
    setPreview(null);
    setApplyResult(null);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError('Vui lòng chọn tệp có phần mở rộng .csv.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError('Tệp vượt giới hạn 2 MB và chưa được đọc.');
      return;
    }
    setBusy('reading');
    try {
      const text = await file.text();
      const nextHeaders = readHeader(text.replace(/^\uFEFF/, ''));
      if (!nextHeaders.length) throw new Error('Tệp không có hàng tiêu đề hợp lệ.');
      setFileName(file.name);
      setCsv(text.replace(/^\uFEFF/, ''));
      setHeaders(nextHeaders);
      setMapping(automaticMapping(nextHeaders));
    } catch (issue) {
      setCsv('');
      setHeaders([]);
      setMapping({});
      setError(issue instanceof Error ? issue.message : 'Không thể đọc tệp UTF-8.');
    } finally {
      setBusy(null);
    }
  };

  const runPreview = async () => {
    if (!csv || busy) return;
    setBusy('preview');
    setError('');
    setApplyResult(null);
    try {
      const result = await dashboardRequest<ImportPreview | { preview?: ImportPreview }>('/api/dashboard/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'preview', csv, mapping }),
      });
      setPreview(normalizePreview(result));
    } catch (issue) {
      setPreview(null);
      setError(issue instanceof Error ? issue.message : 'Không thể xem trước tệp CSV.');
    } finally {
      setBusy(null);
    }
  };

  const applyImport = async () => {
    if (!preview?.validRows || busy) return;
    setBusy('apply');
    setError('');
    try {
      const result = await dashboardRequest<ImportApplyResult>('/api/dashboard/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'apply',
          previewId: preview.previewId,
          idempotencyKey: `csv-import:${crypto.randomUUID()}`,
        }),
      });
      setApplyResult(result);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Không thể đưa tệp vào hàng chờ nhập.');
    } finally {
      setBusy(null);
    }
  };

  const previewUrl = async () => {
    if (!manualUrl.trim() || manualBusy) return;
    setManualBusy('preview');
    setManualError('');
    setManualPreview(null);
    setManualResult(null);
    try {
      const result = await dashboardRequest<ManualUrlPreview>('/api/dashboard/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'manual', url: manualUrl }),
      });
      setManualPreview(result);
    } catch (issue) {
      setManualError(issue instanceof Error ? issue.message : 'Không thể kiểm tra URL.');
    } finally {
      setManualBusy(null);
    }
  };

  const submitManualSource = async () => {
    if (!manualPreview?.valid || !manualMetadata.title.trim() || manualBusy) return;
    setManualBusy('submit');
    setManualError('');
    setManualResult(null);
    try {
      const result = await dashboardRequest<ManualSubmitResult>('/api/dashboard/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'manual_submit', url: manualPreview.normalizedUrl, metadata: manualMetadata }),
      });
      setManualResult(result);
    } catch (issue) {
      setManualError(issue instanceof Error ? issue.message : 'Không thể lưu nguồn chờ xử lý.');
    } finally {
      setManualBusy(null);
    }
  };

  return (
    <main className={styles.page}>
      <DashboardPageHeader
        icon="import"
        eyebrow="Sản phẩm"
        title="Nhập sản phẩm"
        description="Kiểm tra tệp CSV theo từng dòng trước khi đưa các dòng hợp lệ vào hàng chờ bền vững. Dữ liệu nhập không được tự động công khai."
        meta={<><StatusBadge tone="success">UTF-8</StatusBadge><StatusBadge tone="info">Xem trước trước khi áp dụng</StatusBadge><StatusBadge tone="warning">Không tự đăng</StatusBadge></>}
      />

      <div className={styles.tabs} role="group" aria-label="Phương thức nhập sản phẩm">
        <button type="button" className={styles.tab} aria-pressed={activeTab === 'csv'} onClick={() => setActiveTab('csv')}><DashboardIcon name="import" size={16} />CSV</button>
        <button type="button" className={styles.tab} aria-pressed={activeTab === 'manual'} onClick={() => setActiveTab('manual')}><DashboardIcon name="external" size={16} />URL thủ công</button>
        <button type="button" className={styles.tab} aria-pressed={activeTab === 'accesstrade'} onClick={() => setActiveTab('accesstrade')}><DashboardIcon name="source" size={16} />AccessTrade</button>
      </div>

      {activeTab === 'csv' && <>
        {error && <DashboardState kind="error" title="Không thể xử lý tệp" description={error} />}

      <div className={styles.twoColumns}>
        <Panel title="1. Chọn tệp CSV" icon="import" description="Tệp chỉ được đọc trong trình duyệt và gửi để kiểm tra; SanDeal không lưu tệp upload lâu dài.">
          <div className={styles.panelBody}>
            <label className={styles.fileInput}>
              <DashboardIcon name="import" size={28} />
              <strong>{fileName || 'Chọn tệp dữ liệu UTF-8'}</strong>
              <span>Tối đa 2 MB. Một dòng lỗi không làm dừng toàn bộ tệp.</span>
              <input type="file" accept=".csv,text/csv" disabled={Boolean(busy)} onChange={(event) => void chooseFile(event.target.files?.[0])} />
            </label>
            <p className={styles.help}>Giá trị bắt đầu bằng ký tự công thức phải được backend vô hiệu hóa khi xuất hoặc xem lại. Không nhập secret, token hay thông tin đăng nhập.</p>
          </div>
        </Panel>

        <Panel title="2. Ánh xạ cột" icon="compare" description="SanDeal tự nhận diện tên cột phổ biến; bạn có thể sửa trước khi xem trước.">
          {headers.length === 0 ? <div className={styles.panelBody}><DashboardState kind="empty" title="Chưa có cột để ánh xạ" description="Chọn tệp CSV hợp lệ để đọc hàng tiêu đề." /></div> : (
            <div className={styles.formGrid}>
              {MAPPING_FIELDS.map(([field, label]) => (
                <label className={styles.formField} key={field}>
                  <span>{label}</span>
                  <select value={mapping[field] || ''} onChange={(event) => setMapping((current) => ({ ...current, [field]: event.target.value || undefined }))}>
                    <option value="">Không ánh xạ</option>
                    {headers.map((header) => <option value={header} key={header}>{header}</option>)}
                  </select>
                </label>
              ))}
              <div className={`${styles.formFull} ${styles.buttonRow}`}>
                <button type="button" className={styles.primaryButton} disabled={!csv || Boolean(busy)} onClick={() => void runPreview()}>
                  <DashboardIcon name="search" size={16} />{busy === 'preview' ? 'Đang kiểm tra' : 'Xem trước và kiểm tra'}
                </button>
              </div>
            </div>
          )}
        </Panel>
      </div>

      {busy === 'preview' && <DashboardState kind="loading" title="Đang kiểm tra CSV" />}

      {preview && (
        <>
          <section className={styles.metrics} aria-label="Tóm tắt nhập CSV">
            <MetricCard icon="list" label="Tổng số dòng" value={preview.totalRows} help={preview.truncated ? 'Bản xem trước đã được giới hạn' : 'Đã đọc trong phạm vi cho phép'} />
            <MetricCard icon="check" label="Dòng hợp lệ" value={preview.validRows} tone="success" help="Có thể đưa vào hàng chờ" />
            <MetricCard icon="warning" label="Dòng lỗi" value={preview.invalidRows} tone={preview.invalidRows ? 'danger' : 'neutral'} help="Được báo riêng, không chặn dòng khác" />
            <MetricCard icon="duplicate" label="Nghi trùng" value={preview.suspectedDuplicates} tone={preview.suspectedDuplicates ? 'warning' : 'neutral'} help={`${preview.creates} mới · ${preview.updates} cập nhật`} />
          </section>

          <Panel
            title="3. Kết quả kiểm tra từng dòng"
            icon="list"
            description={`Hiển thị tối đa ${Math.min(50, visibleRows.length)} dòng trong bản xem trước.`}
            actions={<button type="button" className={styles.primaryButton} disabled={!preview.validRows || Boolean(busy) || Boolean(applyResult)} onClick={() => void applyImport()}>{busy === 'apply' ? 'Đang tạo tác vụ' : 'Nhập các dòng hợp lệ'}</button>}
          >
            <div className={`${styles.notice} ${styles.noticeWarning}`}><DashboardIcon name="warning" size={17} /><span>Áp dụng chỉ tạo tác vụ nền. Không có sản phẩm nào được public hoặc bulk publish từ màn hình này.</span></div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Dòng</th><th>Kết quả</th><th>Hành động</th><th>Dữ liệu nhận diện</th><th>Lỗi / cảnh báo</th></tr></thead>
                <tbody>{visibleRows.map((row) => (
                  <tr key={row.row}>
                    <td data-label="Dòng"><strong>{row.row}</strong></td>
                    <td data-label="Kết quả"><StatusBadge tone={row.valid ? 'success' : 'danger'}>{row.valid ? 'Hợp lệ' : 'Có lỗi'}</StatusBadge></td>
                    <td data-label="Hành động">{row.action === 'create' ? 'Tạo mới' : row.action === 'update' ? 'Cập nhật' : row.action === 'duplicate' ? 'Nghi trùng' : 'Bỏ qua'}</td>
                    <td data-label="Dữ liệu"><strong>{typeof row.normalized?.title === 'string' ? row.normalized.title : 'Chưa nhận diện tên'}</strong><small>{typeof row.normalized?.originalUrl === 'string' ? row.normalized.originalUrl : 'Không có link gốc'}</small></td>
                    <td data-label="Lỗi / cảnh báo">{row.errors.length ? row.errors.join(' · ') : row.warnings.length ? row.warnings.join(' · ') : 'Không có'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </Panel>
        </>
      )}

      {applyResult && (
        <Panel title="Đã đưa vào hàng chờ" icon="queue" description="Bộ xử lý nền sẽ nhập các dòng hợp lệ theo idempotency key của thao tác.">
          <div className={styles.panelBody}>
            <div className={styles.notice}><DashboardIcon name="check" size={18} /><span><strong>Tác vụ đã được ghi nhận.</strong> Trạng thái: {applyResult.status || 'đang chờ xử lý'}. Mã thao tác: {applyResult.operationId || applyResult.jobId}.</span></div>
          </div>
        </Panel>
      )}
      </>}

      {activeTab === 'manual' && (
        <>
          {manualError && <DashboardState kind="error" title="Không thể xử lý URL" description={manualError} />}
          <Panel title="1. Kiểm tra URL an toàn" icon="external" description="SanDeal chỉ kiểm tra định dạng và đích URL. Màn hình này không tải trang, không chạy JavaScript và không scrape website ngoài.">
            <form className={styles.formGrid} onSubmit={(event) => { event.preventDefault(); void previewUrl(); }}>
              <label className={`${styles.formField} ${styles.formFull}`}>
                <span>URL sản phẩm</span>
                <input type="url" required value={manualUrl} placeholder="https://nhaban.example/san-pham" onChange={(event) => { setManualUrl(event.target.value); setManualPreview(null); setManualResult(null); }} />
              </label>
              <div className={`${styles.formFull} ${styles.buttonRow}`}>
                <button type="submit" className={styles.primaryButton} disabled={!manualUrl.trim() || Boolean(manualBusy)}><DashboardIcon name="search" size={16} />{manualBusy === 'preview' ? 'Đang kiểm tra' : 'Kiểm tra URL'}</button>
              </div>
            </form>
          </Panel>

          {manualPreview?.valid && (
            <Panel title="2. Nhập metadata thủ công" icon="content" description="Domain này chưa có adapter URL. Chỉ sau khi bạn nhập metadata và xác nhận, SanDeal mới lưu một nguồn chờ xử lý nội bộ.">
              <div className={`${styles.notice} ${styles.noticeWarning}`}><DashboardIcon name="warning" size={17} /><span><strong>Không có dữ liệu nào được lấy từ URL.</strong> Nguồn chờ không phải Product, luôn ở trạng thái cần xem xét và không thể xuất hiện trên website công khai.</span></div>
              <form className={styles.formGrid} onSubmit={(event) => { event.preventDefault(); void submitManualSource(); }}>
                <label className={`${styles.formField} ${styles.formFull}`}><span>URL đã kiểm tra</span><input value={manualPreview.normalizedUrl || ''} readOnly /></label>
                <label className={`${styles.formField} ${styles.formFull}`}><span>Tên sản phẩm *</span><input required minLength={3} maxLength={240} value={manualMetadata.title} onChange={(event) => setManualMetadata((current) => ({ ...current, title: event.target.value }))} /></label>
                <label className={styles.formField}><span>Giá gốc</span><input inputMode="decimal" value={manualMetadata.price} onChange={(event) => setManualMetadata((current) => ({ ...current, price: event.target.value }))} /></label>
                <label className={styles.formField}><span>Giá bán</span><input inputMode="decimal" value={manualMetadata.salePrice} onChange={(event) => setManualMetadata((current) => ({ ...current, salePrice: event.target.value }))} /></label>
                <label className={styles.formField}><span>Nền tảng</span><select value={manualMetadata.platform} onChange={(event) => setManualMetadata((current) => ({ ...current, platform: event.target.value }))}><option value="">Tự nhận diện từ URL</option><option value="website">Website</option><option value="shopee">Shopee</option><option value="lazada">Lazada</option><option value="tiktok_shop">TikTok Shop</option><option value="accesstrade">AccessTrade</option><option value="other">Khác</option></select></label>
                <label className={styles.formField}><span>Danh mục</span><input maxLength={120} value={manualMetadata.category} onChange={(event) => setManualMetadata((current) => ({ ...current, category: event.target.value }))} /></label>
                <label className={styles.formField}><span>Thương hiệu</span><input maxLength={120} value={manualMetadata.brand} onChange={(event) => setManualMetadata((current) => ({ ...current, brand: event.target.value }))} /></label>
                <label className={styles.formField}><span>SKU / model</span><input maxLength={120} value={manualMetadata.sku} onChange={(event) => setManualMetadata((current) => ({ ...current, sku: event.target.value }))} /></label>
                <label className={`${styles.formField} ${styles.formFull}`}><span>Link affiliate (nếu đã có)</span><input type="url" value={manualMetadata.affiliateUrl} onChange={(event) => setManualMetadata((current) => ({ ...current, affiliateUrl: event.target.value }))} /></label>
                <label className={`${styles.formField} ${styles.formFull}`}><span>Link ảnh (nếu đã xác minh)</span><input type="url" value={manualMetadata.imageUrl} onChange={(event) => setManualMetadata((current) => ({ ...current, imageUrl: event.target.value }))} /></label>
                <div className={`${styles.formFull} ${styles.buttonRow}`}><button type="submit" className={styles.primaryButton} disabled={!manualMetadata.title.trim() || Boolean(manualBusy) || Boolean(manualResult)}>{manualBusy === 'submit' ? 'Đang lưu nguồn chờ' : 'Xác nhận và lưu nguồn chờ'}</button></div>
              </form>
            </Panel>
          )}

          {manualResult && (
            <Panel title="Đã lưu nguồn chờ xử lý" icon="check" description="Metadata sẽ cần được người quản trị xác minh trước khi tạo hoặc cập nhật Product.">
              <div className={styles.panelBody}><div className={styles.notice}><DashboardIcon name="check" size={18} /><span><strong>{manualResult.source.title}</strong> đã được {manualResult.created ? 'tạo' : 'cập nhật'} dưới dạng nguồn chờ. Mã thao tác: {manualResult.operationId}. Không có tác động public.</span></div></div>
            </Panel>
          )}
        </>
      )}

      {activeTab === 'accesstrade' && (
        <Panel title="Kết nối AccessTrade" icon="source" description="SanDeal chỉ hiển thị trạng thái cấu hình an toàn; token và secret không được gửi tới trình duyệt.">
          {vaultHealth.loading && <div className={styles.panelBody}><DashboardState kind="loading" title="Đang kiểm tra trạng thái kết nối" /></div>}
          {vaultHealth.error && <div className={styles.panelBody}><DashboardState kind="error" description={vaultHealth.error} onRetry={vaultHealth.reload} /></div>}
          {vaultHealth.data && <div className={styles.panelBody}>
            {vaultHealth.data.accessTradeConfigured ? (
              <div className={styles.notice}><DashboardIcon name="check" size={18} /><span><strong>Đã có cấu hình AccessTrade chính.</strong> Trạng thái này chỉ xác nhận credential đã được lưu, không khẳng định API đang hoạt động. Hãy dùng trang Nguồn sản phẩm để kiểm tra và đồng bộ có kiểm soát.</span></div>
            ) : (
              <div className={`${styles.notice} ${styles.noticeWarning}`}><DashboardIcon name="warning" size={18} /><span><strong>Cần thiết lập kết nối.</strong> Chưa có credential AccessTrade chính trong Kết nối bảo mật. SanDeal sẽ không giả lập kết quả hoặc báo đồng bộ thành công.</span></div>
            )}
            <div className={styles.buttonRow}><Link className={styles.secondaryButton} href="/dashboard/token-vault">Mở Kết nối bảo mật</Link><Link className={styles.primaryButton} href="/dashboard/product-sources">Mở Nguồn sản phẩm</Link></div>
          </div>}
        </Panel>
      )}
    </main>
  );
}
