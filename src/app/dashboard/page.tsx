import Link from 'next/link';
import { getProductStats } from '@/lib/storage/products';
import { getVaultStats } from '@/lib/storage/tokenVault';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const stats = await getProductStats();
  let vaultTotal = 0;
  let vaultErrors = 0;
  try {
    const vs = await getVaultStats();
    vaultTotal = vs.totalCredentials;
    vaultErrors = vs.errorCount;
  } catch { /* vault empty */ }

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">AI Revenue Command Center</div>
        <div className="safe-mode-badges">
          <span className="dashboard-status-badge success">Safe Mode</span>
          <span className="dashboard-status-badge success">Free Only</span>
          <span className="dashboard-status-badge neutral">Auto Publish: OFF</span>
        </div>
      </div>

      <div className="page-content">
        {/* Hero */}
        <div className="dashboard-hero">
          <div className="dashboard-hero-content">
            <h1 style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, letterSpacing: '-0.02em', marginBottom: '8px', color: 'var(--dash-text-primary)' }}>
              AI Revenue Command Center
            </h1>
            <p style={{ color: 'var(--dash-text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.7, maxWidth: '520px', marginBottom: 'var(--space-lg)' }}>
              Điều phối đội bot AI để tìm sản phẩm thật, lọc deal, tạo bài review an toàn, kiểm tra link và đưa sản phẩm vào hàng chờ duyệt.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
              <Link href="/dashboard/ai-bots" className="dashboard-gradient-button">Mở Đội Bot AI</Link>
              <Link href="/dashboard/token-vault" className="dashboard-secondary-button">Cấu hình Token Vault</Link>
            </div>
          </div>
          <div className="dashboard-hero-panel">
            <div style={{ display: 'grid', gap: '6px', minWidth: '200px' }}>
              <div className="dashboard-status-badge success" style={{ justifyContent: 'flex-start' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 6px rgba(16,185,129,0.5)' }} /> Safe Mode: ON
              </div>
              <div className="dashboard-status-badge success" style={{ justifyContent: 'flex-start' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 6px rgba(16,185,129,0.5)' }} /> Free Only: ON
              </div>
              <div className="dashboard-status-badge neutral" style={{ justifyContent: 'flex-start' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#64748b' }} /> Auto Publish: OFF
              </div>
              <div className={`dashboard-status-badge ${vaultErrors > 0 ? 'warning' : 'success'}`} style={{ justifyContent: 'flex-start' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: vaultErrors > 0 ? '#f59e0b' : '#10b981' }} />
                Token Vault: {vaultTotal} credential{vaultTotal !== 1 ? 's' : ''}
              </div>
              <div className={`dashboard-status-badge ${stats.needsReview > 0 ? 'warning' : 'success'}`} style={{ justifyContent: 'flex-start' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: stats.needsReview > 0 ? '#f59e0b' : '#10b981' }} />
                {stats.needsReview > 0 ? `${stats.needsReview} chờ duyệt` : 'Không có việc cần làm'}
              </div>
            </div>
          </div>
        </div>

        {/* Metrics */}
        <div className="grid grid-6" style={{ marginBottom: 'var(--space-xl)', gap: 'var(--space-md)' }}>
          {[
            { icon: 'P', bg: 'rgba(124,58,237,0.1)', color: '#a78bfa', value: stats.total, label: 'Tổng sản phẩm' },
            { icon: 'D', bg: 'rgba(245,158,11,0.1)', color: '#fbbf24', value: stats.needsReview, label: 'Chờ duyệt' },
            { icon: 'A', bg: 'rgba(16,185,129,0.1)', color: '#34d399', value: stats.approved, label: 'Đã duyệt' },
            { icon: 'L', bg: 'rgba(56,189,248,0.1)', color: '#38bdf8', value: stats.published, label: 'Đã public' },
            { icon: 'T', bg: 'rgba(6,182,212,0.1)', color: '#22d3ee', value: vaultTotal, label: 'Token / API' },
            { icon: '!', bg: 'rgba(244,63,94,0.1)', color: '#fb7185', value: vaultErrors, label: 'Lỗi hệ thống' },
          ].map((m, i) => (
            <div key={i} className="dashboard-metric-card">
              <div className="dashboard-metric-icon" style={{ background: m.bg, color: m.color }}>{m.icon}</div>
              <div className="dashboard-metric-value">{m.value}</div>
              <div className="dashboard-metric-label">{m.label}</div>
            </div>
          ))}
        </div>

        {/* Recommendations */}
        {stats.total === 0 && (
          <div className="dashboard-card-strong" style={{ marginBottom: 'var(--space-lg)', display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <div className="dashboard-metric-icon" style={{ background: 'rgba(124,58,237,0.1)', color: '#a78bfa' }}>+</div>
            <div style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--dash-text-secondary)' }}>
              Bắt đầu bằng cách thêm sản phẩm từ <Link href="/dashboard/product-sources" style={{ color: '#a78bfa' }}>Nguồn dữ liệu</Link>.
            </div>
            <Link href="/dashboard/product-sources" className="dashboard-gradient-button" style={{ padding: '8px 16px', fontSize: '12px' }}>Thêm ngay</Link>
          </div>
        )}
        {stats.total > 0 && vaultTotal === 0 && (
          <div className="dashboard-card-strong" style={{ marginBottom: 'var(--space-lg)', display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <div className="dashboard-metric-icon" style={{ background: 'rgba(6,182,212,0.1)', color: '#22d3ee' }}>K</div>
            <div style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--dash-text-secondary)' }}>
              Cấu hình Token Vault để bật tạo nội dung AI và liên kết affiliate tự động.
            </div>
            <Link href="/dashboard/token-vault" className="dashboard-gradient-button" style={{ padding: '8px 16px', fontSize: '12px' }}>Token Vault</Link>
          </div>
        )}
        {stats.needsReview > 0 && stats.total > 0 && (
          <div className="dashboard-card-strong" style={{ marginBottom: 'var(--space-lg)', display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <div className="dashboard-metric-icon" style={{ background: 'rgba(245,158,11,0.1)', color: '#fbbf24' }}>!</div>
            <div style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--dash-text-secondary)' }}>
              Bạn có <strong style={{ color: 'var(--dash-text-primary)' }}>{stats.needsReview}</strong> sản phẩm chờ duyệt.
            </div>
            <Link href="/dashboard/products?status=needs_review" className="dashboard-gradient-button" style={{ padding: '8px 16px', fontSize: '12px' }}>Duyệt ngay</Link>
          </div>
        )}

        {/* Workflow */}
        <div className="dashboard-card" style={{ marginBottom: 'var(--space-xl)' }}>
          <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 700, marginBottom: 'var(--space-xs)', color: 'var(--dash-text-primary)' }}>Quy trình AI an toàn</h3>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--dash-text-muted)', marginBottom: 'var(--space-md)' }}>
            Mỗi bước đều yêu cầu xác nhận thủ công. Không tự động đăng bài.
          </p>
          <div className="workflow-timeline-premium">
            {[
              { n: '1', l: 'Nguồn dữ liệu' },
              { n: '2', l: 'Bot quét SP' },
              { n: '3', l: 'AI phân tích' },
              { n: '4', l: 'Tạo bài review' },
              { n: '5', l: 'Kiểm duyệt' },
              { n: '6', l: 'Kiểm link' },
              { n: '7', l: 'Chờ duyệt' },
            ].map(s => (
              <div className="workflow-step-premium" key={s.n}>
                <div className="workflow-step-premium-num">{s.n}</div>
                <div className="workflow-step-premium-label">{s.l}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Quick Actions */}
        <h3 className="dashboard-section-title">Truy cập nhanh</h3>
        <div className="quick-actions" style={{ marginBottom: 'var(--space-xl)' }}>
          {[
            { href: '/dashboard/ai-bots', icon: 'B', label: 'Đội Bot AI' },
            { href: '/dashboard/token-vault', icon: 'T', label: 'Token Vault' },
            { href: '/dashboard/product-sources', icon: 'N', label: 'Nguồn dữ liệu' },
            { href: '/dashboard/products', icon: 'K', label: 'Kết quả bot' },
            { href: '/dashboard/app-health', icon: 'H', label: 'Sức khỏe hệ thống' },
          ].map(a => (
            <Link key={a.href} href={a.href} className="dashboard-quick-action">
              <span className="dashboard-quick-action-icon">{a.icon}</span>
              {a.label}
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
