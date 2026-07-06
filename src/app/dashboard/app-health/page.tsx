'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

interface HealthData {
  app: { name: string; engine: string; url: string };
  safeMode: {
    costMode: string;
    allowPaidAi: boolean;
    autoPublishEnabled: boolean;
    allowPublishingApi: boolean;
  };
  products: {
    storageType: string;
    storageStatus: string;
    total: number;
    draft: number;
    needsReview: number;
    approved: number;
    published: number;
    archived: number;
  };
  integrations: {
    accesstrade: { configured: boolean };
  };
  tokenVault: {
    storageStatus: string;
    totalCredentials: number;
    geminiKeysCount?: number;
    geminiPrimaryConfigured?: boolean;
    accessTradeConfigured?: boolean;
    socialTokensCount?: number;
    affiliateKeysCount?: number;
    disabledCount?: number;
    errorCount?: number;
    lastCheckTime?: string;
  };
  timestamp: string;
}

export default function AppHealthPage() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/app-health');
      const data = await res.json();
      if (data.ok) {
        setHealth(data.data);
      } else {
        setError(data.message || 'Không thể tải trạng thái.');
      }
    } catch {
      setError('Lỗi kết nối.');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadHealth();
  }, [loadHealth]);

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Sức khỏe hệ thống</div>
        <div className="safe-mode-badges">
          <span className="safe-badge safe-badge-on">🔒 Safe Mode: ON</span>
          <span className="safe-badge safe-badge-on">💰 Free Only: ON</span>
          <span className="safe-badge safe-badge-off">📤 Auto Publish: OFF</span>
        </div>
      </div>
      <div className="page-content">
        <div className="page-header">
          <div>
            <h1 className="page-header-title">💚 Sức khỏe hệ thống</h1>
            <p className="page-header-desc">Theo dõi trạng thái hệ thống, API, dữ liệu và token vault.</p>
          </div>
          <button className="btn btn-secondary" onClick={() => { setLoading(true); loadHealth(); }}>
            🔄 Làm mới
          </button>
        </div>

        {loading && <div className="loading-state"><div className="spinner"></div></div>}

        {error && (
          <div className="glass-card" style={{ borderColor: 'rgba(244,63,94,0.3)', marginBottom: 'var(--space-lg)' }}>
            <p style={{ color: 'var(--color-danger)' }}>❌ {error}</p>
          </div>
        )}

        {health && (
          <>
            {/* App Info */}
            <div className="command-hero" style={{ marginBottom: 'var(--space-xl)' }}>
              <div className="command-hero-content">
                <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 800, marginBottom: '8px' }}>
                  {health.app.name} · {health.app.engine}
                </h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
                  {health.app.url}
                </p>
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: '8px' }}>
                  Cập nhật: {new Date(health.timestamp).toLocaleString('vi-VN')}
                </p>
              </div>
              <div className="command-hero-panel">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', minWidth: '240px' }}>
                  <StatusDot label="Safe Mode" on={health.safeMode.costMode === 'free_only'} />
                  <StatusDot label="Free Only" on={!health.safeMode.allowPaidAi} />
                  <StatusDot label="Auto Publish" on={health.safeMode.autoPublishEnabled} inverted />
                  <StatusDot label="Publishing API" on={health.safeMode.allowPublishingApi} inverted />
                </div>
              </div>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-4" style={{ marginBottom: 'var(--space-xl)' }}>
              <div className="stat-card">
                <div className="stat-card-icon" style={{ background: 'var(--color-info-bg)', color: 'var(--color-info)' }}>📦</div>
                <div className="stat-card-value">{health.products.total}</div>
                <div className="stat-card-label">Tổng sản phẩm</div>
              </div>
              <div className="stat-card">
                <div className="stat-card-icon" style={{ background: 'var(--color-success-bg)', color: 'var(--color-success)' }}>✅</div>
                <div className="stat-card-value">{health.products.published}</div>
                <div className="stat-card-label">Đã xuất bản</div>
              </div>
              <div className="stat-card">
                <div className="stat-card-icon" style={{ background: 'rgba(124,58,237,0.12)', color: '#8b5cf6' }}>🔐</div>
                <div className="stat-card-value">{health.tokenVault.totalCredentials}</div>
                <div className="stat-card-label">Token Vault</div>
              </div>
              <div className="stat-card">
                <div className="stat-card-icon" style={{ background: 'var(--color-warning-bg)', color: 'var(--color-warning)' }}>🔍</div>
                <div className="stat-card-value">{health.products.needsReview}</div>
                <div className="stat-card-label">Cần xem xét</div>
              </div>
            </div>

            {/* Details */}
            <div className="grid grid-2">
              {/* Product Storage */}
              <div className="glass-card">
                <h3 className="card-title" style={{ marginBottom: 'var(--space-md)' }}>📦 Sản phẩm</h3>
                <div className="detail-meta">
                  <div className="detail-meta-row"><span>Storage:</span><span>{health.products.storageType}</span></div>
                  <div className="detail-meta-row"><span>Trạng thái:</span><span className="badge badge-success">{health.products.storageStatus}</span></div>
                  <div className="detail-meta-row"><span>Nháp:</span><span>{health.products.draft}</span></div>
                  <div className="detail-meta-row"><span>Cần xem xét:</span><span>{health.products.needsReview}</span></div>
                  <div className="detail-meta-row"><span>Đã duyệt:</span><span>{health.products.approved}</span></div>
                  <div className="detail-meta-row"><span>Đã xuất bản:</span><span>{health.products.published}</span></div>
                  <div className="detail-meta-row"><span>Lưu trữ:</span><span>{health.products.archived}</span></div>
                </div>
              </div>

              {/* Token Vault */}
              <div className="glass-card">
                <h3 className="card-title" style={{ marginBottom: 'var(--space-md)' }}>🔐 Token Vault</h3>
                <div className="detail-meta">
                  <div className="detail-meta-row"><span>Trạng thái:</span><span className="badge badge-success">{health.tokenVault.storageStatus}</span></div>
                  <div className="detail-meta-row"><span>Tổng credentials:</span><span>{health.tokenVault.totalCredentials}</span></div>
                  <div className="detail-meta-row">
                    <span>Gemini keys:</span>
                    <span>{health.tokenVault.geminiKeysCount ?? 0}</span>
                  </div>
                  <div className="detail-meta-row">
                    <span>Gemini primary:</span>
                    <span className={`badge ${health.tokenVault.geminiPrimaryConfigured ? 'badge-success' : 'badge-neutral'}`}>
                      {health.tokenVault.geminiPrimaryConfigured ? 'Đã cấu hình' : 'Chưa có'}
                    </span>
                  </div>
                  <div className="detail-meta-row">
                    <span>AccessTrade:</span>
                    <span className={`badge ${health.tokenVault.accessTradeConfigured || health.integrations.accesstrade.configured ? 'badge-success' : 'badge-neutral'}`}>
                      {health.tokenVault.accessTradeConfigured || health.integrations.accesstrade.configured ? 'Đã cấu hình' : 'Chưa có'}
                    </span>
                  </div>
                  <div className="detail-meta-row"><span>Social tokens:</span><span>{health.tokenVault.socialTokensCount ?? 0}</span></div>
                  <div className="detail-meta-row"><span>Đã tắt:</span><span>{health.tokenVault.disabledCount ?? 0}</span></div>
                  <div className="detail-meta-row"><span>Lỗi:</span><span style={{ color: (health.tokenVault.errorCount ?? 0) > 0 ? 'var(--color-danger)' : undefined }}>{health.tokenVault.errorCount ?? 0}</span></div>
                  {health.tokenVault.lastCheckTime && (
                    <div className="detail-meta-row"><span>Kiểm tra cuối:</span><span>{new Date(health.tokenVault.lastCheckTime).toLocaleString('vi-VN')}</span></div>
                  )}
                </div>
                <Link href="/dashboard/token-vault" className="btn btn-secondary btn-sm" style={{ marginTop: 'var(--space-md)', width: '100%', textAlign: 'center' }}>
                  🔐 Mở Token Vault
                </Link>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function StatusDot({ label, on, inverted }: { label: string; on: boolean; inverted?: boolean }) {
  const isGood = inverted ? !on : on;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: isGood ? 'var(--color-success)' : 'var(--text-tertiary)',
        display: 'inline-block',
      }} />
      {label}: {on ? 'ON' : 'OFF'}
    </div>
  );
}
