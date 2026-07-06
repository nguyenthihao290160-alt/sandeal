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
        <div className="topbar-search">
          <span className="topbar-search-icon">🔍</span>
          <input type="text" placeholder="Tìm sản phẩm, deal, nội dung..." readOnly />
        </div>
        <div className="safe-mode-badges">
          <span className="safe-badge safe-badge-on">🔒 Safe Mode: ON</span>
          <span className="safe-badge safe-badge-on">💰 Free Only: ON</span>
          <span className="safe-badge safe-badge-off">📤 Auto Publish: OFF</span>
        </div>
      </div>
      <div className="page-content">
        {/* Command Hero */}
        <div className="command-hero">
          <div className="command-hero-content">
            <h1 style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, marginBottom: '8px', letterSpacing: '-0.02em' }}>
              Revenue Command Center
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.6, maxWidth: '500px' }}>
              Quản lý sản phẩm, nội dung và kênh đăng từ một nơi duy nhất. Hệ thống đang hoạt động trong chế độ an toàn.
            </p>
          </div>
          <div className="command-hero-panel">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', minWidth: '240px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-success)', display: 'inline-block' }}></span>
                Safe Mode ON
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-success)', display: 'inline-block' }}></span>
                Free Only ON
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--text-tertiary)', display: 'inline-block' }}></span>
                Auto Publish OFF
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-success)', display: 'inline-block' }}></span>
                API Health
              </div>
            </div>
          </div>
        </div>

        {/* Stat Cards */}
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
            <div className="stat-card-icon" style={{ background: 'rgba(124, 58, 237, 0.12)', color: '#8b5cf6' }}>🌐</div>
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
          <Link href="/dashboard/token-vault" className="quick-action-btn">
            <span className="quick-action-icon">🔐</span>
            Token Vault
          </Link>
          <Link href="/dashboard/app-health" className="quick-action-btn">
            <span className="quick-action-icon">💚</span>
            Sức khỏe hệ thống
          </Link>
        </div>

        {/* Workflow + Tips */}
        <div className="grid grid-2" style={{ marginBottom: 'var(--space-xl)' }}>
          {/* Workflow */}
          <div className="gradient-card">
            <h3 className="card-title" style={{ marginBottom: 'var(--space-md)' }}>📋 Quy trình làm việc</h3>
            <ul className="workflow-list">
              <li>
                <span className="workflow-step">1</span>
                <span>Thêm sản phẩm từ nguồn affiliate hoặc thủ công</span>
              </li>
              <li>
                <span className="workflow-step">2</span>
                <span>Chấm điểm sản phẩm bằng AI</span>
              </li>
              <li>
                <span className="workflow-step">3</span>
                <span>Duyệt sản phẩm đạt tiêu chuẩn</span>
              </li>
              <li>
                <span className="workflow-step">4</span>
                <span>Tạo nội dung cho sản phẩm đã duyệt</span>
              </li>
              <li>
                <span className="workflow-step">5</span>
                <span>Xuất gói nội dung để đăng</span>
              </li>
            </ul>
          </div>

          {/* Tips */}
          <div className="gradient-card">
            <h3 className="card-title" style={{ marginBottom: 'var(--space-md)' }}>💡 Mẹo sử dụng</h3>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <p style={{ marginBottom: '12px' }}>
                <strong style={{ color: 'var(--text-primary)' }}>Quy trình an toàn:</strong> Thêm sản phẩm → chấm điểm → duyệt → tạo nội dung → xuất gói nội dung.
              </p>
              <p style={{ marginBottom: '12px' }}>
                <strong style={{ color: 'var(--text-primary)' }}>Safe Mode đang bật:</strong> Hệ thống sẽ không tự động xuất bản hoặc tạo nội dung mà chưa được duyệt.
              </p>
              <p>
                <strong style={{ color: 'var(--text-primary)' }}>Free Only đang bật:</strong> Chỉ sử dụng các tính năng miễn phí, không gọi API có phí.
              </p>
            </div>
          </div>
        </div>

        {/* Info */}
        <div className="disclosure-banner">
          💡 <strong>Bắt đầu:</strong> Thêm sản phẩm từ <Link href="/dashboard/product-sources" style={{color: 'var(--color-primary-light)'}}>Trung tâm nguồn sản phẩm</Link>, sau đó chấm điểm và duyệt trước khi tạo nội dung.
        </div>
      </div>
    </>
  );
}
