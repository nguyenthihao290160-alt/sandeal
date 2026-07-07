'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { BotTeamStatus, BotRun } from '@/lib/types';

const BOTS = [
  { id: 'orchestrator', name: 'AI Boss Orchestrator', role: 'Điều phối toàn bộ quy trình', icon: 'AI', color: '#a78bfa', dep: 'Sẵn sàng hoạt động' },
  { id: 'source_scout', name: 'Source Scout Bot', role: 'Tìm sản phẩm từ nguồn', icon: 'SS', color: '#22d3ee', dep: 'Cần AccessTrade/local source' },
  { id: 'deal_hunter', name: 'Deal Hunter Bot', role: 'Phát hiện deal tiềm năng', icon: 'DH', color: '#34d399', dep: 'Sẵn sàng hoạt động' },
  { id: 'product_normalizer', name: 'Product Normalizer Bot', role: 'Chuẩn hóa dữ liệu sản phẩm', icon: 'PN', color: '#fbbf24', dep: 'Sẵn sàng hoạt động' },
  { id: 'image_resolver', name: 'Image Resolver Bot', role: 'Xử lý và kiểm tra ảnh', icon: 'IR', color: '#f472b6', dep: 'Sẵn sàng hoạt động' },
  { id: 'gemini_analyst', name: 'Gemini Analyst Bot', role: 'Phân tích bằng Gemini AI', icon: 'GA', color: '#818cf8', dep: 'Cần Gemini key nếu chưa có' },
  { id: 'deal_scorer', name: 'Deal Scoring Bot', role: 'Chấm điểm cơ hội', icon: 'DS', color: '#fb923c', dep: 'Sẵn sàng hoạt động' },
  { id: 'content_review', name: 'Content Review Bot', role: 'Tạo bài review sản phẩm', icon: 'CR', color: '#38bdf8', dep: 'Sẵn sàng hoạt động' },
  { id: 'compliance_guard', name: 'Compliance Guard Bot', role: 'Kiểm duyệt nội dung an toàn', icon: 'CG', color: '#f43f5e', dep: 'Sẵn sàng hoạt động' },
  { id: 'link_health', name: 'Link Health Bot', role: 'Kiểm tra link liên kết', icon: 'LH', color: '#2dd4bf', dep: 'Sẵn sàng kiểm link' },
  { id: 'product_cleanup', name: 'Product Cleanup Bot', role: 'Dọn sản phẩm lỗi / cũ', icon: 'PC', color: '#a3e635', dep: 'Sẵn sàng hoạt động' },
  { id: 'content_package', name: 'Content Package Bot', role: 'Đóng gói nội dung đa nền tảng', icon: 'CP', color: '#c084fc', dep: 'Sẵn sàng hoạt động' },
  { id: 'app_health', name: 'App Health Bot', role: 'Giám sát sức khỏe hệ thống', icon: 'AH', color: '#4ade80', dep: 'Sẵn sàng hoạt động' },
];

const WORKFLOW_STEPS = [
  { n: '1', l: 'Kiểm tra token và nguồn dữ liệu', status: 'completed' },
  { n: '2', l: 'Quét sản phẩm từ nguồn thật', status: 'completed' },
  { n: '3', l: 'Lọc deal tiềm năng', status: 'current' },
  { n: '4', l: 'Tạo nội dung an toàn', status: 'pending' },
  { n: '5', l: 'Kiểm link trước khi public', status: 'pending' },
];

export default function AIBotsPage() {
  const [status, setStatus] = useState<BotTeamStatus | null>(null);
  const [runs, setRuns] = useState<BotRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [reviewQueue, setReviewQueue] = useState<any[]>([]);

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
        
        // Fetch review queue if needed
        if (statusData.data?.reviewProductCount > 0) {
          const queueRes = await fetch('/api/products?status=needs_review&limit=3');
          if (queueRes.ok) {
            const queueData = await queueRes.json();
            setReviewQueue(queueData.data || []);
          }
        }
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
      setSuccessMsg('Đã khởi chạy bot thành công!');
      setTimeout(() => setSuccessMsg(null), 3000);
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
        {successMsg && (
          <div style={{ background: 'rgba(52, 211, 153, 0.1)', border: '1px solid rgba(52, 211, 153, 0.2)', color: '#34d399', padding: '14px 18px', borderRadius: '8px', marginBottom: '24px', fontSize: '14px' }}>
            {successMsg}
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
              <div style={{ display: 'grid', gap: '8px', minWidth: '240px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '8px 12px', background: 'rgba(148,163,184,0.06)', borderRadius: '6px' }}>
                  <span style={{ color: 'var(--dash-text-muted)' }}>Trạng thái hệ thống</span>
                  <span style={{ color: '#34d399', fontWeight: 600 }}>Sẵn sàng</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '8px 12px', background: 'rgba(148,163,184,0.06)', borderRadius: '6px' }}>
                  <span style={{ color: 'var(--dash-text-muted)' }}>Quy trình gần nhất</span>
                  <span style={{ color: 'var(--dash-text-primary)', fontWeight: 600 }}>{runs.length > 0 ? new Date(runs[0].startedAt).toLocaleTimeString('vi-VN') : 'Chưa có'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '8px 12px', background: 'rgba(148,163,184,0.06)', borderRadius: '6px' }}>
                  <span style={{ color: 'var(--dash-text-muted)' }}>Nguồn đang hoạt động</span>
                  <span style={{ color: 'var(--dash-text-primary)', fontWeight: 600 }}>{status.hasAccessTradePrimaryToken ? 'AccessTrade' : 'Demo'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '8px 12px', background: 'rgba(148,163,184,0.06)', borderRadius: '6px' }}>
                  <span style={{ color: 'var(--dash-text-muted)' }}>Sản phẩm chờ xử lý</span>
                  <span style={{ color: '#fbbf24', fontWeight: 600 }}>{status.reviewProductCount}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '8px 12px', background: 'rgba(148,163,184,0.06)', borderRadius: '6px' }}>
                  <span style={{ color: 'var(--dash-text-muted)' }}>Bot cần cấu hình</span>
                  <span style={{ color: !status.hasGeminiPrimaryToken ? '#fb7185' : '#34d399', fontWeight: 600 }}>{!status.hasGeminiPrimaryToken ? 'Gemini Bot' : 'Không'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '8px 12px', background: 'rgba(148,163,184,0.06)', borderRadius: '6px' }}>
                  <span style={{ color: 'var(--dash-text-muted)' }}>Chi phí ước tính</span>
                  <span style={{ color: '#34d399', fontWeight: 600 }}>0đ (Safe Mode)</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {status && status.productCount === 0 && !status.hasAccessTradePrimaryToken && (
          <div style={{ marginBottom: '18px', padding: '12px', borderRadius: '8px', background: '#fff7ed', border: '1px solid #ffedd5', color: '#92400e' }}>
            Local chưa có token/dữ liệu. Hãy kiểm tra trên VPS hoặc cấu hình Token Vault.
          </div>
        )}

        {/* ============ AI BOSS PLAN TIMELINE ============ */}
        <h2 className="dashboard-section-title">AI Boss Plan — Quy trình tự động</h2>
        <div className="workflow-timeline-premium" style={{ marginBottom: 'var(--space-xl)', display: 'flex', justifyContent: 'space-between', position: 'relative' }}>
          <div style={{ position: 'absolute', top: '16px', left: '40px', right: '40px', height: '2px', background: 'rgba(148,163,184,0.1)', zIndex: 0 }} />
          {WORKFLOW_STEPS.map((s, idx) => (
            <div className="workflow-step-premium" key={s.n} style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, textAlign: 'center' }}>
              <div className="workflow-step-premium-num" style={{ width: '32px', height: '32px', borderRadius: '50%', background: s.status === 'completed' ? 'rgba(52, 211, 153, 0.15)' : s.status === 'current' ? 'var(--gradient-accent)' : '#0f172a', border: `2px solid ${s.status === 'completed' ? '#34d399' : s.status === 'current' ? 'transparent' : 'rgba(148,163,184,0.2)'}`, color: s.status === 'completed' ? '#34d399' : s.status === 'current' ? '#fff' : '#64748b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>
                {s.status === 'completed' ? '✓' : s.n}
              </div>
              <div className="workflow-step-premium-label" style={{ fontSize: '12px', fontWeight: s.status === 'current' ? 700 : 500, color: s.status === 'current' ? 'var(--dash-text-primary)' : 'var(--dash-text-muted)', marginBottom: '4px' }}>{s.l}</div>
              {s.status === 'current' && (
                <div style={{ fontSize: '10px', color: '#a78bfa', fontWeight: 600, background: 'rgba(167, 139, 250, 0.15)', padding: '2px 8px', borderRadius: '10px' }}>Chờ chạy</div>
              )}
            </div>
          ))}
        </div>

        {/* ============ BOT TEAM GRID ============ */}
        <h2 className="dashboard-section-title">Đội Bot AI</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '16px', marginBottom: 'var(--space-xl)' }}>
          {BOTS.map(bot => {
            let badge = { text: 'Idle', color: '#64748b', bg: '#0f172a' };
            if (bot.dep.includes('Cần')) {
              badge = { text: 'Needs key', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.1)' };
            } else if (bot.id === 'orchestrator') {
              badge = { text: 'Ready', color: '#34d399', bg: 'rgba(52, 211, 153, 0.1)' };
            }

            return (
              <div key={bot.id} className="bot-card-premium" style={{ transition: 'transform 0.2s, box-shadow 0.2s', cursor: 'pointer' }} 
                   onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-4px)'; e.currentTarget.style.boxShadow = '0 12px 24px rgba(0,0,0,0.4)'; }}
                   onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', marginBottom: '12px' }}>
                  <div className="bot-icon" style={{ background: `${bot.color}15`, color: bot.color }}>
                    {bot.icon}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="bot-card-name" style={{ fontSize: '14px', fontWeight: 700, color: 'var(--dash-text-primary)' }}>{bot.name}</div>
                    <div className="bot-card-role" style={{ fontSize: '12px', color: 'var(--dash-text-muted)' }}>{bot.role}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', background: badge.bg, padding: '2px 8px', borderRadius: '12px' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: badge.color, display: 'inline-block' }} />
                    <span style={{ color: badge.color, fontWeight: 600 }}>{badge.text}</span>
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--dash-text-muted)' }}>{bot.dep}</div>
                </div>
                <div className="bot-card-stats" style={{ marginTop: '10px', display: 'flex', justifyContent: 'space-between', borderTop: '1px solid rgba(148,163,184,0.1)', paddingTop: '12px' }}>
                  <div className="bot-card-stat-item" style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', color: 'var(--dash-text-muted)', marginBottom: '4px' }}>Processed</div>
                    <div className="bot-card-stat-value" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--dash-text-primary)' }}>—</div>
                  </div>
                  <div className="bot-card-stat-item" style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', color: 'var(--dash-text-muted)', marginBottom: '4px' }}>Output</div>
                    <div className="bot-card-stat-value" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--dash-text-primary)' }}>—</div>
                  </div>
                  <div className="bot-card-stat-item" style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', color: 'var(--dash-text-muted)', marginBottom: '4px' }}>Errors</div>
                    <div className="bot-card-stat-value" style={{ fontSize: '14px', fontWeight: 600, color: '#fb7185' }}>0</div>
                  </div>
                </div>
              </div>
            );
          })}
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
          <div className="dashboard-empty-state" style={{ marginBottom: 'var(--space-xl)', background: 'var(--dash-panel-bg)', border: '1px solid var(--dash-border)', borderRadius: '12px' }}>
            <p style={{ color: 'var(--dash-text-muted)' }}>Chưa có sản phẩm chờ duyệt. Hãy kết nối nguồn dữ liệu hoặc chạy bot quét nguồn.</p>
          </div>
        ) : (
          <div className="dashboard-card" style={{ marginBottom: 'var(--space-xl)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-md)' }}>
              <span style={{ color: 'var(--dash-text-secondary)', fontSize: 'var(--text-sm)' }}>
                {status?.reviewProductCount || 0} sản phẩm đang chờ duyệt
              </span>
              <Link href="/dashboard/products?status=needs_review" className="dashboard-secondary-button" style={{ padding: '6px 14px', fontSize: '12px' }}>
                Xem tất cả
              </Link>
            </div>
            {reviewQueue.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
                {reviewQueue.map((p: any) => (
                  <div key={p.id} style={{ background: '#0f172a', border: '1px solid rgba(148,163,184,0.1)', borderRadius: '12px', padding: '16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                      <h4 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--dash-text-primary)', margin: 0, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.title}</h4>
                      <span style={{ fontSize: '10px', background: 'rgba(148,163,184,0.1)', color: 'var(--dash-text-muted)', padding: '2px 8px', borderRadius: '4px', whiteSpace: 'nowrap', marginLeft: '12px' }}>{p.source}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '11px', color: p.score >= 75 ? '#34d399' : '#fbbf24', background: p.score >= 75 ? 'rgba(52,211,153,0.1)' : 'rgba(251,191,36,0.1)', padding: '2px 8px', borderRadius: '12px' }}>Điểm: {p.score || 'N/A'}</span>
                      <span style={{ fontSize: '11px', color: p.linkHealth === 'healthy' ? '#34d399' : '#64748b', background: p.linkHealth === 'healthy' ? 'rgba(52,211,153,0.1)' : 'rgba(148,163,184,0.1)', padding: '2px 8px', borderRadius: '12px' }}>Link: {p.linkHealth || 'Unknown'}</span>
                      <span style={{ fontSize: '11px', color: '#22d3ee', background: 'rgba(34,211,238,0.1)', padding: '2px 8px', borderRadius: '12px' }}>Content: {p.status}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <Link href={`/dashboard/products/${p.id}`} className="dashboard-secondary-button" style={{ flex: 1, textAlign: 'center', padding: '6px 0', fontSize: '12px' }}>Xem chi tiết</Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
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
