import Link from 'next/link';

export default function SchedulePage() {
  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Lịch đăng</div>
      </div>
      <div className="coming-soon-container">
        <div className="coming-soon-card">
          <span className="coming-soon-icon">📅</span>
          <h2 className="coming-soon-title">Lịch đăng</h2>
          <p className="coming-soon-desc">
            Lên lịch đăng nội dung trên nhiều nền tảng. Xem lịch, chỉnh sửa, huỷ hoặc dời bài đăng. Tất cả đều cần xác nhận trước khi đăng.
          </p>
          <div className="coming-soon-badges">
            <span className="safe-badge safe-badge-on">Safe Mode: ON</span>
            <span className="safe-badge safe-badge-off">Auto Publish: OFF</span>
          </div>
          <div className="coming-soon-actions">
            <Link href="/dashboard/content" className="btn btn-primary">🤖 Tạo nội dung trước</Link>
            <Link href="/dashboard/channels" className="btn btn-secondary">📡 Kết nối kênh</Link>
          </div>
        </div>
      </div>
    </>
  );
}
