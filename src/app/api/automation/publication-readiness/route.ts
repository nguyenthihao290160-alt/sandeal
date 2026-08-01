import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { publicationReadinessDryRun } from '@/lib/automation/safeProductRechecks';
import { getAutomationControl } from '@/lib/automation/store';
import { readBoundedCollectionSnapshot } from '@/lib/storage/adapter';
import type { Product } from '@/lib/types';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 10;
const MAXIMUM_LIMIT = 50;
const MAXIMUM_PRODUCTS = 5_000;
const MAXIMUM_PRODUCT_BYTES = 32 * 1024 * 1024;

function requestedLimit(request: NextRequest): number | null {
  const raw = request.nextUrl.searchParams.get('limit');
  if (raw === null || raw === '') return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAXIMUM_LIMIT) return null;
  return parsed;
}

/**
 * An authenticated, observational publication-readiness dry run. It is
 * deliberately GET-only: no rechecks, repairs, publications, or evidence
 * changes are scheduled when this endpoint is opened or refreshed.
 */
export async function GET(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;

  const limit = requestedLimit(request);
  if (limit === null) {
    return NextResponse.json({
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `limit phải là số nguyên từ 1 đến ${MAXIMUM_LIMIT}.`,
    }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const [products, control] = await Promise.all([
      readBoundedCollectionSnapshot<Product>('products', {
        maximumItems: MAXIMUM_PRODUCTS,
        maximumBytes: MAXIMUM_PRODUCT_BYTES,
      }),
      getAutomationControl(),
    ]);
    const data = publicationReadinessDryRun(products.items, {
      limit,
      // This field intentionally represents the Runtime Guardian block only.
      // Operator and policy blocks retain their own explicit classifications.
      runtimePublishingBlocked: control.publishBlockedByRuntime === true,
    });
    const currentStateComplete = products.metadata.collectionPresent;
    return NextResponse.json({
      ok: true,
      code: currentStateComplete ? 'OK' : 'PUBLICATION_READINESS_BOOTSTRAP',
      readOnly: true,
      message: currentStateComplete
        ? 'Dry-run sẵn sàng xuất bản đã hoàn tất; không có dữ liệu nào bị thay đổi.'
        : 'Chưa có read model sản phẩm để đánh giá sẵn sàng xuất bản; không có dữ liệu nào bị thay đổi.',
      data: {
        ...data,
        readOnly: true,
        currentState: currentStateComplete ? 'COMPLETE' : 'INSUFFICIENT_DATA',
        source: {
          driver: products.metadata.driver,
          collectionPresent: products.metadata.collectionPresent,
          itemCount: products.metadata.itemCount,
          observedBytes: products.metadata.observedBytes,
          maximumItems: products.metadata.maximumItems,
          maximumBytes: products.metadata.maximumBytes,
          queryCount: products.metadata.queryCount,
          currentStateComplete,
        },
        runtime: {
          publishBlockedByRuntime: control.publishBlockedByRuntime === true,
          currentReasonCodes: control.publishRuntimeReasons,
        },
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    console.error(JSON.stringify({
      type: 'publication_readiness_request_failed',
      reasonCode: 'PUBLICATION_READINESS_UNAVAILABLE',
    }));
    return NextResponse.json({
      ok: false,
      code: 'PUBLICATION_READINESS_UNAVAILABLE',
      message: 'Không thể đọc an toàn dữ liệu sẵn sàng xuất bản lúc này. Không có dữ liệu nào bị thay đổi.',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
