import Link from 'next/link';

export default function SettingsPage() {
  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Cài đặt</div>
        <div className="safe-mode-badges">
          <span className="safe-badge safe-badge-on">🔒 Safe Mode</span>
          <span className="safe-badge safe-badge-on">💰 Free Only</span>
          <span className="safe-badge safe-badge-off">📤 Auto Publish: OFF</span>
        </div>
      </div>
      <div className="module-placeholder">
        <div className="module-hero">
          <span className="module-hero-icon">⚙️</span>
          <h1 className="module-hero-title">Cài đặt hệ thống</h1>
          <p className="module-hero-desc">
            Cấu hình chung cho ReviewPilot AI: Safe Mode, chi phí, chuẩn bị đăng, ngôn ngữ mặc định và các thông số vận hành.
          </p>
          <div className="module-hero-badges">
            <span className="safe-badge safe-badge-on">🔒 Safe Mode: ON</span>
            <span className="safe-badge safe-badge-on">💰 Free Only: ON</span>
            <span className="safe-badge safe-badge-off">📤 Auto Publish: OFF</span>
          </div>
          <div className="module-hero-actions">
            <Link href="/dashboard/token-vault" className="btn btn-secondary">🔐 Token Vault</Link>
            <Link href="/dashboard/app-health" className="btn btn-secondary">💚 App Health</Link>
          </div>
        </div>
        <div className="module-features">
          <div className="module-feature">
            <div className="module-feature-icon">🛡️</div>
            <div className="module-feature-title">Safe Mode Control</div>
            <div className="module-feature-desc">Bật/tắt chế độ an toàn, kiểm soát chi phí và ngăn chặn đăng bài tự động.</div>
          </div>
          <div className="module-feature">
            <div className="module-feature-icon">🌐</div>
            <div className="module-feature-title">Ngôn ngữ & Khu vực</div>
            <div className="module-feature-desc">Cấu hình ngôn ngữ mặc định, múi giờ và đơn vị tiền tệ cho hệ thống.</div>
          </div>
          <div className="module-feature">
            <div className="module-feature-icon">📧</div>
            <div className="module-feature-title">Thông báo</div>
            <div className="module-feature-desc">Cài đặt cảnh báo email, webhook và lỗi hệ thống quan trọng.</div>
          </div>
        </div>
      </div>
    </>
  );
}
