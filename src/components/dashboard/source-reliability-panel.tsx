'use client';

import { useCallback, useEffect, useState } from 'react';
import styles from './source-reliability-panel.module.css';

type Row = {
  id: string; provider: string; campaign: string; affiliateGatewayDomain: string; merchantDomain: string;
  affiliateCircuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN'; merchantCircuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN'; lastSuccessfulProbe?: string; lastFailedProbe?: string;
  reasonCode?: string; nextProbeAt?: string; pending: number; delayed: number; discarded: number;
  quarantined: number; published: number; ingestionSkipped: boolean; ingestionSkipReason?: string;
};
type Diversity = {
  status: 'HEALTHY_DIVERSITY' | 'LIMITED_DIVERSITY' | 'INSUFFICIENT_SOURCE_DIVERSITY' | 'SINGLE_SOURCE' | 'NO_SOURCE';
  discoveredCampaignCount: number;
  discoveredMerchantCount: number;
  eligibleCampaignCount: number;
  eligibleMerchantCount: number;
  healthyCampaignCount: number;
  healthyMerchantCount: number;
  providersChecked: number;
};
type Report = {
  generatedAt: string;
  rows: Row[];
  controls: { maximumPerMerchant: number; maximumPerCampaign: number; pausedDomains: string[]; pausedCampaigns: string[] };
  diversity?: Diversity;
};

function timestamp(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

export function SourceReliabilityPanel() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [controls, setControls] = useState({ maximumPerMerchant: 5, maximumPerCampaign: 15, pausedDomains: '', pausedCampaigns: '' });

  const load = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/automation/source-reliability', { cache: 'no-store' });
      const body = await response.json() as { ok?: boolean; message?: string; data?: Report };
      if (!response.ok || !body.ok || !body.data) throw new Error(body.message || 'Không thể tải trạng thái nguồn.');
      setReport(body.data);
      setControls({
        maximumPerMerchant: body.data.controls.maximumPerMerchant,
        maximumPerCampaign: body.data.controls.maximumPerCampaign,
        pausedDomains: body.data.controls.pausedDomains.join(', '),
        pausedCampaigns: body.data.controls.pausedCampaigns.join(', '),
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không thể tải trạng thái nguồn.'); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const save = async () => {
    if (!confirmed) { setError('Đánh dấu xác nhận trước khi lưu kiểm soát nguồn.'); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/automation/source-reliability', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmed: true,
          maximumPerMerchant: controls.maximumPerMerchant,
          maximumPerCampaign: controls.maximumPerCampaign,
          pausedDomains: controls.pausedDomains.split(',').map(value => value.trim()).filter(Boolean),
          pausedCampaigns: controls.pausedCampaigns.split(',').map(value => value.trim()).filter(Boolean),
        }),
      });
      const body = await response.json() as { ok?: boolean; message?: string };
      if (!response.ok || !body.ok) throw new Error(body.message || 'Không thể lưu kiểm soát nguồn.');
      setConfirmed(false);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không thể lưu kiểm soát nguồn.'); setBusy(false); }
  };

  const skipped = report?.rows.filter(row => row.ingestionSkipped) || [];
  return <section className={`card ${styles.panel}`} aria-labelledby="source-reliability-title">
    <div className={styles.header}>
      <div>
        <h2 id="source-reliability-title">Source Reliability</h2>
        <p>Affiliate gateway và merchant được theo dõi độc lập; URL truy vấn luôn được che giá trị.</p>
        {report?.diversity && (
          <small style={{ display: 'block', marginTop: '0.25rem', color: 'var(--text-secondary)' }}>
            Đa dạng nguồn: <strong>{report.diversity.status}</strong> · {report.diversity.healthyMerchantCount} merchant khỏe mạnh · {report.diversity.discoveredCampaignCount} campaigns
          </small>
        )}
      </div>
      <button type="button" className={`secondary-button ${styles.refresh}`} onClick={() => void load()} disabled={busy}>{busy ? 'Đang tải' : 'Làm mới'}</button>
    </div>
    {skipped.length > 0 && <div className={styles.notice} role="status"><strong>Ingestion đang được bỏ qua:</strong> {skipped.map(row => row.ingestionSkipReason || 'NO_HEALTHY_PRODUCT_SOURCE').join(' · ')}</div>}
    {error && <div className={styles.error} role="alert">{error}</div>}
    <div className={styles.controls}>
      <label>Giới hạn / merchant<input type="number" min={1} max={25} value={controls.maximumPerMerchant} onChange={event => setControls(current => ({ ...current, maximumPerMerchant: Number(event.target.value) }))} /></label>
      <label>Giới hạn / campaign<input type="number" min={1} max={50} value={controls.maximumPerCampaign} onChange={event => setControls(current => ({ ...current, maximumPerCampaign: Number(event.target.value) }))} /></label>
      <label>Domain tạm dừng<input value={controls.pausedDomains} onChange={event => setControls(current => ({ ...current, pausedDomains: event.target.value }))} placeholder="merchant.example, ..." /></label>
      <label>Campaign tạm dừng<input value={controls.pausedCampaigns} onChange={event => setControls(current => ({ ...current, pausedCampaigns: event.target.value }))} placeholder="Tên campaign, ..." /></label>
    </div>
    <div className={styles.controlActions}><label className={styles.confirm}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Xác nhận cập nhật kiểm soát nguồn</label><button type="button" className="primary-button" onClick={() => void save()} disabled={busy || !confirmed}>Lưu kiểm soát</button></div>
    <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Provider / campaign</th><th>Gateway</th><th>Merchant</th><th>Circuit</th><th>Probe gần nhất</th><th>Lý do / cooldown</th><th>Trạng thái record</th></tr></thead><tbody>
      {report?.rows.map(row => <tr key={row.id}><td><strong>{row.provider}</strong><small>{row.campaign}</small></td><td>{row.affiliateGatewayDomain}</td><td>{row.merchantDomain}</td><td><span className={styles.badge} data-state={row.circuitState}>{row.circuitState}</span><small>Gateway {row.affiliateCircuitState} · Merchant {row.merchantCircuitState}</small></td><td>OK {timestamp(row.lastSuccessfulProbe)}<small>Lỗi {timestamp(row.lastFailedProbe)}</small></td><td><strong>{row.reasonCode || '—'}</strong><small>Probe tiếp: {timestamp(row.nextProbeAt)}</small></td><td className={styles.counts}>Chờ {row.pending} · Trễ {row.delayed} · Bỏ {row.discarded}<small>Quarantine {row.quarantined} · Public {row.published}</small></td></tr>)}
      {report && report.rows.length === 0 && <tr><td colSpan={7} className={styles.empty}>Chưa có bằng chứng probe nguồn.</td></tr>}
    </tbody></table></div>
  </section>;
}
