// ===========================================
// API: Product by ID — GET + PATCH + DELETE
// ===========================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { getProductById, updateProduct, deleteProduct } from '@/lib/storage/products';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authError = await requireAuth(request);
    if (authError) return authError;
    const { id } = await params;
    const product = await getProductById(id);
    if (!product) {
      return errorResponse('Không tìm thấy sản phẩm.', undefined, 404);
    }
    return successResponse('Đã tải sản phẩm.', product);
  } catch (err) {
    return serverErrorResponse('Không thể tải sản phẩm.', err);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authError = await requireAuth(request);
    if (authError) return authError;
    const { id } = await params;
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return errorResponse('Dữ liệu JSON không hợp lệ.');
    }

    // Don't allow updating id, createdAt
    const { id: _id, createdAt: _ca, ...updates } = body;
    void _id;
    void _ca;

    const requestsPublicState = updates.status === 'published'
      || updates.publicHidden === false
      || updates.autoPublished === true
      || updates.publicDecision === 'published'
      || updates.indexable === true
      || Object.prototype.hasOwnProperty.call(updates, 'publishedAt');
    if (requestsPublicState) {
      return errorResponse('Trạng thái public chỉ được thay đổi qua Safe Publish.', 'SAFE_PUBLISH_REQUIRED', 409);
    }

    // Parse tags if string
    if (typeof updates.tags === 'string') {
      updates.tags = updates.tags.split(',').map((t: string) => t.trim()).filter(Boolean);
    }

    const product = await updateProduct(id, updates);
    if (!product) {
      return errorResponse('Không tìm thấy sản phẩm.', undefined, 404);
    }
    return successResponse('Đã cập nhật sản phẩm.', product);
  } catch (err) {
    return serverErrorResponse('Không thể cập nhật sản phẩm.', err);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authError = await requireAuth(request);
    if (authError) return authError;
    const { id } = await params;
    const deleted = await deleteProduct(id);
    if (!deleted) {
      return errorResponse('Không tìm thấy sản phẩm.', undefined, 404);
    }
    return successResponse('Đã xoá sản phẩm.');
  } catch (err) {
    return serverErrorResponse('Không thể xoá sản phẩm.', err);
  }
}
