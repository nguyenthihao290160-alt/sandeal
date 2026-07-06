import Link from 'next/link';

export default function ChannelsPage() {
  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Kênh kết nối</div>
      </div>
      <div className="coming-soon-container">
        <div className="coming-soon-card">
          <span className="coming-soon-icon">📡</span>
          <h2 className="coming-soon-title">Kênh kết nối</h2>
          <p className="coming-soon-desc">
            Kết nối tài khoản mạng xã hội: Facebook, Instagram, TikTok, YouTube, Threads. Quản lý quyền truy cập, token và trạng thái kết nối.
          </p>
          <div className="coming-soon-badges">
            <span className="safe-badge safe-badge-on">Safe Mode: ON</span>
            <span className="safe-badge safe-badge-off">Auto Publish: OFF</span>
          </div>
          <div className="coming-soon-actions">
            <Link href="/dashboard/token-vault" className="btn btn-primary">🔐 Token Vault</Link>
            <Link href="/dashboard" className="btn btn-secondary">📊 Dashboard</Link>
          </div>
        </div>
      </div>
    </>
  );
}
