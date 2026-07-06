import Link from 'next/link';

export default function ContentPage() {
  return (
    <>
      <div className="topbar">
        <div className="topbar-title">AI Content</div>
        <div className="safe-mode-badges">
          <span className="safe-badge safe-badge-on">🔒 Safe Mode: ON</span>
        </div>
      </div>
      <div className="coming-soon-container">
        <div className="coming-soon-card">
          <span className="coming-soon-icon">🤖</span>
          <h2 className="coming-soon-title">AI Content</h2>
          <p className="coming-soon-desc">
            Tạo nội dung tự động cho sản phẩm affiliate: review, so sánh, deal alert, caption, hashtag, script video ngắn. AI sẽ tạo nội dung tuân thủ và phù hợp với từng nền tảng.
          </p>
          <div className="coming-soon-badges">
            <span className="safe-badge safe-badge-on">Safe Mode: ON</span>
            <span className="safe-badge safe-badge-on">Free Only: ON</span>
            <span className="safe-badge safe-badge-off">Auto Publish: OFF</span>
          </div>
          <div className="coming-soon-actions">
            <Link href="/dashboard/products" className="btn btn-primary">📦 Xem sản phẩm đã duyệt</Link>
            <Link href="/dashboard/product-sources" className="btn btn-secondary">🔗 Thêm sản phẩm mới</Link>
          </div>
        </div>
      </div>
    </>
  );
}
