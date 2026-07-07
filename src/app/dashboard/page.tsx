import Link from 'next/link';
import { getProductStats } from '@/lib/storage/products';
import { getVaultStats } from '@/lib/storage/tokenVault';
import { config } from '@/lib/config';

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

  const needsAction = stats.needsReview > 0;
  const noProducts = stats.total === 0;
  const noTokens = vaultTotal === 0;

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Command Center</div>
        <div className="topbar-search">
          <span className="topbar-search-icon">🔍</span>
          <input placeholder="Tìm sản phẩm, deal, nội dung..." readOnly />
        </div>
        <div className="safe-mode-badges">
          <span className="safe-badge safe-badge-on">Safe Mode</span>
          <span className="safe-badge safe-badge-on">Free Only</span>
          <span className="safe-badge safe-badge-off">Auto Publish: OFF</span>
        </div>
      </div>

      <div className="page-content">
        {/* Hero */}
        <div className="command-hero">
          <div className="command-hero-content">
            <h1 style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, letterSpacing: '-0.02em', marginBottom: '8px' }}>
              Revenue Command Center
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.7, maxWidth: '520px', marginBottom: 'var(--space-lg)' }}>
              Quản lý sản phẩm, chấm điểm cơ hội, tạo nội dung và chuẩn bị đăng đa nền tảng từ một nơi duy nhất.
            </p>
            <div className="flex gap-sm" style={{ flexWrap: 'wrap' }}>
              <Link href="/dashboard/product-sources" className="btn btn-primary">Add / Get Products</Link>
              <Link href="/dashboard/products" className="btn btn-secondary">View Product Inventory</Link>
            </div>
          </div>
          <div className="command-hero-panel">
            <div style={{ display: 'grid', gap: '6px', minWidth: '200px' }}>
              <div className="status-dot status-dot-ok">Safe Mode: ON</div>
              <div className="status-dot status-dot-ok">Free Only: ON</div>
              <div className="status-dot status-dot-neutral">Auto Publish: OFF</div>
              <div className={`status-dot ${vaultErrors > 0 ? 'status-dot-warn' : 'status-dot-ok'}`}>
                Token Vault: {vaultTotal} credential{vaultTotal !== 1 ? 's' : ''}
              </div>
              <div className="status-dot status-dot-ok">Product Storage: OK</div>
              <div className={`status-dot ${stats.needsReview > 0 ? 'status-dot-warn' : 'status-dot-ok'}`}>
                {stats.needsReview > 0 ? `${stats.needsReview} cần xem xét` : 'Không có việc cần làm'}
              </div>
            </div>
          </div>
        </div>

        {/* Metrics */}
        <div className="grid grid-6" style={{ marginBottom: 'var(--space-xl)', gap: 'var(--space-md)' }}>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'rgba(124,58,237,0.08)', color: '#a78bfa' }}>■</div>
            <div className="stat-card-value">{stats.total}</div>
            <div className="stat-card-label">Total Products</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'var(--color-warning-bg)', color: 'var(--color-warning)' }}>●</div>
            <div className="stat-card-value">{stats.needsReview}</div>
            <div className="stat-card-label">Needs Review</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'var(--color-success-bg)', color: 'var(--color-success)' }}>✓</div>
            <div className="stat-card-value">{stats.approved}</div>
            <div className="stat-card-label">Approved</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'var(--color-info-bg)', color: 'var(--color-info)' }}>→</div>
            <div className="stat-card-value">{stats.published}</div>
            <div className="stat-card-label">Published</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'rgba(6,182,212,0.08)', color: 'var(--color-accent-light)' }}>◆</div>
            <div className="stat-card-value">{vaultTotal}</div>
            <div className="stat-card-label">Tokens / APIs</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}>!</div>
            <div className="stat-card-value">{vaultErrors}</div>
            <div className="stat-card-label">Errors</div>
          </div>
        </div>

        {/* Recommendation */}
        {noProducts && (
          <div className="rec-card">
            <div className="rec-card-icon">■</div>
            <div className="rec-card-text">Start by adding your first product from <Link href="/dashboard/product-sources">Product Sources</Link>.</div>
            <Link href="/dashboard/product-sources" className="btn btn-primary btn-sm">Add Now</Link>
          </div>
        )}
        {!noProducts && noTokens && (
          <div className="rec-card">
            <div className="rec-card-icon">◆</div>
            <div className="rec-card-text">Configure Token Vault to enable AI content generation and automatic affiliate linking.</div>
            <Link href="/dashboard/token-vault" className="btn btn-primary btn-sm">Open Token Vault</Link>
          </div>
        )}
        {needsAction && !noProducts && (
          <div className="rec-card">
            <div className="rec-card-icon">●</div>
            <div className="rec-card-text">You have <strong>{stats.needsReview}</strong> products pending review. Review and approve to continue.</div>
            <Link href="/dashboard/products?status=needs_review" className="btn btn-primary btn-sm">Review Now</Link>
          </div>
        )}

        {/* Workflow */}
        <div className="glass-card" style={{ marginBottom: 'var(--space-xl)' }}>
          <h3 className="card-title" style={{ marginBottom: 'var(--space-sm)' }}>Quy trình làm việc an toàn</h3>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-md)' }}>
            Mỗi bước đều yêu cầu xác nhận thủ công trước khi tiếp tục. Không tự động đăng bài.
          </p>
          <div className="workflow-timeline">
            {[
              { n: '1', l: 'Lấy sản phẩm' },
              { n: '2', l: 'Chấm điểm' },
              { n: '3', l: 'Duyệt SP' },
              { n: '4', l: 'Tạo nội dung' },
              { n: '5', l: 'Kiểm duyệt' },
              { n: '6', l: 'Xuất gói đăng' },
            ].map(s => (
              <div className="workflow-step-card" key={s.n}>
                <div className="workflow-step-num">{s.n}</div>
                <div className="workflow-step-label">{s.l}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Quick Actions */}
        <h3 className="section-title">Truy cập nhanh</h3>
        <div className="quick-actions" style={{ marginBottom: 'var(--space-xl)' }}>
          <Link href="/dashboard/product-sources" className="quick-action-btn">
            <span className="quick-action-icon">🔗</span>Nguồn sản phẩm
          </Link>
          <Link href="/dashboard/products" className="quick-action-btn">
            <span className="quick-action-icon">📦</span>Kho sản phẩm
          </Link>
          <Link href="/dashboard/content" className="quick-action-btn">
            <span className="quick-action-icon">🤖</span>AI Content Studio
          </Link>
          <Link href="/dashboard/token-vault" className="quick-action-btn">
            <span className="quick-action-icon">🔐</span>Token Vault
          </Link>
          <Link href="/dashboard/app-health" className="quick-action-btn">
            <span className="quick-action-icon">💚</span>Sức khỏe hệ thống
          </Link>
          <Link href="/deals" className="quick-action-btn" target="_blank">
            <span className="quick-action-icon">🌐</span>Xem trang deal
          </Link>
        </div>
      </div>
    </>
  );
}
