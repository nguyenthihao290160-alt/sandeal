'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

type RunLog = {
  id: string;
  runId: string;
  mode: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  message?: string;
  error?: string;
  summary?: any;
};

type AutomationState = {
  settings: {
    enabled: boolean;
    sourceScanEnabled: boolean;
    intervalHours: number;
    mode: string;
    maxItemsPerRun: number;
    maxItemsPerDay: number;
  };
  currentStatus: string;
  activeLock: any;
  nextRunAt: string | null;
  dailyUsage: number;
  dailyRemaining: number;
  policy: any;
  recentRuns: RunLog[];
};

export default function AutomationDashboard() {
  const [state, setState] = useState<AutomationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error', message: string } | null>(null);
  const [forceReleasing, setForceReleasing] = useState(false);

  const loadState = useCallback(async () => {
    try {
      const res = await fetch('/api/ai-bots/schedule');
      const data = await res.json();
      if (res.ok) {
        setState(data);
      }
    } catch {
      //
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadState();
    const interval = setInterval(loadState, 15000);
    return () => clearInterval(interval);
  }, [loadState]);

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  };

  const handleToggleEnabled = async () => {
    if (!state) return;
    setSaving(true);
    try {
      const res = await fetch('/api/ai-bots/schedule', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !state.settings.enabled })
      });
      if (res.ok) {
        showToast('success', !state.settings.enabled ? 'Đã bật Scheduler' : 'Đã tắt Scheduler');
        await loadState();
      } else {
        const data = await res.json();
        showToast('error', data.error || 'Lỗi cập nhật');
      }
    } catch {
      showToast('error', 'Lỗi kết nối');
    } finally {
      setSaving(false);
    }
  };

  const handleRunNow = async (mode: string) => {
    setRunning(true);
    try {
      showToast('success', 'Đang khởi chạy AutoPilot...');
      const res = await fetch('/api/ai-bots/run-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast('success', 'AutoPilot hoàn tất');
      } else {
        showToast('error', data.message || data.error || 'Lỗi khi chạy AutoPilot');
      }
      await loadState();
    } catch {
      showToast('error', 'Lỗi kết nối');
    } finally {
      setRunning(false);
    }
  };

  const handleUpdateLimit = async (field: string, value: number) => {
    if (!state) return;
    setSaving(true);
    try {
      const res = await fetch('/api/ai-bots/schedule', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value })
      });
      if (res.ok) {
        showToast('success', 'Đã lưu cấu hình');
        await loadState();
      } else {
        showToast('error', 'Lỗi cấu hình');
      }
    } finally {
      setSaving(false);
    }
  };

  const formatTime = (isoString?: string) => {
    if (!isoString) return '—';
    try {
      const date = new Date(isoString);
      return new Intl.DateTimeFormat('vi-VN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        day: '2-digit', month: '2-digit', year: 'numeric'
      }).format(date);
    } catch {
      return isoString;
    }
  };

  if (loading) {
    return <div className="page-content" style={{ display: 'grid', placeItems: 'center', height: '60vh' }}>Đang tải...</div>;
  }

  return (
    <div className="page-content">
      {toast && (
        <div className="toast-container">
          <div className={`toast toast-${toast.type}`}>{toast.message}</div>
        </div>
      )}

      {/* Hero */}
      <section className="command-hero" style={{ marginBottom: 'var(--space-xl)' }}>
        <div className="command-hero-content">
          <div className="badge badge-purple" style={{ marginBottom: 'var(--space-md)' }}>AI Command Center</div>
          <h1 className="page-title">AutoPilot Automation</h1>
          <p className="page-subtitle" style={{ maxWidth: 760 }}>
            Quản lý luồng chạy tự động của AutoPilot. Hệ thống được bảo vệ bởi Persistent Lock, Daily Quota, và Safe Publish Policies.
          </p>

          <div className="flex gap-sm" style={{ flexWrap: 'wrap', marginTop: 'var(--space-md)' }}>
            <span className="badge badge-success">Safe Mode ON</span>
            <span className="badge badge-success">Free Only ON</span>
            <span className="badge badge-success">Safe Publish ON</span>
          </div>

          <div className="flex gap-sm" style={{ flexWrap: 'wrap', marginTop: 'var(--space-lg)' }}>
            <button
              className={`primary-button ${state?.settings.enabled ? 'danger' : ''}`}
              onClick={handleToggleEnabled}
              disabled={saving}
              style={state?.settings.enabled ? { background: 'var(--color-danger)', borderColor: 'transparent' } : {}}
            >
              {state?.settings.enabled ? 'Tạm dừng Scheduler' : 'Bật Scheduler Tự động'}
            </button>
            <button
              className="secondary-button"
              disabled={running || state?.currentStatus === 'running'}
              onClick={() => handleRunNow('full_safe_run')}
            >
              {running ? 'Đang chạy...' : 'Run Now (Full)'}
            </button>
          </div>
        </div>

        <div className="command-hero-panel">
          <div className="card" style={{ minWidth: 280 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>System Status</h3>
            <div className="detail-meta">
              <div className="detail-meta-row">
                <span>Trạng thái</span>
                <span className={`badge ${state?.currentStatus === 'running' ? 'badge-info' : state?.currentStatus === 'idle' ? 'badge-success' : 'badge-neutral'}`}>
                  {state?.currentStatus === 'running' ? 'Đang chạy' : state?.currentStatus === 'idle' ? 'Đang chờ' : 'Đã dừng'}
                </span>
              </div>
              <div className="detail-meta-row">
                <span>Daily Quota</span>
                <span style={{ color: 'var(--color-success)' }}>{state?.dailyUsage} / {state?.settings.maxItemsPerDay} items</span>
              </div>
              <div className="detail-meta-row">
                <span>Next Run</span>
                <span>{state?.currentStatus !== 'paused' ? formatTime(state?.nextRunAt || undefined) : '—'}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--space-lg)' }}>
        
        {/* Settings Panel */}
        <div className="card">
          <h3 className="card-title" style={{ marginBottom: 'var(--space-lg)' }}>Cấu hình Limits</h3>
          
          <div className="form-group" style={{ marginBottom: 'var(--space-md)' }}>
            <label className="label">Số item tối đa mỗi lần chạy (Run Limit)</label>
            <div className="flex gap-sm items-center">
              <input 
                type="number" 
                className="input" 
                value={state?.settings.maxItemsPerRun || 10} 
                onChange={(e) => handleUpdateLimit('maxItemsPerRun', Number(e.target.value))}
                min={1} max={50}
                disabled={saving}
              />
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 'var(--space-md)' }}>
            <label className="label">Số item tối đa mỗi ngày (Daily Quota)</label>
            <div className="flex gap-sm items-center">
              <input 
                type="number" 
                className="input" 
                value={state?.settings.maxItemsPerDay || 30} 
                onChange={(e) => handleUpdateLimit('maxItemsPerDay', Number(e.target.value))}
                min={1} max={200}
                disabled={saving}
              />
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 'var(--space-md)' }}>
            <label className="label">Chu kỳ chạy tự động (Giờ)</label>
            <select 
              className="select" 
              value={state?.settings.intervalHours || 6}
              onChange={(e) => handleUpdateLimit('intervalHours', Number(e.target.value))}
              disabled={saving}
            >
              <option value={3}>Mỗi 3 giờ</option>
              <option value={6}>Mỗi 6 giờ</option>
              <option value={12}>Mỗi 12 giờ</option>
              <option value={24}>Mỗi 24 giờ</option>
            </select>
          </div>
        </div>

        {/* Read-Only Policies */}
        <div className="card">
          <h3 className="card-title" style={{ marginBottom: 'var(--space-lg)' }}>Chính sách Immutable</h3>
          <p style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16 }}>
            Các chính sách này được khóa chặt (hard-coded server-side) để đảm bảo an toàn tuyệt đối.
          </p>

          <div className="detail-meta">
            <div className="detail-meta-row">
              <span>Safe Publish</span>
              <span className="badge badge-success">Bắt buộc</span>
            </div>
            <div className="detail-meta-row">
              <span>Free Only (0đ API)</span>
              <span className="badge badge-success">Bắt buộc</span>
            </div>
            <div className="detail-meta-row">
              <span>Paid AI Models</span>
              <span className="badge badge-danger">Vô hiệu hóa</span>
            </div>
            <div className="detail-meta-row">
              <span>Cost Mode</span>
              <span className="badge badge-info">safe_free</span>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Logs */}
      <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
        <h3 className="card-title" style={{ marginBottom: 'var(--space-lg)' }}>Nhật ký chạy gần đây</h3>
        
        {state?.recentRuns && state.recentRuns.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-tertiary)' }}>
                  <th style={{ padding: '12px 8px' }}>Thời gian</th>
                  <th style={{ padding: '12px 8px' }}>Trạng thái</th>
                  <th style={{ padding: '12px 8px' }}>Trigger</th>
                  <th style={{ padding: '12px 8px' }}>Items (Lưu / Quét)</th>
                  <th style={{ padding: '12px 8px' }}>Chi tiết</th>
                </tr>
              </thead>
              <tbody>
                {state.recentRuns.map((log) => (
                  <tr key={log.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ padding: '12px 8px', color: 'var(--text-secondary)' }}>
                      {formatTime(log.startedAt)}
                    </td>
                    <td style={{ padding: '12px 8px' }}>
                      <span className={`badge ${log.status === 'completed' ? 'badge-success' : log.status === 'failed' ? 'badge-danger' : log.status === 'skipped' ? 'badge-neutral' : 'badge-info'}`}>
                        {log.status}
                      </span>
                    </td>
                    <td style={{ padding: '12px 8px' }}>{log.trigger}</td>
                    <td style={{ padding: '12px 8px' }}>
                      {log.summary?.saved || 0} / {log.summary?.found || 0}
                    </td>
                    <td style={{ padding: '12px 8px', color: 'var(--text-secondary)' }}>
                      {log.message || log.error || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: 'var(--space-xl)', textAlign: 'center', color: 'var(--text-tertiary)' }}>
            Chưa có nhật ký nào
          </div>
        )}
      </div>

    </div>
  );
}
