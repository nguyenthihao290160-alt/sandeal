'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import type { AutomationJob, AutomationJobStatus, BotRegistryEntry, ManualTask, ManualTaskFieldSchema } from '@/lib/automation/types';
import styles from '../operations.module.css';
import controlStyles from './control-center.module.css';

type SafeJob = Omit<AutomationJob, 'payload'>;
type Tab = 'overview' | 'runs' | 'plan' | 'manual' | 'quality';
type Envelope<T> = { ok: boolean; code?: string; message: string; data?: T };

const TABS: Array<{ id: Tab; label: string; icon: 'dashboard' | 'queue' | 'task' | 'approval' | 'analytics' }> = [
  { id: 'overview', label: 'Tổng quan', icon: 'dashboard' },
  { id: 'runs', label: 'Lần chạy', icon: 'queue' },
  { id: 'plan', label: 'Execution Plan', icon: 'task' },
  { id: 'manual', label: 'Manual Task Inbox', icon: 'approval' },
  { id: 'quality', label: 'Chất lượng Bot', icon: 'analytics' },
];

const STATUS_LABELS: Record<AutomationJobStatus, string> = {
  PENDING: 'Chờ xử lý', WAITING_APPROVAL: 'Chờ phê duyệt', WAITING_FOR_MANUAL_INPUT: 'Chờ thông tin thủ công', RUNNING: 'Đang xử lý', RETRY_SCHEDULED: 'Chờ chạy lại', SUCCEEDED: 'Đã xử lý', FAILED: 'Thất bại', CANCELLED: 'Đã hủy', BLOCKED: 'Bị chặn', PAUSED: 'Tạm dừng',
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

export function BotControlCenter() {
  const [tab, setTab] = useState<Tab>('overview');
  const [registry, setRegistry] = useState<BotRegistryEntry[]>([]);
  const [jobs, setJobs] = useState<SafeJob[]>([]);
  const [manualTasks, setManualTasks] = useState<ManualTask[]>([]);
  const [providerCapabilities, setProviderCapabilities] = useState({ geminiApi: false, accessTradeApi: false });
  const [selectedJobId, setSelectedJobId] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [manualInput, setManualInput] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [registryResponse, jobsResponse, manualResponse] = await Promise.all([
        fetch('/api/ai-bots', { cache: 'no-store' }),
        fetch('/api/automation/jobs?page=1&pageSize=50', { cache: 'no-store' }),
        fetch('/api/automation/manual-tasks?page=1&pageSize=50', { cache: 'no-store' }),
      ]);
      const registryBody = await registryResponse.json() as Envelope<{ registry: BotRegistryEntry[]; providerCapabilities: { geminiApi: boolean; accessTradeApi: boolean } }>;
      const jobsBody = await jobsResponse.json() as Envelope<{ items: SafeJob[] }>;
      const manualBody = await manualResponse.json() as Envelope<{ items: ManualTask[] }>;
      if (!registryResponse.ok || !registryBody.ok || !registryBody.data) throw new Error(registryBody.message || 'Không thể tải registry.');
      if (!jobsResponse.ok || !jobsBody.ok || !jobsBody.data) throw new Error(jobsBody.message || 'Không thể tải lần chạy.');
      if (!manualResponse.ok || !manualBody.ok || !manualBody.data) throw new Error(manualBody.message || 'Không thể tải công việc thủ công.');
      setRegistry(registryBody.data.registry);
      setProviderCapabilities(registryBody.data.providerCapabilities);
      setJobs(jobsBody.data.items);
      setManualTasks(manualBody.data.items);
      setManualInput({});
      setSelectedJobId(current => current && jobsBody.data?.items.some(job => job.id === current) ? current : jobsBody.data?.items[0]?.id || '');
      setSelectedTaskId(current => current && manualBody.data?.items.some(task => task.id === current) ? current : manualBody.data?.items.find(task => ['WAITING', 'DRAFT', 'REVISION_REQUIRED'].includes(task.status))?.id || '');
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể tải Trung tâm Bot.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selectedJob = jobs.find(job => job.id === selectedJobId) || null;
  const selectedTask = manualTasks.find(task => task.id === selectedTaskId) || null;
  const jobCounts = useMemo(() => ({
    running: jobs.filter(job => job.status === 'RUNNING').length,
    waiting: jobs.filter(job => ['PENDING', 'RETRY_SCHEDULED', 'WAITING_FOR_MANUAL_INPUT'].includes(job.status)).length,
    approval: jobs.filter(job => job.status === 'WAITING_APPROVAL').length,
    failed: jobs.filter(job => ['FAILED', 'BLOCKED'].includes(job.status)).length,
  }), [jobs]);
  const quality = useMemo(() => {
    const finished = jobs.filter(job => ['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(job.status));
    const deterministic = finished.filter(job => ['LOCAL_RULES', 'LOCAL_TEMPLATE', 'SHADOW_MODE'].includes(job.executionMode || ''));
    const withEvidence = finished.filter(job => typeof job.disclosure?.evidenceCoverage === 'number');
    const fallback = finished.filter(job => Boolean(job.disclosure?.fallbackReason));
    const safetyViolations = jobs.filter(job => job.outcomeStatus === 'BLOCKED_BY_SAFETY' || job.lastErrorCode === 'SAFETY_POLICY_BLOCKED').length;
    return { finished, deterministic, withEvidence, fallback, safetyViolations };
  }, [jobs]);

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

  async function jobAction(job: SafeJob, action: 'approve' | 'reject' | 'retry' | 'cancel') {
    const reason = action === 'retry' ? '' : window.prompt(action === 'approve' ? 'Lý do phê duyệt' : action === 'reject' ? 'Lý do từ chối' : 'Lý do hủy', '')?.trim() || '';
    if (action !== 'retry' && reason.length < 5) return;
    setBusy(`${job.id}:${action}`);
    try {
      const response = await fetch(`/api/automation/jobs/${job.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
      const body = await response.json() as Envelope<unknown>;
      if (!response.ok || !body.ok) throw new Error(body.message || 'Không thể cập nhật tác vụ.');
      setMessage({ tone: 'info', text: body.message });
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
    <section className={styles.statusRow} aria-label="Tình trạng hàng đợi"><div className={styles.metric}><span>Đang xử lý</span><strong>{jobCounts.running}</strong></div><div className={styles.metric}><span>Đang chờ</span><strong>{jobCounts.waiting}</strong></div><div className={styles.metric}><span>Chờ phê duyệt</span><strong>{jobCounts.approval}</strong></div><div className={styles.metric}><span>Thất bại hoặc bị chặn</span><strong>{jobCounts.failed}</strong></div></section>
    {message && <div className={`${styles.notice} ${message.tone === 'error' ? styles.errorBox : ''}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</div>}
    <div className={controlStyles.commandBar}><button className={styles.primary} onClick={() => void enqueue('AUTO')} disabled={Boolean(busy)}><DashboardIcon name="scheduler" />Auto chạy thử</button><button className={styles.button} onClick={() => void enqueue('LOCAL_ONLY')} disabled={Boolean(busy)}><DashboardIcon name="worker" />Local chạy thử</button><button className={styles.button} onClick={() => void enqueue('MANUAL_ONLY')} disabled={Boolean(busy)}><DashboardIcon name="approval" />Tạo Manual Task</button>{providerCapabilities.geminiApi && <button className={styles.button} onClick={() => void enqueue('AUTO')} disabled={Boolean(busy)}><DashboardIcon name="ai" />API</button>}</div>
    <nav className={controlStyles.tabs} aria-label="Các khu vực Trung tâm Bot">{TABS.map(item => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined} className={tab === item.id ? controlStyles.activeTab : controlStyles.tab} onClick={() => setTab(item.id)}><DashboardIcon name={item.icon} size={17} />{item.label}</button>)}</nav>

    {tab === 'overview' && <section className={styles.panel}><div className={styles.panelHeader}><h2>Bot Registry</h2><span className={styles.muted}>{registry.length} capability</span></div>{registry.length === 0 ? <div className={styles.empty}>Chưa có registry.</div> : <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Bot</th><th>Loại</th><th>Capability</th><th>Mode mặc định</th><th>Provider</th><th>Rủi ro</th><th>Fallback</th></tr></thead><tbody>{registry.map(bot => <tr key={bot.id}><td><strong className={styles.name}>{bot.name}</strong><span className={styles.muted}>{bot.id} · v{bot.version}</span></td><td>{bot.category}</td><td>{bot.capability}</td><td>{bot.defaultExecutionMode}</td><td>{bot.provider}{bot.modelId ? ` / ${bot.modelId}` : ''}</td><td>{bot.risk}{bot.approvalRequired ? ' · cần duyệt' : ''}</td><td>{bot.fallback.join(', ') || 'Không có'}</td></tr>)}</tbody></table></div>}</section>}

    {tab === 'runs' && <section className={styles.panel}><div className={styles.panelHeader}><h2>Durable jobs</h2><span className={styles.muted}>{jobs.length} lần chạy gần nhất</span></div>{jobs.length === 0 ? <div className={styles.empty}>Chưa có lần chạy.</div> : <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Tác vụ</th><th>Trạng thái</th><th>Mode / provider</th><th>Tiến độ</th><th>Cập nhật</th><th>Thao tác</th></tr></thead><tbody>{jobs.map(job => <tr key={job.id}><td><button className={controlStyles.linkButton} onClick={() => { setSelectedJobId(job.id); setTab('plan'); }}>{job.type}</button><span className={styles.muted}>{job.operationId}</span></td><td><span className={jobTone(job.status)}>{STATUS_LABELS[job.status]}</span>{job.outcomeStatus && <span className={styles.muted}>{job.outcomeStatus}</span>}</td><td>{job.executionMode || 'Chưa chọn'} / {job.disclosure?.provider || 'Chưa có'}{job.disclosure?.fallbackReason && <span className={styles.muted}>Fallback: {job.disclosure.fallbackReason}</span>}</td><td>{job.progress?.total ? `${job.progress.processed}/${job.progress.total}${job.progress.percentage !== undefined ? ` · ${job.progress.percentage}%` : ''}` : 'Chưa có mẫu số'}</td><td>{new Date(job.updatedAt).toLocaleString('vi-VN')}</td><td><div className={styles.actions}>{job.status === 'WAITING_APPROVAL' && <><button className={styles.primary} onClick={() => void jobAction(job, 'approve')} disabled={Boolean(busy)}>Duyệt</button><button className={styles.button} onClick={() => void jobAction(job, 'reject')} disabled={Boolean(busy)}>Từ chối</button></>}{job.status === 'FAILED' && job.attemptCount < job.maxAttempts && <button className={styles.button} onClick={() => void jobAction(job, 'retry')} disabled={Boolean(busy)}>Chạy lại</button>}{['PENDING', 'WAITING_FOR_MANUAL_INPUT', 'RETRY_SCHEDULED', 'PAUSED'].includes(job.status) && <button className={styles.button} onClick={() => void jobAction(job, 'cancel')} disabled={Boolean(busy)}>Hủy</button>}</div></td></tr>)}</tbody></table></div>}</section>}

    {tab === 'plan' && <section className={styles.panel}><div className={styles.panelHeader}><h2>Execution Plan</h2><select aria-label="Chọn lần chạy" value={selectedJobId} onChange={event => setSelectedJobId(event.target.value)}>{jobs.map(job => <option key={job.id} value={job.id}>{job.type} · {job.operationId.slice(0, 12)}</option>)}</select></div>{!selectedJob ? <div className={styles.empty}>Chưa có execution plan.</div> : <div className={controlStyles.planList}>{(selectedJob.executionPlan || []).map(step => <article key={step.id} className={controlStyles.planStep}><div><strong>{step.capability}</strong><span className={jobTone(step.status === 'FAILED' ? 'FAILED' : step.status === 'COMPLETED' ? 'SUCCEEDED' : 'PENDING')}>{step.status}</span></div><p>{step.reason}</p><dl><dt>Phụ thuộc</dt><dd>{step.dependsOn.join(', ') || 'Không có'}</dd><dt>Ghi dự kiến</dt><dd>{step.expectedWrite.join(', ') || 'Không ghi'}</dd><dt>Rủi ro</dt><dd>{step.risk}{step.approvalRequired ? ' · cần duyệt' : ''}</dd><dt>External call</dt><dd>{step.externalCall ? 'Có' : 'Không'}</dd><dt>Fallback</dt><dd>{step.fallback.join(', ') || 'Không có'}</dd></dl></article>)}{!(selectedJob.executionPlan || []).length && <div className={styles.empty}>Job cũ chưa có execution plan.</div>}<div className={controlStyles.disclosure}><strong>Kết quả minh bạch</strong><span>Mode: {selectedJob.disclosure?.executionMode || 'Chưa có'}</span><span>AI requests: {selectedJob.disclosure?.aiRequests ?? 0}</span><span>External requests: {selectedJob.disclosure?.externalRequests ?? 0}</span><span>Evidence coverage: {selectedJob.disclosure?.evidenceCoverage !== undefined ? `${selectedJob.disclosure.evidenceCoverage}%` : 'Chưa có dữ liệu'}</span></div></div>}</section>}

    {tab === 'manual' && <section className={styles.grid}><div className={styles.panel}><div className={styles.panelHeader}><h2>Manual Task Inbox</h2><span className={styles.muted}>{manualTasks.length} công việc</span></div>{manualTasks.length === 0 ? <div className={styles.empty}>Không có công việc thủ công.</div> : <div className={controlStyles.taskList}>{manualTasks.map(task => <button key={task.id} type="button" className={task.id === selectedTaskId ? controlStyles.selectedTask : controlStyles.task} onClick={() => setSelectedTaskId(task.id)}><strong>{task.title}</strong><span>{task.status} · {task.reasonCode}</span><small>{new Date(task.updatedAt).toLocaleString('vi-VN')}</small></button>)}</div>}</div><div className={styles.panel}><div className={styles.panelHeader}><h2>Thông tin cần bổ sung</h2></div>{!selectedTask ? <div className={styles.empty}>Chọn một công việc để xem biểu mẫu.</div> : <div className={controlStyles.manualForm}><p>{selectedTask.instructions.join(' ')}</p>{selectedTask.missingInformation.length > 0 && <div className={styles.notice}>Còn thiếu: {selectedTask.missingInformation.join('; ')}</div>}{selectedTask.expectedInputSchema.fields.map(field => <label key={field.name}>{field.label}{field.required ? ' *' : ''}{field.type === 'boolean' ? <input type="checkbox" checked={inputValue(field, manualInput[field.name]) === true} onChange={event => setManualInput(current => ({ ...current, [field.name]: event.target.checked }))} disabled={!['WAITING', 'DRAFT', 'REVISION_REQUIRED'].includes(selectedTask.status)} /> : field.type === 'string' && field.options ? <select value={String(inputValue(field, manualInput[field.name]))} onChange={event => setManualInput(current => ({ ...current, [field.name]: event.target.value }))}><option value="">Chọn giá trị</option>{field.options.map(option => <option key={option} value={option}>{option}</option>)}</select> : <textarea rows={field.type === 'string_array' ? 4 : 3} value={String(inputValue(field, manualInput[field.name]))} onChange={event => setManualInput(current => ({ ...current, [field.name]: event.target.value }))} disabled={!['WAITING', 'DRAFT', 'REVISION_REQUIRED'].includes(selectedTask.status)} />}</label>)}<button className={styles.primary} onClick={() => void submitManualTask()} disabled={Boolean(busy) || !['WAITING', 'DRAFT', 'REVISION_REQUIRED'].includes(selectedTask.status)}>Kiểm tra và tiếp tục</button></div>}</div></section>}

    {tab === 'quality' && <section className={styles.grid}><div className={styles.panel}><div className={styles.panelHeader}><h2>Chỉ số có mẫu số thật</h2></div><div className={styles.healthList}><div className={styles.healthRow}><span>Deterministic pass</span><strong>{formatRate(quality.deterministic.filter(job => job.status === 'SUCCEEDED').length, quality.deterministic.length)}</strong></div><div className={styles.healthRow}><span>Fallback</span><strong>{formatRate(quality.fallback.length, quality.finished.length)}</strong></div><div className={styles.healthRow}><span>Có evidence coverage</span><strong>{formatRate(quality.withEvidence.length, quality.finished.length)}</strong></div><div className={styles.healthRow}><span>Safety violations</span><strong>{quality.safetyViolations}</strong></div></div></div><div className={styles.panel}><div className={styles.panelHeader}><h2>Metric chưa đủ nền tảng</h2></div><div className={styles.healthList}><div className={styles.healthRow}><span>Human correction rate</span><strong>Chưa có dữ liệu</strong></div><div className={styles.healthRow}><span>Schema-valid rate</span><strong>Chưa có mẫu số</strong></div><div className={styles.healthRow}><span>Unsupported claim rate</span><strong>Chưa có mẫu số</strong></div></div></div></section>}
  </main>;
}
