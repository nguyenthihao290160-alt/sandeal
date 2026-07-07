'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { BotTeamStatus, BotRun } from '@/lib/types';

const BOTS = [
  { id: 'orchestrator', name: 'AI Boss Orchestrator', role: 'Điều phối toàn bộ quy trình', icon: 'AI', color: '#a78bfa' },
  { id: 'source_scout', name: 'Source Scout Bot', role: 'Tìm sản phẩm từ nguồn', icon: 'SS', color: '#22d3ee' },
  { id: 'deal_hunter', name: 'Deal Hunter Bot', role: 'Phát hiện deal tiềm năng', icon: 'DH', color: '#34d399' },
  { id: 'product_normalizer', name: 'Product Normalizer Bot', role: 'Chuẩn hóa dữ liệu sản phẩm', icon: 'PN', color: '#fbbf24' },
  { id: 'image_resolver', name: 'Image Resolver Bot', role: 'Xử lý và kiểm tra ảnh', icon: 'IR', color: '#f472b6' },
  { id: 'gemini_analyst', name: 'Gemini Analyst Bot', role: 'Phân tích bằng Gemini AI', icon: 'GA', color: '#818cf8' },
  { id: 'deal_scorer', name: 'Deal Scoring Bot', role: 'Chấm điểm cơ hội', icon: 'DS', color: '#fb923c' },
  { id: 'content_review', name: 'Content Review Bot', role: 'Tạo bài review sản phẩm', icon: 'CR', color: '#38bdf8' },
  { id: 'compliance_guard', name: 'Compliance Guard Bot', role: 'Kiểm duyệt nội dung an toàn', icon: 'CG', color: '#f43f5e' },
  { id: 'link_health', name: 'Link Health Bot', role: 'Kiểm tra link liên kết', icon: 'LH', color: '#2dd4bf' },
  { id: 'product_cleanup', name: 'Product Cleanup Bot', role: 'Dọn sản phẩm lỗi / cũ', icon: 'PC', color: '#a3e635' },
  { id: 'content_package', name: 'Content Package Bot', role: 'Đóng gói nội dung đa nền tảng', icon: 'CP', color: '#c084fc' },
  { id: 'app_health', name: 'App Health Bot', role: 'Giám sát sức khỏe hệ thống', icon: 'AH', color: '#4ade80' },
];

const WORKFLOW_STEPS = [
  { n: '1', l: 'Kiểm tra token' },
  { n: '2', l: 'Quét nguồn dữ liệu' },
  { n: '3', l: 'Lọc deal tiềm năng' },
  { n: '4', l: 'Chuẩn hóa SP' },
  { n: '5', l: 'Phân tích AI' },
  { n: '6', l: 'Tạo bài review' },
  { n: '7', l: 'Kiểm duyệt' },
  { n: '8', l: 'Kiểm tra link' },
  { n: '9', l: 'Chờ duyệt' },
];

export default function AIBotsPage() {
  const [status, setStatus] = useState<BotTeamStatus | null>(null);
  const [runs, setRuns] = useState<BotRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runLoading, setRunLoading] = useState(false);

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);
        const [statusRes, runsRes] = await Promise.all([
          fetch('/api/ai-bots/status'),
          fetch('/api/ai-bots/runs'),
        ]);

        if (!statusRes.ok || !runsRes.ok) {
          throw new Error('Failed to load bot status');
        }

        const statusData = await statusRes.json();
        const runsData = await runsRes.json();

        setStatus(statusData.data);
        setRuns(runsData.data || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleRunBot = async (mode: string) => {
    try {
      setRunLoading(true);
      setError(null);
      const res = await fetch('/api/ai-bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          source: 'all',
          limit: 10,
          costMode: 'safe_free',
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to start bot run');
      }

      const runsRes = await fetch('/api/ai-bots/runs');
      const runsData = await runsRes.json();
      setRuns(runsData.data || []);

      const statusRes = await fetch('/api/ai-bots/status');
      const statusData = await statusRes.json();
      setStatus(statusData.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setRunLoading(false);
    }
  };

  if (loading) {
    return (
      <>
        <div className="topbar">
          <div className="topbar-title">AI Command Center</div>
        </div>
        <div className="page-content">
          <div className="dashboard-empty-state">
            <p>Initializing AI Command Center...</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">AI Command Center</div>
        <div className="safe-mode-badges">
          {status && (
            <>
              <span className={`dashboard-status-badge ${status.safeMode ? 'success' : 'warning'}`}>
                Safe Mode {status.safeMode ? 'ON' : 'OFF'}
              </span>
              <span className={`dashboard-status-badge ${status.freeOnly ? 'success' : 'neutral'}`}>
                Free Only {status.freeOnly ? 'ON' : 'OFF'}
              </span>
              <span className="dashboard-status-badge neutral">
                Auto Publish OFF
              </span>
            </>
          )}
        </div>
      </div>

      <div className="page-content" style={{ maxWidth: '1400px' }}>
        {error && (
          <div style={{ background: 'rgba(244,63,94,0.1)', border: '1px solid rgba(244,63,94,0.2)', color: '#fb7185', padding: '14px 18px', borderRadius: '8px', marginBottom: '24px', fontSize: '14px' }}>
            <strong>Error:</strong> {error}
          </div>
        )}

        {/* ============ HERO / MISSION CONTROL ============ */}
        <div className="dashboard-hero" style={{ marginBottom: 'var(--space-xl)' }}>
          <div className="dashboard-hero-content">
            <h1 style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, letterSpacing: '-0.02em', marginBottom: '8px', background: 'linear-gradient(135deg, #a78bfa, #22d3ee)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              AI Command Center SanDeal
            </h1>
            <p style={{ color: 'var(--dash-text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.7, maxWidth: '520px', marginBottom: 'var(--space-lg)' }}>
              Trung tâm điều phối đội bot AI săn deal, tạo nội dung, kiểm link và bảo trì dữ liệu sản phẩm.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
              <button className="dashboard-gradient-button" onClick={() => handleRunBot('full_safe_run')} disabled={runLoading}>
                {runLoading ? 'Đang chạy...' : 'Chạy toàn bộ quy trình an toàn'}
              </button>
              <button className="dashboard-secondary-button" onClick={() => handleRunBot('source_scan')} disabled={runLoading}>
                Quét nguồn
              </button>
              <button className="dashboard-secondary-button" onClick={() => handleRunBot('content_review')} disabled={runLoading}>
                Tạo bài review
              </button>
              <button className="dashboard-secondary-button" onClick={() => handleRunBot('link_health')} disabled={runLoading}>
                Kiểm tra link
              </button>
            </div>
          </div>

          {status && (
            <div className="dashboard-hero-panel">
              <div style={{ display: 'grid', gap: '8px', minWidth: '220px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '6px 10px', background: 'rgba(148,163,184,0.04)', borderRadius: '6px' }}>
                  <span style={{ color: 'var(--dash-text-muted)' }}>Operation Mode</span>
                  <span style={{ color: 'var(--dash-text-primary)', fontWeight: 600 }}>{status.freeOnly ? 'Safe Free' : status.safeMode ? 'Smart Test' : 'Premium'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '6px 10px', background: 'rgba(148,163,184,0.04)', borderRadius: '6px' }}>
                  <span style={{ color: 'var(--dash-text-muted)' }}>Gemini</span>
                  <span style={{ color: status.hasGeminiPrimaryToken ? '#34d399' : '#fb7185', fontWeight: 600 }}>{status.hasGeminiPrimaryToken ? 'Ready' : 'Missing'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '6px 10px', background: 'rgba(148,163,184,0.04)', borderRadius: '6px' }}>
                  <span style={{ color: 'var(--dash-text-muted)' }}>AccessTrade</span>
                  <span style={{ color: status.hasAccessTradePrimaryToken ? '#34d399' : '#fb7185', fontWeight: 600 }}>{status.hasAccessTradePrimaryToken ? 'Ready' : 'Missing'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '6px 10px', background: 'rgba(148,163,184,0.04)', borderRadius: '6px' }}>
                  <span style={{ color: 'var(--dash-text-muted)' }}>Chờ duyệt</span>
                  <span style={{ color: status.reviewProductCount > 0 ? '#fbbf24' : '#34d399', fontWeight: 600 }}>{status.reviewProductCount}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '6px 10px', background: 'rgba(148,163,184,0.04)', borderRadius: '6px' }}>
                  <span style={{ color: 'var(--dash-text-muted)' }}>Link lỗi</span>
                  <span style={{ color: status.brokenLinkCount > 0 ? '#fb7185' : '#34d399', fontWeight: 600 }}>{status.brokenLinkCount}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '6px 10px', background: 'rgba(148,163,184,0.04)', borderRadius: '6px' }}>
                  <span style={{ color: 'var(--dash-text-muted)' }}>Gói nội dung</span>
                  <span style={{ color: 'var(--dash-text-primary)', fontWeight: 600 }}>{status.contentPackageCount}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ============ AI BOSS PLAN TIMELINE ============ */}
        <h2 className="dashboard-section-title">AI Boss Plan — Quy trình tự động</h2>
        <div className="workflow-timeline-premium" style={{ marginBottom: 'var(--space-xl)' }}>
          {WORKFLOW_STEPS.map(s => (
            <div className="workflow-step-premium" key={s.n}>
              <div className="workflow-step-premium-num">{s.n}</div>
              <div className="workflow-step-premium-label">{s.l}</div>
              <div className="workflow-step-premium-dot" />
            </div>
          ))}
        </div>

        {/* ============ BOT TEAM GRID ============ */}
        <h2 className="dashboard-section-title">Đội Bot AI</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '16px', marginBottom: 'var(--space-xl)' }}>
          {BOTS.map(bot => (
            <div key={bot.id} className="bot-card-premium">
              <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', marginBottom: '12px' }}>
                <div className="bot-icon" style={{ background: `${bot.color}15`, color: bot.color }}>
                  {bot.icon}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="bot-card-name">{bot.name}</div>
                  <div className="bot-card-role">{bot.role}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#64748b', display: 'inline-block' }} />
                <span style={{ color: 'var(--dash-text-secondary)', fontWeight: 600 }}>Idle</span>
              </div>
              <div className="bot-card-stats" style={{ marginTop: '10px' }}>
                <div className="bot-card-stat-item">
                  <span style={{ color: 'var(--dash-text-muted)' }}>Processed</span>
                  <span className="bot-card-stat-value">—</span>
                </div>
                <div className="bot-card-stat-item">
                  <span style={{ color: 'var(--dash-text-muted)' }}>Output</span>
                  <span className="bot-card-stat-value">—</span>
                </div>
                <div className="bot-card-stat-item">
                  <span style={{ color: 'var(--dash-text-muted)' }}>Errors</span>
                  <span className="bot-card-stat-value">0</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* ============ WORKFLOW CONTROL PANEL ============ */}
        <h2 className="dashboard-section-title">Bảng điều khiển quy trình</h2>
        <div className="dashboard-card" style={{ marginBottom: 'var(--space-xl)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
            <button className="dashboard-secondary-button" onClick={() => handleRunBot('source_scan')} disabled={runLoading}>
              Quét nguồn sản phẩm
            </button>
            <button className="dashboard-secondary-button" onClick={() => handleRunBot('deal_hunt')} disabled={runLoading}>
              Tìm deal hot
            </button>
            <button className="dashboard-secondary-button" onClick={() => handleRunBot('gemini_analysis')} disabled={runLoading}>
              Phân tích bằng Gemini
            </button>
            <button className="dashboard-secondary-button" onClick={() => handleRunBot('content_review')} disabled={runLoading}>
              Tạo bài review an toàn
            </button>
            <button className="dashboard-secondary-button" onClick={() => handleRunBot('link_health')} disabled={runLoading}>
              Kiểm tra link liên kết
            </button>
            <button className="dashboard-secondary-button" onClick={() => handleRunBot('cleanup')} disabled={runLoading}>
              Dọn sản phẩm lỗi
            </button>
            <button className="dashboard-gradient-button" onClick={() => handleRunBot('full_safe_run')} disabled={runLoading}
              style={{ gridColumn: 'span 1' }}>
              {runLoading ? 'Đang xử lý...' : 'Chạy toàn bộ quy trình an toàn'}
            </button>
          </div>
        </div>

        {/* ============ BOT RUN LOGS ============ */}
        <h2 className="dashboard-section-title">Nhật ký chạy bot</h2>
        {runs.length === 0 ? (
          <div className="dashboard-empty-state" style={{ marginBottom: 'var(--space-xl)' }}>
            <p>Chưa có lượt chạy bot. Hãy chạy quy trình an toàn để bắt đầu.</p>
          </div>
        ) : (
          <div className="dashboard-table" style={{ marginBottom: 'var(--space-xl)' }}>
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
                {runs.slice(0, 20).map(run => (
                  <tr key={run.id}>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{run.id.slice(0, 8)}</td>
                    <td>{run.mode}</td>
                    <td>
                      <span className={`dashboard-status-badge ${
                        run.status === 'completed' ? 'success' :
                        run.status === 'running' ? 'info' :
                        run.status === 'failed' ? 'danger' : 'warning'
                      }`}>
                        {run.status}
                      </span>
                    </td>
                    <td style={{ fontSize: '12px', color: 'var(--dash-text-secondary)' }}>
                      {new Date(run.startedAt).toLocaleString('vi-VN')}
                    </td>
                    <td style={{ fontSize: '12px' }}>
                      {run.candidatesFound} found, {run.productsSaved} saved
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ============ REVIEW QUEUE PREVIEW ============ */}
        <h2 className="dashboard-section-title">Hàng chờ duyệt</h2>
        {status && status.reviewProductCount === 0 ? (
          <div className="dashboard-empty-state" style={{ marginBottom: 'var(--space-xl)' }}>
            <p>Chưa có sản phẩm chờ duyệt. Hãy kết nối nguồn dữ liệu hoặc chạy bot quét nguồn.</p>
          </div>
        ) : (
          <div className="dashboard-card" style={{ marginBottom: 'var(--space-xl)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--dash-text-secondary)', fontSize: 'var(--text-sm)' }}>
                {status?.reviewProductCount || 0} sản phẩm đang chờ duyệt
              </span>
              <Link href="/dashboard/products?status=needs_review" className="dashboard-secondary-button" style={{ padding: '6px 14px', fontSize: '12px' }}>
                Xem tất cả
              </Link>
            </div>
          </div>
        )}

        {/* ============ PRODUCT INVENTORY ============ */}
        {status && (
          <>
            <h2 className="dashboard-section-title">Tổng quan sản phẩm</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px', marginBottom: 'var(--space-md)' }}>
              {[
                { label: 'Tổng SP', value: status.productCount, color: '#a78bfa' },
                { label: 'Đã duyệt', value: status.approvedProductCount, color: '#34d399' },
                { label: 'Chờ duyệt', value: status.reviewProductCount, color: '#fbbf24' },
                { label: 'Link lỗi', value: status.brokenLinkCount, color: '#fb7185' },
              ].map((item, i) => (
                <div key={i} className="dashboard-metric-card">
                  <div className="dashboard-metric-value" style={{ color: item.color }}>{item.value}</div>
                  <div className="dashboard-metric-label">{item.label}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: 'var(--space-xl)' }}>
              <Link href="/dashboard/products" className="dashboard-secondary-button" style={{ fontSize: '12px', padding: '8px 14px' }}>
                Xem tất cả sản phẩm
              </Link>
              <Link href="/dashboard/token-vault" className="dashboard-secondary-button" style={{ fontSize: '12px', padding: '8px 14px' }}>
                Token Vault
              </Link>
            </div>
          </>
        )}
      </div>
    </>
  );
}
