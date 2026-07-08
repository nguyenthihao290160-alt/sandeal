import Link from 'next/link';

export default function MediaPage() {
  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Media / Video Studio</div>
        <div className="safe-mode-badges">
          <span className="safe-badge safe-badge-on">🔒 Safe Mode</span>
          <span className="safe-badge safe-badge-on">💰 Free Only</span>
          <span className="safe-badge safe-badge-on">🚀 Safe Publish ON</span>
        </div>
      </div>
      <div className="module-placeholder">
        <div className="module-hero">
          <span className="module-hero-icon">🎬</span>
          <h1 className="module-hero-title">Media / Video Studio</h1>
          <p className="module-hero-desc">
            Lên kịch bản video, tạo scene plan, prompt ảnh/video và chuẩn bị tài liệu sản xuất nội dung đa phương tiện.
          </p>
          <div className="module-hero-badges">
            <span className="safe-badge safe-badge-on">🎬 Video Pipeline</span>
            <span className="safe-badge safe-badge-on">💰 Free Only: ON</span>
          </div>
          <div className="module-hero-actions">
            <Link href="/dashboard/content" className="btn btn-primary">🤖 AI Content Studio</Link>
            <Link href="/dashboard/products" className="btn btn-secondary">📦 Chọn sản phẩm</Link>
          </div>
        </div>
        <div className="module-features">
          <div className="module-feature">
            <div className="module-feature-icon">📹</div>
            <div className="module-feature-title">Kịch bản video</div>
            <div className="module-feature-desc">Tạo kịch bản video từ dữ liệu sản phẩm, chia scene và gợi ý hình ảnh minh hoạ.</div>
          </div>
          <div className="module-feature">
            <div className="module-feature-icon">🖼️</div>
            <div className="module-feature-title">Prompt ảnh AI</div>
            <div className="module-feature-desc">Tạo prompt DALL·E/Midjourney cho thumbnail, banner và visual content.</div>
          </div>
          <div className="module-feature">
            <div className="module-feature-icon">📐</div>
            <div className="module-feature-title">Scene Plan</div>
            <div className="module-feature-desc">Lên kế hoạch từng cảnh quay, thời lượng, lời thoại và B-roll gợi ý.</div>
          </div>
        </div>
      </div>
    </>
  );
}
