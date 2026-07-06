import Link from 'next/link';

export default function CompliancePage() {
  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Kiểm duyệt nội dung</div>
        <div className="safe-mode-badges">
          <span className="safe-badge safe-badge-on">🔒 Safe Mode: ON</span>
        </div>
      </div>
      <div className="coming-soon-container">
        <div className="coming-soon-card">
          <span className="coming-soon-icon">🛡️</span>
          <h2 className="coming-soon-title">Kiểm duyệt nội dung</h2>
          <p className="coming-soon-desc">
            Kiểm tra nội dung trước khi xuất bản: phát hiện lời quá mức, thiếu disclosure affiliate, vi phạm quy định. Đảm bảo mọi nội dung đều an toàn và minh bạch.
          </p>
          <div className="coming-soon-badges">
            <span className="safe-badge safe-badge-on">Safe Mode: ON</span>
            <span className="safe-badge safe-badge-off">Auto Publish: OFF</span>
          </div>
          <div className="coming-soon-actions">
            <Link href="/dashboard/content" className="btn btn-primary">🤖 AI Content</Link>
            <Link href="/dashboard/products" className="btn btn-secondary">📦 Sản phẩm</Link>
          </div>
        </div>
      </div>
    </>
  );
}
