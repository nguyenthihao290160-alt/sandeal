import Link from 'next/link';
import { getProductStats } from '@/lib/storage/products';
import { seedSampleProducts } from '@/lib/storage/products';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  // Seed sample products on first visit
  await seedSampleProducts();

  const stats = await getProductStats();

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Tổng quan</div>
        <div className="safe-mode-badges">
          <span className="safe-badge safe-badge-on">🔒 Safe Mode: ON</span>
          <span className="safe-badge safe-badge-on">💰 Free Only: ON</span>
          <span className="safe-badge safe-badge-off">📤 Auto Publish: OFF</span>
        </div>
      </div>
      <div className="page-content">
        <div className="page-header">
          <div>
            <h1 className="page-header-title">Xin chào 👋</h1>
            <p className="page-header-desc">Quản lý sản phẩm, nội dung và đăng bài từ một nơi duy nhất.</p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-4" style={{ marginBottom: 'var(--space-xl)' }}>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'var(--color-info-bg)', color: 'var(--color-info)' }}>📦</div>
            <div className="stat-card-value">{stats.total}</div>
            <div className="stat-card-label">Tổng sản phẩm</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'var(--color-warning-bg)', color: 'var(--color-warning)' }}>🔍</div>
            <div className="stat-card-value">{stats.needsReview}</div>
            <div className="stat-card-label">Cần xem xét</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'var(--color-success-bg)', color: 'var(--color-success)' }}>✅</div>
            <div className="stat-card-value">{stats.approved}</div>
            <div className="stat-card-label">Đã duyệt</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'rgba(168, 85, 247, 0.12)', color: '#a855f7' }}>🌐</div>
            <div className="stat-card-value">{stats.published}</div>
            <div className="stat-card-label">Đã xuất bản</div>
          </div>
        </div>

        {/* Quick Actions */}
        <h2 className="section-title">Hành động nhanh</h2>
        <div className="quick-actions" style={{ marginBottom: 'var(--space-xl)' }}>
          <Link href="/dashboard/product-sources" className="quick-action-btn">
            <span className="quick-action-icon">🔗</span>
            Thêm / Lấy sản phẩm
          </Link>
          <Link href="/dashboard/products" className="quick-action-btn">
            <span className="quick-action-icon">📦</span>
            Quản lý sản phẩm
          </Link>
          <Link href="/dashboard/products?minScore=75" className="quick-action-btn">
            <span className="quick-action-icon">⭐</span>
            Sản phẩm nên làm
          </Link>
          <Link href="/deals" className="quick-action-btn" target="_blank">
            <span className="quick-action-icon">🌐</span>
            Xem trang deal
          </Link>
        </div>

        {/* Info */}
        <div className="disclosure-banner">
          💡 <strong>Mẹo:</strong> Thêm sản phẩm từ <Link href="/dashboard/product-sources" style={{color: 'var(--color-primary-light)'}}>Trung tâm nguồn sản phẩm</Link>, sau đó chấm điểm và duyệt trước khi tạo nội dung.
        </div>
      </div>
    </>
  );
}
