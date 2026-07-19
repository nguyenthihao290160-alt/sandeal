'use client';

import { useMemo, useState } from 'react';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import { DashboardPageHeader, DashboardState, MetricCard, Panel, StatusBadge, dashboardRequest, formatDateTime, intelligenceStyles as styles, useDashboardResource } from '@/components/dashboard/intelligence-ui';

type Incident = {
  id: string; rootCauseKey: string; category: string; severity: string; status: string;
  affectedEntityType: string; affectedCount: number; firstSeenAt: string; lastSeenAt: string;
  lastCheckedAt: string | null; nextEligibleRemediationAt: string | null; remediationAttemptCount: number;
  maxRemediationAttempts: number; humanDecisionRequired: boolean; autoRemediationAllowed: boolean;
  evidenceStatus: string; evidence: { checker: string; checkerVersion: string; checkedAt: string; result: string; affectedCountBefore: number; affectedCountAfter: number; sampleEntityIds: string[] } | null;
};
type Response = { items: Incident[]; pagination: { page: number; pageSize: number; totalItems: number; totalPages: number }; summary: { active: number; critical: number; humanDecision: number; autoFixable: number } };
type Occurrence = { id: string; entityType: string; entityId: string; reasonCode: string; active: boolean; lastSeenAt: string };

const STATUS_LABELS: Record<string, string> = {
  NEW: 'Mới', ACKNOWLEDGED: 'Đã xem', REMEDIATION_QUEUED: 'Đã xếp hàng sửa an toàn', REMEDIATION_RUNNING: 'Đang sửa',
  RECHECK_REQUIRED: 'Cần recheck', RESOLVED: 'Đã xác minh hết lỗi', HUMAN_DECISION_REQUIRED: 'Cần quyết định người quản trị',
  IGNORED: 'Bỏ qua có lý do', EXHAUSTED: 'Hết lượt tự động',
};

export default function AlertsPage() {
  const [page, setPage] = useState(1);
  const resource = useDashboardResource<{ data?: Response } | Response>(`/api/dashboard/alert-incidents?page=${page}&pageSize=20`);
  const response: Response | undefined = resource.data && 'data' in resource.data
    ? resource.data.data
    : resource.data as Response | undefined;
  const [severity, setSeverity] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState('');
  const [occurrences, setOccurrences] = useState<Record<string, Occurrence[]>>({});
  const items = useMemo(() => (response?.items || []).filter(item => (!severity || item.severity === severity) && (!status || item.status === status)), [response, severity, status]);

  async function mutate(body: Record<string, unknown>, method: 'POST' | 'PATCH' = 'PATCH') {
    setBusy(String(body.id || body.action)); setError('');
    try { await dashboardRequest('/api/dashboard/alert-incidents', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); setSelected([]); resource.reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Không thể cập nhật incident.'); }
    finally { setBusy(''); }
  }

  async function toggleDetails(id: string) {
    if (expanded === id) { setExpanded(''); return; }
    setExpanded(id);
    if (occurrences[id]) return;
    try {
      const result = await dashboardRequest<{ items: Occurrence[] }>(`/api/dashboard/alert-incidents?incidentId=${encodeURIComponent(id)}&pageSize=25`);
      setOccurrences(current => ({ ...current, [id]: result.items }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Không thể tải occurrence.'); }
  }

  const selectedIncidents = (response?.items || []).filter(item => selected.includes(item.id));
  const bulkRemediationAllowed = selectedIncidents.length > 0 && selectedIncidents.every(item => item.autoRemediationAllowed && !item.humanDecisionRequired && item.remediationAttemptCount < item.maxRemediationAttempts);

  return <main className={styles.page}>
    <DashboardPageHeader icon="alert" eyebrow="Vận hành" title="Root-Cause Alert Center" description="Mặc định hiển thị incident theo nguyên nhân gốc. REMEDIATION_QUEUED không đồng nghĩa RESOLVED; chỉ recheck PASS với 0 occurrence active mới đóng incident." actions={<><button className={styles.primaryButton} disabled={Boolean(busy)} onClick={() => void mutate({ action: 'synchronize' }, 'POST')}>Đồng bộ incident</button><button className={styles.secondaryButton} onClick={resource.reload}>Làm mới</button></>} />
    {resource.loading && !response && <DashboardState kind="loading" title="Đang tải incidents" />}
    {(resource.error || error) && <DashboardState kind="error" description={resource.error || error} onRetry={resource.reload} />}
    {response && <>
      <section className={styles.metrics}>
        <MetricCard icon="alert" label="Incident active" value={response.summary.active} tone={response.summary.active ? 'warning' : 'success'} />
        <MetricCard icon="emergency" label="Critical" value={response.summary.critical} tone={response.summary.critical ? 'danger' : 'neutral'} />
        <MetricCard icon="approval" label="Cần quyết định" value={response.summary.humanDecision} tone={response.summary.humanDecision ? 'warning' : 'neutral'} />
        <MetricCard icon="task" label="Có thể sửa an toàn" value={response.summary.autoFixable} tone="accent" />
      </section>
      <div className={styles.toolbar}>
        <label className={styles.field}><span>Severity</span><select value={severity} onChange={event => setSeverity(event.target.value)}><option value="">Tất cả</option><option value="critical">Critical</option><option value="important">Important</option><option value="attention">Attention</option><option value="info">Info</option></select></label>
        <label className={styles.field}><span>Status</span><select value={status} onChange={event => setStatus(event.target.value)}><option value="">Tất cả</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button className={styles.secondaryButton} disabled={!selected.length || Boolean(busy)} onClick={() => void mutate({ ids: selected, action: 'acknowledge' })}>Đã xem ({selected.length})</button>
        <button className={styles.secondaryButton} disabled={!bulkRemediationAllowed || Boolean(busy)} onClick={() => selectedIncidents.forEach(item => void mutate({ action: 'queue_remediation', incidentId: item.id }, 'POST'))}>Queue sửa an toàn</button>
      </div>
      <Panel title="Incident groups" icon="alert" description={`${response.pagination.totalItems} root cause; mỗi drill-down tối đa 25 occurrence.`}>
        {!items.length ? <div className={styles.panelBody}><DashboardState kind="empty" title="Không có incident phù hợp" /></div> : <div className={styles.alertList}>{items.map(item => <article className={styles.alertCard} data-severity={item.severity} key={item.id}>
          <label><input type="checkbox" checked={selected.includes(item.id)} onChange={event => setSelected(current => event.target.checked ? [...new Set([...current, item.id])] : current.filter(id => id !== item.id))} /><span className="sr-only">Chọn incident</span></label>
          <span className={styles.alertIcon}><DashboardIcon name="alert" size={19} /></span>
          <div>
            <div className={styles.cardMeta}><StatusBadge tone={item.severity === 'critical' ? 'danger' : 'warning'}>{item.severity}</StatusBadge><StatusBadge>{STATUS_LABELS[item.status] || item.status}</StatusBadge><StatusBadge tone="neutral">{item.affectedCount} đối tượng</StatusBadge>{item.autoRemediationAllowed && <StatusBadge tone="info">Safe auto-fix</StatusBadge>}</div>
            <h3>{item.category}</h3><p className={styles.help}>{item.rootCauseKey}</p>
            <div className={styles.actionDetails}><span>Lần cuối: {formatDateTime(item.lastSeenAt)}</span><span>Attempts: {item.remediationAttemptCount}/{item.maxRemediationAttempts}</span><span>Next retry: {formatDateTime(item.nextEligibleRemediationAt)}</span><span>Evidence: {item.evidenceStatus}</span></div>
            {item.evidence && <div className={styles.notice}><span>{item.evidence.checker}@{item.evidence.checkerVersion} · {item.evidence.result} · {item.evidence.affectedCountBefore} → {item.evidence.affectedCountAfter}</span></div>}
            {expanded === item.id && <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Entity</th><th>Reason</th><th>Active</th><th>Last seen</th></tr></thead><tbody>{(occurrences[item.id] || []).map(occ => <tr key={occ.id}><td>{occ.entityType} · {occ.entityId}</td><td>{occ.reasonCode}</td><td>{occ.active ? 'YES' : 'NO'}</td><td>{formatDateTime(occ.lastSeenAt)}</td></tr>)}</tbody></table></div>}
          </div>
          <div className={styles.cellActions}><button className={styles.textButton} onClick={() => void toggleDetails(item.id)}>{expanded === item.id ? 'Đóng chi tiết' : 'Drill-down'}</button>{item.status === 'NEW' && <button className={styles.textButton} disabled={Boolean(busy)} onClick={() => void mutate({ id: item.id, action: 'acknowledge' })}>Đánh dấu đã xem</button>}{item.autoRemediationAllowed && !item.humanDecisionRequired && <button className={styles.textButton} disabled={Boolean(busy) || item.remediationAttemptCount >= item.maxRemediationAttempts} onClick={() => void mutate({ action: 'queue_remediation', incidentId: item.id }, 'POST')}>Queue sửa an toàn</button>}<button className={styles.textButton} disabled title="Chỉ recheck evidence PASS + 0 occurrence mới được resolved">Resolved cần evidence</button></div>
        </article>)}</div>}
      </Panel>
      <div className={styles.pagination}><button className={styles.secondaryButton} disabled={page <= 1 || Boolean(busy)} onClick={() => setPage(value => Math.max(1, value - 1))}>Trang trước</button><span>Trang {response.pagination.page}/{response.pagination.totalPages}</span><button className={styles.secondaryButton} disabled={page >= response.pagination.totalPages || Boolean(busy)} onClick={() => setPage(value => value + 1)}>Trang sau</button></div>
    </>}
  </main>;
}
