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
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
  intelligenceStyles as styles,
  useDashboardResource,
} from '@/components/dashboard/intelligence-ui';
import type { PriceSnapshot, PriceStatistics } from '@/lib/product-intelligence/types';

type ProductOption = { id: string; title: string; currentPrice?: number; price?: number | null; source?: string };
type ProductsResponse = { items: ProductOption[]; pagination?: { totalItems?: number } };
type PriceHistoryResponse = {
  product?: ProductOption;
  selectedProduct?: ProductOption;
  snapshots?: PriceSnapshot[];
  history?: PriceSnapshot[];
  statistics?: PriceStatistics;
  stats?: PriceStatistics;
  updatedAt?: string;
};

function snapshotValue(snapshot: PriceSnapshot): number | null {
  if (Number.isFinite(snapshot.salePrice)) return snapshot.salePrice!;
  if (Number.isFinite(snapshot.price)) return snapshot.price!;
  return null;
}

function PriceChart({ snapshots }: { snapshots: PriceSnapshot[] }) {
  const points = snapshots.map((snapshot) => ({ snapshot, value: snapshotValue(snapshot) })).filter((point): point is { snapshot: PriceSnapshot; value: number } => point.value !== null);
  if (points.length < 2) return <DashboardState kind="empty" title="Chưa đủ điểm để vẽ biểu đồ" description="Cần ít nhất hai snapshot giá hợp lệ. Bảng bên dưới vẫn hiển thị dữ liệu hiện có." />;

  const width = 760;
  const height = 250;
  const pad = 38;
  const min = Math.min(...points.map((point) => point.value));
  const max = Math.max(...points.map((point) => point.value));
  const spread = Math.max(1, max - min);
  const coordinate = (value: number, index: number) => ({
    x: pad + (index * (width - pad * 2)) / Math.max(1, points.length - 1),
    y: height - pad - ((value - min) / spread) * (height - pad * 2),
  });
  const path = points.map((point, index) => {
    const { x, y } = coordinate(point.value, index);
    return `${index ? 'L' : 'M'} ${x} ${y}`;
  }).join(' ');

  return (
    <div className={styles.chart}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="price-chart-title price-chart-desc">
        <title id="price-chart-title">Lịch sử giá do SanDeal ghi nhận</title>
        <desc id="price-chart-desc">Biểu đồ thể hiện giá theo các snapshot nội bộ, không phải giá thấp nhất thị trường.</desc>
        {[0, .25, .5, .75, 1].map((step) => <line key={step} className={styles.chartGrid} x1={pad} x2={width - pad} y1={pad + step * (height - pad * 2)} y2={pad + step * (height - pad * 2)} />)}
        <path d={path} className={styles.chartLine} />
        {points.map((point, index) => {
          const { x, y } = coordinate(point.value, index);
          return <circle key={point.snapshot.id} className={styles.chartPoint} cx={x} cy={y} r="4"><title>{formatDateTime(point.snapshot.capturedAt)}: {formatMoney(point.value, point.snapshot.currency)}</title></circle>;
        })}
        <text className={styles.chartLabel} x={pad} y={height - 10}>{formatDateTime(points[0].snapshot.capturedAt)}</text>
        <text className={styles.chartLabel} x={width - pad} y={height - 10} textAnchor="end">{formatDateTime(points.at(-1)?.snapshot.capturedAt)}</text>
      </svg>
    </div>
  );
}

export default function PriceHistoryPage() {
  const [productId, setProductId] = useState('');
  const productsResource = useDashboardResource<ProductsResponse>('/api/dashboard/products?page=1&pageSize=50&sort=updated_desc');
  const url = productId ? `/api/dashboard/price-history?productId=${encodeURIComponent(productId)}` : null;
  const resource = useDashboardResource<PriceHistoryResponse>(url);
  const data = resource.data;
  const products = productsResource.data?.items || [];
  const selectedProduct = data?.product || data?.selectedProduct || products.find((product) => product.id === productId);
  const snapshots = useMemo(() => [...(data?.snapshots || data?.history || [])].sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt)), [data]);
  const stats = data?.statistics || data?.stats;

  return (
    <main className={styles.page}>
      <DashboardPageHeader
        icon="price"
        eyebrow="Sản phẩm"
        title="Lịch sử giá"
        description="Theo dõi các snapshot giá do SanDeal ghi nhận từ nguồn sản phẩm. Các chỉ số chỉ phản ánh dữ liệu nội bộ, không phải toàn thị trường."
        actions={<button type="button" className={styles.secondaryButton} onClick={() => { productsResource.reload(); resource.reload(); }} disabled={resource.loading || productsResource.loading}><DashboardIcon name="refresh" size={16} />Làm mới</button>}
        meta={<StatusBadge tone="info">Lịch sử do SanDeal ghi nhận</StatusBadge>}
      />

      <div className={styles.toolbar}>
        <label className={`${styles.field} ${styles.fieldGrow}`}><span>Sản phẩm</span><select value={productId} disabled={productsResource.loading} onChange={(event) => setProductId(event.target.value)}><option value="">{productsResource.loading ? 'Đang tải sản phẩm' : products.length ? 'Chọn sản phẩm để xem lịch sử' : 'Chưa có sản phẩm'}</option>{products.map((product) => <option value={product.id} key={product.id}>{product.title}</option>)}</select></label>
        {selectedProduct && <Link className={styles.secondaryButton} href={`/dashboard/products/${encodeURIComponent(selectedProduct.id)}`}>Xem sản phẩm</Link>}
      </div>

      {productsResource.error && <DashboardState kind="error" title="Không thể tải danh sách sản phẩm" description={productsResource.error} onRetry={productsResource.reload} />}
      {resource.loading && !data && <DashboardState kind="loading" title="Đang tải lịch sử giá" />}
      {resource.error && <DashboardState kind="error" description={resource.error} onRetry={resource.reload} />}

      {!productId && !productsResource.loading && !productsResource.error && <DashboardState kind="empty" title={products.length ? 'Chọn sản phẩm để xem lịch sử giá' : 'Chưa có sản phẩm'} description={products.length ? 'API lịch sử giá chỉ được gọi cho đúng sản phẩm đã chọn.' : 'Nhập sản phẩm trước, sau đó tạo snapshot giá qua hàng chờ nền.'} actionHref={products.length ? undefined : '/dashboard/import'} actionLabel={products.length ? undefined : 'Nhập sản phẩm'} />}

      {data && selectedProduct && (
        <>
          <section className={styles.metrics} aria-label="Thống kê giá nội bộ">
            <MetricCard icon="price" label="Giá hiện tại" value={formatMoney(stats?.current ?? selectedProduct.currentPrice ?? selectedProduct.price)} help="Snapshot mới nhất có giá" />
            <MetricCard icon="check" label="Thấp nhất nội bộ" value={formatMoney(stats?.lowest)} tone="success" help="Không phải thấp nhất thị trường" />
            <MetricCard icon="analytics" label="Giá trung bình" value={formatMoney(stats?.average)} tone="accent" help={`${formatNumber(stats?.snapshots)} snapshot`} />
            <MetricCard icon="refresh" label="Số lần thay đổi" value={formatNumber(stats?.changeCount)} tone={stats?.changeCount ? 'warning' : 'neutral'} help={`${formatNumber(stats?.trackingDays)} ngày theo dõi`} />
          </section>

          <Panel title={selectedProduct.title} icon="analytics" description="Biểu đồ chỉ dùng snapshot có giá hợp lệ.">
            <div className={styles.panelBody}>
              {stats?.lastChange !== undefined && <div className={styles.notice}><DashboardIcon name="analytics" size={17} /><span>Thay đổi gần nhất: {formatMoney(stats.lastChange)}{stats.lastChangePercent !== undefined ? ` (${formatPercent(stats.lastChangePercent)})` : ''}.</span></div>}
              <PriceChart snapshots={snapshots} />
            </div>
          </Panel>

          <Panel title="Bảng snapshot giá" icon="list" description={`${snapshots.length} bản ghi trong phạm vi API trả về.`}>
            {snapshots.length === 0 ? <div className={styles.panelBody}><DashboardState kind="empty" title="Chưa có snapshot giá" description="Tạo snapshot qua tác vụ kiểm tra giá; màn hình này không tự gọi nguồn bên ngoài." /></div> : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead><tr><th>Thời điểm</th><th>Giá</th><th>Giá bán</th><th>Tình trạng</th><th>Nguồn</th><th>Mã thao tác</th></tr></thead>
                  <tbody>{[...snapshots].reverse().map((snapshot) => (
                    <tr key={snapshot.id}>
                      <td data-label="Thời điểm">{formatDateTime(snapshot.capturedAt)}</td>
                      <td data-label="Giá">{formatMoney(snapshot.price, snapshot.currency)}</td>
                      <td data-label="Giá bán"><strong>{formatMoney(snapshot.salePrice, snapshot.currency)}</strong></td>
                      <td data-label="Tình trạng"><StatusBadge tone={snapshot.availability === 'available' ? 'success' : snapshot.availability === 'unavailable' ? 'danger' : 'neutral'}>{snapshot.availability === 'available' ? 'Có sẵn' : snapshot.availability === 'unavailable' ? 'Không có sẵn' : 'Chưa rõ'}</StatusBadge></td>
                      <td data-label="Nguồn">{snapshot.source}</td>
                      <td data-label="Mã thao tác"><small>{snapshot.operationId}</small></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </main>
  );
}
