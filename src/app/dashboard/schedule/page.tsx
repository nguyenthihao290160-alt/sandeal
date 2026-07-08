import Link from 'next/link';

export default function SchedulePage() {
  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Lịch đăng</div>
        <div className="safe-mode-badges">
          <span className="safe-badge safe-badge-on">🔒 Safe Mode</span>
          <span className="safe-badge safe-badge-on">💰 Free Only</span>
          <span className="safe-badge safe-badge-on">🚀 Safe Publish ON</span>
        </div>
      </div>
      <div className="module-placeholder">
        <div className="module-hero">
          <span className="module-hero-icon">📅</span>
          <h1 className="module-hero-title">Lịch đăng</h1>
          <p className="module-hero-desc">
            Lên lịch xuất bản nội dung, nhắc đăng bài và quản lý thời gian xuất bản tối ưu cho từng kênh.
          </p>
          <div className="module-hero-badges">
            <span className="safe-badge safe-badge-on">📅 Scheduling</span>
            <span className="safe-badge safe-badge-on">🚀 Safe Publish ON</span>
          </div>
          <div className="module-hero-actions">
            <Link href="/dashboard/channels" className="btn btn-primary">📡 Kênh kết nối</Link>
            <Link href="/dashboard/queue" className="btn btn-secondary">⏳ Hàng đợi</Link>
          </div>
        </div>
        <div className="module-features">
          <div className="module-feature">
            <div className="module-feature-icon">🗓️</div>
            <div className="module-feature-title">Lịch calendar</div>
            <div className="module-feature-desc">Xem lịch xuất bản theo tuần/tháng, kéo thả để thay đổi thời gian.</div>
          </div>
          <div className="module-feature">
            <div className="module-feature-icon">⏰</div>
            <div className="module-feature-title">Nhắc đăng bài</div>
            <div className="module-feature-desc">Nhận thông báo nhắc đăng bài khi đến giờ, không bỏ lỡ golden hour.</div>
          </div>
          <div className="module-feature">
            <div className="module-feature-icon">📊</div>
            <div className="module-feature-title">Thời gian tối ưu</div>
            <div className="module-feature-desc">Gợi ý thời gian đăng tốt nhất dựa trên thống kê tương tác của từng kênh.</div>
          </div>
        </div>
      </div>
    </>
  );
}
