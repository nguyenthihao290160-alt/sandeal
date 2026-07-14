'use client';

import { useMemo, useState } from 'react';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import { StatusBadge, dashboardRequest, formatDateTime } from '@/components/dashboard/intelligence-ui';
import type { VerifiedProductFact } from '@/lib/types';
import type {
  ContentDraft,
  ContentDraftClaim,
  ContentWorkflowStatus,
  DraftClaimType,
  EditorialCheckResult,
} from '@/lib/product-intelligence/types';
import styles from './content-editor.module.css';

type EditableForm = {
  title: string;
  summary: string;
  verdict: string;
  strengths: string;
  limitations: string;
  suitableFor: string;
  notSuitableFor: string;
  buyingNotes: string;
  faq: string;
  metaTitle: string;
  metaDescription: string;
  slug: string;
  affiliateDisclosure: string;
  assignee: string;
  claims: ContentDraftClaim[];
};

const CLAIM_TYPES: Array<{ value: DraftClaimType; label: string; help: string }> = [
  { value: 'VERIFIED_SOURCE', label: 'Nguồn đã xác minh', help: 'Khẳng định trực tiếp từ fact nguồn.' },
  { value: 'DERIVED', label: 'Suy luận có giới hạn', help: 'Kết luận suy ra từ fact và phải nêu giới hạn.' },
  { value: 'HUMAN_CONFIRMED', label: 'Người xử lý xác nhận', help: 'Vẫn bắt buộc tham chiếu evidence hợp lệ.' },
  { value: 'AI_DRAFT', label: 'Nháp AI', help: 'Không đủ điều kiện duyệt cho đến khi được xác minh.' },
  { value: 'UNVERIFIED', label: 'Chưa xác minh', help: 'Editorial Guard sẽ chặn Safe Publish.' },
];

const CLAIM_FIELDS = ['summary', 'verdict', 'strengths', 'limitations', 'suitableFor', 'notSuitableFor', 'buyingNotes', 'faq'] as const;

const TRANSITION_OPTIONS: Record<ContentWorkflowStatus, ContentWorkflowStatus[]> = {
  insufficient_data: ['ready_for_draft', 'blocked', 'archived'],
  ready_for_draft: ['drafting', 'blocked', 'archived'],
  drafting: ['needs_verification', 'pending_review', 'blocked', 'archived'],
  needs_verification: ['drafting', 'pending_review', 'blocked', 'archived'],
  pending_review: ['drafting', 'approved', 'blocked', 'archived'],
  approved: ['scheduled', 'stale', 'archived'],
  scheduled: ['approved', 'blocked', 'archived'],
  published: ['stale', 'archived'],
  stale: ['drafting', 'needs_verification', 'archived'],
  blocked: ['drafting', 'needs_verification', 'archived'],
  archived: [],
};

const STATUS_LABELS: Record<ContentWorkflowStatus, string> = {
  insufficient_data: 'Chưa đủ dữ liệu', ready_for_draft: 'Sẵn sàng tạo nháp', drafting: 'Đang soạn',
  needs_verification: 'Cần xác minh', pending_review: 'Chờ kiểm duyệt', approved: 'Đã duyệt',
  scheduled: 'Đã lên lịch', published: 'Đã đăng', stale: 'Lỗi thời', blocked: 'Bị chặn', archived: 'Đã lưu trữ',
};

function lines(value: string): string[] {
  return value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}

function faq(value: string): Array<{ question: string; answer: string }> {
  return value.split(/\r?\n/).map(item => {
    const [question, ...answer] = item.split('||');
    return { question: question.trim(), answer: answer.join('||').trim() };
  }).filter(item => item.question || item.answer);
}

function formFromDraft(draft: ContentDraft): EditableForm {
  return {
    title: draft.title,
    summary: draft.summary,
    verdict: draft.verdict,
    strengths: draft.strengths.join('\n'),
    limitations: draft.limitations.join('\n'),
    suitableFor: draft.suitableFor.join('\n'),
    notSuitableFor: draft.notSuitableFor.join('\n'),
    buyingNotes: draft.buyingNotes.join('\n'),
    faq: draft.faq.map(item => `${item.question} || ${item.answer}`).join('\n'),
    metaTitle: draft.metaTitle,
    metaDescription: draft.metaDescription,
    slug: draft.slug,
    affiliateDisclosure: draft.affiliateDisclosure,
    assignee: draft.assignee || '',
    claims: draft.claims.map(claim => ({ ...claim, evidenceFactIds: [...claim.evidenceFactIds] })),
  };
}

function newClaim(field = 'summary', text = ''): ContentDraftClaim {
  return {
    id: `claim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    field,
    text,
    type: 'UNVERIFIED',
    evidenceFactIds: [],
  };
}

function checkTone(status: EditorialCheckResult['status']): 'success' | 'warning' | 'danger' {
  if (status === 'READY') return 'success';
  if (status === 'BLOCKED') return 'danger';
  return 'warning';
}

export function ContentEditor({
  draft,
  productTitle,
  evidenceFacts,
  onClose,
  onChanged,
}: {
  draft: ContentDraft;
  productTitle: string;
  evidenceFacts: VerifiedProductFact[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<EditableForm>(() => formFromDraft(draft));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editorial, setEditorial] = useState<EditorialCheckResult | undefined>(draft.lastEditorialCheck);
  const transitions = TRANSITION_OPTIONS[draft.status];
  const [nextStatus, setNextStatus] = useState<ContentWorkflowStatus | ''>(transitions[0] || '');
  const [scheduledAt, setScheduledAt] = useState('');
  const readOnly = ['approved', 'scheduled', 'published', 'archived'].includes(draft.status);

  const classified = useMemo(() => new Set(form.claims.map(claim => `${claim.field}:${claim.text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi')}`)), [form.claims]);
  const unclassifiedCount = useMemo(() => [
    ...lines(form.strengths).map(text => ({ field: 'strengths', text })),
    ...lines(form.limitations).map(text => ({ field: 'limitations', text })),
  ].filter(item => !classified.has(`${item.field}:${item.text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi')}`)).length, [classified, form.limitations, form.strengths]);

  const setField = (field: keyof Omit<EditableForm, 'claims'>, value: string) => setForm(current => ({ ...current, [field]: value }));
  const updateClaim = (index: number, updates: Partial<ContentDraftClaim>) => setForm(current => ({
    ...current,
    claims: current.claims.map((claim, claimIndex) => claimIndex === index ? { ...claim, ...updates } : claim),
  }));

  const synchronizeClaims = () => {
    setForm(current => {
      const known = new Set(current.claims.map(claim => `${claim.field}:${claim.text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi')}`));
      const missing = [
        ...lines(current.strengths).map(text => ({ field: 'strengths', text })),
        ...lines(current.limitations).map(text => ({ field: 'limitations', text })),
      ].filter(item => !known.has(`${item.field}:${item.text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi')}`));
      return { ...current, claims: [...current.claims, ...missing.map(item => newClaim(item.field, item.text))] };
    });
  };

  const save = async () => {
    setBusy('save'); setError(''); setNotice('');
    try {
      const saved = await dashboardRequest<ContentDraft>('/api/dashboard/content', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update', draftId: draft.id,
          updates: {
            title: form.title, summary: form.summary, verdict: form.verdict,
            strengths: lines(form.strengths), limitations: lines(form.limitations),
            suitableFor: lines(form.suitableFor), notSuitableFor: lines(form.notSuitableFor), buyingNotes: lines(form.buyingNotes),
            faq: faq(form.faq), metaTitle: form.metaTitle, metaDescription: form.metaDescription, slug: form.slug,
            affiliateDisclosure: form.affiliateDisclosure, assignee: form.assignee, claims: form.claims,
          },
        }),
      });
      setForm(formFromDraft(saved));
      setEditorial(undefined);
      setNotice('Đã lưu bản nháp. Kết quả Editorial Guard cũ đã được xóa vì nội dung thay đổi.');
      onChanged();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Không thể lưu bản nháp.');
    } finally { setBusy(''); }
  };

  const runGuard = async () => {
    setBusy('guard'); setError(''); setNotice('');
    try {
      const result = await dashboardRequest<EditorialCheckResult>('/api/dashboard/content', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'check', draftId: draft.id }),
      });
      setEditorial(result);
      setNotice(result.status === 'READY' ? 'Editorial Guard: bản nháp sẵn sàng gửi kiểm duyệt.' : `Editorial Guard tìm thấy ${result.issues.length} vấn đề cần xử lý.`);
      onChanged();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Không thể chạy Editorial Guard.');
    } finally { setBusy(''); }
  };

  const transition = async () => {
    if (!nextStatus) return;
    setBusy('transition'); setError(''); setNotice('');
    try {
      const result = await dashboardRequest<{ draft: ContentDraft; editorial?: EditorialCheckResult }>('/api/dashboard/content', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'transition', draftId: draft.id, status: nextStatus, scheduledAt: nextStatus === 'scheduled' && scheduledAt ? new Date(scheduledAt).toISOString() : undefined }),
      });
      if (result.editorial) setEditorial(result.editorial);
      setNotice(`Đã chuyển workflow sang “${STATUS_LABELS[result.draft.status]}”.`);
      onChanged();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Không thể chuyển workflow.');
      onChanged();
    } finally { setBusy(''); }
  };

  return (
    <section className={styles.editor} aria-labelledby="content-editor-title">
      <header className={styles.header}>
        <div>
          <span>Trình soạn thủ công · không gọi AI</span>
          <h2 id="content-editor-title">{productTitle}</h2>
          <p>Bản nháp {draft.id} · cập nhật {formatDateTime(draft.updatedAt)}</p>
        </div>
        <div className={styles.headerActions}>
          <StatusBadge tone={readOnly ? 'warning' : 'info'}>{STATUS_LABELS[draft.status]}</StatusBadge>
          <button type="button" className={styles.secondaryButton} onClick={onClose}>Đóng trình soạn</button>
        </div>
      </header>

      {error && <div className={styles.error} role="alert"><DashboardIcon name="warning" size={17} /><span>{error}</span></div>}
      {notice && <div className={styles.notice} role="status"><DashboardIcon name="check" size={17} /><span>{notice}</span></div>}
      {readOnly && <div className={styles.warning} role="status"><DashboardIcon name="lock" size={17} /><span>Nội dung đang ở trạng thái chỉ đọc. Chuyển workflow về bước soạn trước khi chỉnh sửa.</span></div>}

      <div className={styles.grid} aria-disabled={readOnly}>
        <label className={styles.full}><span>Tiêu đề bài đánh giá</span><input value={form.title} maxLength={220} disabled={readOnly} onChange={event => setField('title', event.target.value)} /></label>
        <label className={styles.full}><span>Tóm tắt</span><textarea rows={5} value={form.summary} maxLength={8000} disabled={readOnly} onChange={event => setField('summary', event.target.value)} /></label>
        <label className={styles.full}><span>Kết luận</span><textarea rows={4} value={form.verdict} maxLength={4000} disabled={readOnly} onChange={event => setField('verdict', event.target.value)} /></label>
        <ListField label="Ưu điểm" value={form.strengths} disabled={readOnly} onChange={value => setField('strengths', value)} />
        <ListField label="Hạn chế" value={form.limitations} disabled={readOnly} onChange={value => setField('limitations', value)} />
        <ListField label="Phù hợp với ai" value={form.suitableFor} disabled={readOnly} onChange={value => setField('suitableFor', value)} />
        <ListField label="Chưa phù hợp với ai" value={form.notSuitableFor} disabled={readOnly} onChange={value => setField('notSuitableFor', value)} />
        <ListField label="Lưu ý mua hàng" value={form.buyingNotes} disabled={readOnly} onChange={value => setField('buyingNotes', value)} />
        <label><span>FAQ</span><textarea rows={5} value={form.faq} disabled={readOnly} onChange={event => setField('faq', event.target.value)} /><small>Mỗi dòng: Câu hỏi || Câu trả lời</small></label>
        <label><span>Meta title</span><input value={form.metaTitle} maxLength={60} disabled={readOnly} onChange={event => setField('metaTitle', event.target.value)} /><small>{form.metaTitle.length}/60 ký tự</small></label>
        <label><span>Meta description</span><textarea rows={3} value={form.metaDescription} maxLength={160} disabled={readOnly} onChange={event => setField('metaDescription', event.target.value)} /><small>{form.metaDescription.length}/160 ký tự</small></label>
        <label><span>Slug</span><input value={form.slug} maxLength={180} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" disabled={readOnly} onChange={event => setField('slug', event.target.value)} /></label>
        <label><span>Người xử lý</span><input value={form.assignee} maxLength={120} disabled={readOnly} onChange={event => setField('assignee', event.target.value)} /></label>
        <label className={styles.full}><span>Disclosure affiliate</span><textarea rows={3} value={form.affiliateDisclosure} maxLength={1000} disabled={readOnly} onChange={event => setField('affiliateDisclosure', event.target.value)} /></label>
      </div>

      <section className={styles.sourceFacts}>
        <div className={styles.sectionHeading}><div><h3>Thông số đã xác minh</h3><p>Chỉ đọc từ canonical product; Content Studio không thể ghi đè nguồn.</p></div><StatusBadge tone="success">Read-only</StatusBadge></div>
        {Object.keys(draft.verifiedSpecifications).length ? <dl>{Object.entries(draft.verifiedSpecifications).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl> : <p className={styles.empty}>Sản phẩm chưa có thông số được xác minh.</p>}
      </section>

      <section className={styles.claims}>
        <div className={styles.sectionHeading}>
          <div><h3>Claim và evidence</h3><p>Mỗi ưu điểm/hạn chế phải có claim. VERIFIED_SOURCE, DERIVED và HUMAN_CONFIRMED đều cần evidence hợp lệ.</p></div>
          <div className={styles.inlineActions}>
            {unclassifiedCount > 0 && <button type="button" className={styles.secondaryButton} disabled={readOnly} onClick={synchronizeClaims}>Tạo {unclassifiedCount} claim còn thiếu</button>}
            <button type="button" className={styles.secondaryButton} disabled={readOnly || form.claims.length >= 200} onClick={() => setForm(current => ({ ...current, claims: [...current.claims, newClaim()] }))}>Thêm claim</button>
          </div>
        </div>
        {form.claims.length === 0 ? <p className={styles.empty}>Chưa có claim. Editorial Guard sẽ chặn nhận định quan trọng chưa được phân loại.</p> : <div className={styles.claimList}>{form.claims.map((claim, index) => (
          <article className={styles.claimCard} key={claim.id}>
            <div className={styles.claimMeta}>
              <label><span>Vị trí</span><select value={claim.field} disabled={readOnly} onChange={event => updateClaim(index, { field: event.target.value })}>{CLAIM_FIELDS.map(field => <option key={field} value={field}>{field}</option>)}</select></label>
              <label><span>Loại claim</span><select value={claim.type} disabled={readOnly} onChange={event => updateClaim(index, { type: event.target.value as DraftClaimType })}>{CLAIM_TYPES.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}</select><small>{CLAIM_TYPES.find(type => type.value === claim.type)?.help}</small></label>
            </div>
            <label><span>Nội dung claim</span><textarea rows={3} value={claim.text} maxLength={2000} disabled={readOnly} onChange={event => updateClaim(index, { text: event.target.value })} /></label>
            <label><span>Evidence</span><select multiple size={Math.min(6, Math.max(3, evidenceFacts.length))} value={claim.evidenceFactIds} disabled={readOnly || evidenceFacts.length === 0} onChange={event => updateClaim(index, { evidenceFactIds: Array.from(event.target.selectedOptions, option => option.value) })}>{evidenceFacts.map(fact => <option key={fact.id} value={fact.id}>{fact.label}: {String(fact.value).slice(0, 70)} · {fact.sourceName}</option>)}</select><small>Giữ Ctrl/Cmd để chọn nhiều fact. Chỉ các fact canonical phía server mới hợp lệ.</small></label>
            <div className={styles.claimFooter}><code>{claim.id}</code><button type="button" className={styles.removeButton} disabled={readOnly} onClick={() => setForm(current => ({ ...current, claims: current.claims.filter((_, claimIndex) => claimIndex !== index) }))}>Xóa claim</button></div>
          </article>
        ))}</div>}
      </section>

      <div className={styles.actions}>
        <button type="button" className={styles.primaryButton} disabled={readOnly || Boolean(busy)} onClick={() => void save()}>{busy === 'save' ? 'Đang lưu…' : 'Lưu bản nháp'}</button>
        <button type="button" className={styles.secondaryButton} disabled={Boolean(busy)} onClick={() => void runGuard()}>{busy === 'guard' ? 'Đang kiểm tra…' : 'Chạy Editorial Guard'}</button>
      </div>

      {editorial && <section className={styles.guardResult} data-status={editorial.status} aria-live="polite">
        <div className={styles.sectionHeading}><div><h3>Kết quả Editorial Guard</h3><p>Kiểm tra lúc {formatDateTime(editorial.checkedAt)}</p></div><StatusBadge tone={checkTone(editorial.status)}>{editorial.status}</StatusBadge></div>
        {editorial.issues.length === 0 ? <p className={styles.ready}>Không còn lỗi biên tập trong bộ quy tắc hiện tại.</p> : <ul>{editorial.issues.map((issue, index) => <li key={`${issue.code}-${issue.field}-${index}`} data-severity={issue.severity}><strong>{issue.field}: {issue.message}</strong><span>{issue.suggestedFix}</span><code>{issue.code}</code></li>)}</ul>}
      </section>}

      <section className={styles.workflow}>
        <div><h3>Chuyển workflow</h3><p>Backend kiểm tra transition và quyền phê duyệt. Route này không có lựa chọn “Đã đăng”; xuất bản phải qua Safe Publish.</p></div>
        {transitions.length ? <div className={styles.workflowControls}>
          <label><span>Trạng thái tiếp theo</span><select value={nextStatus} onChange={event => setNextStatus(event.target.value as ContentWorkflowStatus)}>{transitions.map(status => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}</select></label>
          {nextStatus === 'scheduled' && <label><span>Thời điểm lên lịch</span><input type="datetime-local" value={scheduledAt} onChange={event => setScheduledAt(event.target.value)} /><small>Backend chỉ chấp nhận thời điểm trong tương lai.</small></label>}
          <button type="button" className={nextStatus === 'approved' ? styles.approveButton : styles.secondaryButton} disabled={Boolean(busy) || !nextStatus || (nextStatus === 'scheduled' && !scheduledAt)} onClick={() => void transition()}>{busy === 'transition' ? 'Đang chuyển…' : nextStatus === 'approved' ? 'Phê duyệt nội dung' : 'Chuyển trạng thái'}</button>
        </div> : <p className={styles.empty}>Không có transition trực tiếp từ trạng thái này.</p>}
      </section>
    </section>
  );
}

function ListField({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  return <label><span>{label}</span><textarea rows={5} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} /><small>Mỗi dòng là một mục.</small></label>;
}
