import Link from 'next/link';

export default function ChannelsPage() {
  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Kênh kết nối</div>
        <div className="safe-mode-badges">
          <span className="safe-badge safe-badge-on">🔒 Safe Mode</span>
          <span className="safe-badge safe-badge-on">💰 Free Only</span>
          <span className="safe-badge safe-badge-off">📤 Auto Publish: OFF</span>
        </div>
      </div>
      <div className="module-placeholder">
        <div className="module-hero">
          <span className="module-hero-icon">📡</span>
          <h1 className="module-hero-title">Kênh kết nối</h1>
          <p className="module-hero-desc">
            Kết nối và quản lý các kênh đăng bài: Facebook Page, Instagram, Threads, TikTok, YouTube.
            Tất cả token được bảo mật trong Token Vault.
          </p>
          <div className="module-hero-badges">
            <span className="safe-badge safe-badge-on">📡 Multi-Channel</span>
            <span className="safe-badge safe-badge-off">📤 Auto Publish: OFF</span>
          </div>
          <div className="module-hero-actions">
            <Link href="/dashboard/token-vault" className="btn btn-primary">🔐 Token Vault</Link>
            <Link href="/dashboard/schedule" className="btn btn-secondary">📅 Lịch đăng</Link>
          </div>
        </div>
        <div className="module-features">
          <div className="module-feature">
            <div className="module-feature-icon">📘</div>
            <div className="module-feature-title">Facebook Page</div>
            <div className="module-feature-desc">Kết nối Page, kiểm tra quyền đăng bài và quản lý token dài hạn.</div>
          </div>
          <div className="module-feature">
            <div className="module-feature-icon">📸</div>
            <div className="module-feature-title">Instagram & Threads</div>
            <div className="module-feature-desc">Đăng bài qua Instagram Business API và Threads Publishing API.</div>
          </div>
          <div className="module-feature">
            <div className="module-feature-icon">🎵</div>
            <div className="module-feature-title">TikTok & YouTube</div>
            <div className="module-feature-desc">Chuẩn bị nội dung video, upload script và quản lý kênh video.</div>
          </div>
        </div>
      </div>
    </>
  );
}
