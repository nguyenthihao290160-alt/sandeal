'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import type {
  AutomationJob,
  AutomationJobListItem,
  AutomationJobStatus,
  BotRegistryEntry,
  ManualTask,
  ManualTaskFieldSchema,
} from '@/lib/automation/types';
import styles from '../operations.module.css';
import controlStyles from './control-center.module.css';

type SafeJob = AutomationJobListItem;
type SafeJobDetail = Omit<AutomationJob, 'payload' | 'claimToken' | 'idempotencyKey'>;
type Tab = 'overview' | 'runs' | 'plan' | 'manual' | 'quality';
type Envelope<T> = { ok: boolean; code?: string; message: string; data?: T };
type ResourcePhase = 'idle' | 'loading' | 'refreshing' | 'loaded' | 'empty' | 'error' | 'timeout';

const REQUEST_TIMEOUT_MS = 15_000;
const SLOW_REQUEST_MS = 4_000;

class DashboardRequestTimeoutError extends Error {
  constructor() {
    super('Yêu cầu mất quá nhiều thời gian. Dữ liệu hợp lệ gần nhất vẫn được giữ lại.');
    this.name = 'DashboardRequestTimeoutError';
  }
}

async function fetchEnvelope<T>(url: string, controllers: Set<AbortController>): Promise<Envelope<T>> {
  const controller = new AbortController();
  controllers.add(controller);
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    const body = await response.json() as Envelope<T>;
    if (!response.ok || !body.ok || !body.data) throw new Error(body.message || 'Không thể tải dữ liệu.');
    return body;
  } catch (error) {
    if (timedOut) throw new DashboardRequestTimeoutError();
    throw error;
  } finally {
    window.clearTimeout(timeout);
    controllers.delete(controller);
  }
}

function nextLoadingPhase(current: ResourcePhase): ResourcePhase {
  return ['loaded', 'refreshing', 'empty', 'error', 'timeout'].includes(current) ? 'refreshing' : 'loading';
}

const TABS: Array<{ id: Tab; label: string; icon: 'dashboard' | 'queue' | 'task' | 'approval' | 'analytics' }> = [
  { id: 'overview', label: 'Tổng quan', icon: 'dashboard' },
  { id: 'runs', label: 'Lần chạy', icon: 'queue' },
  { id: 'plan', label: 'Execution Plan', icon: 'task' },
  { id: 'manual', label: 'Manual Task Inbox', icon: 'approval' },
  { id: 'quality', label: 'Chất lượng Bot', icon: 'analytics' },
];

const STATUS_LABELS: Record<AutomationJobStatus, string> = {
  PENDING: 'Chờ xử lý', WAITING_APPROVAL: 'Chờ phê duyệt', WAITING_FOR_MANUAL_INPUT: 'Chờ thông tin thủ công', WAITING_CHILDREN: 'Chờ tác vụ con', RUNNING: 'Đang xử lý', RETRY_SCHEDULED: 'Chờ chạy lại', SUCCEEDED: 'Đã xử lý', FAILED: 'Thất bại', CANCELLED: 'Đã hủy', BLOCKED: 'Bị chặn', PAUSED: 'Tạm dừng',
};

function jobTone(status: AutomationJobStatus): string {
  if (status === 'SUCCEEDED') return `${styles.badge} ${styles.success}`;
  if (['FAILED', 'BLOCKED', 'CANCELLED'].includes(status)) return `${styles.badge} ${styles.error}`;
  if (['RUNNING', 'RETRY_SCHEDULED'].includes(status)) return `${styles.badge} ${styles.info}`;
  return `${styles.badge} ${styles.warning}`;
}

function formatRate(numerator: number, denominator: number): string {
  return denominator > 0 ? `${Math.round((numerator / denominator) * 100)}% (${numerator}/${denominator})` : 'Chưa có dữ liệu';
}

function inputValue(field: ManualTaskFieldSchema, value: unknown): string | boolean {
  if (field.type === 'boolean') return value === true;
  if (field.type === 'string_array') return Array.isArray(value) ? value.join('\n') : String(value || '');
  return String(value ?? '');
}

function TableSkeleton({ label }: { label: string }) {
  return <div className={controlStyles.skeleton} role="status" aria-live="polite" aria-label={label}>
    <span>{label}</span>
    {Array.from({ length: 4 }, (_, index) => <i key={index} aria-hidden="true" />)}
  </div>;
}

function RetryState({ message, onRetry }: { message: string; onRetry(): void }) {
  return <div className={styles.empty} role="alert">
    <strong>Không thể tải dữ liệu</strong>
    <p>{message}</p>
    <button type="button" className={styles.button} onClick={onRetry}>Thử lại</button>
  </div>;
}

export function BotControlCenter() {
  const [tab, setTab] = useState<Tab>('overview');
  const [registry, setRegistry] = useState<BotRegistryEntry[]>([]);
  const [jobs, setJobs] = useState<SafeJob[]>([]);
  const [manualTasks, setManualTasks] = useState<ManualTask[]>([]);
  const [providerCapabilities, setProviderCapabilities] = useState({ geminiApi: false, accessTradeApi: false });
  const [selectedJobId, setSelectedJobId] = useState('');
  const [selectedJobDetail, setSelectedJobDetail] = useState<SafeJobDetail | null>(null);
  const [jobDetailPhase, setJobDetailPhase] = useState<ResourcePhase>('idle');
  const [jobDetailError, setJobDetailError] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [manualInput, setManualInput] = useState<Record<string, unknown>>({});
  const [registryPhase, setRegistryPhase] = useState<ResourcePhase>('idle');
  const [jobsPhase, setJobsPhase] = useState<ResourcePhase>('idle');
  const [manualPhase, setManualPhase] = useState<ResourcePhase>('idle');
  const [resourceErrors, setResourceErrors] = useState({ registry: '', jobs: '', manual: '' });
  const [slowResources, setSlowResources] = useState({ registry: false, jobs: false, manual: false });
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [pendingJobAction, setPendingJobAction] = useState<{ job: SafeJob; action: 'approve' | 'reject' | 'cancel' } | null>(null);
  const [jobActionReason, setJobActionReason] = useState('');
  const requestGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const activeControllers = useRef(new Set<AbortController>());

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    for (const controller of activeControllers.current) controller.abort();
    activeControllers.current.clear();
    setRegistryPhase(nextLoadingPhase);
    setJobsPhase(nextLoadingPhase);
    setManualPhase(nextLoadingPhase);
    setResourceErrors({ registry: '', jobs: '', manual: '' });
    setSlowResources({ registry: false, jobs: false, manual: false });
    const slowTimers = {
      registry: window.setTimeout(() => setSlowResources(current => ({ ...current, registry: true })), SLOW_REQUEST_MS),
      jobs: window.setTimeout(() => setSlowResources(current => ({ ...current, jobs: true })), SLOW_REQUEST_MS),
      manual: window.setTimeout(() => setSlowResources(current => ({ ...current, manual: true })), SLOW_REQUEST_MS),
    };

    const registryRequest = fetchEnvelope<{
      registry: BotRegistryEntry[];
      providerCapabilities: { geminiApi: boolean; accessTradeApi: boolean };
    }>('/api/ai-bots', activeControllers.current)
      .then((body) => {
        if (generation !== requestGeneration.current || !body.data) return;
        setRegistry(body.data.registry);
        setProviderCapabilities(body.data.providerCapabilities);
        setRegistryPhase(body.data.registry.length ? 'loaded' : 'empty');
      })
      .catch((error: unknown) => {
        if (generation !== requestGeneration.current) return;
        setRegistryPhase(error instanceof DashboardRequestTimeoutError ? 'timeout' : 'error');
        setResourceErrors(current => ({
          ...current,
          registry: error instanceof Error ? error.message : 'Không thể tải Bot Registry.',
        }));
      })
      .finally(() => {
        window.clearTimeout(slowTimers.registry);
        if (generation === requestGeneration.current) {
          setSlowResources(current => ({ ...current, registry: false }));
        }
      });

    const jobsRequest = fetchEnvelope<{ items: SafeJob[] }>('/api/automation/jobs?page=1&pageSize=50', activeControllers.current)
      .then((body) => {
        if (generation !== requestGeneration.current || !body.data) return;
        setJobs(body.data.items);
        setJobsPhase(body.data.items.length ? 'loaded' : 'empty');
        setSelectedJobId(current => current && body.data?.items.some(job => job.id === current) ? current : '');
      })
      .catch((error: unknown) => {
        if (generation !== requestGeneration.current) return;
        setJobsPhase(error instanceof DashboardRequestTimeoutError ? 'timeout' : 'error');
        setResourceErrors(current => ({
          ...current,
          jobs: error instanceof Error ? error.message : 'Không thể tải danh sách tác vụ.',
        }));
      })
      .finally(() => {
        window.clearTimeout(slowTimers.jobs);
        if (generation === requestGeneration.current) {
          setSlowResources(current => ({ ...current, jobs: false }));
        }
      });

    const manualRequest = fetchEnvelope<{ items: ManualTask[] }>('/api/automation/manual-tasks?page=1&pageSize=50', activeControllers.current)
      .then((body) => {
        if (generation !== requestGeneration.current || !body.data) return;
        setManualTasks(body.data.items);
        setManualPhase(body.data.items.length ? 'loaded' : 'empty');
        setManualInput({});
        setSelectedTaskId(current => current && body.data?.items.some(task => task.id === current)
          ? current
          : body.data?.items.find(task => ['WAITING', 'DRAFT', 'REVISION_REQUIRED'].includes(task.status))?.id || '');
      })
      .catch((error: unknown) => {
        if (generation !== requestGeneration.current) return;
        setManualPhase(error instanceof DashboardRequestTimeoutError ? 'timeout' : 'error');
        setResourceErrors(current => ({
          ...current,
          manual: error instanceof Error ? error.message : 'Không thể tải công việc thủ công.',
        }));
      })
      .finally(() => {
        window.clearTimeout(slowTimers.manual);
        if (generation === requestGeneration.current) {
          setSlowResources(current => ({ ...current, manual: false }));
        }
      });

    await Promise.allSettled([registryRequest, jobsRequest, manualRequest]);
  }, []);

  useEffect(() => {
    const controllers = activeControllers.current;
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => {
      window.clearTimeout(timer);
      requestGeneration.current += 1;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, [load]);

  const loading = [registryPhase, jobsPhase, manualPhase].some(phase => phase === 'loading' || phase === 'refreshing');
  const jobsHaveResolved = !['idle', 'loading'].includes(jobsPhase);
  const registryCountLabel = registry.length > 0
    ? `${registry.length} capability${registryPhase === 'refreshing' ? ' · đang làm mới' : ''}`
    : ['idle', 'loading', 'refreshing'].includes(registryPhase)
      ? 'Đang tải…'
      : 'Không có dữ liệu gần nhất';
  const selectedTask = manualTasks.find(task => task.id === selectedTaskId) || null;
  const jobCounts = useMemo(() => ({
    running: jobs.filter(job => job.status === 'RUNNING').length,
    waiting: jobs.filter(job => ['PENDING', 'RETRY_SCHEDULED', 'WAITING_FOR_MANUAL_INPUT', 'WAITING_CHILDREN'].includes(job.status)).length,
    approval: jobs.filter(job => job.status === 'WAITING_APPROVAL').length,
    failed: jobs.filter(job => ['FAILED', 'BLOCKED'].includes(job.status)).length,
  }), [jobs]);
  const quality = useMemo(() => {
    const finished = jobs.filter(job => ['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(job.status));
    const deterministic = finished.filter(job => ['LOCAL_RULES', 'LOCAL_TEMPLATE', 'SHADOW_MODE'].includes(job.executionMode || ''));
    const withEvidence = finished.filter(job => typeof job.evidenceCoverage === 'number');
    const fallback = finished.filter(job => job.fallbackUsed);
    const safetyViolations = jobs.filter(job => job.outcomeStatus === 'BLOCKED_BY_SAFETY' || job.lastErrorCode === 'SAFETY_POLICY_BLOCKED').length;
    return { finished, deterministic, withEvidence, fallback, safetyViolations };
  }, [jobs]);

  async function openJobDetail(jobId: string) {
    const generation = ++detailGeneration.current;
    setSelectedJobId(jobId);
    setSelectedJobDetail(null);
    setJobDetailError('');
    setJobDetailPhase('loading');
    setTab('plan');
    try {
      const body = await fetchEnvelope<SafeJobDetail>(`/api/automation/jobs/${encodeURIComponent(jobId)}`, activeControllers.current);
      if (generation !== detailGeneration.current || !body.data) return;
      setSelectedJobDetail(body.data);
      setJobDetailPhase('loaded');
    } catch (error) {
      if (generation !== detailGeneration.current) return;
      setJobDetailPhase(error instanceof DashboardRequestTimeoutError ? 'timeout' : 'error');
      setJobDetailError(error instanceof Error ? error.message : 'Không thể tải chi tiết tác vụ.');
    }
  }

  async function enqueue(mode: 'AUTO' | 'LOCAL_ONLY' | 'MANUAL_ONLY') {
    setBusy(`enqueue:${mode}`);
    setMessage(null);
    const legacyMode = mode === 'MANUAL_ONLY' ? 'gemini_analysis' : 'full_safe_run';
    try {
      const response = await fetch('/api/ai-bots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: legacyMode, requestedExecutionMode: mode, dryRun: mode !== 'MANUAL_ONLY' }) });
      const body = await response.json() as Envelope<unknown>;
      if (!response.ok || !body.ok) throw new Error(body.message || 'Không thể tạo tác vụ.');
      setMessage({ tone: 'info', text: body.message });
      await load();
      setTab('runs');
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể tạo tác vụ.' });
    } finally {
      setBusy('');
    }
  }

  async function jobAction(
    job: SafeJob,
    action: 'approve' | 'reject' | 'retry' | 'cancel',
    requestedReason = '',
  ) {
    const reason = action === 'retry' ? '' : requestedReason.trim();
    if (action !== 'retry' && reason.length < 5) return;
    setBusy(`${job.id}:${action}`);
    try {
      const response = await fetch(`/api/automation/jobs/${job.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
      const body = await response.json() as Envelope<unknown>;
      if (!response.ok || !body.ok) throw new Error(body.message || 'Không thể cập nhật tác vụ.');
      setMessage({ tone: 'info', text: body.message });
      setPendingJobAction(null);
      setJobActionReason('');
      await load();
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể cập nhật tác vụ.' });
    } finally {
      setBusy('');
    }
  }

  async function submitManualTask() {
    if (!selectedTask) return;
    const input = Object.fromEntries(selectedTask.expectedInputSchema.fields.map(field => {
      const value = manualInput[field.name];
      if (field.type === 'number') return [field.name, Number(value)];
      if (field.type === 'string_array') return [field.name, String(value || '').split('\n').map(item => item.trim()).filter(Boolean)];
      return [field.name, value];
    }));
    setBusy(`manual:${selectedTask.id}`);
    try {
      const response = await fetch(`/api/automation/manual-tasks/${selectedTask.id}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
      const body = await response.json() as Envelope<unknown>;
      if (!response.ok || !body.ok) throw new Error(body.message || 'Không thể gửi dữ liệu.');
      setMessage({ tone: 'info', text: body.message });
      await load();
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể gửi dữ liệu.' });
    } finally {
      setBusy('');
    }
  }

  return <main className={styles.page} aria-busy={loading}>
    <header className={styles.header}>
      <div><h1>Trung tâm Bot &amp; Tự động hóa</h1><p>Điều phối durable job, execution mode, checkpoint, phê duyệt và fallback trên một luồng vận hành.</p></div>
      <div className={styles.actions}><button className={styles.button} onClick={() => void load()} disabled={loading} title="Làm mới"><DashboardIcon name="refresh" />Làm mới</button></div>
    </header>
    <section className={styles.statusRow} aria-label="Tình trạng hàng đợi"><div className={styles.metric}><span>Đang xử lý</span><strong>{jobsHaveResolved ? jobCounts.running : '—'}</strong></div><div className={styles.metric}><span>Đang chờ</span><strong>{jobsHaveResolved ? jobCounts.waiting : '—'}</strong></div><div className={styles.metric}><span>Chờ phê duyệt</span><strong>{jobsHaveResolved ? jobCounts.approval : '—'}</strong></div><div className={styles.metric}><span>Thất bại hoặc bị chặn</span><strong>{jobsHaveResolved ? jobCounts.failed : '—'}</strong></div></section>
    {message && <div className={`${styles.notice} ${message.tone === 'error' ? styles.errorBox : ''}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</div>}
    <div className={controlStyles.commandBar}><button className={styles.primary} onClick={() => void enqueue('AUTO')} disabled={Boolean(busy)}><DashboardIcon name="scheduler" />Auto chạy thử</button><button className={styles.button} onClick={() => void enqueue('LOCAL_ONLY')} disabled={Boolean(busy)}><DashboardIcon name="worker" />Local chạy thử</button><button className={styles.button} onClick={() => void enqueue('MANUAL_ONLY')} disabled={Boolean(busy)}><DashboardIcon name="approval" />Tạo Manual Task</button>{providerCapabilities.geminiApi && <button className={styles.button} onClick={() => void enqueue('AUTO')} disabled={Boolean(busy)}><DashboardIcon name="ai" />API</button>}</div>
    <nav className={controlStyles.tabs} aria-label="Các khu vực Trung tâm Bot">{TABS.map(item => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined} className={tab === item.id ? controlStyles.activeTab : controlStyles.tab} onClick={() => setTab(item.id)}><DashboardIcon name={item.icon} size={17} />{item.label}</button>)}</nav>

    {tab === 'overview' && <section className={styles.panel} data-resource-state={registryPhase}>
      <div className={styles.panelHeader}>
        <h2>Bot Registry</h2>
        <span className={styles.muted}>{registryCountLabel}</span>
      </div>
      {(['idle', 'loading'].includes(registryPhase) || (registryPhase === 'refreshing' && registry.length === 0))
        ? <TableSkeleton label={slowResources.registry ? 'Bot Registry đang phản hồi chậm…' : 'Đang tải Bot Registry…'} />
        : (registryPhase === 'error' || registryPhase === 'timeout') && registry.length === 0
          ? <RetryState message={resourceErrors.registry} onRetry={() => void load()} />
          : registryPhase === 'empty'
            ? <div className={styles.empty}>Chưa có capability nào trong registry.</div>
            : <>
              {(registryPhase === 'refreshing' || slowResources.registry) && <div className={controlStyles.refreshNotice} role="status">Đang làm mới registry; dữ liệu hợp lệ gần nhất vẫn được hiển thị.</div>}
              {(registryPhase === 'error' || registryPhase === 'timeout') && <div className={`${styles.notice} ${styles.errorBox}`} role="alert">{resourceErrors.registry} <button type="button" className={styles.button} onClick={() => void load()}>Thử lại</button></div>}
              <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Bot</th><th>Loại</th><th>Capability</th><th>Mode mặc định</th><th>Provider</th><th>Rủi ro</th><th>Fallback</th></tr></thead><tbody>{registry.map(bot => <tr key={bot.id}><td><strong className={styles.name}>{bot.name}</strong><span className={styles.muted}>{bot.id} · v{bot.version}</span></td><td>{bot.category}</td><td>{bot.capability}</td><td>{bot.defaultExecutionMode}</td><td>{bot.provider}{bot.modelId ? ` / ${bot.modelId}` : ''}</td><td>{bot.risk}{bot.approvalRequired ? ' · cần duyệt' : ''}</td><td>{bot.fallback.join(', ') || 'Không có'}</td></tr>)}</tbody></table></div>
            </>}
    </section>}

    {tab === 'runs' && <section className={styles.panel} data-resource-state={jobsPhase}>
      <div className={styles.panelHeader}>
        <h2>Durable jobs</h2>
        <span className={styles.muted}>{jobs.length} lần chạy gần nhất{jobsPhase === 'refreshing' ? ' · đang làm mới' : ''}</span>
      </div>
      {(['idle', 'loading'].includes(jobsPhase) || (jobsPhase === 'refreshing' && jobs.length === 0))
        ? <TableSkeleton label={slowResources.jobs ? 'Máy chủ đang phản hồi chậm…' : 'Đang tải danh sách tác vụ…'} />
        : (jobsPhase === 'error' || jobsPhase === 'timeout') && jobs.length === 0
          ? <RetryState message={resourceErrors.jobs} onRetry={() => void load()} />
          : jobsPhase === 'empty'
            ? <div className={styles.empty}>Chưa có lần chạy nào.</div>
            : <>
              {(jobsPhase === 'refreshing' || slowResources.jobs) && <div className={controlStyles.refreshNotice} role="status">Đang làm mới; bảng hiện tại vẫn là dữ liệu hợp lệ gần nhất.</div>}
              {(jobsPhase === 'error' || jobsPhase === 'timeout') && <div className={`${styles.notice} ${styles.errorBox}`} role="alert">{resourceErrors.jobs} <button type="button" className={styles.button} onClick={() => void load()}>Thử lại</button></div>}
              <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Tác vụ</th><th>Trạng thái</th><th>Mode / provider</th><th>Tiến độ</th><th>Cập nhật</th><th>Thao tác</th></tr></thead><tbody>{jobs.map(job => <tr key={job.id}><td><button className={controlStyles.linkButton} onClick={() => void openJobDetail(job.id)} aria-label={`Mở chi tiết tác vụ ${job.type}`}>{job.type}</button><span className={styles.muted}>Mã {job.id.slice(0, 12)}{job.id.length > 12 ? '…' : ''}</span></td><td><span className={jobTone(job.status)}>{STATUS_LABELS[job.status]}</span>{job.shortStatusReason && <span className={styles.muted}>{job.shortStatusReason}</span>}</td><td>{job.executionMode || job.requestedExecutionMode || 'Chưa chọn'} / {job.provider || 'Chưa có'}{job.fallbackUsed && <span className={styles.muted}>Đã dùng fallback</span>}</td><td>{job.progress?.total ? `${job.progress.processed}/${job.progress.total}${job.progress.percentage !== undefined ? ` · ${job.progress.percentage}%` : ''}` : 'Chưa có mẫu số'}</td><td>{new Date(job.updatedAt).toLocaleString('vi-VN')}</td><td><div className={styles.actions}>{job.status === 'WAITING_APPROVAL' && <><button className={styles.primary} onClick={() => { setPendingJobAction({ job, action: 'approve' }); setJobActionReason(''); }} disabled={Boolean(busy)}>Duyệt</button><button className={styles.button} onClick={() => { setPendingJobAction({ job, action: 'reject' }); setJobActionReason(''); }} disabled={Boolean(busy)}>Từ chối</button></>}{job.status === 'FAILED' && job.attemptCount < job.maxAttempts && <button className={styles.button} onClick={() => void jobAction(job, 'retry')} disabled={Boolean(busy)}>Chạy lại</button>}{['PENDING', 'WAITING_FOR_MANUAL_INPUT', 'RETRY_SCHEDULED', 'PAUSED'].includes(job.status) && <button className={styles.button} onClick={() => { setPendingJobAction({ job, action: 'cancel' }); setJobActionReason(''); }} disabled={Boolean(busy)}>Hủy</button>}</div></td></tr>)}</tbody></table></div>
              {pendingJobAction && <div className={styles.inlineConfirm} role="group" aria-labelledby="job-action-confirm-title">
                <strong id="job-action-confirm-title">{pendingJobAction.action === 'approve' ? 'Xác nhận phê duyệt' : pendingJobAction.action === 'reject' ? 'Xác nhận từ chối' : 'Xác nhận hủy tác vụ'}</strong>
                <span>Nhập lý do ít nhất 5 ký tự. Thao tác được lưu vào nhật ký kiểm soát.</span>
                <input aria-label="Lý do thao tác" value={jobActionReason} onChange={event => setJobActionReason(event.target.value)} autoFocus />
                <div><button type="button" className={styles.button} onClick={() => { setPendingJobAction(null); setJobActionReason(''); }} disabled={Boolean(busy)}>Đóng</button><button type="button" className={styles.primary} onClick={() => void jobAction(pendingJobAction.job, pendingJobAction.action, jobActionReason)} disabled={Boolean(busy) || jobActionReason.trim().length < 5}>Xác nhận</button></div>
              </div>}
            </>}
    </section>}

    {tab === 'plan' && <section className={styles.panel} data-resource-state={jobDetailPhase}>
      <div className={styles.panelHeader}>
        <h2>Execution Plan</h2>
        <select aria-label="Chọn lần chạy để tải chi tiết" value={selectedJobId} onChange={event => void openJobDetail(event.target.value)}>
          <option value="">Chọn một tác vụ</option>
          {jobs.map(job => <option key={job.id} value={job.id}>{job.type} · {job.operationId.slice(0, 12)}</option>)}
        </select>
      </div>
      {jobDetailPhase === 'loading'
        ? <TableSkeleton label="Đang tải chi tiết tác vụ…" />
        : (jobDetailPhase === 'error' || jobDetailPhase === 'timeout')
          ? <RetryState message={jobDetailError} onRetry={() => { if (selectedJobId) void openJobDetail(selectedJobId); }} />
          : !selectedJobDetail
            ? <div className={styles.empty}>Chọn “Mở chi tiết” ở bảng tác vụ để tải execution plan. Danh sách không tải dữ liệu nặng này.</div>
            : <div className={controlStyles.planList}>{(selectedJobDetail.executionPlan || []).map(step => <article key={step.id} className={controlStyles.planStep}><div><strong>{step.capability}</strong><span className={jobTone(step.status === 'FAILED' ? 'FAILED' : step.status === 'COMPLETED' ? 'SUCCEEDED' : 'PENDING')}>{step.status}</span></div><p>{step.reason}</p><dl><dt>Phụ thuộc</dt><dd>{step.dependsOn.join(', ') || 'Không có'}</dd><dt>Ghi dự kiến</dt><dd>{step.expectedWrite.join(', ') || 'Không ghi'}</dd><dt>Rủi ro</dt><dd>{step.risk}{step.approvalRequired ? ' · cần duyệt' : ''}</dd><dt>External call</dt><dd>{step.externalCall ? 'Có' : 'Không'}</dd><dt>Fallback</dt><dd>{step.fallback.join(', ') || 'Không có'}</dd></dl></article>)}{!(selectedJobDetail.executionPlan || []).length && <div className={styles.empty}>Tác vụ cũ chưa có execution plan.</div>}<div className={controlStyles.disclosure}><strong>Kết quả minh bạch</strong><span>Mode: {selectedJobDetail.disclosure?.executionMode || 'Chưa có'}</span><span>AI requests: {selectedJobDetail.disclosure?.aiRequests ?? 0}</span><span>External requests: {selectedJobDetail.disclosure?.externalRequests ?? 0}</span><span>Evidence coverage: {selectedJobDetail.disclosure?.evidenceCoverage !== undefined ? `${selectedJobDetail.disclosure.evidenceCoverage}%` : 'Chưa có dữ liệu'}</span></div></div>}
    </section>}

    {tab === 'manual' && <section className={styles.grid}><div className={styles.panel}><div className={styles.panelHeader}><h2>Manual Task Inbox</h2><span className={styles.muted}>{manualTasks.length} công việc</span></div>{(['idle', 'loading'].includes(manualPhase) || (manualPhase === 'refreshing' && manualTasks.length === 0)) ? <TableSkeleton label={slowResources.manual ? 'Máy chủ đang phản hồi chậm…' : 'Đang tải công việc thủ công…'} /> : (manualPhase === 'error' || manualPhase === 'timeout') && manualTasks.length === 0 ? <RetryState message={resourceErrors.manual} onRetry={() => void load()} /> : manualPhase === 'empty' ? <div className={styles.empty}>Không có công việc thủ công.</div> : <div className={controlStyles.taskList}>{manualTasks.map(task => <button key={task.id} type="button" className={task.id === selectedTaskId ? controlStyles.selectedTask : controlStyles.task} onClick={() => setSelectedTaskId(task.id)}><strong>{task.title}</strong><span>{task.status} · {task.reasonCode}</span><small>{new Date(task.updatedAt).toLocaleString('vi-VN')}</small></button>)}</div>}</div><div className={styles.panel}><div className={styles.panelHeader}><h2>Thông tin cần bổ sung</h2></div>{!selectedTask ? <div className={styles.empty}>Chọn một công việc để xem biểu mẫu.</div> : <div className={controlStyles.manualForm}><p>{selectedTask.instructions.join(' ')}</p>{selectedTask.missingInformation.length > 0 && <div className={styles.notice}>Còn thiếu: {selectedTask.missingInformation.join('; ')}</div>}{selectedTask.expectedInputSchema.fields.map(field => <label key={field.name}>{field.label}{field.required ? ' *' : ''}{field.type === 'boolean' ? <input type="checkbox" checked={inputValue(field, manualInput[field.name]) === true} onChange={event => setManualInput(current => ({ ...current, [field.name]: event.target.checked }))} disabled={!['WAITING', 'DRAFT', 'REVISION_REQUIRED'].includes(selectedTask.status)} /> : field.type === 'string' && field.options ? <select value={String(inputValue(field, manualInput[field.name]))} onChange={event => setManualInput(current => ({ ...current, [field.name]: event.target.value }))}><option value="">Chọn giá trị</option>{field.options.map(option => <option key={option} value={option}>{option}</option>)}</select> : <textarea rows={field.type === 'string_array' ? 4 : 3} value={String(inputValue(field, manualInput[field.name]))} onChange={event => setManualInput(current => ({ ...current, [field.name]: event.target.value }))} disabled={!['WAITING', 'DRAFT', 'REVISION_REQUIRED'].includes(selectedTask.status)} />}</label>)}<button className={styles.primary} onClick={() => void submitManualTask()} disabled={Boolean(busy) || !['WAITING', 'DRAFT', 'REVISION_REQUIRED'].includes(selectedTask.status)}>Kiểm tra và tiếp tục</button></div>}</div></section>}

    {tab === 'quality' && <section className={styles.grid}><div className={styles.panel}><div className={styles.panelHeader}><h2>Chỉ số có mẫu số thật</h2></div><div className={styles.healthList}><div className={styles.healthRow}><span>Deterministic pass</span><strong>{formatRate(quality.deterministic.filter(job => job.status === 'SUCCEEDED').length, quality.deterministic.length)}</strong></div><div className={styles.healthRow}><span>Fallback</span><strong>{formatRate(quality.fallback.length, quality.finished.length)}</strong></div><div className={styles.healthRow}><span>Có evidence coverage</span><strong>{formatRate(quality.withEvidence.length, quality.finished.length)}</strong></div><div className={styles.healthRow}><span>Safety violations</span><strong>{quality.safetyViolations}</strong></div></div></div><div className={styles.panel}><div className={styles.panelHeader}><h2>Metric chưa đủ nền tảng</h2></div><div className={styles.healthList}><div className={styles.healthRow}><span>Human correction rate</span><strong>Chưa có dữ liệu</strong></div><div className={styles.healthRow}><span>Schema-valid rate</span><strong>Chưa có mẫu số</strong></div><div className={styles.healthRow}><span>Unsupported claim rate</span><strong>Chưa có mẫu số</strong></div></div></div></section>}
  </main>;
}
