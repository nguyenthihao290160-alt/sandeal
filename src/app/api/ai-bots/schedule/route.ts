import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getAutomationSettings, updateAutomationSettings } from '@/lib/storage/automationSettings';
import { getRunLockStatus } from '@/lib/bots/runLock';
import { listRunLogs } from '@/lib/bots/runLogs';
import { getSchedulerState } from '@/lib/bots/automationScheduler';
import { getDailyPipelineUsage } from '@/lib/bots/productPipeline';
import { getQueueStats } from '@/lib/storage/candidateQueue';
import { getAllProducts } from '@/lib/storage/products';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const REVIEW_BLOCK_LABELS: Record<string, string> = {
  insufficient_facts: 'Chưa đủ dữ kiện đã xác minh', unsafe_claim: 'Có claim không an toàn',
  claim_validation_failed: 'Claim thiếu bằng chứng', duplicate_content: 'Nội dung trùng lặp',
  low_originality: 'Nội dung chưa đủ khác biệt', low_content_quality: 'Chất lượng nội dung thấp',
  low_seo_readiness: 'Chưa đạt điều kiện SEO', unverified_source: 'Nguồn chưa xác minh',
  review_not_indexable: 'Bài đánh giá chưa đủ điều kiện lập chỉ mục', broken_product_url: 'Link sản phẩm lỗi',
  broken_affiliate_url: 'Link affiliate lỗi', broken_image: 'Ảnh lỗi', missing_price: 'Thiếu giá',
};

function getVietnameseBlockReasons(product: Awaited<ReturnType<typeof getAllProducts>>[number]): string[] {
  const reasons = [
    ...(product.publicBlockReasons || String(product.publicBlockReason || '').split(',')),
    ...(product.reviewContent?.reviewBlockReasons || []),
  ].map((item) => item.trim()).filter(Boolean);
  return [...new Set(reasons.length ? reasons : ['review_not_indexable'])].map((reason) => REVIEW_BLOCK_LABELS[reason] || reason);
}

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;

  try {
    const settings = await getAutomationSettings();
    const lockStatus = await getRunLockStatus();
    const recentLogs = await listRunLogs(20); // Get latest 20 logs
    const lastRun = recentLogs.length > 0 ? recentLogs[0] : null;
    const schedulerState = await getSchedulerState();
    const pipelineUsage = await getDailyPipelineUsage();
    const queue = await getQueueStats();
    const products = await getAllProducts();

    const dailyUsage = pipelineUsage.productsReviewed;

    // Calculate next run
    let nextRunAt = null;
    if (settings.enabled) {
      nextRunAt = [schedulerState.nextSourceScanAt, schedulerState.nextReviewRunAt]
        .filter((value): value is string => Boolean(value)).sort()[0] || new Date().toISOString();
    }

    const currentStatus = lockStatus.isLocked ? 'running' : (settings.enabled ? 'idle' : 'paused');

    return NextResponse.json({
      settings,
      currentStatus,
      activeLock: lockStatus.isLocked ? lockStatus.lock : null,
      lastRun,
      nextRunAt,
      recentRuns: recentLogs.slice(0, 5),
      dailyUsage,
      dailyRemaining: Math.max(0, settings.maxItemsPerDay - dailyUsage),
      schedulerState,
      pipelineUsage,
      queue,
      publicationBlocks: Object.entries(products.filter((p) => p.status === 'needs_review').reduce<Record<string, number>>((acc, product) => {
        for (const reason of getVietnameseBlockReasons(product)) acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8),
      reviewStats: products.reduce((stats, product) => {
        const status = product.reviewContent?.reviewStatus || 'pending';
        stats[status] = (stats[status] || 0) + 1;
        if (product.reviewContent?.seoReadinessScore && product.reviewContent.seoReadinessScore >= 80 && product.reviewContent.reviewStatus === 'approved') stats.seoReady++;
        else stats.seoBlocked++;
        return stats;
      }, { pending: 0, generated: 0, needs_review: 0, approved: 0, rejected: 0, stale: 0, seoReady: 0, seoBlocked: 0 } as Record<string, number>),
      policy: {
        safeMode: settings.safePublish,
        freeOnly: settings.freeOnly,
        safePublish: settings.safePublish,
        allowPaidAi: settings.allowPaidAi,
        costMode: settings.costMode,
      },
    });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch schedule data' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;

  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 400 });
    }

    const body = await request.json() as Record<string, unknown>;
    
    // Check for policy violations directly in the payload
    if (
      body.safePublish === false ||
      body.freeOnly === false ||
      body.allowPaidAi === true ||
      (body.costMode && body.costMode !== 'safe_free') ||
      body.safeMode === false
    ) {
      return NextResponse.json({ 
        error: 'Policy violation: Cannot override safety immutables.' 
      }, { status: 403 });
    }

    // Pick only allowed fields
    const updates: Record<string, unknown> = {};
    const allowedFields = [
      'enabled', 'sourceScanEnabled', 'intervalHours', 'mode', 'source',
      'maxItemsPerRun', 'maxItemsPerDay', 'autoClassify', 'autoCheckPrice',
      'autoCheckLink', 'autoCheckImage', 'autoScore', 'duplicateProtection',
      'sourceKeywords', 'bootstrapKeywordCount', 'steadyKeywordCount',
      'bootstrapCandidateLimit', 'steadyCandidateLimit', 'bootstrapReviewBatch',
      'steadyReviewBatch', 'maxConcurrency', 'maxRunDurationMs',
      'sourceRequestBudgetPerDay', 'networkCheckBudgetPerDay'
    ];

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    const updatedSettings = await updateAutomationSettings(updates);

    return NextResponse.json({
      success: true,
      settings: updatedSettings
    });
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }
    return NextResponse.json({ 
      error: err instanceof Error ? err.message : 'Failed to update schedule settings'
    }, { status: 500 });
  }
}
