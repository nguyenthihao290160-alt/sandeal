import Link from 'next/link';

export default function QueuePage() {
  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Hàng đợi</div>
        <div className="safe-mode-badges">
          <span className="safe-badge safe-badge-on">🔒 Safe Mode</span>
          <span className="safe-badge safe-badge-on">💰 Free Only</span>
          <span className="safe-badge safe-badge-on">🚀 Safe Publish ON</span>
        </div>
      </div>
      <div className="module-placeholder">
        <div className="module-hero">
          <span className="module-hero-icon">⏳</span>
          <h1 className="module-hero-title">Hàng đợi xuất bản</h1>
          <p className="module-hero-desc">
            Queue nội dung chờ đăng, xem lại lỗi, retry thất bại và duyệt nội dung trước khi xuất bản.
          </p>
          <div className="module-hero-badges">
            <span className="safe-badge safe-badge-on">⏳ Queue System</span>
            <span className="safe-badge safe-badge-on">🚀 Safe Publish ON</span>
          </div>
          <div className="module-hero-actions">
            <Link href="/dashboard/schedule" className="btn btn-primary">📅 Lịch đăng</Link>
            <Link href="/dashboard/content" className="btn btn-secondary">🤖 AI Content</Link>
          </div>
        </div>
        <div className="module-features">
          <div className="module-feature">
            <div className="module-feature-icon">📋</div>
            <div className="module-feature-title">Queue Management</div>
            <div className="module-feature-desc">Xem danh sách nội dung chờ đăng, sắp xếp ưu tiên và xem trước nội dung.</div>
          </div>
          <div className="module-feature">
            <div className="module-feature-icon">🔄</div>
            <div className="module-feature-title">Retry & Error</div>
            <div className="module-feature-desc">Tự động retry khi đăng thất bại, xem log lỗi chi tiết và sửa nội dung.</div>
          </div>
          <div className="module-feature">
            <div className="module-feature-icon">✅</div>
            <div className="module-feature-title">Duyệt cuối cùng</div>
            <div className="module-feature-desc">Xem lại toàn bộ nội dung lần cuối trước khi bấm xuất bản chính thức.</div>
          </div>
        </div>
      </div>
    </>
  );
}
