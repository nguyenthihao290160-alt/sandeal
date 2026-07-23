'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { DashboardIcon, type DashboardIconName } from '@/components/dashboard/dashboard-icon';
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
const GROUP_LABELS: Record<string, string> = {
  'AI Providers': 'Dịch vụ AI',
  'Affiliate Sources': 'Nguồn tiếp thị liên kết',
  'Social Channels': 'Kết nối mạng xã hội',
  System: 'Kết nối hệ thống',
};
const PLATFORM_ICONS: Record<CredentialPlatform, DashboardIconName> = {
  gemini: 'ai', accesstrade: 'source', shopee: 'product', lazada: 'product', tiktok: 'external',
  facebook: 'external', instagram: 'external', threads: 'external', youtube: 'external',
  system: 'settings', other: 'security',
};

const READINESS_REASON_LABELS: Record<NonNullable<SafeCredential['readiness']>['reasonCode'], string> = {
  ready: 'Generation probe đã xác minh model tạo nội dung.',
  not_applicable: 'Readiness tạo nội dung không áp dụng cho kết nối này.',
  credential_not_checked: 'Kết nối đã lưu nhưng chưa chạy kiểm tra hợp lệ.',
  credential_not_valid: 'Kết nối chưa có kết quả kiểm tra hợp lệ.',
  generation_not_verified: 'Khóa hợp lệ theo kiểm tra nhẹ; khả năng tạo nội dung chưa được xác minh.',
  generation_check_stale: 'Lần tạo nội dung thành công đã quá hạn xác minh; cần kiểm tra lại.',
  generation_temporarily_unavailable: 'Kiểm tra tạo nội dung gần nhất chưa thành công; hệ thống vẫn fail-closed.',
  cooldown_active: 'Kết nối đang trong thời gian chờ phục hồi.',
  quota_limited: 'Nhóm hạn mức hiện không cho phép tạo nội dung.',
  billing_not_confirmed: 'Chưa xác minh kết nối thuộc chính sách Free; hệ thống không định tuyến yêu cầu tạo.',
  free_policy_unverified: 'Chưa xác minh model đã thử thuộc chính sách Free-only.',
  quota_group_missing: 'Chưa cấu hình nhóm hạn mức cho định tuyến deterministic.',
  model_not_verified: 'Light Test chưa xác minh model tạo nội dung phù hợp.',
  model_not_available: 'Không tìm được model phù hợp hỗ trợ tạo nội dung.',
  region_restricted: 'Kết nối Gemini bị giới hạn theo khu vực.',
  provider_unavailable: 'Adapter có sẵn nhưng tuyến Gemini tạm thời chưa hoạt động.',
  invalid: 'Kết nối không hợp lệ theo lần kiểm tra gần nhất.',
  disabled: 'Kết nối đang bị tắt.',
  missing_permission: 'Kết nối thiếu quyền hoặc model tạo nội dung phù hợp.',
  unknown: 'Chưa có đủ metadata để xác minh khả năng tạo nội dung.',
};

const GEMINI_ERROR_LABELS: Record<string, string> = {
  INVALID_KEY: 'Lỗi cấu hình khóa',
  PERMISSION_DENIED: 'Thiếu quyền tạo nội dung',
  QUOTA_EXCEEDED: 'Đã hết hạn mức',
  RATE_LIMITED: 'Đang bị giới hạn tốc độ',
  MODEL_NOT_AVAILABLE: 'Mô hình không khả dụng',
  REGION_RESTRICTED: 'Khu vực bị hạn chế',
  NETWORK_TIMEOUT: 'Hết thời gian kết nối',
  PROVIDER_UNAVAILABLE: 'Nhà cung cấp tạm thời gián đoạn',
  TRANSIENT_ERROR: 'Lỗi nhà cung cấp tạm thời',
  UNKNOWN_PROVIDER_ERROR: 'Lỗi nhà cung cấp chưa xác định',
};

function geminiReadinessBadge(credential: SafeCredential): { label: string; badge: string } {
  const readiness = credential.readiness;
  const category = readiness?.diagnosticCategory || readiness?.errorCategory || String(credential.metadata?.diagnosticCategory || credential.metadata?.errorCategory || '');
  if (credential.role === 'disabled' || readiness?.state === 'disabled') return { label: 'Đã tắt', badge: 'badge-neutral' };
  if (readiness?.generationReady) return { label: 'Sẵn sàng tạo nội dung', badge: 'badge-success' };
  if (category === 'PERMISSION_DENIED' || readiness?.reasonCode === 'missing_permission') return { label: 'Lỗi quyền · Thiếu quyền tạo nội dung', badge: 'badge-danger' };
  if (category === 'QUOTA_EXCEEDED' || category === 'RATE_LIMITED') return { label: 'Hạn mức / tốc độ', badge: 'badge-warning' };
  if (['NETWORK_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'TRANSIENT_ERROR', 'UNKNOWN_PROVIDER_ERROR'].includes(category)) {
    return { label: 'Lỗi tạm thời', badge: 'badge-warning' };
  }
  if (category === 'INVALID_KEY' || readiness?.reasonCode === 'invalid') return { label: 'Lỗi cấu hình · Khóa không hợp lệ', badge: 'badge-danger' };
  if (category === 'MODEL_NOT_AVAILABLE' || readiness?.reasonCode === 'model_not_available' || readiness?.reasonCode === 'model_not_verified') {
    return { label: 'Lỗi cấu hình · Không tìm được model', badge: 'badge-warning' };
  }
  if (readiness?.reasonCode === 'free_policy_unverified' || readiness?.reasonCode === 'billing_not_confirmed') return { label: 'Chưa xác minh Free policy', badge: 'badge-warning' };
  if (readiness?.state === 'cooldown' || readiness?.state === 'quota_limited') return { label: 'Đang cooldown/hạn mức', badge: 'badge-warning' };
  if (['generation_temporarily_unavailable', 'provider_unavailable', 'region_restricted'].includes(String(readiness?.reasonCode))) return { label: 'Tạm thời chưa sẵn sàng', badge: 'badge-warning' };
  if (readiness?.valid) return { label: 'Khóa hợp lệ · Chưa generation-ready', badge: 'badge-warning' };
  return { label: 'Chưa kiểm tra', badge: 'badge-neutral' };
}

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
      showToast('error', 'Không thể tải danh sách kết nối bảo mật.');
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
      showToast('error', 'Giá trị khóa kết nối là bắt buộc.');
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
        showToast('success', data.message || 'Đã lưu kết nối.');
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
        body: JSON.stringify({ id, operationId: `credential-primary:${id}` }),
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
        body: JSON.stringify({ id, operationId: `credential-primary:${id}` }),
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
      showToast(data.ok && data.data?.generationReady ? 'success' : 'warning', data.message || 'Đã kiểm tra khả năng tạo nội dung.');
      await loadCredentials();
    } catch { showToast('error', 'Không thể kiểm tra khả năng tạo nội dung.'); }
    finally { setTestingId(null); }
  };

  const handleTestAll = async () => {
    setTestingAll(true);
    try {
      const res = await fetch('/api/token-vault/test-all', { method: 'POST' });
      const data = await res.json();
      const stats = data.data;
      const summary = data.ok && stats
        ? `${stats.total} kết nối · ${stats.validKeys} khóa hợp lệ · ${stats.generationReady} sẵn sàng · ${stats.permissionDenied} thiếu quyền · ${stats.invalidKey} khóa lỗi · ${stats.rateLimited} giới hạn tốc độ · ${stats.quotaExceeded} hết quota · ${stats.modelUnavailable} thiếu model · ${stats.freePolicyUnverified} chưa xác minh Free policy.`
        : data.message || 'Đã kiểm tra các kết nối Gemini.';
      showToast(data.ok && Number(stats?.generationReady || 0) > 0 ? 'success' : 'warning', summary);
      await loadCredentials();
    } catch { showToast('error', 'Không thể kiểm tra các kết nối Gemini.'); }
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

  const handlePriority = async (credential: SafeCredential, priority: number) => {
    if (!Number.isInteger(priority) || priority < 0 || priority > 10_000) {
      showToast('error', 'Priority phải là số nguyên từ 0 đến 10000.');
      return;
    }
    try {
      const res = await fetch('/api/token-vault/priority', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: credential.id, priority, operationId: `credential-priority:${credential.id}:${priority}` }) });
      const data = await res.json();
      showToast(data.ok ? 'success' : 'error', data.message || 'Không thể cập nhật priority.');
      if (data.ok) await loadCredentials();
    } catch { showToast('error', 'Không thể cập nhật priority.'); }
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
    return { name: GROUP_LABELS[sectionName] || sectionName, groups: sectionGroups };
  }).filter(s => s.groups.length > 0);

  const totalCredentials = groups.reduce((sum, g) => sum + g.credentials.length, 0);
  const geminiRows = groups.find(g => g.platform === 'gemini')?.credentials ?? [];
  const geminiCredentials = geminiRows.length;
  const geminiReady = geminiRows.filter(credential => credential.readiness?.generationReady).length;
  const geminiPrimary = geminiRows.find(credential => credential.role === 'primary');
  const geminiUnavailableReason = geminiReady === 0
    ? geminiRows.find(credential => credential.readiness)?.readiness?.reasonCode
    : null;

  // ---- Render ----
  return (
      <div className="token-vault-page">
        {/* Toast */}
        {toast && (
          <div className="toast-container">
            <div className={`toast toast-${toast.type}`}>
              {toast.message}
            </div>
          </div>
        )}

        {/* Header */}
        <div className="page-header dashboard-tinted-header">
          <div className="flex items-start gap-md">
            <span className="dashboard-page-icon"><DashboardIcon name="security" size={24} /></span>
            <div>
            <h1 className="page-header-title">Trung tâm kết nối bảo mật</h1>
            <p className="page-header-desc">Quản lý khóa kết nối cho dịch vụ AI và nguồn sản phẩm. Giá trị bí mật luôn được che trên giao diện.</p>
            <span className="badge badge-success" style={{ marginTop: 8 }}>Thông tin nhạy cảm luôn được che</span>
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
            {showForm ? 'Đóng biểu mẫu' : 'Thêm kết nối'}
          </button>
        </div>

        {/* Security Notice */}
        <div className="disclosure-banner" style={{ marginBottom: 'var(--space-lg)' }}>
          <strong>Bảo mật:</strong> Khóa kết nối được mã hóa và lưu phía máy chủ. Giao diện chỉ hiển thị dạng rút gọn. Không nhập thông tin bí mật vào trường công khai.
        </div>

        {/* Stats */}
        <div style={{ marginBottom: 'var(--space-md)', textAlign: 'right' }}>
          <button className="btn btn-secondary" disabled={testingAll || geminiCredentials === 0} title={geminiCredentials === 0 ? 'Cần thiết lập ít nhất một kết nối Gemini trước khi kiểm tra.' : 'Kiểm tra các kết nối Gemini đã lưu'} onClick={handleTestAll}>{testingAll ? 'Đang kiểm tra các kết nối Gemini...' : 'Kiểm tra các kết nối Gemini'}</button>
        </div>
        <div className="grid grid-4" style={{ marginBottom: 'var(--space-xl)' }}>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'var(--ds-surface-purple)', color: '#7c3aed' }}><DashboardIcon name="security" size={21} /></div>
            <div className="stat-card-value">{totalCredentials}</div>
            <div className="stat-card-label">Tổng kết nối</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'var(--ds-surface-blue)', color: 'var(--ds-info)' }}><DashboardIcon name="ai" size={21} /></div>
            <div className="stat-card-value">{geminiReady}/{geminiCredentials}</div>
            <div className="stat-card-label">Gemini generation-ready</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'var(--ds-surface-green)', color: 'var(--ds-success)' }}><DashboardIcon name="source" size={21} /></div>
            <div className="stat-card-value">
              {groups.filter(g => ['accesstrade', 'shopee', 'lazada'].includes(g.platform)).reduce((s, g) => s + g.credentials.length, 0)}
            </div>
            <div className="stat-card-label">Nguồn tiếp thị liên kết</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'var(--ds-surface-amber)', color: 'var(--ds-warning)' }}><DashboardIcon name="external" size={21} /></div>
            <div className="stat-card-value">
              {groups.filter(g => ['facebook', 'instagram', 'threads', 'youtube', 'tiktok'].includes(g.platform)).reduce((s, g) => s + g.credentials.length, 0)}
            </div>
            <div className="stat-card-label">Kết nối mạng xã hội</div>
          </div>
        </div>
        {geminiCredentials > 0 && (
          <div className="disclosure-banner" data-gemini-summary style={{ marginBottom: 'var(--space-lg)' }}>
            <strong>Gemini:</strong> {geminiReady}/{geminiCredentials} kết nối sẵn sàng tạo nội dung
            {' · '}Kết nối chính: {geminiPrimary ? geminiPrimary.label : 'chưa chọn'}
            {geminiUnavailableReason && (
              <> · {READINESS_REASON_LABELS[geminiUnavailableReason]}</>
            )}
          </div>
        )}

        {/* Add Credential Form */}
        {showForm && (
          <div className="card" style={{ marginBottom: 'var(--space-xl)', maxWidth: '800px' }}>
            <h3 className="card-title" style={{ marginBottom: 'var(--space-lg)' }}>Thêm kết nối mới</h3>

            <fieldset className="form-fieldset">
              <legend className="form-legend">Thông tin kết nối</legend>
              <div className="form-row">
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="label">Nền tảng *</label>
                  <select className="select" name="platform" value={form.platform} onChange={handleChange}>
                    {Object.entries(PLATFORM_CONFIG).map(([key, config]) => (
                      <option key={key} value={key}>{config.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="label">Loại kết nối *</label>
                  <select className="select" name="credentialType" value={form.credentialType} onChange={handleChange}>
                    {(PLATFORM_TYPES[form.platform] || ['api_key']).map(type => (
                      <option key={type} value={type}>{CREDENTIAL_TYPE_LABELS[type]}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="label">Vai trò</label>
                  <select className="select" name="role" value={form.role} onChange={handleChange}>
                    <option value="primary">Kết nối chính</option>
                    <option value="backup">Kết nối dự phòng</option>
                    <option value="testing">Kết nối thử nghiệm</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="label">Nhãn (tuỳ chọn)</label>
                <input className="input" name="label" value={form.label} onChange={handleChange} placeholder="Ví dụ: Kết nối Gemini chính, Trang Facebook chính..." />
              </div>
            </fieldset>

            <fieldset className="form-fieldset">
              <legend className="form-legend">Giá trị bí mật</legend>
              <div className="form-group">
                <label className="label">Khóa kết nối *</label>
                <div style={{ position: 'relative' }}>
                  <input
                    className="input"
                    name="value"
                    type={showValue ? 'text' : 'password'}
                    value={form.value}
                    onChange={handleChange}
                    placeholder="Dán khóa kết nối vào đây..."
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
                  Không dùng mật khẩu tài khoản làm khóa kết nối. Không chia sẻ giá trị này công khai.
                </p>
              </div>
              <div className="form-group">
                <label className="label">Chi tiết kỹ thuật (JSON, tùy chọn)</label>
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
                {saving ? 'Đang lưu...' : 'Lưu kết nối'}
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
            <div className="token-vault-platform-grid">
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
                  onPriority={handlePriority}
                  onDelete={handleDelete}
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
            <div className="empty-state-icon"><DashboardIcon name="security" size={28} /></div>
            <div className="empty-state-title">Chưa có kết nối nào</div>
            <div className="empty-state-desc">
              Thêm khóa để kết nối với dịch vụ bên ngoài. Có thể bắt đầu bằng kết nối Gemini hoặc AccessTrade.
            </div>
            <button className="btn btn-primary" style={{ marginTop: 'var(--space-lg)' }} onClick={() => setShowForm(true)}>
              Thêm kết nối đầu tiên
            </button>
          </div>
        )}

        {/* Next module link */}
        <div className="disclosure-banner" style={{ marginTop: 'var(--space-xl)' }}>
          <strong>Tiếp theo:</strong>{' '}
          <Link href="/dashboard/content" style={{ color: 'var(--ds-primary)' }}>
            Xem trạng thái phần tạo nội dung
          </Link>{' '}
          (Cần có kết nối Gemini đã được thiết lập trong Kết nối bảo mật)
        </div>
      </div>
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
  onPriority: (credential: SafeCredential, priority: number) => void;
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
  onPriority,
  onDelete,
  onReplace,
  onReplaceSubmit,
  onReplaceCancel,
  onReplaceValueChange,
}: PlatformCardProps) {
  const primary = group.credentials.find(c => c.role === 'primary');
  const hasCredentials = group.credentials.length > 0;
  const generationReadyCount = group.platform === 'gemini'
    ? group.credentials.filter(credential => credential.readiness?.generationReady).length
    : 0;

  return (
    <div className="glass-card token-vault-platform-card">
      {/* Platform Header */}
      <div className="token-vault-platform-header" style={{ marginBottom: hasCredentials ? 'var(--space-md)' : 0 }}>
        <div className="flex items-center gap-sm">
          <span className="dashboard-page-icon" style={{ width: 38, height: 38, flexBasis: 38 }}><DashboardIcon name={PLATFORM_ICONS[group.platform]} size={20} /></span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 'var(--text-sm)' }}>{group.label}</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
              {hasCredentials
                ? `${group.credentials.length} kết nối`
                : 'Chưa cấu hình'}
            </div>
          </div>
        </div>
        {group.platform === 'gemini' && hasCredentials ? (
           <span className={`badge ${generationReadyCount > 0 ? 'badge-success' : 'badge-warning'}`} style={{ fontSize: '10px' }}>
             {generationReadyCount}/{group.credentials.length} sẵn sàng
           </span>
        ) : primary ? (
          <span className={`badge ${primary.status === 'valid' ? 'badge-success' : 'badge-neutral'}`} style={{ fontSize: '10px' }}>
            {primary.status === 'valid' ? 'Kết nối hợp lệ' : 'Kết nối đã lưu'}
          </span>
        ) : hasCredentials ? (
          <span className="badge badge-warning" style={{ fontSize: '10px' }}>
            Chưa chọn kết nối chính
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
          onPriority={onPriority}
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
  onPriority: (credential: SafeCredential, priority: number) => void;
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
  onPriority,
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
  const [priorityEditing, setPriorityEditing] = useState(false);
  const [priorityValue, setPriorityValue] = useState(String(cred.readiness?.priority ?? cred.metadata?.priority ?? 100));
  const [deletePending, setDeletePending] = useState(false);
  const readinessBadge = cred.platform === 'gemini' ? geminiReadinessBadge(cred) : null;
  const canSetPrimary = cred.platform !== 'gemini' || cred.readiness?.generationReady === true;
  const primaryDisabledReason = cred.platform === 'gemini' && !canSetPrimary && cred.readiness
    ? READINESS_REASON_LABELS[cred.readiness.reasonCode]
    : null;

  return (
    <div className="token-vault-credential">
      <div className="token-vault-credential-layout">
        <div className="token-vault-credential-info">
          <div className="flex items-center gap-xs" style={{ flexWrap: 'wrap', marginBottom: '4px' }}>
            <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{cred.label}</span>
            <span className={`badge ${roleConfig.badge}`} style={{ fontSize: '9px', padding: '2px 6px' }}>
              {roleConfig.label}
            </span>
            <span className={`badge ${statusConfig.badge}`} style={{ fontSize: '9px', padding: '2px 6px' }}>
              {cred.platform === 'gemini' && cred.status === 'valid' ? 'Khóa hợp lệ' : statusConfig.label}
            </span>
            {readinessBadge && (
              <span className={`badge ${readinessBadge.badge}`} data-generation-ready={String(Boolean(cred.readiness?.generationReady))} style={{ fontSize: '9px', padding: '2px 6px' }}>
                {readinessBadge.label}
              </span>
            )}
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
            {CREDENTIAL_TYPE_LABELS[cred.credentialType]} · {cred.maskedValue}
          </div>
          {cred.readiness && (
            <div className="token-vault-readiness-summary">
              Trạng thái: {cred.readiness.generationReady ? 'sẵn sàng tạo nội dung' : 'chưa sẵn sàng'} · Ưu tiên: {cred.readiness.priority}
            </div>
          )}
          {cred.platform === 'gemini' && cred.readiness && (
            <div className="token-vault-readiness-reason" data-readiness-reason={cred.readiness.reasonCode}>
              {READINESS_REASON_LABELS[cred.readiness.reasonCode]}
            </div>
          )}
          {cred.lastCheckedAt && (
            <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
              Kiểm tra lần cuối: {new Date(cred.lastCheckedAt).toLocaleString('vi-VN')}
            </div>
          )}
          {cred.lastError && (
            <div style={{ fontSize: '10px', color: 'var(--color-danger)', marginTop: '2px' }}>
              {GEMINI_ERROR_LABELS[cred.lastError] || cred.lastError.slice(0, 100)}
            </div>
          )}
          {cred.permissions && cred.permissions.length > 0 && (
            <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
              Quyền: {cred.permissions.join(', ')}
            </div>
          )}
          {cred.platform === 'gemini' && (
            <details className="token-vault-gemini-meta">
              <summary>Chi tiết định tuyến</summary>
              Nhà cung cấp: Gemini · Mô hình đã thử: {cred.readiness?.testedModel || String(cred.metadata?.testedModel || cred.metadata?.preferredModel || 'chưa có')} · HTTP: {cred.readiness?.httpStatus ?? '—'}<br />
              Phân loại: {GEMINI_ERROR_LABELS[cred.readiness?.diagnosticCategory || cred.readiness?.errorCategory || ''] || (cred.readiness?.generationReady ? 'Sẵn sàng' : 'Chưa có lỗi đã phân loại')} · Có thể thử lại: {cred.readiness?.retryable ? 'Có' : 'Không'} · Generation ready: {cred.readiness?.generationReady ? 'Có' : 'Không'}<br />
              Free policy: {cred.readiness?.freePolicyEligible ? 'đã xác minh' : 'chưa xác minh'} · Lần tạo thành công: {cred.readiness?.lastGenerationSucceededAt ? new Date(cred.readiness.lastGenerationSucceededAt).toLocaleString('vi-VN') : 'chưa có'}<br />
              Lần kiểm tra: {cred.readiness?.lastCheckedAt ? new Date(cred.readiness.lastCheckedAt).toLocaleString('vi-VN') : 'chưa kiểm tra'} · Chờ phục hồi: {cred.readiness?.cooldownUntil ? new Date(cred.readiness.cooldownUntil).toLocaleString('vi-VN') : 'không có'}<br />
              Dự án: {String(cred.metadata?.projectAlias || 'chưa đặt')} · Nhóm hạn mức: {String(cred.metadata?.quotaGroupId || 'chưa đặt')} · Ưu tiên: {String(cred.metadata?.priority ?? 100)}
            </details>
          )}
          {primaryDisabledReason && cred.role !== 'primary' && cred.role !== 'disabled' && (
            <div className="token-vault-readiness-reason" data-primary-disabled-reason>
              Chưa thể đặt làm chính: {primaryDisabledReason}
            </div>
          )}
        </div>
        <div className="token-vault-credential-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => onTest(cred.id)} disabled={isTesting} title="Kiểm tra">
            {isTesting ? 'Đang kiểm tra...' : 'Kiểm tra'}
          </button>
          {cred.platform === 'gemini' && <button className="btn btn-ghost btn-sm" onClick={() => onProbe(cred.id)} disabled={isTesting}>Thử tạo nội dung</button>}
          {cred.role !== 'primary' && cred.role !== 'disabled' && (
            <button className="btn btn-ghost btn-sm" onClick={() => onSetPrimary(cred.id)} disabled={!canSetPrimary} title={primaryDisabledReason || 'Đặt làm chính'}>
              Đặt làm chính
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => setPriorityEditing(value => !value)} title="Đổi thứ tự ưu tiên">Đổi ưu tiên</button>
          <button className="btn btn-ghost btn-sm" onClick={() => onReplace(cred.id)} title="Thay thế">
            Thay thế
          </button>
          {cred.role !== 'disabled' && (
            <button className="btn btn-ghost btn-sm" onClick={() => onDisable(cred.id)} title="Tắt">
              Tắt
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => setDeletePending(true)} title="Xoá" style={{ color: 'var(--color-danger)' }}>
            Xóa
          </button>
        </div>
      </div>

      {/* Replace inline form */}
      {isReplacing && (
        <div className="token-vault-replace-form">
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
      {priorityEditing && (
        <div className="token-vault-replace-form" data-inline-priority>
          <label htmlFor={`priority-${cred.id}`}>Ưu tiên (0–10000, số nhỏ chạy trước)</label>
          <input
            id={`priority-${cred.id}`}
            className="input"
            type="number"
            min={0}
            max={10_000}
            step={1}
            value={priorityValue}
            onChange={event => setPriorityValue(event.target.value)}
          />
          <button className="btn btn-primary btn-sm" onClick={() => {
            const parsed = Number(priorityValue);
            if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 10_000) setPriorityEditing(false);
            onPriority(cred, parsed);
          }}>Lưu ưu tiên</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setPriorityEditing(false)}>Huỷ</button>
        </div>
      )}
      {deletePending && (
        <div className="token-vault-replace-form" role="status" data-inline-delete-confirmation>
          <span>Xóa vĩnh viễn kết nối “{cred.label}”?</span>
          <button className="btn btn-danger btn-sm" onClick={() => {
            setDeletePending(false);
            onDelete(cred.id);
          }}>Xóa kết nối</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setDeletePending(false)}>Huỷ</button>
        </div>
      )}
    </div>
  );
}
