import { NextRequest, NextResponse } from 'next/server';
import { requirePermission, getServerActor } from '@/lib/auth';
import { generateId } from '@/lib/storage/adapter';
import { createAutomationJob } from '@/lib/automation/store';
import { getProductById } from '@/lib/storage/products';
import { getContentStudioDashboard } from '@/lib/product-intelligence/insights';
import {
  transitionContentDraft,
  updateContentDraft,
} from '@/lib/product-intelligence/contentStudio';
import type { ContentDraft, ContentWorkflowStatus } from '@/lib/product-intelligence/types';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 128 * 1024;
const ACTIONS = new Set(['create_local', 'update', 'check', 'transition']);
const WORKFLOW_STATUSES = new Set<ContentWorkflowStatus>([
  'insufficient_data', 'ready_for_draft', 'drafting', 'needs_verification', 'pending_review',
  'approved', 'scheduled', 'published', 'stale', 'blocked', 'archived',
]);
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9._:-]{1,160}$/;

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_REQUEST_BODY: 'Payload Content Studio phải là JSON object hợp lệ.',
  REQUEST_TOO_LARGE: 'Payload Content Studio vượt giới hạn 128 KB.',
  INVALID_CONTENT_ACTION: 'Thao tác Content Studio không hợp lệ.',
  INVALID_PRODUCT_ID: 'Mã sản phẩm không hợp lệ.',
  INVALID_DRAFT_ID: 'Mã bản nháp không hợp lệ.',
  INVALID_CONTENT_STATUS: 'Trạng thái workflow không hợp lệ.',
  INVALID_SCHEDULED_AT: 'Thời điểm lên lịch phải hợp lệ và nằm trong tương lai.',
  INVALID_CONTENT_UPDATES: 'Dữ liệu cập nhật bản nháp không hợp lệ.',
  INVALID_CONTENT_UPDATE_FIELD: 'Payload chứa trường Content Studio không được phép.',
  CONTENT_UPDATE_TOO_LARGE: 'Dữ liệu cập nhật bản nháp vượt giới hạn.',
  INVALID_CONTENT_TEXT_FIELD: 'Trường nội dung phải là chuỗi.',
  CONTENT_FIELD_TOO_LONG: 'Một trường nội dung vượt giới hạn cho phép.',
  INVALID_CONTENT_LIST: 'Danh sách nội dung không hợp lệ hoặc vượt giới hạn.',
  INVALID_CONTENT_FAQ: 'Danh sách FAQ không hợp lệ hoặc vượt giới hạn.',
  INVALID_CONTENT_CLAIMS: 'Danh sách claim không hợp lệ hoặc vượt giới hạn.',
  INVALID_CLAIM_ID: 'Mã claim không hợp lệ.',
  DUPLICATE_CLAIM_ID: 'Các claim phải có mã riêng biệt.',
  INVALID_CLAIM_TYPE: 'Loại claim không hợp lệ.',
  INVALID_CLAIM_EVIDENCE: 'Danh sách evidence của claim không hợp lệ.',
  EMPTY_CONTENT_UPDATE: 'Không có trường nội dung hợp lệ để lưu.',
  PRODUCT_NOT_FOUND: 'Không tìm thấy sản phẩm.',
  CONTENT_DRAFT_NOT_FOUND: 'Không tìm thấy bản nháp nội dung.',
  CONTENT_DRAFT_READ_ONLY: 'Bản nháp ở trạng thái chỉ đọc; hãy chuyển về bước soạn trước khi sửa.',
  INVALID_CONTENT_TRANSITION: 'Không thể chuyển workflow theo hướng đã chọn.',
  CONTENT_TRANSITION_CONFLICT: 'Workflow vừa được cập nhật ở nơi khác; hãy tải lại dữ liệu.',
  EDITORIAL_BLOCKED: 'Editorial Guard đang chặn bản nháp. Hãy xử lý các blocker trước.',
  EDITORIAL_NEEDS_EDIT: 'Bản nháp cần chỉnh sửa trước khi gửi kiểm duyệt.',
  EDITORIAL_NEEDS_VERIFICATION: 'Bản nháp cần bổ sung xác minh trước khi gửi kiểm duyệt.',
  SAFE_PUBLISH_REQUIRED: 'Không thể đánh dấu đã đăng trực tiếp. Hãy dùng quy trình Safe Publish có quyền, approval và audit.',
};

function response<T>(data: T, operationId?: string, status = 200) {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (operationId) headers['X-Operation-Id'] = operationId;
  return NextResponse.json({ ok: true, code: 'OK', operationId, data }, { status, headers });
}

function failure(code: string, operationId?: string, status = 400) {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (operationId) headers['X-Operation-Id'] = operationId;
  return NextResponse.json({ ok: false, code, operationId, message: ERROR_MESSAGES[code] || 'Không thể cập nhật Content Studio.' }, { status, headers });
}

function errorFailure(error: unknown, operationId?: string) {
  const rawCode = error instanceof Error ? error.message : '';
  const code = Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, rawCode) ? rawCode : 'CONTENT_STUDIO_ERROR';
  if (code === 'PRODUCT_NOT_FOUND' || code === 'CONTENT_DRAFT_NOT_FOUND') return failure(code, operationId, 404);
  if (['CONTENT_DRAFT_READ_ONLY', 'INVALID_CONTENT_TRANSITION', 'CONTENT_TRANSITION_CONFLICT', 'EDITORIAL_BLOCKED', 'EDITORIAL_NEEDS_EDIT', 'EDITORIAL_NEEDS_VERIFICATION', 'SAFE_PUBLISH_REQUIRED'].includes(code)) return failure(code, operationId, 409);
  if (code === 'CONTENT_STUDIO_ERROR') return failure(code, operationId, 500);
  return failure(code, operationId, code === 'REQUEST_TOO_LARGE' ? 413 : 400);
}

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new Error('REQUEST_TOO_LARGE');
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw new Error('REQUEST_TOO_LARGE');
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new Error('INVALID_REQUEST_BODY'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_REQUEST_BODY');
  return body as Record<string, unknown>;
}

function identifier(body: Record<string, unknown>, key: 'productId' | 'draftId', code: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value.trim())) throw new Error(code);
  return value.trim();
}

export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_CONTENT');
  if (denied) return denied;
  try {
    return response(await getContentStudioDashboard());
  } catch {
    return failure('CONTENT_STUDIO_ERROR', undefined, 500);
  }
}

export async function POST(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_CONTENT');
  if (denied) return denied;
  const operationId = generateId();
  try {
    const body = await readBody(request);
    const action = typeof body.action === 'string' ? body.action : '';
    if (!ACTIONS.has(action)) throw new Error('INVALID_CONTENT_ACTION');
    const actor = getServerActor();
    const context = { actor, operationId };

    if (action === 'create_local') {
      const productId = identifier(body, 'productId', 'INVALID_PRODUCT_ID');
      if (!await getProductById(productId)) throw new Error('PRODUCT_NOT_FOUND');
      const result = await createAutomationJob({
        type: 'PREPARE_CONTENT_DRAFT', payload: { productIds: [productId] },
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : `content:local:${productId}:${new Date().toISOString().slice(0, 13)}`,
        operationId, requestedBy: actor, riskLevel: 'MEDIUM', dryRun: body.dryRun === true,
        botId: 'CONTENT_DRAFT_ASSISTANT', capability: 'PREPARE_CONTENT_DRAFT', requestedExecutionMode: 'LOCAL_ONLY',
        executionPlan: [{ id: 'prepare-local-draft', capability: 'PREPARE_CONTENT_DRAFT', dependsOn: [], reason: 'Tạo draft từ verified facts bằng template deterministic.', status: 'PENDING', risk: 'MEDIUM', approvalRequired: false, expectedWrite: ['content-drafts'], externalCall: false, fallback: ['LOCAL_TEMPLATE', 'MANUAL_INPUT'] }],
      });
      return response({ jobId: result.job.id, operationId: result.job.operationId, status: result.job.status, trackingRoute: `/api/automation/jobs/${result.job.id}` }, operationId, result.created ? 202 : 200);
    }
    if (action === 'update') {
      const data = await updateContentDraft(identifier(body, 'draftId', 'INVALID_DRAFT_ID'), body.updates as Partial<ContentDraft>, context);
      if (!data) throw new Error('CONTENT_DRAFT_NOT_FOUND');
      return response(data, operationId);
    }
    if (action === 'check') {
      const draftId = identifier(body, 'draftId', 'INVALID_DRAFT_ID');
      const result = await createAutomationJob({
        type: 'EDITORIAL_CHECK', payload: { draftId },
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : `editorial:${draftId}:${new Date().toISOString().slice(0, 13)}`,
        operationId, requestedBy: actor, riskLevel: 'MEDIUM', dryRun: body.dryRun === true,
        botId: 'EDITORIAL_GUARD', capability: 'VALIDATE_EDITORIAL', requestedExecutionMode: 'LOCAL_ONLY',
        executionPlan: [{ id: 'editorial-guard', capability: 'VALIDATE_EDITORIAL', dependsOn: [], reason: 'Kiểm tra claim, evidence và readiness bằng rule phiên bản hóa.', status: 'PENDING', risk: 'MEDIUM', approvalRequired: false, expectedWrite: ['content-drafts'], externalCall: false, fallback: ['LOCAL_RULES', 'MANUAL_INPUT'] }],
      });
      return response({ jobId: result.job.id, operationId: result.job.operationId, status: result.job.status, trackingRoute: `/api/automation/jobs/${result.job.id}` }, operationId, result.created ? 202 : 200);
    }

    const draftId = identifier(body, 'draftId', 'INVALID_DRAFT_ID');
    const status = body.status;
    if (typeof status !== 'string' || !WORKFLOW_STATUSES.has(status as ContentWorkflowStatus)) throw new Error('INVALID_CONTENT_STATUS');
    if (status === 'approved') {
      const approvalDenied = await requirePermission(request, 'APPROVE_CONTENT');
      if (approvalDenied) return approvalDenied;
    }
    const scheduledAt = body.scheduledAt;
    if (scheduledAt !== undefined && (typeof scheduledAt !== 'string' || scheduledAt.length > 80)) throw new Error('INVALID_SCHEDULED_AT');
    return response(await transitionContentDraft(draftId, status as ContentWorkflowStatus, { ...context, scheduledAt }), operationId);
  } catch (error) {
    return errorFailure(error, operationId);
  }
}
