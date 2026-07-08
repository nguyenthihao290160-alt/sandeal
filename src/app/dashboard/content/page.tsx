import Link from 'next/link';

export default function ContentPage() {
  return (
    <>
      <div className="topbar">
        <div className="topbar-title">AI Content Studio</div>
        <div className="safe-mode-badges">
          <span className="safe-badge safe-badge-on">🔒 Safe Mode</span>
          <span className="safe-badge safe-badge-on">💰 Free Only</span>
          <span className="safe-badge safe-badge-on">🚀 Safe Publish ON</span>
        </div>
      </div>
      <div className="module-placeholder">
        <div className="module-hero">
          <span className="module-hero-icon">🤖</span>
          <h1 className="module-hero-title">AI Content Studio</h1>
          <p className="module-hero-desc">
            Tạo bài viết review, caption social, hook và script video bằng Gemini AI. Mỗi nội dung phải qua kiểm duyệt trước khi xuất bản.
          </p>
          <div className="module-hero-badges">
            <span className="safe-badge safe-badge-on">🤖 Gemini AI</span>
            <span className="badge badge-info">Cần Gemini API Key</span>
            <span className="safe-badge safe-badge-on">💰 Free Only: ON</span>
          </div>
          <div className="module-hero-actions">
            <Link href="/dashboard/token-vault" className="btn btn-primary">🔐 Cấu hình Gemini Key</Link>
            <Link href="/dashboard/products" className="btn btn-secondary">📦 Chọn sản phẩm</Link>
          </div>
        </div>
        <div className="module-features">
          <div className="module-feature">
            <div className="module-feature-icon">📝</div>
            <div className="module-feature-title">Tạo bài viết review</div>
            <div className="module-feature-desc">Viết bài review chi tiết dựa trên dữ liệu sản phẩm, điểm số và góc nội dung.</div>
          </div>
          <div className="module-feature">
            <div className="module-feature-icon">💬</div>
            <div className="module-feature-title">Caption & Hook</div>
            <div className="module-feature-desc">Tạo caption Facebook/Instagram, hook video TikTok, và CTA chuyển đổi cao.</div>
          </div>
          <div className="module-feature">
            <div className="module-feature-icon">📋</div>
            <div className="module-feature-title">Script video</div>
            <div className="module-feature-desc">Script video từng scene, kèm prompt hình ảnh/video cho từng phân đoạn.</div>
          </div>
        </div>
      </div>
    </>
  );
}
