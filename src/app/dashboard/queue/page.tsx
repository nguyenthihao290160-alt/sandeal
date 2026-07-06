import Link from 'next/link';

export default function QueuePage() {
  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Hàng đợi</div>
      </div>
      <div className="coming-soon-container">
        <div className="coming-soon-card">
          <span className="coming-soon-icon">⏳</span>
          <h2 className="coming-soon-title">Hàng đợi</h2>
          <p className="coming-soon-desc">
            Xem danh sách nội dung đang chờ duyệt, chờ đăng hoặc đang xử lý. Theo dõi trạng thái real-time và xử lý lỗi nhanh chóng.
          </p>
          <div className="coming-soon-badges">
            <span className="safe-badge safe-badge-on">Safe Mode: ON</span>
            <span className="safe-badge safe-badge-off">Auto Publish: OFF</span>
          </div>
          <div className="coming-soon-actions">
            <Link href="/dashboard/schedule" className="btn btn-primary">📅 Lịch đăng</Link>
            <Link href="/dashboard" className="btn btn-secondary">📊 Dashboard</Link>
          </div>
        </div>
      </div>
    </>
  );
}
