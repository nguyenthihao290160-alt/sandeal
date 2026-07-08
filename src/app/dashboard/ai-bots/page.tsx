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
    dep: 'Sẵn sàng hoạt động',
  },
  {
    id: 'source_scout',
    name: 'Source Scout Bot',
    role: 'Tìm sản phẩm từ nguồn',
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
    dep: 'Sẵn sàng hoạt động',
  },
  {
    id: 'product_normalizer',
    name: 'Product Normalizer Bot',
    role: 'Chuẩn hóa dữ liệu sản phẩm',
    icon: 'PN',
    color: '#fbbf24',
    dep: 'Sẵn sàng hoạt động',
  },
  {
    id: 'image_resolver',
    name: 'Image Resolver Bot',
    role: 'Xử lý và kiểm tra ảnh',
    icon: 'IR',
    color: '#f472b6',
    dep: 'Sẵn sàng hoạt động',
  },
  {
    id: 'gemini_analyst',
    name: 'Gemini Analyst Bot',
    role: 'Phân tích bằng Gemini AI',
    icon: 'GA',
    color: '#818cf8',
    dep: 'Cần Gemini key nếu chưa có',
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
    dep: 'Sẵn sàng hoạt động',
  },
  {
    id: 'compliance_guard',
    name: 'Compliance Guard Bot',
    role: 'Kiểm duyệt nội dung an toàn',
    icon: 'CG',
    color: '#f43f5e',
    dep: 'Sẵn sàng hoạt động',
  },
  {
    id: 'link_health',
    name: 'Link Health Bot',
    role: 'Kiểm tra link liên kết',
    icon: 'LH',
    color: '#2dd4bf',
    dep: 'Sẵn sàng kiểm link',
  },
  {
    id: 'product_cleanup',
    name: 'Product Cleanup Bot',
    role: 'Dọn sản phẩm lỗi / cũ',
    icon: 'PC',
    color: '#a3e635',
    dep: 'Sẵn sàng hoạt động',
  },
  {
    id: 'content_package',
    name: 'Content Package Bot',
    role: 'Đóng gói nội dung đa nền tảng',
    icon: 'CP',
    color: '#c084fc',
    dep: 'Sẵn sàng hoạt động',
  },
  {
    id: 'app_health',
    name: 'App Health Bot',
    role: 'Giám sát sức khỏe hệ thống',
    icon: 'AH',
    color: '#4ade80',
    dep: 'Sẵn sàng hoạt động',
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
    label: 'Lọc deal tiềm năng',
    status: 'current',
  },
  {
    number: '4',
    label: 'Tạo nội dung an toàn',
    status: 'pending',
  },
  {
    number: '5',
    label: 'Kiểm link trước khi public',
    status: 'pending',
  },
] as const;

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
        : { text: 'Needs key', className: 'badge-warning' };
  }

  if (botId === 'orchestrator') {
    return { text: 'Ready', className: 'badge-success' };
  }

  if (botId === 'link_health') {
    return linkHealthEnabled
        ? { text: 'Ready', className: 'badge-success' }
        : { text: 'Idle', className: 'badge-neutral' };
  }

  return { text: 'Idle', className: 'badge-neutral' };
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

export default function AIBotsPage() {
  const [status, setStatus] = useState<BotTeamStatus | null>(null);
  const [runs, setRuns] = useState<BotRun[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [runLoading, setRunLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

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

  useEffect(() => {
    void loadData();

    const interval = window.setInterval(() => {
      void loadData();
    }, 30000);

    return () => window.clearInterval(interval);
  }, [loadData]);

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
          autoPublish: false,
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

      setSuccessMsg('Đã khởi chạy bot thành công. Safe Mode ON, Free Only ON, Auto Publish OFF.');
      window.setTimeout(() => setSuccessMsg(null), 3500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không khởi chạy được bot.');
    } finally {
      setRunLoading(false);
    }
  };

  const hasAccessTrade = getStatusBool(status, 'hasAccessTradePrimaryToken');
  const hasGemini = getStatusBool(status, 'hasGeminiPrimaryToken');
  const productCount = getStatusNumber(status, 'productCount');
  const approvedProductCount = getStatusNumber(status, 'approvedProductCount');
  const reviewProductCount = getStatusNumber(status, 'reviewProductCount');
  const brokenLinkCount = getStatusNumber(status, 'brokenLinkCount');
  const lastRunStartedAt = runs[0]?.startedAt;

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
              ReviewPilot AI Command Center
            </div>

            <h1 className="page-title">AI Command Center SanDeal</h1>

            <p className="page-subtitle" style={{ maxWidth: 620 }}>
              Trung tâm điều phối đội bot AI săn deal, tạo nội dung, kiểm link và bảo trì dữ liệu
              sản phẩm. Quy trình hiện giữ Safe Mode ON, Free Only ON và Auto Publish OFF.
            </p>

            <div className="flex gap-sm" style={{ flexWrap: 'wrap', marginTop: 'var(--space-lg)' }}>
              <button
                  type="button"
                  className="primary-button"
                  onClick={() => void handleRunBot('full_safe_run')}
                  disabled={runLoading}
              >
                {runLoading ? 'Đang chạy...' : 'Chạy toàn bộ quy trình an toàn'}
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('source_scan')}
                  disabled={runLoading}
              >
                Quét nguồn
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('content_review')}
                  disabled={runLoading}
              >
                Tạo bài review
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('link_health')}
                  disabled={runLoading}
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
                  <span>Quy trình gần nhất</span>
                  <span>{formatTime(lastRunStartedAt)}</span>
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
                        Chờ chạy
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
                  disabled={runLoading}
              >
                Quét nguồn sản phẩm
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('deal_hunt')}
                  disabled={runLoading}
              >
                Tìm deal hot
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('gemini_analysis')}
                  disabled={runLoading}
              >
                Phân tích Gemini
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('content_review')}
                  disabled={runLoading}
              >
                Tạo bài review an toàn
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('link_health')}
                  disabled={runLoading}
              >
                Kiểm tra link
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRunBot('cleanup')}
                  disabled={runLoading}
              >
                Dọn sản phẩm lỗi
              </button>

              <button
                  type="button"
                  className="primary-button"
                  onClick={() => void handleRunBot('full_safe_run')}
                  disabled={runLoading}
              >
                {runLoading ? 'Đang xử lý...' : 'Chạy toàn bộ an toàn'}
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
                  Hãy chạy quy trình an toàn hoặc quét nguồn để bắt đầu tạo dữ liệu nội bộ.
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
                        <td>{run.mode}</td>
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
                  Hãy kết nối nguồn dữ liệu hoặc chạy Source Scout Bot. Voucher/campaign/store offer vẫn
                  được giữ nội bộ và không public tự động.
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
                  { label: 'Đã duyệt', value: approvedProductCount, className: 'badge-success' },
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
              </div>
            </section>
        )}
      </>
  );
}