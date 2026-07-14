import { createHash } from 'crypto';
import type { EditorialClaim, Product, ReviewContent } from '@/lib/types';
import { extractVerifiedProductFacts, generateEditorialReview } from '@/lib/editorialReview';
import { getProductById, saveCanonicalProduct } from '@/lib/storage/products';
import { generateId, readCollection, runTransaction } from '@/lib/storage/adapter';
import { appendAutomationAudit } from '@/lib/automation/store';
import { PRODUCT_INTELLIGENCE_CONFIG as CONFIG } from './config';
import type {
  ContentDraft,
  ContentDraftClaim,
  ContentWorkflowStatus,
  EditorialCheckResult,
  EditorialIssue,
} from './types';

const COLLECTION = 'content-drafts';
const ABSOLUTE_LANGUAGE = /\b(rẻ nhất|tốt nhất|số một|100%|chắc chắn|cam kết|bán chạy nhất|thấp nhất thị trường)\b/i;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9._:-]{1,160}$/;
const MAX_DRAFT_UPDATE_BYTES = 128 * 1024;
const EDITABLE_STATUSES = new Set<ContentWorkflowStatus>(['insufficient_data', 'ready_for_draft', 'drafting', 'needs_verification', 'pending_review', 'stale', 'blocked']);

export interface ContentOperationContext {
  actor?: string;
  operationId?: string;
}

export interface ContentTransitionOptions extends ContentOperationContext {
  scheduledAt?: string;
}

const TRANSITIONS: Record<ContentWorkflowStatus, ContentWorkflowStatus[]> = {
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

function claimFromEditorial(claim: EditorialClaim, field: string): ContentDraftClaim {
  return {
    id: claim.id,
    field,
    text: claim.text,
    type: claim.claimType === 'factual' ? 'VERIFIED_SOURCE' : claim.claimType === 'inferred' ? 'DERIVED' : 'UNVERIFIED',
    evidenceFactIds: [...claim.evidenceFactIds],
  };
}

function assertIdentifier(value: string, code: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER_PATTERN.test(normalized)) throw new Error(code);
  return normalized;
}

function operationContext(context: ContentOperationContext = {}): Required<ContentOperationContext> {
  return {
    actor: String(context.actor || 'content-studio').trim().slice(0, 120) || 'content-studio',
    operationId: IDENTIFIER_PATTERN.test(String(context.operationId || '')) ? String(context.operationId) : generateId(),
  };
}

async function appendContentAudit(input: {
  context?: ContentOperationContext;
  operationType: string;
  target: string;
  previousState?: string;
  nextState?: string;
  risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKER';
  reasons?: string[];
  result?: Record<string, unknown>;
}): Promise<void> {
  const context = operationContext(input.context);
  await appendAutomationAudit({
    correlationId: context.operationId,
    operationId: context.operationId,
    operationType: input.operationType,
    actor: context.actor,
    target: input.target,
    previousState: input.previousState,
    nextState: input.nextState,
    risk: input.risk || 'MEDIUM',
    reasons: input.reasons || [],
    result: input.result,
    dryRun: false,
    attempts: 1,
  });
}

export async function createLocalContentDraft(productId: string, actor: string, operationId?: string): Promise<ContentDraft> {
  productId = assertIdentifier(productId, 'INVALID_PRODUCT_ID');
  const product = await getProductById(productId);
  if (!product) throw new Error('PRODUCT_NOT_FOUND');
  const current = (await readCollection<ContentDraft>(COLLECTION)).find(item => item.productId === productId && item.status !== 'archived');
  if (current) {
    await appendContentAudit({
      context: { actor, operationId }, operationType: 'CONTENT_DRAFT_REUSED', target: current.id,
      previousState: current.status, nextState: current.status, risk: 'LOW', reasons: ['active_draft_already_exists'],
    });
    return current;
  }
  const review = product.reviewContent || generateEditorialReview(product);
  const now = new Date().toISOString();
  const facts = extractVerifiedProductFacts(product);
  const draft: ContentDraft = {
    id: generateId(),
    productId,
    status: facts.length >= 3 ? 'drafting' : 'insufficient_data',
    title: review.reviewTitle || product.title,
    summary: review.reviewSummary || '',
    verdict: review.reviewVerdict || '',
    strengths: review.strengths.map(item => item.text),
    limitations: review.limitations.map(item => item.text),
    suitableFor: [...review.suitableFor],
    notSuitableFor: [...review.notSuitableFor],
    buyingNotes: [...review.buyingConsiderations],
    verifiedSpecifications: { ...(product.specifications || {}) },
    faq: [],
    metaTitle: (review.reviewTitle || product.title).slice(0, 60),
    metaDescription: (review.reviewSummary || '').slice(0, 160),
    slug: product.slug,
    affiliateDisclosure: product.affiliateDisclosure || 'SanDeal có thể nhận hoa hồng khi bạn mua qua liên kết, không làm tăng giá bạn trả.',
    claims: [
      ...review.strengths.map(item => claimFromEditorial(item, 'strengths')),
      ...review.limitations.map(item => claimFromEditorial(item, 'limitations')),
      ...review.factualClaims.map(item => claimFromEditorial(item, 'summary')),
      ...review.inferredClaims.map(item => claimFromEditorial(item, 'summary')),
    ].filter((item, index, list) => list.findIndex(candidate => candidate.id === item.id) === index),
    createdBy: actor.slice(0, 120),
    createdAt: now,
    updatedAt: now,
  };
  await runTransaction<ContentDraft>(COLLECTION, items => [...items.slice(-(CONFIG.limits.collectionRecords - 1)), draft]);
  await saveCanonicalProduct(productId, { contentWorkflowStatus: draft.status });
  await appendContentAudit({
    context: { actor, operationId }, operationType: 'CONTENT_DRAFT_CREATED', target: draft.id,
    nextState: draft.status, risk: 'LOW', result: { productId, mode: 'local_template', aiUsed: false },
  });
  return draft;
}

export async function listContentDrafts(): Promise<ContentDraft[]> {
  return (await readCollection<ContentDraft>(COLLECTION)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function getContentDraft(id: string): Promise<ContentDraft | null> {
  return (await readCollection<ContentDraft>(COLLECTION)).find(item => item.id === id) || null;
}

export function validateContentDraftUpdates(value: unknown): Partial<ContentDraft> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CONTENT_UPDATES');
  let serialized = '';
  try { serialized = JSON.stringify(value); } catch { throw new Error('INVALID_CONTENT_UPDATES'); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DRAFT_UPDATE_BYTES) throw new Error('CONTENT_UPDATE_TOO_LARGE');
  const updates = value as Partial<ContentDraft>;
  const allowedFields = new Set([
    'title', 'summary', 'verdict', 'metaTitle', 'metaDescription', 'slug', 'affiliateDisclosure', 'assignee',
    'strengths', 'limitations', 'suitableFor', 'notSuitableFor', 'buyingNotes', 'faq', 'claims',
    // Source specifications are accepted for backwards compatibility, but are intentionally ignored below.
    'verifiedSpecifications',
  ]);
  for (const key of Object.keys(updates)) if (!allowedFields.has(key)) throw new Error('INVALID_CONTENT_UPDATE_FIELD');
  const textLimits: Partial<Record<keyof ContentDraft, number>> = {
    title: 220, summary: 8_000, verdict: 4_000, metaTitle: 60, metaDescription: 160,
    slug: 180, affiliateDisclosure: 1_000, assignee: 120,
  };
  const textFields = Object.keys(textLimits) as Array<keyof ContentDraft>;
  const safe: Partial<ContentDraft> = {};
  for (const field of textFields) {
    const value = updates[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new Error('INVALID_CONTENT_TEXT_FIELD');
    const normalized = value.trim();
    if (normalized.length > (textLimits[field] || 500)) throw new Error('CONTENT_FIELD_TOO_LONG');
    (safe as Record<string, unknown>)[field] = normalized;
  }
  for (const field of ['strengths', 'limitations', 'suitableFor', 'notSuitableFor', 'buyingNotes'] as const) {
    if (updates[field] === undefined) continue;
    if (!Array.isArray(updates[field]) || updates[field]!.length > 30) throw new Error('INVALID_CONTENT_LIST');
    const list = updates[field]!.map(item => {
      if (typeof item !== 'string' || item.length > 1_000) throw new Error('INVALID_CONTENT_LIST');
      return item.trim();
    }).filter(Boolean);
    safe[field] = list;
  }
  if (updates.faq !== undefined) {
    if (!Array.isArray(updates.faq) || updates.faq.length > 20) throw new Error('INVALID_CONTENT_FAQ');
    safe.faq = updates.faq.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('INVALID_CONTENT_FAQ');
      const question = typeof item.question === 'string' ? item.question.trim() : '';
      const answer = typeof item.answer === 'string' ? item.answer.trim() : '';
      if (question.length > 500 || answer.length > 2_000) throw new Error('INVALID_CONTENT_FAQ');
      return { question, answer };
    }).filter(item => item.question || item.answer);
  }
  if (updates.claims !== undefined) {
    if (!Array.isArray(updates.claims) || updates.claims.length > 200) throw new Error('INVALID_CONTENT_CLAIMS');
    const claimIds = new Set<string>();
    safe.claims = updates.claims.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('INVALID_CONTENT_CLAIMS');
      const id = item.id ? assertIdentifier(String(item.id), 'INVALID_CLAIM_ID') : generateId();
      if (claimIds.has(id)) throw new Error('DUPLICATE_CLAIM_ID');
      claimIds.add(id);
      const field = typeof item.field === 'string' ? item.field.trim() : '';
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (!field || field.length > 120 || !text || text.length > 2_000) throw new Error('INVALID_CONTENT_CLAIMS');
      if (!['VERIFIED_SOURCE', 'DERIVED', 'AI_DRAFT', 'HUMAN_CONFIRMED', 'UNVERIFIED'].includes(item.type)) throw new Error('INVALID_CLAIM_TYPE');
      if (!Array.isArray(item.evidenceFactIds) || item.evidenceFactIds.length > 50) throw new Error('INVALID_CLAIM_EVIDENCE');
      const evidenceFactIds = [...new Set(item.evidenceFactIds.map(evidenceId => assertIdentifier(String(evidenceId), 'INVALID_CLAIM_EVIDENCE')))];
      return { id, field, text, type: item.type, evidenceFactIds };
    });
  }
  return safe;
}

export async function updateContentDraft(id: string, updates: Partial<ContentDraft>, context: ContentOperationContext = {}): Promise<ContentDraft | null> {
  id = assertIdentifier(id, 'INVALID_DRAFT_ID');
  const existing = await getContentDraft(id);
  if (!existing) return null;
  if (!EDITABLE_STATUSES.has(existing.status)) throw new Error('CONTENT_DRAFT_READ_ONLY');
  const product = await getProductById(existing.productId);
  if (!product) throw new Error('PRODUCT_NOT_FOUND');
  const safeUpdates = validateContentDraftUpdates(updates);
  // Verified source specifications always come from the canonical product and cannot be edited in Content Studio.
  const canonicalSpecifications = { ...(product.specifications || {}) };
  const onlyReadOnlySourceFacts = Object.keys(safeUpdates).length === 0 && Object.prototype.hasOwnProperty.call(updates, 'verifiedSpecifications');
  if (Object.keys(safeUpdates).length === 0 && !onlyReadOnlySourceFacts) throw new Error('EMPTY_CONTENT_UPDATE');
  let saved: ContentDraft | null = null;
  await runTransaction<ContentDraft>(COLLECTION, items => {
    const index = items.findIndex(item => item.id === id);
    if (index < 0) return undefined;
    if (!EDITABLE_STATUSES.has(items[index].status)) throw new Error('CONTENT_DRAFT_READ_ONLY');
    if (onlyReadOnlySourceFacts) {
      const needsRestore = JSON.stringify(items[index].verifiedSpecifications || {}) !== JSON.stringify(canonicalSpecifications);
      items[index].verifiedSpecifications = canonicalSpecifications;
      saved = { ...items[index] };
      return needsRestore ? items : undefined;
    }
    items[index] = {
      ...items[index], ...safeUpdates, verifiedSpecifications: canonicalSpecifications,
      lastEditorialCheck: undefined, id, productId: items[index].productId, updatedAt: new Date().toISOString(),
    };
    saved = { ...items[index] };
    return items;
  });
  const savedDraft = saved as ContentDraft | null;
  if (savedDraft) await appendContentAudit({
    context, operationType: onlyReadOnlySourceFacts ? 'CONTENT_SOURCE_FACT_UPDATE_IGNORED' : 'CONTENT_DRAFT_UPDATED', target: id,
    previousState: existing.status, nextState: savedDraft.status, risk: 'MEDIUM',
    reasons: onlyReadOnlySourceFacts ? ['verified_specifications_are_read_only'] : [],
    result: { productId: existing.productId, changedFields: Object.keys(safeUpdates) },
  });
  return savedDraft;
}

function addIssue(issues: EditorialIssue[], code: string, field: string, severity: EditorialIssue['severity'], message: string, suggestedFix: string) {
  issues.push({ code, field, severity, message, suggestedFix });
}

export function runEditorialGuard(draft: ContentDraft, product: Product, now = Date.now()): EditorialCheckResult {
  const issues: EditorialIssue[] = [];
  const facts = new Set(extractVerifiedProductFacts(product).map(item => item.id));
  for (const claim of draft.claims) {
    const evidenceValid = claim.evidenceFactIds.length > 0 && claim.evidenceFactIds.every(id => facts.has(id));
    if (!claim.text.trim()) addIssue(issues, 'empty_claim', claim.field, 'blocker', 'Claim không có nội dung.', 'Xóa claim hoặc bổ sung nội dung cần kiểm chứng.');
    if (claim.type === 'UNVERIFIED') addIssue(issues, 'unverified_claim', claim.field, 'blocker', 'Claim quan trọng chưa được xác minh.', 'Gắn evidence hoặc loại bỏ claim.');
    if (claim.type === 'AI_DRAFT') addIssue(issues, 'ai_draft_claim', claim.field, 'error', 'Claim AI draft chưa được con người xác minh.', 'Đối chiếu nguồn rồi đổi trạng thái claim.');
    if (claim.type === 'VERIFIED_SOURCE' && !evidenceValid) addIssue(issues, 'missing_evidence', claim.field, 'blocker', 'Claim nguồn xác minh thiếu evidence hợp lệ.', 'Chọn fact đã xác minh tương ứng.');
    if (claim.type === 'HUMAN_CONFIRMED' && !evidenceValid) addIssue(issues, 'human_confirmation_without_evidence', claim.field, 'blocker', 'Claim được người xử lý xác nhận nhưng chưa tham chiếu evidence hợp lệ.', 'Gắn fact đã xác minh hoặc đổi claim về UNVERIFIED.');
    if (claim.type === 'DERIVED' && !evidenceValid) addIssue(issues, 'derived_without_evidence', claim.field, 'error', 'Claim suy luận chưa nêu dữ liệu làm cơ sở.', 'Gắn fact dùng để suy luận và diễn đạt có giới hạn.');
    if (ABSOLUTE_LANGUAGE.test(claim.text)) addIssue(issues, 'absolute_language', claim.field, 'error', 'Ngôn từ tuyệt đối không có cơ sở so sánh.', 'Dùng mô tả giới hạn theo dữ liệu SanDeal ghi nhận.');
  }
  const classifiedClaims = new Set(draft.claims.map(claim => `${claim.field}:${claim.text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi')}`));
  for (const [field, claims] of [['strengths', draft.strengths], ['limitations', draft.limitations]] as const) {
    for (const text of claims) {
      if (!classifiedClaims.has(`${field}:${text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi')}`)) {
        addIssue(issues, 'missing_claim_classification', field, 'blocker', 'Một nhận định quan trọng chưa được phân loại claim.', 'Tạo claim tương ứng và chọn loại cùng evidence phù hợp.');
      }
    }
  }
  const canonicalSpecifications = JSON.stringify(Object.entries(product.specifications || {}).sort(([left], [right]) => left.localeCompare(right)));
  const draftSpecifications = JSON.stringify(Object.entries(draft.verifiedSpecifications || {}).sort(([left], [right]) => left.localeCompare(right)));
  if (canonicalSpecifications !== draftSpecifications) addIssue(issues, 'source_fact_modified', 'verifiedSpecifications', 'blocker', 'Thông số trong draft khác dữ liệu nguồn đã xác minh.', 'Khôi phục thông số từ sản phẩm canonical; không sửa tại Content Studio.');
  const combined = `${draft.title} ${draft.summary} ${draft.verdict} ${draft.strengths.join(' ')} ${draft.limitations.join(' ')}`;
  if (ABSOLUTE_LANGUAGE.test(combined)) addIssue(issues, 'absolute_language', 'content', 'error', 'Nội dung có tuyên bố tuyệt đối hoặc không được chứng minh.', 'Viết lại theo bằng chứng hiện có.');
  if (!draft.affiliateDisclosure.trim()) addIssue(issues, 'missing_disclosure', 'affiliateDisclosure', 'blocker', 'Thiếu disclosure tiếp thị liên kết.', 'Thêm thông báo SanDeal có thể nhận hoa hồng.');
  if (draft.metaTitle.trim().length < 20 || draft.metaTitle.length > 60) addIssue(issues, 'invalid_meta_title', 'metaTitle', 'error', 'Meta title trống, quá ngắn hoặc quá dài.', 'Giữ meta title từ 20 đến 60 ký tự.');
  if (draft.metaDescription.trim().length < 70 || draft.metaDescription.length > 160) addIssue(issues, 'invalid_meta_description', 'metaDescription', 'error', 'Meta description trống, quá ngắn hoặc quá dài.', 'Giữ meta description từ 70 đến 160 ký tự.');
  if (!SLUG_PATTERN.test(draft.slug)) addIssue(issues, 'invalid_slug', 'slug', 'blocker', 'Slug không hợp lệ.', 'Chỉ dùng chữ thường, số và dấu gạch ngang.');
  if (combined.length < 180) addIssue(issues, 'content_too_short', 'content', 'error', 'Nội dung quá ngắn để kiểm duyệt.', 'Bổ sung phần kết luận, điểm mạnh và hạn chế có bằng chứng.');
  if (combined.length > 30_000) addIssue(issues, 'content_too_long', 'content', 'error', 'Nội dung vượt giới hạn.', 'Rút gọn nội dung dưới 30.000 ký tự.');
  const priceAge = Date.parse(product.priceLastChangedAt || product.lastSeenAt || product.updatedAt);
  if (!Number.isFinite(priceAge) || now - priceAge > CONFIG.freshness.priceDays * 86_400_000) addIssue(issues, 'stale_price', 'price', 'error', 'Giá đã cũ hoặc chưa có thời điểm xác minh.', 'Tạo snapshot giá mới.');
  if (!['ok', 'redirect_ok'].includes(String(product.linkHealthStatus || product.productHealthStatus || ''))) addIssue(issues, 'link_unhealthy', 'originalUrl', 'blocker', 'Link sản phẩm chưa được xác minh hoạt động.', 'Chạy kiểm tra link trước khi duyệt.');
  if (product.imageUrl && !['ok', 'redirect_ok'].includes(String(product.imageHealthStatus || ''))) addIssue(issues, 'image_unhealthy', 'imageUrl', 'error', 'Ảnh chưa được xác minh hoạt động.', 'Chạy kiểm tra ảnh.');
  if ((product.duplicateConfidence || 0) >= CONFIG.thresholds.duplicateHigh) addIssue(issues, 'duplicate_blocker', 'product', 'blocker', 'Sản phẩm có nguy cơ trùng rất cao.', 'Xử lý nhóm trùng trước khi duyệt.');
  if (product.lastEditorialCheckAt && now - Date.parse(product.lastEditorialCheckAt) > CONFIG.freshness.editorialDays * 86_400_000) addIssue(issues, 'editorial_stale', 'content', 'error', 'Nội dung đã quá hạn kiểm tra.', 'Chạy lại Editorial Guard.');
  const status = issues.some(item => item.severity === 'blocker') ? 'BLOCKED'
    : issues.some(item => ['missing_evidence', 'human_confirmation_without_evidence', 'derived_without_evidence', 'ai_draft_claim', 'stale_price', 'link_unhealthy'].includes(item.code)) ? 'NEEDS_VERIFICATION'
      : issues.length ? 'NEEDS_EDIT' : 'READY';
  return { status, issues, checkedAt: new Date(now).toISOString() };
}

function draftReviewContent(draft: ContentDraft, product: Product, checkedAt: string): ReviewContent {
  const base = generateEditorialReview(product);
  const factual = draft.claims.filter(item => item.type === 'VERIFIED_SOURCE' || item.type === 'HUMAN_CONFIRMED').map<EditorialClaim>(item => ({
    id: item.id, text: item.text, claimType: 'factual', evidenceFactIds: item.evidenceFactIds, confidence: item.type === 'HUMAN_CONFIRMED' ? 'high' : 'medium',
  }));
  const inferred = draft.claims.filter(item => item.type === 'DERIVED').map<EditorialClaim>(item => ({
    id: item.id, text: item.text, claimType: 'inferred', evidenceFactIds: item.evidenceFactIds, confidence: 'medium',
  }));
  const review: ReviewContent = {
    ...base,
    reviewStatus: 'approved',
    reviewerType: 'human_editorial',
    reviewTitle: draft.title,
    reviewSummary: draft.summary,
    reviewVerdict: draft.verdict,
    suitableFor: draft.suitableFor,
    notSuitableFor: draft.notSuitableFor,
    strengths: factual.filter(item => draft.strengths.includes(item.text)),
    limitations: factual.filter(item => draft.limitations.includes(item.text)),
    factualClaims: factual,
    inferredClaims: inferred,
    unknownClaims: [],
    reviewBlockReasons: [],
    reviewedAt: checkedAt,
    contentUpdatedAt: checkedAt,
    editorialConfidence: factual.length ? 90 : base.editorialConfidence,
  };
  review.reviewContentHash = createHash('sha256').update(JSON.stringify({
    title: review.reviewTitle, summary: review.reviewSummary, verdict: review.reviewVerdict,
    factual, inferred, disclosure: draft.affiliateDisclosure,
  })).digest('hex');
  return review;
}

export async function transitionContentDraft(
  id: string,
  nextStatus: ContentWorkflowStatus,
  options: ContentTransitionOptions = {},
): Promise<{ draft: ContentDraft; editorial?: EditorialCheckResult }> {
  id = assertIdentifier(id, 'INVALID_DRAFT_ID');
  const draft = await getContentDraft(id);
  if (!draft) throw new Error('CONTENT_DRAFT_NOT_FOUND');
  if (nextStatus === 'published') {
    await appendContentAudit({
      context: options, operationType: 'CONTENT_DIRECT_PUBLISH_REJECTED', target: id,
      previousState: draft.status, nextState: draft.status, risk: 'BLOCKER', reasons: ['safe_publish_required'],
    });
    throw new Error('SAFE_PUBLISH_REQUIRED');
  }
  if (!TRANSITIONS[draft.status]?.includes(nextStatus)) throw new Error('INVALID_CONTENT_TRANSITION');
  const product = await getProductById(draft.productId);
  if (!product) throw new Error('PRODUCT_NOT_FOUND');
  let scheduledAt: string | undefined;
  if (nextStatus === 'scheduled') {
    const scheduledTime = Date.parse(String(options.scheduledAt || ''));
    if (!Number.isFinite(scheduledTime) || scheduledTime < Date.now()) throw new Error('INVALID_SCHEDULED_AT');
    scheduledAt = new Date(scheduledTime).toISOString();
  }
  let editorial: EditorialCheckResult | undefined;
  if (nextStatus === 'pending_review' || nextStatus === 'approved') {
    editorial = runEditorialGuard(draft, product);
    if (editorial.status !== 'READY') {
      await runTransaction<ContentDraft>(COLLECTION, items => {
        const current = items.find(item => item.id === id);
        if (!current) return undefined;
        current.lastEditorialCheck = editorial;
        return items;
      });
      await saveCanonicalProduct(product.id, { lastEditorialCheckAt: editorial.checkedAt });
      await appendContentAudit({
        context: options, operationType: 'CONTENT_TRANSITION_REJECTED', target: id,
        previousState: draft.status, nextState: draft.status, risk: editorial.status === 'BLOCKED' ? 'HIGH' : 'MEDIUM',
        reasons: editorial.issues.map(issue => issue.code), result: { requestedStatus: nextStatus, editorialStatus: editorial.status },
      });
      throw new Error(`EDITORIAL_${editorial.status}`);
    }
  }
  let updated!: ContentDraft;
  await runTransaction<ContentDraft>(COLLECTION, items => {
    const current = items.find(item => item.id === id);
    if (!current || current.status !== draft.status) throw new Error('CONTENT_TRANSITION_CONFLICT');
    current.status = nextStatus;
    current.scheduledAt = nextStatus === 'scheduled' ? scheduledAt : undefined;
    if (editorial) current.lastEditorialCheck = editorial;
    current.updatedAt = new Date().toISOString(); updated = { ...current };
    return items;
  });
  const productUpdates: Partial<Product> = { contentWorkflowStatus: nextStatus, lastEditorialCheckAt: editorial?.checkedAt };
  if (nextStatus === 'approved' && editorial) productUpdates.reviewContent = draftReviewContent(updated, product, editorial.checkedAt);
  await saveCanonicalProduct(product.id, productUpdates);
  await appendContentAudit({
    context: options, operationType: nextStatus === 'approved' ? 'CONTENT_APPROVED' : 'CONTENT_STATUS_CHANGED', target: id,
    previousState: draft.status, nextState: nextStatus, risk: nextStatus === 'approved' ? 'HIGH' : 'MEDIUM',
    result: { productId: product.id, editorialStatus: editorial?.status, scheduledAt },
  });
  return { draft: updated, editorial };
}

export async function editorialCheckDraft(id: string, context: ContentOperationContext = {}): Promise<EditorialCheckResult> {
  id = assertIdentifier(id, 'INVALID_DRAFT_ID');
  const draft = await getContentDraft(id);
  if (!draft) throw new Error('CONTENT_DRAFT_NOT_FOUND');
  const product = await getProductById(draft.productId);
  if (!product) throw new Error('PRODUCT_NOT_FOUND');
  const result = runEditorialGuard(draft, product);
  await runTransaction<ContentDraft>(COLLECTION, items => {
    const current = items.find(item => item.id === id);
    if (!current) return undefined;
    current.lastEditorialCheck = result;
    return items;
  });
  await saveCanonicalProduct(product.id, { lastEditorialCheckAt: result.checkedAt });
  await appendContentAudit({
    context, operationType: 'CONTENT_EDITORIAL_CHECKED', target: id, previousState: draft.status, nextState: draft.status,
    risk: result.status === 'BLOCKED' ? 'HIGH' : 'LOW', reasons: result.issues.map(issue => issue.code),
    result: { productId: product.id, status: result.status, issueCount: result.issues.length },
  });
  return result;
}
