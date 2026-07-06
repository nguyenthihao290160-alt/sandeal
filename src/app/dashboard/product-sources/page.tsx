'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import type { Product } from '@/lib/types';

// ---- Tab IDs ----
const TABS = [
  { id: 'manual', label: 'Thêm thủ công', icon: '✏️' },
  { id: 'accesstrade', label: 'AccessTrade', icon: '🔗' },
  { id: 'shopee', label: 'Shopee Affiliate', icon: '🛒' },
  { id: 'tiktok', label: 'TikTok Shop', icon: '🎵' },
  { id: 'lazada', label: 'Lazada', icon: '🏪' },
  { id: 'csv', label: 'CSV Import', icon: '📄' },
  { id: 'other', label: 'Nguồn khác', icon: '🔌' },
] as const;

type TabId = (typeof TABS)[number]['id'];

// ---- Source Status ----
const SOURCE_STATUSES = [
  { name: 'AccessTrade', status: 'pending', note: 'Cấu hình qua API key', icon: '🔗' },
  { name: 'Shopee', status: 'placeholder', note: 'Sắp kết nối', icon: '🛒' },
  { name: 'TikTok Shop', status: 'placeholder', note: 'Sắp kết nối', icon: '🎵' },
  { name: 'Lazada', status: 'placeholder', note: 'Sắp kết nối', icon: '🏪' },
  { name: 'Thủ công', status: 'active', note: 'Luôn khả dụng', icon: '✏️' },
  { name: 'CSV', status: 'coming', note: 'Sắp có', icon: '📄' },
];

// ---- Form Default ----
const EMPTY_FORM = {
  title: '',
  description: '',
  platform: 'shopee' as string,
  category: '',
  tags: '',
  originalUrl: '',
  affiliateUrl: '',
  imageUrl: '',
  gallery: '',
  price: '',
  salePrice: '',
  priceNote: 'Giá có thể thay đổi theo thời gian',
  affiliateSource: '',
  campaignName: '',
  commissionNote: '',
  affiliateDisclosure: '',
  benefits: '',
  painPoints: '',
  targetAudience: '',
  warnings: '',
  contentAngles: '',
  complianceNotes: '',
  kind: 'product' as string,
  status: 'needs_review' as string,
};

export default function ProductSourcesPage() {
  const [activeTab, setActiveTab] = useState<TabId>('manual');
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: string; message: string } | null>(null);
  const [recentProducts, setRecentProducts] = useState<Product[]>([]);

  // AccessTrade state
  const [atKeyword, setAtKeyword] = useState('');
  const [atKind, setAtKind] = useState('all');
  const [atLoading, setAtLoading] = useState(false);
  const [atError, setAtError] = useState('');
  const [atResults, setAtResults] = useState<{items: Array<Record<string, unknown>>; summary: Record<string, number>} | null>(null);
  const [atSaving, setAtSaving] = useState<string | null>(null);

  const showToast = useCallback((type: string, message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  // ---- Load recent products ----
  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch('/api/products?status=needs_review');
      const data = await res.json();
      if (data.ok && Array.isArray(data.data)) {
        setRecentProducts(data.data.slice(0, 10));
      }
    } catch { /* ignore */ }
  }, []);

  // Load on first render
  useState(() => { loadRecent(); });

  // ---- Form handlers ----
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSave = async (status: string, runScore = false) => {
    if (!form.title.trim()) {
      showToast('error', 'Tên sản phẩm là bắt buộc.');
      return;
    }
    if (!form.platform) {
      showToast('error', 'Nền tảng là bắt buộc.');
      return;
    }
    if (!form.originalUrl && !form.affiliateUrl) {
      showToast('error', 'Cần ít nhất link sản phẩm gốc hoặc link affiliate.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          status,
          price: form.price ? Number(form.price) : undefined,
          salePrice: form.salePrice ? Number(form.salePrice) : undefined,
          gallery: form.gallery ? form.gallery.split('\n').filter(Boolean) : [],
        }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast('success', 'Đã thêm sản phẩm vào danh sách cần xem xét.');
        setForm(EMPTY_FORM);

        // If score requested
        if (runScore && data.data?.id) {
          await fetch(`/api/products/${data.data.id}/score`, { method: 'POST' });
        }

        loadRecent();
      } else {
        showToast('error', data.message || 'Không thể thêm sản phẩm.');
      }
    } catch {
      showToast('error', 'Lỗi kết nối. Vui lòng thử lại.');
    } finally {
      setSaving(false);
    }
  };

  // ---- AccessTrade handlers ----
  const handleAtSearch = async () => {
    setAtLoading(true);
    setAtError('');
    setAtResults(null);
    try {
      const res = await fetch('/api/product-sources/accesstrade/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: atKeyword, kind: atKind, limit: 20 }),
      });
      const data = await res.json();
      if (data.ok) {
        setAtResults(data.data);
      } else {
        setAtError(data.message || 'Lỗi khi tìm kiếm.');
      }
    } catch {
      setAtError('Không thể kết nối đến server.');
    } finally {
      setAtLoading(false);
    }
  };

  const handleAtSave = async (item: Record<string, unknown>, runScore = false) => {
    const itemId = String(item.id || '');
    setAtSaving(itemId);
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: item.name || '',
          description: item.description || '',
          kind: item.kind || 'unknown',
          platform: 'accesstrade',
          source: 'accesstrade',
          originalUrl: item.originalUrl || '',
          affiliateUrl: item.affiliateUrl || '',
          imageUrl: item.imageUrl || '',
          price: item.price || undefined,
          salePrice: item.salePrice || undefined,
          category: item.category || '',
          campaignName: item.campaignName || '',
          status: 'needs_review',
        }),
      });
      const data = await res.json();
      if (data.ok) {
        if (runScore && data.data?.id) {
          await fetch(`/api/products/${data.data.id}/score`, { method: 'POST' });
        }
        showToast('success', 'Đã lưu sản phẩm từ AccessTrade.');
        loadRecent();
      } else {
        showToast('error', data.message || 'Không thể lưu sản phẩm.');
      }
    } catch {
      showToast('error', 'Lỗi kết nối.');
    } finally {
      setAtSaving(null);
    }
  };

  const renderPlaceholderTab = (icon: string, title: string, desc: string, keys?: string) => (
    <div className="coming-soon-container" style={{ minHeight: 'auto', padding: 'var(--space-xl) 0' }}>
      <div className="coming-soon-card" style={{ padding: 'var(--space-xl)' }}>
        <span className="coming-soon-icon">{icon}</span>
        <h3 className="coming-soon-title" style={{ fontSize: 'var(--text-xl)' }}>{title}</h3>
        <p className="coming-soon-desc">{desc}</p>
        <div className="coming-soon-actions">
          <button className="btn btn-primary" onClick={() => setActiveTab('manual')}>✏️ Thêm thủ công</button>
          <Link href="/dashboard/token-vault" className="btn btn-secondary">🔐 Cấu hình API</Link>
        </div>
        {keys && (
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 'var(--space-md)' }}>
            Cần: {keys}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Trung tâm nguồn sản phẩm</div>
        <div className="safe-mode-badges">
          <span className="safe-badge safe-badge-on">🔒 Safe Mode</span>
          <span className="safe-badge safe-badge-on">💰 Free Only</span>
          <span className="safe-badge safe-badge-off">📤 Auto Publish: OFF</span>
        </div>
      </div>
      <div className="page-content">
        {/* Toast */}
        {toast && (
          <div className="toast-container">
            <div className={`toast toast-${toast.type}`}>
              {toast.type === 'success' ? '✅' : '❌'} {toast.message}
            </div>
          </div>
        )}

        {/* Header */}
        <div className="page-header">
          <div>
            <h1 className="page-header-title">Trung tâm nguồn sản phẩm</h1>
            <p className="page-header-desc">Thêm, lấy và đánh giá sản phẩm affiliate trước khi tạo nội dung.</p>
          </div>
        </div>

        {/* Source Status Cards */}
        <div className="source-cards">
          {SOURCE_STATUSES.map(s => (
            <div key={s.name} className={`source-card${activeTab === (s.name === 'Thủ công' ? 'manual' : s.name === 'CSV' ? 'csv' : s.name.toLowerCase().replace(/\s+/g,'')) ? ' active' : ''}`}
              onClick={() => {
                if (s.name === 'Thủ công') setActiveTab('manual');
                else if (s.name === 'AccessTrade') setActiveTab('accesstrade');
                else if (s.name === 'Shopee') setActiveTab('shopee');
                else if (s.name === 'TikTok Shop') setActiveTab('tiktok');
                else if (s.name === 'Lazada') setActiveTab('lazada');
                else if (s.name === 'CSV') setActiveTab('csv');
              }}>
              <div className="source-card-icon">{s.icon}</div>
              <div className="source-card-name">{s.name}</div>
              <div className="source-card-status">
                <span className={`badge ${s.status === 'active' ? 'badge-success' : s.status === 'pending' ? 'badge-warning' : 'badge-neutral'}`} style={{ fontSize: '9px', padding: '2px 6px' }}>
                  {s.status === 'active' ? 'Khả dụng' : s.status === 'pending' ? 'Cần cấu hình' : 'Sắp có'}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="tabs-bar">
          {TABS.map(tab => (
            <button
              key={tab.id}
              className={`tab-btn${activeTab === tab.id ? ' tab-btn-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span>{tab.icon}</span> {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="tab-content">
          {/* ====== MANUAL TAB ====== */}
          {activeTab === 'manual' && (
            <div className="card" style={{ maxWidth: '900px' }}>
              <h3 className="card-title" style={{ marginBottom: 'var(--space-lg)' }}>✏️ Thêm sản phẩm thủ công</h3>

              {/* Basic Info */}
              <fieldset className="form-fieldset">
                <legend className="form-legend">Thông tin cơ bản</legend>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 2 }}>
                    <label className="label">Tên sản phẩm *</label>
                    <input className="input" name="title" value={form.title} onChange={handleChange} placeholder="VD: Tai nghe Bluetooth TWS Pro Max" />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Nền tảng *</label>
                    <select className="select" name="platform" value={form.platform} onChange={handleChange}>
                      <option value="shopee">Shopee</option>
                      <option value="tiktok_shop">TikTok Shop</option>
                      <option value="lazada">Lazada</option>
                      <option value="accesstrade">AccessTrade</option>
                      <option value="website">Website khác</option>
                    </select>
                  </div>
                </div>
                <div className="form-group">
                  <label className="label">Mô tả ngắn</label>
                  <textarea className="textarea" name="description" value={form.description} onChange={handleChange} rows={2} placeholder="Mô tả ngắn gọn về sản phẩm..." />
                </div>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Loại</label>
                    <select className="select" name="kind" value={form.kind} onChange={handleChange}>
                      <option value="product">Sản phẩm</option>
                      <option value="voucher">Voucher</option>
                      <option value="campaign">Chiến dịch</option>
                      <option value="deal">Deal</option>
                    </select>
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Danh mục</label>
                    <input className="input" name="category" value={form.category} onChange={handleChange} placeholder="VD: Công nghệ" />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Tags (phân cách bằng dấu phẩy)</label>
                    <input className="input" name="tags" value={form.tags} onChange={handleChange} placeholder="VD: tai nghe, bluetooth" />
                  </div>
                </div>
              </fieldset>

              {/* Links & Images */}
              <fieldset className="form-fieldset">
                <legend className="form-legend">Liên kết & hình ảnh</legend>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Link sản phẩm gốc</label>
                    <input className="input" name="originalUrl" value={form.originalUrl} onChange={handleChange} placeholder="https://..." />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Link affiliate *</label>
                    <input className="input" name="affiliateUrl" value={form.affiliateUrl} onChange={handleChange} placeholder="https://..." />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Link ảnh sản phẩm</label>
                    <input className="input" name="imageUrl" value={form.imageUrl} onChange={handleChange} placeholder="https://..." />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Link ảnh phụ (mỗi dòng một URL)</label>
                    <textarea className="textarea" name="gallery" value={form.gallery} onChange={handleChange} rows={2} placeholder={"https://image1.jpg\nhttps://image2.jpg"} style={{ minHeight: '60px' }} />
                  </div>
                </div>
              </fieldset>

              {/* Price */}
              <fieldset className="form-fieldset">
                <legend className="form-legend">Giá & ưu đãi</legend>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Giá gốc (VND)</label>
                    <input className="input" name="price" type="number" value={form.price} onChange={handleChange} placeholder="VD: 299000" />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Giá khuyến mãi (VND)</label>
                    <input className="input" name="salePrice" type="number" value={form.salePrice} onChange={handleChange} placeholder="VD: 199000" />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Ghi chú giá</label>
                    <input className="input" name="priceNote" value={form.priceNote} onChange={handleChange} />
                  </div>
                </div>
              </fieldset>

              {/* Content Intelligence */}
              <fieldset className="form-fieldset">
                <legend className="form-legend">Góc nội dung</legend>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Lợi ích chính (mỗi dòng một lợi ích)</label>
                    <textarea className="textarea" name="benefits" value={form.benefits} onChange={handleChange} rows={3} placeholder={"Chống ồn chủ động\nPin 30 giờ\nBluetooth 5.3"} />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Cảnh báo / Không được nói quá</label>
                    <textarea className="textarea" name="warnings" value={form.warnings} onChange={handleChange} rows={3} placeholder={"Không cam kết chất lượng tuyệt đối\nKhông khẳng định chữa bệnh"} />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Pain point khách hàng</label>
                    <textarea className="textarea" name="painPoints" value={form.painPoints} onChange={handleChange} rows={2} placeholder={"Muốn tai nghe không dây\nCần tai nghe cho họp online"} />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Đối tượng phù hợp</label>
                    <textarea className="textarea" name="targetAudience" value={form.targetAudience} onChange={handleChange} rows={2} placeholder={"Dân văn phòng\nSinh viên"} />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Gợi ý góc nội dung</label>
                    <textarea className="textarea" name="contentAngles" value={form.contentAngles} onChange={handleChange} rows={2} placeholder={"Review trung thực\nSo sánh với sản phẩm khác"} />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Ghi chú kiểm duyệt</label>
                    <textarea className="textarea" name="complianceNotes" value={form.complianceNotes} onChange={handleChange} rows={2} />
                  </div>
                </div>
              </fieldset>

              {/* Kiểm duyệt & rủi ro */}
              <fieldset className="form-fieldset">
                <legend className="form-legend">Kiểm duyệt & rủi ro</legend>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Nguồn affiliate</label>
                    <input className="input" name="affiliateSource" value={form.affiliateSource} onChange={handleChange} />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Tên chiến dịch</label>
                    <input className="input" name="campaignName" value={form.campaignName} onChange={handleChange} />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Ghi chú hoa hồng</label>
                    <input className="input" name="commissionNote" value={form.commissionNote} onChange={handleChange} />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Affiliate disclosure</label>
                    <input className="input" name="affiliateDisclosure" value={form.affiliateDisclosure} onChange={handleChange} placeholder="VD: Bài viết có chứa link liên kết..." />
                  </div>
                </div>
              </fieldset>

              {/* Actions */}
              <div className="form-actions">
                <button className="btn btn-primary" disabled={saving} onClick={() => handleSave('needs_review')}>
                  {saving ? '⏳ Đang lưu...' : '💾 Lưu sản phẩm'}
                </button>
                <button className="btn btn-secondary" disabled={saving} onClick={() => handleSave('draft')}>
                  📝 Lưu nháp
                </button>
                <button className="btn btn-accent" disabled={saving} onClick={() => handleSave('needs_review', true)}>
                  ⭐ Lưu và chấm điểm
                </button>
                <Link href="/dashboard/products" className="btn btn-ghost">
                  📦 Xem danh sách
                </Link>
              </div>
            </div>
          )}

          {/* ====== ACCESSTRADE TAB ====== */}
          {activeTab === 'accesstrade' && (
            <div>
              <div className="glass-card" style={{ maxWidth: '900px', marginBottom: 'var(--space-lg)' }}>
                <h3 className="card-title" style={{ marginBottom: 'var(--space-md)' }}>🔗 Tìm kiếm trên AccessTrade</h3>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 2 }}>
                    <label className="label">Từ khoá</label>
                    <input className="input" value={atKeyword} onChange={e => setAtKeyword(e.target.value)} placeholder="VD: tai nghe, serum, balo..." />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="label">Loại dữ liệu</label>
                    <select className="select" value={atKind} onChange={e => setAtKind(e.target.value)}>
                      <option value="all">Tất cả</option>
                      <option value="product">Sản phẩm</option>
                      <option value="voucher">Voucher</option>
                      <option value="campaign">Chiến dịch</option>
                    </select>
                  </div>
                </div>
                <button className="btn btn-primary" onClick={handleAtSearch} disabled={atLoading}>
                  {atLoading ? '⏳ Đang tìm...' : '🔍 Tìm kiếm'}
                </button>
              </div>

              {atError && (
                <div className="glass-card" style={{ borderColor: 'rgba(244, 63, 94, 0.3)', maxWidth: '900px', marginBottom: 'var(--space-lg)' }}>
                  <p style={{ color: 'var(--color-danger)' }}>❌ {atError}</p>
                </div>
              )}

              {atResults && (
                <div style={{ maxWidth: '900px' }}>
                  {/* Summary */}
                  <div className="grid grid-4" style={{ marginBottom: 'var(--space-lg)' }}>
                    <div className="stat-card" style={{ padding: 'var(--space-md)' }}>
                      <div className="stat-card-value" style={{ fontSize: 'var(--text-xl)' }}>{atResults.summary.total}</div>
                      <div className="stat-card-label">Tổng kết quả</div>
                    </div>
                    <div className="stat-card" style={{ padding: 'var(--space-md)' }}>
                      <div className="stat-card-value" style={{ fontSize: 'var(--text-xl)' }}>{atResults.summary.products}</div>
                      <div className="stat-card-label">Sản phẩm</div>
                    </div>
                    <div className="stat-card" style={{ padding: 'var(--space-md)' }}>
                      <div className="stat-card-value" style={{ fontSize: 'var(--text-xl)' }}>{atResults.summary.vouchers}</div>
                      <div className="stat-card-label">Voucher</div>
                    </div>
                    <div className="stat-card" style={{ padding: 'var(--space-md)' }}>
                      <div className="stat-card-value" style={{ fontSize: 'var(--text-xl)' }}>{atResults.summary.unknown}</div>
                      <div className="stat-card-label">Chưa xác định</div>
                    </div>
                  </div>

                  {/* Results */}
                  {atResults.items.map((rawItem, idx) => {
                    const item = {
                      id: String(rawItem.id || ''),
                      name: String(rawItem.name || 'Không có tên'),
                      kind: String(rawItem.kind || 'unknown'),
                      imageUrl: typeof rawItem.imageUrl === 'string' ? rawItem.imageUrl : '',
                      price: Number(rawItem.price || 0),
                      affiliateUrl: typeof rawItem.affiliateUrl === 'string' ? rawItem.affiliateUrl : '',
                      needsVerification: Boolean(rawItem.needsVerification),
                      originalItem: rawItem,
                    };
                    
                    return (
                      <div key={idx} className="glass-card" style={{ marginBottom: 'var(--space-md)', display: 'flex', gap: 'var(--space-md)' }}>
                        {Boolean(item.imageUrl) && (
                          <div style={{ width: '80px', height: '80px', borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--bg-tertiary)', flexShrink: 0 }}>
                            <img src={item.imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          </div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="flex items-center gap-sm" style={{ marginBottom: '4px', flexWrap: 'wrap' }}>
                            <strong style={{ fontSize: 'var(--text-sm)' }}>{item.name}</strong>
                            <span className={`badge ${item.kind === 'product' ? 'badge-success' : item.kind === 'voucher' ? 'badge-warning' : 'badge-neutral'}`}>
                              {item.kind}
                            </span>
                            {item.needsVerification && <span className="badge badge-warning">Cần xác minh</span>}
                          </div>
                          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                            {item.price > 0 ? `${item.price.toLocaleString('vi-VN')}₫` : ''}
                            {item.affiliateUrl ? ' • Có link affiliate' : ' • Chưa có link affiliate'}
                          </p>
                          <div className="flex gap-sm" style={{ marginTop: 'var(--space-sm)' }}>
                            <button className="btn btn-sm btn-primary" disabled={atSaving === item.id} onClick={() => handleAtSave(item.originalItem)}>
                              💾 Lưu vào sản phẩm
                            </button>
                            <button className="btn btn-sm btn-accent" disabled={atSaving === item.id} onClick={() => handleAtSave(item.originalItem, true)}>
                              ⭐ Lưu và chấm điểm
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {atResults.items.length === 0 && (
                    <div className="empty-state">
                      <div className="empty-state-icon">🔍</div>
                      <div className="empty-state-title">Không tìm thấy kết quả</div>
                      <div className="empty-state-desc">Thử thay đổi từ khoá hoặc bộ lọc.</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ====== SHOPEE TAB ====== */}
          {activeTab === 'shopee' && renderPlaceholderTab('🛒', 'Shopee Affiliate', 'Shopee Affiliate sẽ được kết nối ở bước sau. Hiện tại bạn có thể thêm link Shopee thủ công.', 'SHOPEE_AFFILIATE_APP_ID, SHOPEE_AFFILIATE_SECRET')}

          {/* ====== TIKTOK TAB ====== */}
          {activeTab === 'tiktok' && renderPlaceholderTab('🎵', 'TikTok Shop Affiliate', 'TikTok Shop Affiliate sẽ được kết nối ở bước sau. Hiện tại bạn có thể thêm link sản phẩm thủ công.', 'TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET')}

          {/* ====== LAZADA TAB ====== */}
          {activeTab === 'lazada' && renderPlaceholderTab('🏪', 'Lazada Affiliate', 'Lazada Affiliate sẽ được kết nối ở bước sau.', 'LAZADA_AFFILIATE_APP_KEY, LAZADA_AFFILIATE_APP_SECRET')}

          {/* ====== CSV TAB ====== */}
          {activeTab === 'csv' && (
            <div className="coming-soon-container" style={{ minHeight: 'auto', padding: 'var(--space-xl) 0' }}>
              <div className="coming-soon-card" style={{ padding: 'var(--space-xl)' }}>
                <span className="coming-soon-icon">📄</span>
                <h3 className="coming-soon-title" style={{ fontSize: 'var(--text-xl)' }}>Nhập từ CSV</h3>
                <p className="coming-soon-desc">Tính năng nhập CSV sẽ được thêm ở bước sau.</p>
                <div className="disclosure-banner" style={{ textAlign: 'left', margin: 'var(--space-lg) 0 0' }}>
                  <strong>Các cột dự kiến:</strong><br />
                  title, originalUrl, affiliateUrl, imageUrl, platform, price, salePrice, category, tags
                </div>
              </div>
            </div>
          )}

          {/* ====== OTHER TAB ====== */}
          {activeTab === 'other' && renderPlaceholderTab('🔌', 'Nguồn khác', 'Bạn có thể thêm sản phẩm từ bất kỳ nguồn nào bằng cách nhập thủ công hoặc sử dụng API.')}
        </div>

        {/* Recent Products */}
        {recentProducts.length > 0 && (
          <div style={{ marginTop: 'var(--space-xl)' }}>
            <h2 className="section-title">Sản phẩm mới thêm gần đây</h2>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Sản phẩm</th>
                    <th>Nền tảng</th>
                    <th>Nguồn</th>
                    <th>Trạng thái</th>
                    <th>Điểm</th>
                    <th>Cập nhật</th>
                  </tr>
                </thead>
                <tbody>
                  {recentProducts.map(p => (
                    <tr key={p.id}>
                      <td>
                        <div className="flex items-center gap-sm">
                          {p.imageUrl && (
                            <div style={{ width: 36, height: 36, borderRadius: 'var(--radius-sm)', overflow: 'hidden', background: 'var(--bg-tertiary)', flexShrink: 0 }}>
                              <img src={p.imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            </div>
                          )}
                          <Link href={`/dashboard/products/${p.id}`} style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>
                            {p.title}
                          </Link>
                        </div>
                      </td>
                      <td><span className="badge badge-neutral">{p.platform}</span></td>
                      <td style={{ fontSize: 'var(--text-xs)' }}>{p.source}</td>
                      <td>
                        <span className={`badge ${p.status === 'approved' ? 'badge-success' : p.status === 'needs_review' ? 'badge-warning' : 'badge-neutral'}`}>
                          {p.status === 'approved' ? 'Đã duyệt' : p.status === 'needs_review' ? 'Cần xem xét' : p.status === 'draft' ? 'Nháp' : p.status}
                        </span>
                      </td>
                      <td>{p.score != null ? p.score : '—'}</td>
                      <td style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                        {new Date(p.updatedAt).toLocaleDateString('vi-VN')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
