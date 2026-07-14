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
  formatDate,
  formatNumber,
  formatPercent,
  intelligenceStyles as styles,
  useDashboardResource,
} from '@/components/dashboard/intelligence-ui';

type GrowthTrend = { day: string; views: number; clicks: number; ctr?: number };
type RankedClick = { key: string; value: number };
type GrowthResponse = {
  rangeDays: number;
  views: number;
  clicks: number;
  ctr?: number;
  trend: GrowthTrend[];
  topProducts: RankedClick[];
  topSources: RankedClick[];
  topContent: RankedClick[];
  revenueAvailable: false;
};

function ClickChart({ days }: { days: GrowthTrend[] }) {
  if (!days.length) return <DashboardState kind="empty" title="Chưa có xu hướng lượt nhấp" description="Dữ liệu sẽ xuất hiện sau khi có outbound event và tác vụ tổng hợp chạy thành công." />;
  const width = 760;
  const height = 240;
  const pad = 36;
  const max = Math.max(1, ...days.map((day) => day.clicks));
  const coordinate = (value: number, index: number) => ({
    x: pad + (index * (width - pad * 2)) / Math.max(1, days.length - 1),
    y: height - pad - (value / max) * (height - pad * 2),
  });
  const path = days.map((day, index) => {
    const { x, y } = coordinate(day.clicks, index);
    return `${index ? 'L' : 'M'} ${x} ${y}`;
  }).join(' ');
  return (
    <div className={styles.chart}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="click-chart-title click-chart-desc">
        <title id="click-chart-title">Lượt nhấp theo ngày</title>
        <desc id="click-chart-desc">Xu hướng lượt nhấp outbound thực tế đã được tổng hợp theo ngày.</desc>
        {[0, .25, .5, .75, 1].map((step) => <line key={step} className={styles.chartGrid} x1={pad} x2={width - pad} y1={pad + step * (height - pad * 2)} y2={pad + step * (height - pad * 2)} />)}
        <path d={path} className={styles.chartLine} />
        {days.map((day, index) => {
          const point = coordinate(day.clicks, index);
          return <circle className={styles.chartPoint} key={day.day} cx={point.x} cy={point.y} r="4"><title>{formatDate(day.day)}: {formatNumber(day.clicks)} lượt nhấp</title></circle>;
        })}
        <text className={styles.chartLabel} x={pad} y={height - 9}>{formatDate(days[0]?.day)}</text>
        <text className={styles.chartLabel} x={width - pad} y={height - 9} textAnchor="end">{formatDate(days.at(-1)?.day)}</text>
      </svg>
    </div>
  );
}

export default function GrowthPage() {
  const [range, setRange] = useState<1 | 7 | 30>(30);
  const resource = useDashboardResource<GrowthResponse>(`/api/dashboard/growth?days=${range}`);
  const response = resource.data;
  const days = useMemo(() => [...(response?.trend || [])].sort((left, right) => left.day.localeCompare(right.day)), [response]);
  const views = response?.views || 0;
  const clicks = response?.clicks || 0;
  const ctr = views > 0 ? response?.ctr ?? (clicks / views) * 100 : null;
  const products = response?.topProducts || [];
  const sources = response?.topSources || [];
  const content = response?.topContent || [];

  return (
    <main className={styles.page}>
      <DashboardPageHeader
        icon="analytics"
        eyebrow="Tổng quan"
        title="Hiệu quả tăng trưởng"
        description="Theo dõi lượt xem và lượt nhấp đã được ghi nhận. CTR chỉ được tính khi có mẫu số lượt xem thật; SanDeal không suy diễn doanh thu hoặc hoa hồng."
        actions={<button type="button" className={styles.secondaryButton} onClick={resource.reload} disabled={resource.loading}><DashboardIcon name="refresh" size={16} />Làm mới</button>}
        meta={<><StatusBadge tone="success">Không lưu raw IP</StatusBadge><StatusBadge tone="info">Dữ liệu tổng hợp</StatusBadge></>}
      />

      <div className={styles.toolbar}>
        <label className={styles.field}><span>Khoảng thời gian</span><select value={range} onChange={(event) => setRange(Number(event.target.value) as 1 | 7 | 30)}><option value={1}>Hôm nay</option><option value={7}>7 ngày</option><option value={30}>30 ngày</option></select></label>
        <div className={styles.notice}><DashboardIcon name="analytics" size={17} /><span>Không hiển thị doanh thu vì hệ thống chưa có conversion data được xác minh.</span></div>
      </div>

      {resource.loading && !response && <DashboardState kind="loading" title="Đang tải dữ liệu tăng trưởng" />}
      {resource.error && <DashboardState kind="error" description={resource.error} onRetry={resource.reload} />}

      {response && (
        <>
          <section className={styles.metrics} aria-label="Chỉ số tăng trưởng">
            <MetricCard icon="product" label="Lượt xem" value={formatNumber(views)} help="Chỉ số được ghi nhận trong khoảng chọn" />
            <MetricCard icon="external" label="Lượt nhấp" value={formatNumber(clicks)} tone="accent" help="Outbound click event tối thiểu" />
            <MetricCard icon="analytics" label="CTR" value={ctr === null ? 'Chưa đủ dữ liệu' : formatPercent(ctr)} tone={ctr === null ? 'neutral' : 'success'} help={ctr === null ? 'Không chia cho 0' : 'Lượt nhấp / lượt xem'} />
            <MetricCard icon="calendar" label="Khoảng dữ liệu" value={`${response.rangeDays} ngày`} tone="neutral" help="Giới hạn theo lựa chọn hiện tại" />
          </section>

          <Panel title="Xu hướng lượt nhấp" icon="analytics" description="Mỗi điểm là dữ liệu tổng hợp thật theo ngày.">
            <div className={styles.panelBody}><ClickChart days={days} /></div>
          </Panel>

          <div className={styles.threeColumns}>
            <Panel title="Sản phẩm được quan tâm" icon="product">
              <div className={styles.panelBody}>{products.length ? <ol className={styles.plainList}>{products.map((item) => <li key={item.key}><span><Link href={`/dashboard/products/${encodeURIComponent(item.key)}`}>{item.key}</Link> · {formatNumber(item.value)} lượt nhấp</span></li>)}</ol> : <DashboardState kind="empty" title="Chưa có lượt nhấp theo sản phẩm" />}</div>
            </Panel>
            <Panel title="Nguồn có lượt nhấp" icon="source">
              <div className={styles.panelBody}>{sources.length ? <ol className={styles.plainList}>{sources.map((item) => <li key={item.key}><span>{item.key} · {formatNumber(item.value)} lượt nhấp</span></li>)}</ol> : <DashboardState kind="empty" title="Chưa có lượt nhấp theo nguồn" />}</div>
            </Panel>
            <Panel title="Nội dung có lượt nhấp" icon="content">
              <div className={styles.panelBody}>{content.length ? <ol className={styles.plainList}>{content.map((item) => <li key={item.key}><span>{item.key} · {formatNumber(item.value)} lượt nhấp</span></li>)}</ol> : <DashboardState kind="empty" title="Chưa có lượt nhấp theo nội dung" />}</div>
            </Panel>
          </div>

          <Panel title="Dữ liệu theo ngày" icon="calendar" description="CTR từng ngày chỉ hiển thị khi ngày đó có lượt xem.">
            {days.length === 0 ? <div className={styles.panelBody}><DashboardState kind="empty" title="Chưa có dữ liệu tăng trưởng" description="Hãy kiểm tra outbound redirect và tác vụ tổng hợp analytics." actionHref="/dashboard/alerts" actionLabel="Xem cảnh báo" /></div> : (
              <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Ngày</th><th>Lượt xem</th><th>Lượt nhấp</th><th>CTR</th></tr></thead><tbody>{[...days].reverse().map((day) => <tr key={day.day}><td data-label="Ngày"><strong>{formatDate(day.day)}</strong></td><td data-label="Lượt xem">{formatNumber(day.views)}</td><td data-label="Lượt nhấp">{formatNumber(day.clicks)}</td><td data-label="CTR">{day.views > 0 ? formatPercent(day.ctr ?? (day.clicks / day.views) * 100) : 'Chưa đủ dữ liệu'}</td></tr>)}</tbody></table></div>
            )}
          </Panel>
        </>
      )}
    </main>
  );
}
