import Link from 'next/link';

export default function MediaPage() {
  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Media / Video</div>
      </div>
      <div className="coming-soon-container">
        <div className="coming-soon-card">
          <span className="coming-soon-icon">🎬</span>
          <h2 className="coming-soon-title">Media / Video</h2>
          <p className="coming-soon-desc">
            Quản lý hình ảnh, video và tài liệu sáng tạo cho nội dung affiliate. Upload, chỉnh sửa và tổ chức media theo sản phẩm hoặc chiến dịch.
          </p>
          <div className="coming-soon-badges">
            <span className="safe-badge safe-badge-on">Safe Mode: ON</span>
          </div>
          <div className="coming-soon-actions">
            <Link href="/dashboard/content" className="btn btn-primary">🤖 AI Content</Link>
            <Link href="/dashboard" className="btn btn-secondary">📊 Dashboard</Link>
          </div>
        </div>
      </div>
    </>
  );
}
