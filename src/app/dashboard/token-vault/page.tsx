'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type {
  SafeCredential,
  CredentialGroup,
  CredentialPlatform,
  CredentialType,
  CredentialRole,
} from '@/lib/types/tokenVault';
import {
  PLATFORM_CONFIG,
  CREDENTIAL_TYPE_LABELS,
  CREDENTIAL_STATUS_LABELS,
  CREDENTIAL_ROLE_LABELS,
} from '@/lib/types/tokenVault';

// ---- Platform → default credential types ----
const PLATFORM_TYPES: Record<string, CredentialType[]> = {
  gemini: ['api_key'],
  accesstrade: ['api_key'],
  facebook: ['user_token', 'page_token'],
  instagram: ['access_token'],
  threads: ['access_token'],
  youtube: ['api_key', 'client_id', 'client_secret'],
  tiktok: ['client_id', 'client_secret'],
  shopee: ['client_id', 'client_secret'],
  lazada: ['client_id', 'client_secret'],
  system: ['app_secret', 'other'],
  other: ['api_key', 'other'],
};

const GROUP_ORDER = ['AI Providers', 'Affiliate Sources', 'Social Channels', 'System'];

interface FormState {
  platform: CredentialPlatform;
  credentialType: CredentialType;
  label: string;
  value: string;
  role: CredentialRole;
  metadata: string;
}

const EMPTY_FORM: FormState = {
  platform: 'gemini',
  credentialType: 'api_key',
  label: '',
  value: '',
  role: 'backup',
  metadata: '',
};

export default function TokenVaultPage() {
  const [groups, setGroups] = useState<CredentialGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: string; message: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [showValue, setShowValue] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [replaceId, setReplaceId] = useState<string | null>(null);
  const [replaceValue, setReplaceValue] = useState('');
  const [testingAll, setTestingAll] = useState(false);

  const showToast = useCallback((type: string, message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 5000);
  }, []);

  // ---- Load credentials ----
  const loadCredentials = useCallback(async () => {
    try {
      const res = await fetch('/api/token-vault/list');
      const data = await res.json();
      if (data.ok && data.data?.groups) {
        setGroups(data.data.groups);
      }
    } catch {
      showToast('error', 'Không thể tải danh sách credentials.');
    }
    setLoading(false);
  }, [showToast]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadCredentials(), 0);
    return () => window.clearTimeout(timer);
  }, [loadCredentials]);

  // ---- Form handlers ----
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setForm(prev => {
      const updated = { ...prev, [name]: value };
      // Auto-set credential type when platform changes
      if (name === 'platform') {
        const types = PLATFORM_TYPES[value] || ['api_key'];
        updated.credentialType = types[0];
      }
      return updated;
    });
  };

  const handleSave = async (andTest = false) => {
    if (!form.value.trim()) {
      showToast('error', 'Giá trị token/API key là bắt buộc.');
      return;
    }

    setSaving(true);
    try {
      let metadataObj: Record<string, unknown> | undefined;
      if (form.metadata.trim()) {
        try {
          metadataObj = JSON.parse(form.metadata);
        } catch {
          showToast('error', 'Metadata phải là JSON hợp lệ.');
          setSaving(false);
          return;
        }
      }

      const res = await fetch('/api/token-vault/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: form.platform,
          credentialType: form.credentialType,
          label: form.label || undefined,
          value: form.value,
          role: form.role,
          metadata: metadataObj,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast('success', data.message || 'Đã lưu credential.');
        setForm(EMPTY_FORM);
        setShowForm(false);
        setShowValue(false);
        await loadCredentials();

        // Auto-test if requested
        if (andTest && data.data?.id) {
          handleTest(data.data.id);
        }
      } else {
        showToast('error', data.message || 'Không thể lưu.');
      }
    } catch {
      showToast('error', 'Lỗi kết nối.');
    } finally {
      setSaving(false);
    }
  };

  // ---- Actions ----
  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const res = await fetch('/api/token-vault/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      showToast(data.ok && data.data?.status === 'valid' ? 'success' : 'warning', data.message || 'Đã kiểm tra.');
      await loadCredentials();
    } catch {
      showToast('error', 'Lỗi khi kiểm tra.');
    } finally {
      setTestingId(null);
    }
  };

  const handleSetPrimary = async (id: string) => {
    try {
      const res = await fetch('/api/token-vault/set-primary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      showToast(data.ok ? 'success' : 'error', data.message);
      await loadCredentials();
    } catch {
      showToast('error', 'Lỗi kết nối.');
    }
  };

  const handleGenerationProbe = async (id: string) => {
    setTestingId(id);
    try {
      const res = await fetch('/api/token-vault/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const data = await res.json();
      showToast(data.ok && data.data?.generationStatus === 'available' ? 'success' : 'warning', data.message || 'Generation probe completed.');
      await loadCredentials();
    } catch { showToast('error', 'Generation probe failed.'); }
    finally { setTestingId(null); }
  };

  const handleTestAll = async () => {
    setTestingAll(true);
    try {
      const res = await fetch('/api/token-vault/test-all', { method: 'POST' });
      const data = await res.json(); showToast(data.ok ? 'success' : 'warning', data.message || 'Gemini key tests completed.');
      await loadCredentials();
    } catch { showToast('error', 'Gemini key tests failed.'); }
    finally { setTestingAll(false); }
  };

  const handleDisable = async (id: string) => {
    try {
      const res = await fetch('/api/token-vault/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      showToast(data.ok ? 'success' : 'error', data.message);
      await loadCredentials();
    } catch {
      showToast('error', 'Lỗi kết nối.');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch('/api/token-vault/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      showToast(data.ok ? 'success' : 'error', data.message);
      setDeleteConfirm(null);
      await loadCredentials();
    } catch {
      showToast('error', 'Lỗi kết nối.');
    }
  };

  const handleReplace = async (id: string) => {
    if (!replaceValue.trim()) {
      showToast('error', 'Giá trị mới là bắt buộc.');
      return;
    }
    try {
      const res = await fetch('/api/token-vault/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replaceId: id, value: replaceValue }),
      });
      const data = await res.json();
      showToast(data.ok ? 'success' : 'error', data.message);
      setReplaceId(null);
      setReplaceValue('');
      await loadCredentials();
    } catch {
      showToast('error', 'Lỗi kết nối.');
    }
  };

  // ---- Group credentials by section ----
  const groupedSections = GROUP_ORDER.map(sectionName => {
    const sectionGroups = groups.filter(g => {
      const config = PLATFORM_CONFIG[g.platform];
      return config?.group === sectionName;
    });
    return { name: sectionName, groups: sectionGroups };
  }).filter(s => s.groups.length > 0);

  const totalCredentials = groups.reduce((sum, g) => sum + g.credentials.length, 0);

  // ---- Render ----
  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Token Vault Security Center</div>
        <div className="safe-mode-badges">
          <span className="dashboard-status-badge success">Safe Mode: ON</span>
          <span className="dashboard-status-badge success">Free Only: ON</span>
          <span className="dashboard-status-badge success">Safe Publish ON</span>
          <span className="dashboard-status-badge success">Secrets Hidden</span>
        </div>
      </div>
      <div className="page-content">
        {/* Toast */}
        {toast && (
          <div className="toast-container">
            <div className={`toast toast-${toast.type}`}>
              {toast.message}
            </div>
          </div>
        )}

        {/* Delete Confirmation */}
        {deleteConfirm && (
          <div className="dialog-overlay" onClick={() => setDeleteConfirm(null)}>
            <div className="dialog" onClick={e => e.stopPropagation()}>
              <div className="dialog-title">Xác nhận xoá credential</div>
              <div className="dialog-message">
                Bạn chắc chắn muốn xoá credential này? Hành động không thể hoàn tác. Token/API key sẽ bị xoá vĩnh viễn.
              </div>
              <div className="dialog-actions">
                <button className="btn btn-secondary" onClick={() => setDeleteConfirm(null)}>Huỷ</button>
                <button className="btn btn-danger" onClick={() => handleDelete(deleteConfirm)}>Xoá credential</button>
              </div>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="page-header">
          <div>
            <h1 className="page-header-title">Token Vault Security Center</h1>
            <p className="page-header-desc">Quản lý API key và token bảo mật cho đội bot AI. Token luôn được che và không hiển thị thô.</p>
          </div>
          <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
            {showForm ? 'Đóng form' : '+ Thêm credential'}
          </button>
        </div>

        {/* Security Notice */}
        <div className="disclosure-banner" style={{ marginBottom: 'var(--space-lg)' }}>
          <strong>Bảo mật:</strong> Token/API key được mã hoá và lưu phía server. Giao diện chỉ hiển thị dạng rút gọn (VD: <code style={{ color: 'var(--color-primary-light)' }}>AIza****3456</code>). Không nhập App Secret vào ô công khai nếu chưa thật sự cần.
        </div>

        {/* Stats */}
        <div style={{ marginBottom: 'var(--space-md)', textAlign: 'right' }}>
          <button className="btn btn-secondary" disabled={testingAll} onClick={handleTestAll}>{testingAll ? 'Testing Gemini keys...' : 'Test All Gemini Keys'}</button>
        </div>
        <div className="grid grid-4" style={{ marginBottom: 'var(--space-xl)' }}>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'rgba(124,58,237,0.12)', color: '#8b5cf6' }}>V</div>
            <div className="stat-card-value">{totalCredentials}</div>
            <div className="stat-card-label">Tổng credentials</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'var(--color-info-bg)', color: 'var(--color-info)' }}>G</div>
            <div className="stat-card-value">{groups.find(g => g.platform === 'gemini')?.credentials.length ?? 0}</div>
            <div className="stat-card-label">Gemini keys</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'var(--color-success-bg)', color: 'var(--color-success)' }}>A</div>
            <div className="stat-card-value">
              {groups.filter(g => ['accesstrade', 'shopee', 'lazada'].includes(g.platform)).reduce((s, g) => s + g.credentials.length, 0)}
            </div>
            <div className="stat-card-label">Affiliate keys</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'var(--color-warning-bg)', color: 'var(--color-warning)' }}>S</div>
            <div className="stat-card-value">
              {groups.filter(g => ['facebook', 'instagram', 'threads', 'youtube', 'tiktok'].includes(g.platform)).reduce((s, g) => s + g.credentials.length, 0)}
            </div>
            <div className="stat-card-label">Social tokens</div>
          </div>
        </div>

        {/* Add Credential Form */}
        {showForm && (
          <div className="gradient-card" style={{ marginBottom: 'var(--space-xl)', maxWidth: '800px' }}>
            <h3 className="card-title" style={{ marginBottom: 'var(--space-lg)' }}>Thêm credential mới</h3>

            <fieldset className="form-fieldset">
              <legend className="form-legend">Thông tin credential</legend>
              <div className="form-row">
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="label">Nền tảng *</label>
                  <select className="select" name="platform" value={form.platform} onChange={handleChange}>
                    {Object.entries(PLATFORM_CONFIG).map(([key, config]) => (
                      <option key={key} value={key}>{config.icon} {config.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="label">Loại credential *</label>
                  <select className="select" name="credentialType" value={form.credentialType} onChange={handleChange}>
                    {(PLATFORM_TYPES[form.platform] || ['api_key']).map(type => (
                      <option key={type} value={type}>{CREDENTIAL_TYPE_LABELS[type]}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="label">Vai trò</label>
                  <select className="select" name="role" value={form.role} onChange={handleChange}>
                    <option value="primary">Chính (primary)</option>
                    <option value="backup">Dự phòng (backup)</option>
                    <option value="testing">Thử nghiệm (testing)</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="label">Nhãn (tuỳ chọn)</label>
                <input className="input" name="label" value={form.label} onChange={handleChange} placeholder="VD: Gemini Key #1, Facebook Page Token chính..." />
              </div>
            </fieldset>

            <fieldset className="form-fieldset">
              <legend className="form-legend">Giá trị bí mật</legend>
              <div className="form-group">
                <label className="label">Token / API Key *</label>
                <div style={{ position: 'relative' }}>
                  <input
                    className="input"
                    name="value"
                    type={showValue ? 'text' : 'password'}
                    value={form.value}
                    onChange={handleChange}
                    placeholder="Dán token/API key vào đây..."
                    style={{ paddingRight: '80px' }}
                    autoComplete="off"
                  />
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    onClick={() => setShowValue(!showValue)}
                    style={{ position: 'absolute', right: '4px', top: '50%', transform: 'translateY(-50%)' }}
                  >
                     {showValue ? 'Ẩn' : 'Xem'}
                  </button>
                </div>
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: '4px' }}>
                  Không dùng mật khẩu Gmail/GitHub làm API key. Không chia sẻ token công khai.
                </p>
              </div>
              <div className="form-group">
                <label className="label">Metadata (JSON, tuỳ chọn)</label>
                <textarea
                  className="textarea"
                  name="metadata"
                  value={form.metadata}
                  onChange={handleChange}
                  rows={2}
                  placeholder='{"note": "Key cho dự án SanDeal"}'
                  style={{ minHeight: '60px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
                />
              </div>
            </fieldset>

            <div className="form-actions">
              <button className="btn btn-primary" disabled={saving} onClick={() => handleSave(false)}>
                {saving ? 'Đang lưu...' : 'Lưu credential'}
              </button>
              <button className="btn btn-accent" disabled={saving} onClick={() => handleSave(true)}>
                {saving ? '...' : 'Lưu và kiểm tra'}
              </button>
              <button className="btn btn-ghost" onClick={() => { setForm(EMPTY_FORM); setShowValue(false); }}>
                Xoá form
              </button>
            </div>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="loading-state"><div className="spinner"></div></div>
        )}

        {/* Credential Groups */}
        {!loading && groupedSections.map(section => (
          <div key={section.name} style={{ marginBottom: 'var(--space-xl)' }}>
            <h2 className="section-title">{section.name}</h2>
            <div className="grid grid-2" style={{ gap: 'var(--space-md)' }}>
              {section.groups.map(group => (
                <PlatformCard
                  key={group.platform}
                  group={group}
                  testingId={testingId}
                  replaceId={replaceId}
                  replaceValue={replaceValue}
                  onTest={handleTest}
                  onProbe={handleGenerationProbe}
                  onSetPrimary={handleSetPrimary}
                  onDisable={handleDisable}
                  onDelete={setDeleteConfirm}
                  onReplace={(id) => { setReplaceId(id); setReplaceValue(''); }}
                  onReplaceSubmit={handleReplace}
                  onReplaceCancel={() => { setReplaceId(null); setReplaceValue(''); }}
                  onReplaceValueChange={setReplaceValue}
                />
              ))}
            </div>
          </div>
        ))}

        {/* Empty state */}
        {!loading && totalCredentials === 0 && !showForm && (
          <div className="empty-state" style={{ marginTop: 'var(--space-xl)' }}>
            <div className="empty-state-icon" style={{ fontSize: '32px', opacity: 0.3 }}>V</div>
            <div className="empty-state-title">Chưa có credential nào</div>
            <div className="empty-state-desc">
              Thêm API key hoặc token để kết nối với các nền tảng. Bắt đầu bằng cách thêm Gemini API Key hoặc AccessTrade API Key.
            </div>
            <button className="btn btn-primary" style={{ marginTop: 'var(--space-lg)' }} onClick={() => setShowForm(true)}>
              + Thêm credential đầu tiên
            </button>
          </div>
        )}

        {/* Next module link */}
        <div className="disclosure-banner" style={{ marginTop: 'var(--space-xl)' }}>
          <strong>Tiếp theo:</strong>{' '}
          <Link href="/dashboard/content" style={{ color: 'var(--color-primary-light)' }}>
            Tạo nội dung bằng AI →
          </Link>{' '}
          (Cần có Gemini API Key đã cấu hình trong Token Vault)
        </div>
      </div>
    </>
  );
}

// ---- Platform Card Component ----

interface PlatformCardProps {
  group: CredentialGroup;
  testingId: string | null;
  replaceId: string | null;
  replaceValue: string;
  onTest: (id: string) => void;
  onProbe: (id: string) => void;
  onSetPrimary: (id: string) => void;
  onDisable: (id: string) => void;
  onDelete: (id: string) => void;
  onReplace: (id: string) => void;
  onReplaceSubmit: (id: string) => void;
  onReplaceCancel: () => void;
  onReplaceValueChange: (value: string) => void;
}

function PlatformCard({
  group,
  testingId,
  replaceId,
  replaceValue,
  onTest,
  onProbe,
  onSetPrimary,
  onDisable,
  onDelete,
  onReplace,
  onReplaceSubmit,
  onReplaceCancel,
  onReplaceValueChange,
}: PlatformCardProps) {
  const primary = group.credentials.find(c => c.role === 'primary');
  const hasCredentials = group.credentials.length > 0;

  return (
    <div className="glass-card" style={{ padding: 'var(--space-md)' }}>
      {/* Platform Header */}
      <div className="flex items-center justify-between" style={{ marginBottom: hasCredentials ? 'var(--space-md)' : 0 }}>
        <div className="flex items-center gap-sm">
          <span style={{ fontSize: '24px' }}>{group.icon}</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 'var(--text-sm)' }}>{group.label}</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
              {hasCredentials
                ? `${group.credentials.length} credential${group.credentials.length > 1 ? 's' : ''}`
                : 'Chưa cấu hình'}
            </div>
          </div>
        </div>
        {primary ? (
           <span className="badge badge-success" style={{ fontSize: '10px' }}>
             Đã kết nối
           </span>
        ) : hasCredentials ? (
          <span className="badge badge-warning" style={{ fontSize: '10px' }}>
            Chưa có primary
          </span>
        ) : (
          <span className="badge badge-neutral" style={{ fontSize: '10px' }}>
            Chưa có
          </span>
        )}
      </div>

      {/* Primary credential preview */}
      {primary && (
        <div style={{
          background: 'rgba(148,163,184,0.04)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-sm) var(--space-md)',
          marginBottom: hasCredentials && group.credentials.length > 1 ? 'var(--space-sm)' : 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          color: 'var(--text-secondary)',
        }}>
          {primary.maskedValue}
        </div>
      )}

      {/* Credentials list */}
      {group.credentials.map(cred => (
        <CredentialRow
          key={cred.id}
          cred={cred}
          testingId={testingId}
          replaceId={replaceId}
          replaceValue={replaceValue}
          onTest={onTest}
          onProbe={onProbe}
          onSetPrimary={onSetPrimary}
          onDisable={onDisable}
          onDelete={onDelete}
          onReplace={onReplace}
          onReplaceSubmit={onReplaceSubmit}
          onReplaceCancel={onReplaceCancel}
          onReplaceValueChange={onReplaceValueChange}
        />
      ))}
    </div>
  );
}

// ---- Credential Row Component ----

interface CredentialRowProps {
  cred: SafeCredential;
  testingId: string | null;
  replaceId: string | null;
  replaceValue: string;
  onTest: (id: string) => void;
  onProbe: (id: string) => void;
  onSetPrimary: (id: string) => void;
  onDisable: (id: string) => void;
  onDelete: (id: string) => void;
  onReplace: (id: string) => void;
  onReplaceSubmit: (id: string) => void;
  onReplaceCancel: () => void;
  onReplaceValueChange: (value: string) => void;
}

function CredentialRow({
  cred,
  testingId,
  replaceId,
  replaceValue,
  onTest,
  onProbe,
  onSetPrimary,
  onDisable,
  onDelete,
  onReplace,
  onReplaceSubmit,
  onReplaceCancel,
  onReplaceValueChange,
}: CredentialRowProps) {
  const statusConfig = CREDENTIAL_STATUS_LABELS[cred.status];
  const roleConfig = CREDENTIAL_ROLE_LABELS[cred.role];
  const isTesting = testingId === cred.id;
  const isReplacing = replaceId === cred.id;

  return (
    <div style={{
      borderTop: '1px solid var(--border-primary)',
      padding: 'var(--space-sm) 0',
      marginTop: 'var(--space-sm)',
    }}>
      <div className="flex items-center justify-between" style={{ gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="flex items-center gap-xs" style={{ flexWrap: 'wrap', marginBottom: '4px' }}>
            <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{cred.label}</span>
            <span className={`badge ${roleConfig.badge}`} style={{ fontSize: '9px', padding: '2px 6px' }}>
              {roleConfig.label}
            </span>
            <span className={`badge ${statusConfig.badge}`} style={{ fontSize: '9px', padding: '2px 6px' }}>
              {statusConfig.label}
            </span>
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
            {CREDENTIAL_TYPE_LABELS[cred.credentialType]} · {cred.maskedValue}
          </div>
          {cred.lastCheckedAt && (
            <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
              Kiểm tra lần cuối: {new Date(cred.lastCheckedAt).toLocaleString('vi-VN')}
            </div>
          )}
          {cred.lastError && (
            <div style={{ fontSize: '10px', color: 'var(--color-danger)', marginTop: '2px' }}>
              ❌ {cred.lastError.slice(0, 100)}
            </div>
          )}
          {cred.permissions && cred.permissions.length > 0 && (
            <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
              Quyền: {cred.permissions.join(', ')}
            </div>
          )}
          {cred.platform === 'gemini' && (
            <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
              Project: {String(cred.metadata?.projectAlias || 'unset')} · Group: {String(cred.metadata?.quotaGroupId || 'unset')} · Billing: {String(cred.metadata?.billingMode || 'unknown')}<br />
              Key type: {String(cred.metadata?.keyType || 'unknown')} · Generation: {String(cred.metadata?.generationStatus || 'unchecked')} · Model: {String(cred.metadata?.preferredModel || 'unset')}<br />
              Cooldown: {cred.metadata?.cooldownUntil ? new Date(String(cred.metadata.cooldownUntil)).toLocaleString('vi-VN') : 'none'} · Requests: {String(cred.metadata?.requestsTodayEstimated || 0)}
            </div>
          )}
        </div>
        <div className="flex gap-xs" style={{ flexShrink: 0, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => onTest(cred.id)} disabled={isTesting} title="Kiểm tra">
            {isTesting ? '...' : 'Test'}
          </button>
          {cred.platform === 'gemini' && <button className="btn btn-ghost btn-sm" onClick={() => onProbe(cred.id)} disabled={isTesting}>Generation Probe</button>}
          {cred.role !== 'primary' && cred.role !== 'disabled' && (
            <button className="btn btn-ghost btn-sm" onClick={() => onSetPrimary(cred.id)} title="Đặt làm chính">
              Set Primary
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => onReplace(cred.id)} title="Thay thế">
            Replace
          </button>
          {cred.role !== 'disabled' && (
            <button className="btn btn-ghost btn-sm" onClick={() => onDisable(cred.id)} title="Tắt">
              Disable
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => onDelete(cred.id)} title="Xoá" style={{ color: 'var(--color-danger)' }}>
            Del
          </button>
        </div>
      </div>

      {/* Replace inline form */}
      {isReplacing && (
        <div className="flex gap-sm items-center" style={{ marginTop: 'var(--space-sm)' }}>
          <input
            className="input"
            type="password"
            placeholder="Dán giá trị mới..."
            value={replaceValue}
            onChange={e => onReplaceValueChange(e.target.value)}
            style={{ flex: 1 }}
            autoComplete="off"
          />
          <button className="btn btn-primary btn-sm" onClick={() => onReplaceSubmit(cred.id)}>Cập nhật</button>
          <button className="btn btn-ghost btn-sm" onClick={onReplaceCancel}>Huỷ</button>
        </div>
      )}
    </div>
  );
}
