'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { BotRun, BotTeamStatus } from '@/lib/types';

type ApiEnvelope<T> = {
  ok?: boolean;
  message?: string;
  error?: string;
  data?: T;
};

type ReviewQueueItem = {
  id: string;
  title?: string;
  source?: string;
  platform?: string;
  score?: number;
  linkHealth?: string;
  status?: string;
  kind?: string;
  sourceItemKind?: string;
  publicHidden?: boolean;
};

type SchedulerData = {
  scheduler: {
    enabled: boolean;
    intervalMinutes: number;
    mode: string;
    lastRunAt?: string;
    nextRunAt?: string;
    updatedAt: string;
  };
  lock: {
    isLocked: boolean;
    isExpired: boolean;
    runId?: string | null;
    mode?: string | null;
    startedAt?: string | null;
    expiresAt?: string | null;
  };
};

type OperationLog = {
  id: string;
  runId: string;
  mode: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  summary: Record<string, number | undefined>;
  message?: string;
  error?: string;
};

type BotDefinition = {
  id: string;
  name: string;
  role: string;
  icon: string;
  color: string;
  dep: string;
};

type BotBadge = {
  text: string;
  className: string;
};

const BOTS: BotDefinition[] = [
  {
    id: 'orchestrator',
    name: 'AI Boss Orchestrator',
    role: 'Điều phối toàn bộ quy trình',
    icon: 'AI',
    color: '#a78bfa',
    dep: 'Tự điều phối AutoPilot',
  },
  {
    id: 'source_scout',
    name: 'Source Scout Bot',
    role: 'Tìm sản phẩm thật từ nguồn',
    icon: 'SS',
    color: '#22d3ee',
    dep: 'Cần AccessTrade/local source',
  },
  {
    id: 'deal_hunter',
    name: 'Deal Hunter Bot',
    role: 'Phát hiện deal tiềm năng',
    icon: 'DH',
    color: '#34d399',
    dep: 'Chỉ xử lý sản phẩm thật',
  },
  {
    id: 'product_normalizer',
    name: 'Product Normalizer Bot',
    role: 'Chuẩn hóa dữ liệu sản phẩm',
    icon: 'PN',
    color: '#fbbf24',
    dep: 'Chặn voucher/campaign',
  },
  {
    id: 'image_resolver',
    name: 'Image Resolver Bot',
    role: 'Xử lý và kiểm tra ảnh',
    icon: 'IR',
    color: '#f472b6',
    dep: 'Cần kiểm ảnh lỗi 404',
  },
  {
    id: 'gemini_analyst',
    name: 'Gemini Analyst Bot',
    role: 'Phân tích bằng Gemini AI',
    icon: 'GA',
    color: '#818cf8',
    dep: 'Cần Gemini key nếu dùng AI',
  },
  {
    id: 'deal_scorer',
    name: 'Deal Scoring Bot',
    role: 'Chấm điểm cơ hội',
    icon: 'DS',
    color: '#fb923c',
    dep: 'Sẵn sàng hoạt động',
  },
  {
    id: 'content_review',
    name: 'Content Review Bot',
    role: 'Tạo bài review sản phẩm',
    icon: 'CR',
    color: '#38bdf8',
    dep: 'Không fake trải nghiệm',
  },
  {
    id: 'compliance_guard',
    name: 'Compliance Guard Bot',
    role: 'Kiểm duyệt nội dung an toàn',
    icon: 'CG',
    color: '#f43f5e',
    dep: 'Minh bạch affiliate',
  },
  {
    id: 'link_health',
    name: 'Link Health Bot',
    role: 'Kiểm tra link liên kết',
    icon: 'LH',
    color: '#2dd4bf',
    dep: 'Chặn link lỗi trước public',
  },
  {
    id: 'product_cleanup',
    name: 'Product Cleanup Bot',
    role: 'Dọn sản phẩm lỗi / cũ',
    icon: 'PC',
    color: '#a3e635',
    dep: 'Archive sản phẩm lỗi',
  },
  {
    id: 'content_package',
    name: 'Content Package Bot',
    role: 'Đóng gói nội dung đa nền tảng',
    icon: 'CP',
    color: '#c084fc',
    dep: 'Website/social caption',
  },
  {
    id: 'app_health',
    name: 'App Health Bot',
    role: 'Giám sát sức khỏe hệ thống',
    icon: 'AH',
    color: '#4ade80',
    dep: 'Theo dõi hệ thống',
  },
];

const WORKFLOW_STEPS = [
  {
    number: '1',
    label: 'Kiểm tra token và nguồn dữ liệu',
    status: 'completed',
  },
  {
    number: '2',
    label: 'Quét sản phẩm từ nguồn thật',
    status: 'completed',
  },
  {
    number: '3',
    label: 'Lọc voucher/campaign và chấm điểm',
    status: 'current',
  },
  {
    number: '4',
    label: 'Auto public sản phẩm đạt chuẩn',
    status: 'pending',
  },
  {
    number: '5',
    label: 'Kiểm link, nội dung và dọn lỗi',
    status: 'pending',
  },
] as const;

const AUTOPILOT_BADGES = [
  { label: 'Safe Mode ON', className: 'badge-success' },
  { label: 'Free Only ON', className: 'badge-success' },
  { label: 'AutoPilot ON', className: 'badge-info' },
  { label: 'Safe Publish ON', className: 'badge-success' },
];

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error('API trả về dữ liệu không hợp lệ.');
  }
}

function getStatusValue(status: BotTeamStatus | null, key: string): unknown {
  if (!status || typeof status !== 'object') return undefined;

  return (status as unknown as Record<string, unknown>)[key];
}

function getStatusBool(status: BotTeamStatus | null, key: string, fallback = false): boolean {
  const value = getStatusValue(status, key);

  if (typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'ready'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }

  if (typeof value === 'number') return value > 0;

  return fallback;
}

function getStatusNumber(status: BotTeamStatus | null, key: string): number {
  const value = getStatusValue(status, key);

  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function getBotBadge(botId: string, status: BotTeamStatus | null): BotBadge {
  const hasAccessTrade = getStatusBool(status, 'hasAccessTradePrimaryToken');
  const sourceReady = getStatusBool(status, 'sourceReady') || hasAccessTrade;
  const hasGemini = getStatusBool(status, 'hasGeminiPrimaryToken');
  const linkHealthEnabled = getStatusBool(status, 'linkHealthBotEnabled', true);

  if (botId === 'source_scout') {
    return sourceReady
        ? { text: 'Ready', className: 'badge-success' }
        : { text: 'Needs key', className: 'badge-warning' };
  }

  if (botId === 'gemini_analyst') {
    return hasGemini
        ? { text: 'Ready', className: 'badge-success' }
        : { text: 'Optional key', className: 'badge-warning' };
  }

  if (botId === 'orchestrator') {
    return { text: 'AutoPilot', className: 'badge-info' };
  }

  if (botId === 'link_health') {
    return linkHealthEnabled
        ? { text: 'Ready', className: 'badge-success' }
        : { text: 'Idle', className: 'badge-neutral' };
  }

  if (botId === 'product_normalizer' || botId === 'compliance_guard') {
    return { text: 'Guard ON', className: 'badge-success' };
  }

  return { text: 'Ready', className: 'badge-success' };
}

function getRunBadgeClass(runStatus: string): string {
  if (runStatus === 'completed') return 'badge-success';
  if (runStatus === 'running') return 'badge-info';
  if (runStatus === 'failed') return 'badge-danger';
  return 'badge-warning';
}

function formatDateTime(value: string | number | Date | undefined): string {
  if (!value) return 'Chưa có';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Không rõ';

  return date.toLocaleString('vi-VN');
}

function formatTime(value: string | number | Date | undefined): string {
  if (!value) return 'Chưa có';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Không rõ';

  return date.toLocaleTimeString('vi-VN');
}

function getModeLabel(mode: string): string {
  const labels: Record<string, string> = {
    source_scan: 'Quét nguồn',
    deal_hunt: 'Tìm deal',
    gemini_analysis: 'Gemini analysis',
    content_review: 'Tạo review',
    link_health: 'Kiểm link',
    cleanup: 'Dọn lỗi',
    score_only: 'Chấm điểm',
    full_safe_run: 'AutoPilot đầy đủ',
  };

  return labels[mode] || mode;
}

export default function AIBotsPage() {
  const [status, setStatus] = useState<BotTeamStatus | null>(null);
  const [runs, setRuns] = useState<BotRun[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [runLoading, setRunLoading] = useState(false);
  const [healthCheckLoading, setHealthCheckLoading] = useState(false);
  const [runNowLoading, setRunNowLoading] = useState(false);
  const [schedulerLoading, setSchedulerLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Scheduler & Operations state
  const [schedulerData, setSchedulerData] = useState<SchedulerData | null>(null);
  const [opLogs, setOpLogs] = useState<OperationLog[]>([]);
  const [schedMode, setSchedMode] = useState('full_safe_run');
  const [schedInterval, setSchedInterval] = useState(60);
  const [appHealth, setAppHealth] = useState<Record<string, unknown> | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [statusRes, runsRes] = await Promise.all([
        fetch('/api/ai-bots/status', { cache: 'no-store' }),
        fetch('/api/ai-bots/runs', { cache: 'no-store' }),
      ]);

      if (!statusRes.ok) {
        throw new Error(`Không tải được trạng thái bot. HTTP ${statusRes.status}`);
      }

      if (!runsRes.ok) {
        throw new Error(`Không tải được nhật ký bot. HTTP ${runsRes.status}`);
      }

      const statusPayload = await readJson<ApiEnvelope<BotTeamStatus>>(statusRes);
      const runsPayload = await readJson<ApiEnvelope<BotRun[]>>(runsRes);

      const nextStatus = statusPayload.data ?? null;
      const nextRuns = Array.isArray(runsPayload.data) ? runsPayload.data : [];

      setStatus(nextStatus);
      setRuns(nextRuns);

      const reviewProductCount = getStatusNumber(nextStatus, 'reviewProductCount');

      if (reviewProductCount > 0) {
        const queueRes = await fetch('/api/products?status=needs_review&limit=3', {
          cache: 'no-store',
        });

        if (queueRes.ok) {
          const queuePayload = await readJson<ApiEnvelope<ReviewQueueItem[]>>(queueRes);
          setReviewQueue(Array.isArray(queuePayload.data) ? queuePayload.data : []);
        } else {
          setReviewQueue([]);
        }
      } else {
        setReviewQueue([]);
      }

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được dữ liệu bot.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadScheduler = useCallback(async () => {
    try {
      const [schedRes, logsRes] = await Promise.all([
        fetch('/api/ai-bots/scheduler', { cache: 'no-store' }),
        fetch('/api/ai-bots/logs?limit=50', { cache: 'no-store' }),
      ]);

      if (schedRes.ok) {
        const schedPayload = await readJson<ApiEnvelope<SchedulerData>>(schedRes);
        if (schedPayload.data) {
          setSchedulerData(schedPayload.data);
          setSchedMode(schedPayload.data.scheduler.mode || 'full_safe_run');
          setSchedInterval(schedPayload.data.scheduler.intervalMinutes || 60);
        }
      }

      if (logsRes.ok) {
        const logsPayload = await readJson<ApiEnvelope<OperationLog[]>>(logsRes);
        setOpLogs(Array.isArray(logsPayload.data) ? logsPayload.data : []);
      }
    } catch {
      // Non-critical — scheduler data is optional
    }
  }, []);

  useEffect(() => {
    void loadData();
    void loadScheduler();

    const interval = window.setInterval(() => {
      void loadData();
      void loadScheduler();
    }, 30000);

    return () => window.clearInterval(interval);
  }, [loadData, loadScheduler]);

  const handleRunBot = async (mode: string) => {
    try {
      setRunLoading(true);
      setError(null);
      setSuccessMsg(null);

      const res = await fetch('/api/ai-bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          source: 'all',
          limit: 10,
          costMode: 'safe_free',
          safeMode: true,
          freeOnly: true,
          autoMode: true,
          autoApprove: true,
          autoPublish: true,
          allowPaidAi: false,
        }),
      });

      if (!res.ok) {
        let message = `Không khởi chạy được bot. HTTP ${res.status}`;

        try {
          const payload = await res.json();
          if (payload?.message || payload?.error) {
            message = String(payload.message || payload.error);
          }
        } catch {
          // Keep HTTP fallback message.
        }

        throw new Error(message);
      }

      await loadData();

      setSuccessMsg(
          'Đã khởi chạy AutoPilot. Safe Mode ON, Free Only ON, Safe Publish ON. Chỉ sản phẩm thật đạt chuẩn mới được public.',
      );
      window.setTimeout(() => setSuccessMsg(null), 4200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không khởi chạy được bot.');
    } finally {
      setRunLoading(false);
    }
  };

  const handleHealthCheck = async () => {
    try {
      setHealthCheckLoading(true);
      setError(null);
      setSuccessMsg(null);

      const res = await fetch('/api/products/health-check', {
        method: 'POST',
      });

      if (!res.ok) {
        let message = `Health check thất bại. HTTP ${res.status}`;
        try {
          const payload = await res.json();
          if (payload?.message || payload?.error) {
            message = String(payload.message || payload.error);
          }
        } catch { /* keep fallback */ }
        throw new Error(message);
      }

      const payload = await res.json();
      const data = payload?.data;

      await loadData();

      const msg = data
        ? `Health check xong: ${data.checked ?? 0} kiểm tra, ${data.healthy ?? 0} khỏe, ${data.hidden ?? 0} ẩn, ${data.linkBroken ?? 0} link lỗi, ${data.imageBroken ?? 0} ảnh lỗi.`
        : 'Health check hoàn tất.';

      setSuccessMsg(msg);
      window.setTimeout(() => setSuccessMsg(null), 8000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Health check thất bại.');
    } finally {
      setHealthCheckLoading(false);
    }
  };

  // --- Run Now via /api/ai-bots/run-now ---
  const handleRunNow = async (mode: string) => {
    try {
      setRunNowLoading(true);
      setError(null);
      setSuccessMsg(null);

      const res = await fetch('/api/ai-bots/run-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });

      const payload = await res.json();

      if (res.status === 409) {
        setError(payload?.message || 'AutoPilot đang chạy, không thể chạy song song.');
        return;
      }

      if (!res.ok) {
        throw new Error(payload?.message || payload?.error || `HTTP ${res.status}`);
      }

      await Promise.all([loadData(), loadScheduler()]);

      const data = payload?.data;
      const msg = data?.message || 'Đã hoàn tất.';
      setSuccessMsg(msg);
      window.setTimeout(() => setSuccessMsg(null), 8000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể chạy.');
    } finally {
      setRunNowLoading(false);
    }
  };

  // --- Scheduler Config ---
  const handleSaveScheduler = async (updates: Record<string, unknown>) => {
    try {
      setSchedulerLoading(true);
      setError(null);

      const res = await fetch('/api/ai-bots/scheduler', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      const payload = await res.json();

      if (!res.ok) {
        throw new Error(payload?.error || `HTTP ${res.status}`);
      }

      await loadScheduler();
      setSuccessMsg(payload?.message || 'Đã cập nhật lịch.');
      window.setTimeout(() => setSuccessMsg(null), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể cập nhật lịch.');
    } finally {
      setSchedulerLoading(false);
    }
  };

  const hasAccessTrade = getStatusBool(status, 'hasAccessTradePrimaryToken');
  const hasGemini = getStatusBool(status, 'hasGeminiPrimaryToken');
  const productCount = getStatusNumber(status, 'productCount');
  const approvedProductCount = getStatusNumber(status, 'approvedProductCount');
  const reviewProductCount = getStatusNumber(status, 'reviewProductCount');
  const brokenLinkCount = getStatusNumber(status, 'brokenLinkCount');
  const lastRunStartedAt = runs[0]?.startedAt;
  const latestRun = runs[0];
  const isRunning = runLoading || runNowLoading || runs.some((run) => run.status === 'running');

  if (loading) {
    return (
        <div className="empty-state">
          <div className="spinner" />
          <h2 className="empty-state-title">Đang tải AI Command Center...</h2>
          <p className="empty-state-desc">
            Hệ thống đang kiểm tra trạng thái bot, nguồn dữ liệu và nhật ký chạy gần nhất.
          </p>
        </div>
    );
  }

  return (
      <>
        {error && (
            <div className="card" style={{ marginBottom: 'var(--space-lg)' }}>
              <div className="badge badge-danger" style={{ marginBottom: 'var(--space-sm)' }}>
                Lỗi hệ thống
              </div>
              <p style={{ color: 'var(--color-danger)', fontSize: 'var(--text-sm)' }}>{error}</p>
            </div>
        )}

        {successMsg && (
            <div className="card" style={{ marginBottom: 'var(--space-lg)' }}>
              <div className="badge badge-success" style={{ marginBottom: 'var(--space-sm)' }}>
                Thành công
              </div>
              <p style={{ color: 'var(--color-success)', fontSize: 'var(--text-sm)' }}>
                {successMsg}
              </p>
            </div>
        )}

        <section className="command-hero">
          <div className="command-hero-content">
            <div className="badge badge-purple" style={{ marginBottom: 'var(--space-md)' }}>
              ReviewPilot AI AutoPilot Command Center
            </div>

            <h1 className="page-title">AI Command Center SanDeal</h1>

            <p className="page-subtitle" style={{ maxWidth: 660 }}>
              Trung tâm điều phối đội bot AI săn deal, kiểm tra nguồn, lọc voucher/campaign,
              chấm điểm và tự public sản phẩm thật đạt chuẩn. Quy trình hiện giữ Safe Mode ON,
              Free Only ON, AutoPilot ON và Safe Publish ON.
            </p>

            <div className="flex gap-sm" style={{ flexWrap: 'wrap', marginTop: 'var(--space-md)' }}>
              {AUTOPILOT_BADGES.map((badge) => (
                  <span key={badge.label} className={`badge ${badge.className}`}>
                {badge.label}
              </span>
              ))}
            </div>

            <div className="flex gap-sm" style={{ flexWrap: 'wrap', marginTop: 'var(--space-lg)' }}>
              <button
                  type="button"
                  className="primary-button"
                  onClick={() => void handleRunBot('full_safe_run')}
                  disabled={isRunning}
              >
                {isRunning ? 'AutoPilot đang chạy...' : 'Chạy AutoPilot toàn bộ'}
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('source_scan')}
                  disabled={isRunning}
              >
                Quét nguồn & tự public an toàn
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('content_review')}
                  disabled={isRunning}
              >
                Tạo bài review
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('link_health')}
                  disabled={isRunning}
              >
                Kiểm tra link
              </button>
            </div>
          </div>

          <div className="command-hero-panel">
            <div className="card" style={{ minWidth: 280 }}>
              <div className="detail-meta">
                <div className="detail-meta-row">
                  <span>Trạng thái hệ thống</span>
                  <span style={{ color: 'var(--color-success)' }}>Sẵn sàng</span>
                </div>

                <div className="detail-meta-row">
                  <span>Chế độ tự động</span>
                  <span style={{ color: 'var(--color-success)' }}>AutoPilot ON</span>
                </div>

                <div className="detail-meta-row">
                  <span>Public an toàn</span>
                  <span style={{ color: 'var(--color-success)' }}>Safe Publish ON</span>
                </div>

                <div className="detail-meta-row">
                  <span>Quy trình gần nhất</span>
                  <span>{formatTime(lastRunStartedAt)}</span>
                </div>

                <div className="detail-meta-row">
                  <span>Run gần nhất</span>
                  <span>{latestRun ? getModeLabel(latestRun.mode) : 'Chưa có'}</span>
                </div>

                <div className="detail-meta-row">
                  <span>Nguồn đang hoạt động</span>
                  <span>{hasAccessTrade ? 'AccessTrade' : 'Local/Demo'}</span>
                </div>

                <div className="detail-meta-row">
                  <span>Sản phẩm chờ xử lý</span>
                  <span style={{ color: 'var(--color-warning)' }}>{reviewProductCount}</span>
                </div>

                <div className="detail-meta-row">
                  <span>Bot cần cấu hình</span>
                  <span style={{ color: hasGemini ? 'var(--color-success)' : 'var(--color-warning)' }}>
                  {hasGemini ? 'Không' : 'Gemini Bot'}
                </span>
                </div>

                <div className="detail-meta-row">
                  <span>Chi phí ước tính</span>
                  <span style={{ color: 'var(--color-success)' }}>0đ</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {productCount === 0 && !hasAccessTrade && (
            <div className="card" style={{ marginBottom: 'var(--space-xl)' }}>
              <div className="badge badge-warning" style={{ marginBottom: 'var(--space-sm)' }}>
                Chưa có nguồn dữ liệu
              </div>
              <p className="page-subtitle">
                Local/VPS chưa có AccessTrade token hoặc chưa có dữ liệu sản phẩm. Hãy kiểm tra Token
                Vault trước khi quét nguồn.
              </p>
            </div>
        )}

        <section style={{ marginBottom: 'var(--space-xl)' }}>
          <h2 className="section-title">AI Boss Plan — Quy trình tự động</h2>

          <div className="workflow-timeline">
            {WORKFLOW_STEPS.map((step) => (
                <div key={step.number} className="workflow-step-card">
                  <div
                      className="workflow-step-num"
                      style={{
                        color:
                            step.status === 'completed'
                                ? 'var(--color-success)'
                                : step.status === 'current'
                                    ? '#ffffff'
                                    : 'var(--text-tertiary)',
                        background:
                            step.status === 'completed'
                                ? 'rgba(16,185,129,0.12)'
                                : step.status === 'current'
                                    ? 'var(--gradient-accent)'
                                    : 'rgba(148,163,184,0.06)',
                        border:
                            step.status === 'completed'
                                ? '1px solid rgba(16,185,129,0.28)'
                                : '1px solid var(--border-primary)',
                      }}
                  >
                    {step.status === 'completed' ? '✓' : step.number}
                  </div>

                  <div className="workflow-step-label">{step.label}</div>

                  {step.status === 'current' && (
                      <div className="badge badge-purple" style={{ marginTop: 8 }}>
                        Đang sẵn sàng
                      </div>
                  )}
                </div>
            ))}
          </div>
        </section>

        <section style={{ marginBottom: 'var(--space-xl)' }}>
          <h2 className="section-title">Đội Bot AI</h2>

          <div
              className="grid"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
          >
            {BOTS.map((bot) => {
              const badge = getBotBadge(bot.id, status);

              return (
                  <div key={bot.id} className="card">
                    <div className="flex items-start gap-md" style={{ marginBottom: 'var(--space-md)' }}>
                      <div
                          style={{
                            display: 'grid',
                            placeItems: 'center',
                            width: 44,
                            height: 44,
                            flexShrink: 0,
                            borderRadius: 'var(--radius-md)',
                            color: bot.color,
                            background: `${bot.color}1A`,
                            fontSize: 13,
                            fontWeight: 900,
                          }}
                      >
                        {bot.icon}
                      </div>

                      <div style={{ minWidth: 0 }}>
                        <h3
                            style={{
                              color: 'var(--text-primary)',
                              fontSize: 'var(--text-sm)',
                              fontWeight: 900,
                              lineHeight: 1.35,
                            }}
                        >
                          {bot.name}
                        </h3>
                        <p
                            style={{
                              color: 'var(--text-secondary)',
                              fontSize: 'var(--text-xs)',
                              lineHeight: 1.45,
                            }}
                        >
                          {bot.role}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-sm">
                      <span className={`badge ${badge.className}`}>{badge.text}</span>
                      <span
                          style={{
                            color: 'var(--text-tertiary)',
                            fontSize: 11,
                            textAlign: 'right',
                          }}
                      >
                    {bot.dep}
                  </span>
                    </div>

                    <div
                        className="grid grid-3"
                        style={{
                          gap: 8,
                          marginTop: 'var(--space-md)',
                          paddingTop: 'var(--space-md)',
                          borderTop: '1px solid var(--border-primary)',
                        }}
                    >
                      {[
                        ['Processed', '—', 'var(--text-primary)'],
                        ['Output', '—', 'var(--text-primary)'],
                        ['Errors', '0', 'var(--color-danger)'],
                      ].map(([label, value, color]) => (
                          <div key={label} className="text-center">
                            <div style={{ color: 'var(--text-tertiary)', fontSize: 10 }}>{label}</div>
                            <div style={{ color, fontSize: 14, fontWeight: 800 }}>{value}</div>
                          </div>
                      ))}
                    </div>
                  </div>
              );
            })}
          </div>
        </section>

        <section style={{ marginBottom: 'var(--space-xl)' }}>
          <h2 className="section-title">Bảng điều khiển quy trình</h2>

          <div className="card">
            <div
                className="grid"
                style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}
            >
              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('source_scan')}
                  disabled={isRunning}
              >
                Quét nguồn sản phẩm
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('deal_hunt')}
                  disabled={isRunning}
              >
                Tìm deal hot
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('gemini_analysis')}
                  disabled={isRunning}
              >
                Phân tích Gemini
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('content_review')}
                  disabled={isRunning}
              >
                Tạo bài review an toàn
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('link_health')}
                  disabled={isRunning}
              >
                Kiểm tra link
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('cleanup')}
                  disabled={isRunning}
              >
                Dọn sản phẩm lỗi
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleHealthCheck()}
                  disabled={isRunning || healthCheckLoading}
                  style={{ borderColor: 'var(--color-warning)' }}
              >
                {healthCheckLoading ? '🩺 Đang kiểm tra...' : '🩺 Kiểm tra sức khỏe SP'}
              </button>

              <button
                  type="button"
                  className="primary-button"
                  onClick={() => void handleRunBot('full_safe_run')}
                  disabled={isRunning}
              >
                {isRunning ? 'Đang xử lý...' : 'Chạy AutoPilot an toàn'}
              </button>
            </div>
          </div>
        </section>

        <section style={{ marginBottom: 'var(--space-xl)' }}>
          <h2 className="section-title">Nhật ký chạy bot</h2>

          {runs.length === 0 ? (
              <div className="empty-state card">
                <h3 className="empty-state-title">Chưa có lượt chạy bot</h3>
                <p className="empty-state-desc">
                  Hãy chạy AutoPilot hoặc quét nguồn để bắt đầu tạo dữ liệu nội bộ.
                </p>
              </div>
          ) : (
              <div className="table-container">
                <table>
                  <thead>
                  <tr>
                    <th>Run ID</th>
                    <th>Mode</th>
                    <th>Status</th>
                    <th>Started</th>
                    <th>Stats</th>
                  </tr>
                  </thead>
                  <tbody>
                  {runs.slice(0, 20).map((run) => (
                      <tr key={run.id}>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                          {run.id.slice(0, 8)}
                        </td>
                        <td>{getModeLabel(run.mode)}</td>
                        <td>
                      <span className={`badge ${getRunBadgeClass(run.status)}`}>
                        {run.status}
                      </span>
                        </td>
                        <td style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                          {formatDateTime(run.startedAt)}
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {run.candidatesFound ?? 0} found, {run.productsSaved ?? 0} saved
                        </td>
                      </tr>
                  ))}
                  </tbody>
                </table>
              </div>
          )}
        </section>

        {/* ===== AutoPilot Scheduler & Operations ===== */}
        <section style={{ marginBottom: 'var(--space-xl)' }}>
          <h2 className="section-title">AutoPilot Scheduler & Operations</h2>

          {/* Scheduler Config Card */}
          <div className="card" style={{ marginBottom: 'var(--space-lg)' }}>
            <div className="flex items-center justify-between gap-md" style={{ marginBottom: 'var(--space-md)' }}>
              <h3 style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 'var(--text-base)' }}>
                Cấu hình lịch tự động
              </h3>
              <span className={`badge ${schedulerData?.scheduler?.enabled ? 'badge-success' : 'badge-neutral'}`}>
                {schedulerData?.scheduler?.enabled ? '🟢 Đang bật' : '⚪ Đang tắt'}
              </span>
            </div>

            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--space-md)', marginBottom: 'var(--space-md)' }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>Chế độ chạy</label>
                <select
                  value={schedMode}
                  onChange={(e) => setSchedMode(e.target.value)}
                  className="form-select"
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13 }}
                >
                  <option value="full_safe_run">Full Safe Run</option>
                  <option value="source_scan">Quét nguồn</option>
                  <option value="health_check">Kiểm tra link/ảnh</option>
                  <option value="cleanup_broken_products">Dọn sản phẩm lỗi</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>Chu kỳ</label>
                <select
                  value={schedInterval}
                  onChange={(e) => setSchedInterval(Number(e.target.value))}
                  className="form-select"
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13 }}
                >
                  <option value={30}>30 phút</option>
                  <option value={45}>45 phút</option>
                  <option value={60}>60 phút</option>
                  <option value={120}>120 phút</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>Lần chạy gần nhất</label>
                <div style={{ fontSize: 13, color: 'var(--text-primary)', padding: '8px 0' }}>
                  {schedulerData?.scheduler?.lastRunAt ? formatDateTime(schedulerData.scheduler.lastRunAt) : '—'}
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>Lần chạy tiếp theo</label>
                <div style={{ fontSize: 13, color: 'var(--text-primary)', padding: '8px 0' }}>
                  {schedulerData?.scheduler?.nextRunAt ? formatDateTime(schedulerData.scheduler.nextRunAt) : '—'}
                </div>
              </div>
            </div>

            {/* Lock status */}
            {schedulerData?.lock?.isLocked && (
              <div style={{ padding: '8px 14px', background: 'rgba(251,191,36,0.1)', borderRadius: 8, border: '1px solid rgba(251,191,36,0.3)', marginBottom: 'var(--space-md)', fontSize: 13 }}>
                ⚠️ Đang chạy: <strong>{schedulerData.lock.mode}</strong> (bắt đầu {schedulerData.lock.startedAt ? formatDateTime(schedulerData.lock.startedAt) : '?'})
              </div>
            )}

            <div className="flex gap-sm" style={{ flexWrap: 'wrap' }}>
              <button
                type="button"
                className="secondary-button btn-sm"
                disabled={schedulerLoading}
                onClick={() => void handleSaveScheduler({ mode: schedMode, intervalMinutes: schedInterval })}
              >
                💾 Lưu cấu hình
              </button>

              {schedulerData?.scheduler?.enabled ? (
                <button
                  type="button"
                  className="secondary-button btn-sm"
                  disabled={schedulerLoading}
                  onClick={() => void handleSaveScheduler({ enabled: false })}
                  style={{ borderColor: 'var(--color-danger, #ef4444)' }}
                >
                  ⏸️ Tắt lịch tự động
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-button btn-sm"
                  disabled={schedulerLoading}
                  onClick={() => void handleSaveScheduler({ enabled: true, mode: schedMode, intervalMinutes: schedInterval })}
                  style={{ borderColor: 'var(--color-success, #10b981)' }}
                >
                  ▶️ Bật lịch tự động
                </button>
              )}
            </div>
          </div>

          {/* Run Now Panel */}
          <div className="card" style={{ marginBottom: 'var(--space-lg)' }}>
            <h3 style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 'var(--text-base)', marginBottom: 'var(--space-md)' }}>
              Chạy thủ công (Run Now)
            </h3>

            <div className="flex gap-sm" style={{ flexWrap: 'wrap' }}>
              <button
                type="button"
                className="primary-button"
                disabled={isRunning || runNowLoading}
                onClick={() => void handleRunNow('full_safe_run')}
              >
                {runNowLoading ? '⏳ Đang chạy...' : '🚀 Chạy AutoPilot ngay'}
              </button>

              <button
                type="button"
                className="secondary-button"
                disabled={isRunning || runNowLoading}
                onClick={() => void handleRunNow('source_scan')}
              >
                🔍 Quét nguồn ngay
              </button>

              <button
                type="button"
                className="secondary-button"
                disabled={isRunning || runNowLoading}
                onClick={() => void handleRunNow('health_check')}
              >
                🩺 Kiểm tra link/ảnh ngay
              </button>

              <button
                type="button"
                className="secondary-button"
                disabled={isRunning || runNowLoading}
                onClick={() => void handleRunNow('cleanup_broken_products')}
              >
                🧹 Dọn sản phẩm lỗi
              </button>
            </div>
          </div>

          {/* Operation Logs Table */}
          <div className="card">
            <h3 style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 'var(--text-base)', marginBottom: 'var(--space-md)' }}>
              Nhật ký vận hành
            </h3>

            {opLogs.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Chưa có nhật ký vận hành.</p>
            ) : (
              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>Run ID</th>
                      <th>Trigger</th>
                      <th>Mode</th>
                      <th>Status</th>
                      <th>Bắt đầu</th>
                      <th>Thời lượng</th>
                      <th>Kết quả</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opLogs.slice(0, 30).map((log) => {
                      const triggerLabels: Record<string, string> = {
                        dashboard: '🖥️ Dashboard',
                        scheduler: '⏰ Scheduler',
                        manual: '👤 Thủ công',
                        api: '🔌 API',
                      };

                      const modeLabels: Record<string, string> = {
                        full_safe_run: 'Full Safe Run',
                        source_scan: 'Quét nguồn',
                        health_check: 'Health Check',
                        cleanup_broken_products: 'Cleanup',
                        link_health: 'Link Health',
                        cleanup: 'Cleanup',
                      };

                      const statusBadge: Record<string, string> = {
                        running: 'badge-warning',
                        completed: 'badge-success',
                        failed: 'badge-danger',
                        skipped: 'badge-neutral',
                      };

                      const durationText = typeof log.durationMs === 'number'
                        ? log.durationMs < 1000 ? `${log.durationMs}ms` : `${(log.durationMs / 1000).toFixed(1)}s`
                        : '—';

                      const summaryParts: string[] = [];
                      if (log.summary) {
                        if (log.summary.found) summaryParts.push(`${log.summary.found} tìm`);
                        if (log.summary.saved) summaryParts.push(`${log.summary.saved} lưu`);
                        if (log.summary.checked) summaryParts.push(`${log.summary.checked} check`);
                        if (log.summary.hidden) summaryParts.push(`${log.summary.hidden} ẩn`);
                        if (log.summary.cleaned) summaryParts.push(`${log.summary.cleaned} dọn`);
                        if (log.summary.errors) summaryParts.push(`${log.summary.errors} lỗi`);
                      }
                      if (log.error) summaryParts.push(log.error.slice(0, 40));

                      return (
                        <tr key={log.id}>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                            {log.runId?.slice(0, 8) || '—'}
                          </td>
                          <td style={{ fontSize: 12 }}>{triggerLabels[log.trigger] || log.trigger}</td>
                          <td style={{ fontSize: 12 }}>{modeLabels[log.mode] || log.mode}</td>
                          <td>
                            <span className={`badge ${statusBadge[log.status] || 'badge-neutral'}`}>
                              {log.status}
                            </span>
                          </td>
                          <td style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                            {formatDateTime(log.startedAt)}
                          </td>
                          <td style={{ fontSize: 12 }}>{durationText}</td>
                          <td style={{ fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {summaryParts.join(', ') || log.message || '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* ===== Production Readiness ===== */}
        <section style={{ marginBottom: 'var(--space-xl)' }}>
          <h2 className="section-title">Production Readiness</h2>

          <div className="card">
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 'var(--space-md)' }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>App Health</div>
                <span className={`badge ${appHealth?.ok ? 'badge-success' : 'badge-neutral'}`}>
                  {appHealth?.ok ? '✅ Online' : '⚪ Chưa kiểm tra'}
                </span>
              </div>

              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>Environment</div>
                <span className="badge badge-neutral">
                  {typeof appHealth?.environment === 'string' ? appHealth.environment : '—'}
                </span>
              </div>

              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>Uptime</div>
                <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                  {typeof appHealth?.uptimeSeconds === 'number'
                    ? appHealth.uptimeSeconds > 3600
                      ? `${Math.floor(appHealth.uptimeSeconds / 3600)}h ${Math.floor((appHealth.uptimeSeconds % 3600) / 60)}m`
                      : `${Math.floor(appHealth.uptimeSeconds / 60)}m`
                    : '—'}
                </span>
              </div>

              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>Scheduler</div>
                <span className={`badge ${schedulerData?.scheduler?.enabled ? 'badge-success' : 'badge-neutral'}`}>
                  {schedulerData?.scheduler?.enabled ? '🟢 Bật' : '⚪ Tắt'}
                </span>
              </div>

              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>Run Lock</div>
                <span className={`badge ${schedulerData?.lock?.isLocked ? 'badge-warning' : 'badge-success'}`}>
                  {schedulerData?.lock?.isLocked ? '🔒 Đang chạy' : '✅ Rảnh'}
                </span>
              </div>

              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>VPS Cron</div>
                <span className="badge badge-neutral" style={{ fontSize: 11 }}>
                  Cần cấu hình thủ công
                </span>
              </div>
            </div>

            <div className="flex gap-sm" style={{ marginTop: 'var(--space-md)', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="secondary-button btn-sm"
                onClick={() => {
                  fetch('/api/health', { cache: 'no-store' })
                    .then(r => r.json())
                    .then(d => { setAppHealth(d); setSuccessMsg('Health check: ' + (d?.ok ? 'OK' : 'Lỗi')); window.setTimeout(() => setSuccessMsg(null), 4000); })
                    .catch(() => setError('Không kết nối được /api/health'));
                }}
              >
                🏥 Kiểm tra trạng thái
              </button>

              <button
                type="button"
                className="secondary-button btn-sm"
                onClick={() => void loadScheduler()}
              >
                🔄 Làm mới
              </button>
            </div>
          </div>
        </section>

        <section style={{ marginBottom: 'var(--space-xl)' }}>
          <div className="flex items-center justify-between gap-md" style={{ marginBottom: 12 }}>
            <h2 className="section-title" style={{ marginBottom: 0 }}>
              Hàng chờ duyệt
            </h2>

            <Link href="/dashboard/products?status=needs_review" className="secondary-button btn-sm">
              Xem tất cả
            </Link>
          </div>

          {reviewProductCount === 0 ? (
              <div className="empty-state card">
                <h3 className="empty-state-title">Chưa có sản phẩm chờ duyệt</h3>
                <p className="empty-state-desc">
                  AutoPilot sẽ tự public sản phẩm thật đạt chuẩn. Voucher/campaign/store offer,
                  item thiếu dữ liệu hoặc không an toàn vẫn được giữ nội bộ để kiểm tra.
                </p>
              </div>
          ) : (
              <div className="card">
                <p className="page-subtitle" style={{ marginBottom: 'var(--space-md)' }}>
                  {reviewProductCount} sản phẩm hoặc item đang chờ kiểm tra trong dashboard.
                </p>

                {reviewQueue.length > 0 ? (
                    <div
                        className="grid"
                        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
                    >
                      {reviewQueue.map((product) => {
                        const scoreLabel =
                            typeof product.score === 'number' ? String(product.score) : 'N/A';
                        const sourceLabel = product.source || product.platform || 'unknown';

                        return (
                            <div key={product.id} className="card">
                              <div className="flex items-start justify-between gap-md">
                                <h3
                                    style={{
                                      color: 'var(--text-primary)',
                                      fontSize: 'var(--text-sm)',
                                      fontWeight: 850,
                                      lineHeight: 1.45,
                                    }}
                                >
                                  {product.title || 'Sản phẩm chưa có tên'}
                                </h3>

                                <span className="badge badge-neutral">{sourceLabel}</span>
                              </div>

                              <div
                                  className="flex gap-sm"
                                  style={{ flexWrap: 'wrap', margin: 'var(--space-md) 0' }}
                              >
                                <span className="badge badge-warning">Điểm: {scoreLabel}</span>
                                <span className="badge badge-neutral">
                          Link: {product.linkHealth || 'Unknown'}
                        </span>
                                <span className="badge badge-info">
                          Status: {product.status || 'needs_review'}
                        </span>
                              </div>

                              <Link
                                  href={`/dashboard/products/${product.id}`}
                                  className="secondary-button btn-sm"
                              >
                                Xem chi tiết
                              </Link>
                            </div>
                        );
                      })}
                    </div>
                ) : (
                    <p className="page-subtitle">
                      Có item chờ duyệt nhưng chưa tải được preview. Vào trang Kết quả bot để xem đầy đủ.
                    </p>
                )}
              </div>
          )}
        </section>

        {status && (
            <section>
              <h2 className="section-title">Tổng quan sản phẩm</h2>

              <div className="grid grid-4" style={{ marginBottom: 'var(--space-md)' }}>
                {[
                  { label: 'Tổng SP', value: productCount, className: 'badge-purple' },
                  { label: 'Đã public/duyệt', value: approvedProductCount, className: 'badge-success' },
                  { label: 'Chờ duyệt', value: reviewProductCount, className: 'badge-warning' },
                  { label: 'Link lỗi', value: brokenLinkCount, className: 'badge-danger' },
                ].map((item) => (
                    <div key={item.label} className="metric-card">
                <span className={`badge ${item.className}`} style={{ alignSelf: 'flex-start' }}>
                  {item.label}
                </span>
                      <div className="stat-card-value">{item.value}</div>
                    </div>
                ))}
              </div>

              <div className="flex gap-sm" style={{ flexWrap: 'wrap' }}>
                <Link href="/dashboard/products" className="secondary-button">
                  Xem tất cả sản phẩm
                </Link>

                <Link href="/dashboard/token-vault" className="secondary-button">
                  Token Vault
                </Link>

                <Link href="/deals" target="_blank" rel="noreferrer" className="primary-button">
                  Xem public site
                </Link>
              </div>
            </section>
        )}
      </>
  );
}