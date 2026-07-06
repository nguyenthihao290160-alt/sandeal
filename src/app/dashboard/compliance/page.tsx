import Link from 'next/link';

export default function CompliancePage() {
  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Compliance Guard</div>
        <div className="safe-mode-badges">
          <span className="safe-badge safe-badge-on">🔒 Safe Mode</span>
          <span className="safe-badge safe-badge-on">💰 Free Only</span>
          <span className="safe-badge safe-badge-off">📤 Auto Publish: OFF</span>
        </div>
      </div>
      <div className="module-placeholder">
        <div className="module-hero">
          <span className="module-hero-icon">🛡️</span>
          <h1 className="module-hero-title">Compliance Guard</h1>
          <p className="module-hero-desc">
            Kiểm duyệt nội dung trước khi đăng. Phát hiện từ ngữ rủi ro, claim quá đà, vi phạm quảng cáo và cảnh báo an toàn.
          </p>
          <div className="module-hero-badges">
            <span className="safe-badge safe-badge-on">🛡️ Content Safety</span>
            <span className="safe-badge safe-badge-on">💰 Free Only: ON</span>
          </div>
          <div className="module-hero-actions">
            <Link href="/dashboard/content" className="btn btn-primary">🤖 AI Content Studio</Link>
            <Link href="/dashboard" className="btn btn-secondary">🎯 Command Center</Link>
          </div>
        </div>
        <div className="module-features">
          <div className="module-feature">
            <div className="module-feature-icon">⚠️</div>
            <div className="module-feature-title">Từ ngữ rủi ro</div>
            <div className="module-feature-desc">Phát hiện từ ngữ vi phạm chính sách quảng cáo: &quot;đảm bảo&quot;, &quot;cam kết&quot;, &quot;100% hiệu quả&quot;.</div>
          </div>
          <div className="module-feature">
            <div className="module-feature-icon">📋</div>
            <div className="module-feature-title">Claim Check</div>
            <div className="module-feature-desc">Kiểm tra lời khẳng định quá đà về sức khỏe, tài chính, hiệu quả sản phẩm.</div>
          </div>
          <div className="module-feature">
            <div className="module-feature-icon">✅</div>
            <div className="module-feature-title">Affiliate Disclosure</div>
            <div className="module-feature-desc">Đảm bảo nội dung có disclaimer affiliate minh bạch theo quy định.</div>
          </div>
        </div>
      </div>
    </>
  );
}
