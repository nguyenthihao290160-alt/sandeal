'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { DashboardIcon } from './dashboard-icon';
import {
  DashboardState,
  MetricCard,
  dashboardRequest,
  formatNumber,
  intelligenceStyles as styles,
} from './intelligence-ui';

type BusinessData = {
  newProducts: number | null;
  qualified: number | null;
  duplicates: number | null;
  averageQuality: number | null;
  featuredDeals: number | null;
  pendingContent: number | null;
  brokenLinks: number | null;
  clicks: number | null;
  unresolvedAlerts: number | null;
  recommendations: number | null;
  unavailable: string[];
};

type OverviewResponse = {
  kpis: {
    newProducts: number;
    qualifiedProducts: number;
    suspectedDuplicates: number;
    averageQualityScore?: number;
    featuredDeals: number;
    pendingContentReview: number;
    brokenLinks: number;
    clicks: number;
    unresolvedAlerts: number;
  };
  charts: {
    productsBySource: Array<{ label: string; value: number }>;
    qualityBands: Array<{ label: string; value: number }>;
    dealBands: Array<{ label: string; value: number }>;
    contentWorkflow: Array<{ label: string; value: number }>;
    alertSeverity: Array<{ label: string; value: number }>;
    priceChanges: Array<{ label: string; value: number }>;
    clicksByDay: Array<{ day: string; clicks: number }>;
  };
};

type ChartItem = { label: string; value: number };

function MiniBarChart({ title, items }: { title: string; items: ChartItem[] }) {
  const visible = [...items].filter((item) => item.value > 0).sort((a, b) => b.value - a.value).slice(0, 8);
  const maximum = Math.max(1, ...visible.map((item) => item.value));
  return (
    <article className={styles.miniChart}>
      <h3>{title}</h3>
      {visible.length ? <ul>{visible.map((item) => (
        <li key={item.label}>
          <span title={item.label}>{item.label}</span>
          <i aria-hidden="true"><b style={{ width: `${Math.max(4, (item.value / maximum) * 100)}%` }} /></i>
          <strong>{formatNumber(item.value)}</strong>
        </li>
      ))}</ul> : <p>Chưa có dữ liệu để vẽ biểu đồ.</p>}
    </article>
  );
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function BusinessOverview() {
  const [data, setData] = useState<BusinessData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [charts, setCharts] = useState<OverviewResponse['charts'] | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    const endpoints = [
      ['/api/dashboard/business-overview', 'business-overview'],
      ['/api/dashboard/recommendations', 'recommendations'],
    ] as const;
    const results = await Promise.allSettled([
      dashboardRequest<OverviewResponse>(endpoints[0][0], { signal }),
      dashboardRequest<unknown>(endpoints[1][0], { signal }),
    ]);
    if (signal?.aborted) return;
    const unavailable = results.flatMap((result, index) => result.status === 'rejected' ? [endpoints[index][1]] : []);
    if (unavailable.length === endpoints.length) {
      setError('Không thể tải tầng thông tin kinh doanh. Dashboard vận hành vẫn tiếp tục hoạt động.');
      setData(null);
      setLoading(false);
      return;
    }

    const overview = results[0].status === 'fulfilled' ? results[0].value : null;
    const recommendationsData = results[1].status === 'fulfilled' ? results[1].value : null;
    const recommendations = Array.isArray(recommendationsData)
      ? recommendationsData.length
      : null;
    const kpis = overview?.kpis;

    setData({
      newProducts: finiteOrNull(kpis?.newProducts),
      qualified: finiteOrNull(kpis?.qualifiedProducts),
      duplicates: finiteOrNull(kpis?.suspectedDuplicates),
      averageQuality: finiteOrNull(kpis?.averageQualityScore),
      featuredDeals: finiteOrNull(kpis?.featuredDeals),
      pendingContent: finiteOrNull(kpis?.pendingContentReview),
      brokenLinks: finiteOrNull(kpis?.brokenLinks),
      clicks: finiteOrNull(kpis?.clicks),
      unresolvedAlerts: finiteOrNull(kpis?.unresolvedAlerts),
      recommendations,
      unavailable,
    });
    setCharts(overview?.charts || null);
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load, refreshKey]);

  return (
    <section className={styles.businessSection} aria-labelledby="business-overview-title">
      <div className={styles.sectionHeader}>
        <div><span className={styles.eyebrow}>Thông tin kinh doanh</span><h2 id="business-overview-title">Tổng quan sản phẩm, nội dung và tăng trưởng</h2><p>Chỉ số lấy từ API quản trị hiện tại; trường chưa được backend tổng hợp hiển thị “Chưa có”.</p></div>
        <div className={styles.headerActions}><Link className={styles.secondaryButton} href="/dashboard/today"><DashboardIcon name="today" size={16} />Việc nên làm</Link><button type="button" className={styles.secondaryButton} disabled={loading} onClick={() => setRefreshKey((value) => value + 1)}><DashboardIcon name="refresh" size={16} />Làm mới</button></div>
      </div>
      {loading && !data && <DashboardState kind="loading" title="Đang tải tổng quan kinh doanh" />}
      {error && <DashboardState kind="error" title="Tầng thông tin kinh doanh chưa khả dụng" description={error} onRetry={() => setRefreshKey((value) => value + 1)} />}
      {data && <>
        {data.unavailable.length > 0 && <div className={styles.notice}><DashboardIcon name="warning" size={17} /><span>Một số nguồn tóm tắt chưa khả dụng: {data.unavailable.join(', ')}. Các chỉ số còn lại vẫn là dữ liệu thật.</span></div>}
        <div className={styles.businessMetrics}>
          <MetricCard icon="import" label="Sản phẩm mới" value={data.newProducts === null ? 'Chưa có' : formatNumber(data.newProducts)} help="Cần mốc thời gian từ backend" />
          <MetricCard icon="check" label="Sản phẩm đủ chuẩn" value={data.qualified === null ? 'Chưa có' : formatNumber(data.qualified)} tone="success" />
          <MetricCard icon="duplicate" label="Nghi trùng" value={data.duplicates === null ? 'Chưa có' : formatNumber(data.duplicates)} tone={data.duplicates ? 'warning' : 'neutral'} />
          <MetricCard icon="health" label="Quality trung bình" value={data.averageQuality === null ? 'Chưa có' : formatNumber(data.averageQuality)} tone="accent" />
          <MetricCard icon="price" label="Deal nổi bật" value={data.featuredDeals === null ? 'Chưa có' : formatNumber(data.featuredDeals)} tone="success" />
          <MetricCard icon="approval" label="Bài chờ kiểm duyệt" value={data.pendingContent === null ? 'Chưa có' : formatNumber(data.pendingContent)} tone={data.pendingContent ? 'warning' : 'neutral'} />
          <MetricCard icon="warning" label="Link lỗi" value={data.brokenLinks === null ? 'Chưa có' : formatNumber(data.brokenLinks)} tone={data.brokenLinks ? 'danger' : 'neutral'} />
          <MetricCard icon="analytics" label="Lượt nhấp hôm nay" value={data.clicks === null ? 'Chưa có' : formatNumber(data.clicks)} tone="accent" />
          <MetricCard icon="alert" label="Cảnh báo chưa xử lý" value={data.unresolvedAlerts === null ? 'Chưa có' : formatNumber(data.unresolvedAlerts)} tone={data.unresolvedAlerts ? 'warning' : 'success'} />
          <MetricCard icon="today" label="Hành động đề xuất" value={data.recommendations === null ? 'Chưa có' : formatNumber(data.recommendations)} tone="primary" />
        </div>
        <details className={styles.businessChartsDetails}>
          <summary><DashboardIcon name="analytics" size={16} /> Xem biểu đồ kinh doanh</summary>
          {charts ? <div className={styles.businessCharts}>
            <MiniBarChart title="Sản phẩm theo nguồn" items={charts.productsBySource} />
            <MiniBarChart title="Chất lượng theo band" items={charts.qualityBands} />
            <MiniBarChart title="Deal Score theo band" items={charts.dealBands} />
            <MiniBarChart title="Nội dung theo workflow" items={charts.contentWorkflow} />
            <MiniBarChart title="Cảnh báo theo mức độ" items={charts.alertSeverity} />
            <MiniBarChart title="Lần thay đổi giá theo ngày" items={charts.priceChanges} />
            <MiniBarChart title="Lượt nhấp theo ngày" items={charts.clicksByDay.map((item) => ({ label: item.day, value: item.clicks }))} />
          </div> : <p className={styles.help}>Backend chưa có dữ liệu biểu đồ.</p>}
        </details>
      </>}
    </section>
  );
}
