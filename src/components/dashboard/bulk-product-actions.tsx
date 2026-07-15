'use client';

import { useMemo, useState } from 'react';
import { DashboardIcon } from './dashboard-icon';
import styles from './bulk-product-actions.module.css';

type BulkAction = 'recheck_link' | 'recheck_image' | 'rescore' | 'price_snapshot' | 'content_draft' | 'assign_category' | 'add_tag' | 'archive' | 'export_csv';

type Preview = {
  action: BulkAction;
  requested: number;
  valid: string[];
  skipped: string[];
  expectedImpact: 'NONE' | 'MEDIUM' | 'HIGH';
  estimatedAiUsage: number;
  requiresApproval: boolean;
  businessDataChanged: false;
};

type JobResult = { jobId: string; operationId: string; status: string };
type Envelope<T> = { ok: boolean; code?: string; message?: string; data?: T };

const ACTION_LABELS: Record<BulkAction, string> = {
  recheck_link: 'Kiểm tra lại link',
  recheck_image: 'Kiểm tra lại ảnh',
  rescore: 'Chấm lại điểm',
  price_snapshot: 'Tạo snapshot giá',
  content_draft: 'Đưa vào Content Studio',
  assign_category: 'Gán danh mục',
  add_tag: 'Thêm nhãn',
  archive: 'Lưu trữ',
  export_csv: 'Xuất CSV qua tác vụ',
};

export function BulkProductActions({ productIds, onClear }: { productIds: string[]; onClear: () => void }) {
  const [action, setAction] = useState<BulkAction>('rescore');
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [previewKey, setPreviewKey] = useState('');
  const [operationId, setOperationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [job, setJob] = useState<JobResult | null>(null);

  const payload = useMemo(() => ({
    action,
    productIds,
    ...(action === 'assign_category' ? { category: category.trim() } : {}),
    ...(action === 'add_tag' ? { tag: tag.trim() } : {}),
  }), [action, category, productIds, tag]);

  const inputMissing = (action === 'assign_category' && category.trim().length === 0) || (action === 'add_tag' && tag.trim().length === 0);
  const payloadKey = useMemo(() => JSON.stringify({ ...payload, dryRun }), [dryRun, payload]);

  const submit = async (mode: 'preview' | 'apply') => {
    setBusy(true);
    setMessage('');
    if (mode === 'preview') { setPreview(null); setJob(null); }
    try {
      const response = await fetch('/api/dashboard/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          mode,
          confirmed: mode === 'apply' ? dryRun || confirmed : false,
          dryRun,
          ...(mode === 'apply' && operationId ? { operationId, idempotencyKey: `bulk:${operationId}` } : {}),
        }),
      });
      const body = await response.json().catch(() => null) as Envelope<Preview | JobResult> | null;
      if (!response.ok || !body?.ok || !body.data) throw new Error(body?.message || body?.code || 'BULK_UNAVAILABLE');
      if (mode === 'preview') {
        setPreview(body.data as Preview);
        setPreviewKey(payloadKey);
        setOperationId(crypto.randomUUID());
        setConfirmed(false);
        setMessage('Đã tạo preview, chưa có dữ liệu nào bị thay đổi.');
      } else {
        setJob(body.data as JobResult);
        setMessage('Đã tạo tác vụ bền vững. Worker sẽ xử lý theo Safe Mode và kill switch.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Không thể tạo tác vụ hàng loạt.');
    } finally { setBusy(false); }
  };

  if (!productIds.length) return null;
  const previewMatches = preview && previewKey === payloadKey;
  return (
    <section className={styles.panel} aria-label="Thao tác hàng loạt">
      <div className={styles.heading}>
        <div><strong>{productIds.length} sản phẩm đã chọn</strong><span>Mọi tác vụ dài đều chạy qua queue; không bulk publish trực tiếp.</span></div>
        <button type="button" onClick={onClear}>Bỏ chọn</button>
      </div>
      <div className={styles.controls}>
        <label><span>Hành động</span><select value={action} onChange={(event) => { setAction(event.target.value as BulkAction); setPreview(null); setJob(null); }}>
          {Object.entries(ACTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        {action === 'assign_category' && <label><span>Danh mục</span><input maxLength={120} value={category} onChange={(event) => { setCategory(event.target.value); setPreview(null); }} /></label>}
        {action === 'add_tag' && <label><span>Nhãn</span><input maxLength={80} value={tag} onChange={(event) => { setTag(event.target.value); setPreview(null); }} /></label>}
        <label className={styles.checkbox}><input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} /><span>Chạy thử</span></label>
        <button type="button" className={styles.previewButton} disabled={busy || inputMissing} onClick={() => void submit('preview')}><DashboardIcon name="search" size={15} />Xem trước</button>
      </div>

      {previewMatches && <div className={styles.preview}>
        <dl>
          <div><dt>Hợp lệ</dt><dd>{preview.valid.length}</dd></div>
          <div><dt>Bỏ qua</dt><dd>{preview.skipped.length}</dd></div>
          <div><dt>Tác động</dt><dd>{preview.expectedImpact}</dd></div>
          <div><dt>AI dự kiến</dt><dd>{preview.estimatedAiUsage}</dd></div>
        </dl>
        {preview.requiresApproval && <p><DashboardIcon name="approval" size={16} />Tác vụ rủi ro cao sẽ ở trạng thái chờ phê duyệt.</p>}
        {!dryRun && <label className={styles.confirm}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>Tôi xác nhận tạo tác vụ thay đổi dữ liệu theo preview này.</span></label>}
        <button type="button" className={styles.applyButton} disabled={busy || preview.valid.length === 0 || (!dryRun && !confirmed)} onClick={() => void submit('apply')}>
          {busy ? 'Đang tạo tác vụ' : dryRun ? 'Tạo tác vụ chạy thử' : preview.requiresApproval ? 'Gửi chờ phê duyệt' : 'Tạo tác vụ'}
        </button>
      </div>}
      {job && <p className={styles.job} role="status"><strong>Job {job.jobId}</strong><span>{job.status} · operationId {job.operationId}</span></p>}
      {message && <p className={styles.message} role="status">{message}</p>}
    </section>
  );
}
