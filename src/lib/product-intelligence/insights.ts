import { getAllProducts } from '@/lib/storage/products';
import { listDuplicateGroups } from './dedupe';
import { listContentDrafts } from './contentStudio';
import { listAlerts } from './alerts';
import { getGrowthSummary } from './growth';
import { PRODUCT_INTELLIGENCE_CONFIG as CONFIG } from './config';
import { extractVerifiedProductFacts } from '@/lib/editorialReview';
import { readCollection } from '@/lib/storage/adapter';
import type { PriceSnapshot } from './types';
import { getAllAutomationJobs } from '@/lib/automation/store';

export async function buildBusinessOverview() {
  const [products, groups, drafts, alerts, growth, priceSnapshots] = await Promise.all([
    getAllProducts(), listDuplicateGroups(), listContentDrafts(), listAlerts({ limit: 1_000 }), getGrowthSummary(30),
    readCollection<PriceSnapshot>('price-history'),
  ]);
  const activeAlerts = alerts.filter(item => !['resolved', 'ignored'].includes(item.status));
  const scored = products.filter(product => typeof product.qualityScore === 'number');
  const todayCutoff = Date.now() - 86_400_000;
  const sourceCounts = Object.entries(products.reduce<Record<string, number>>((output, product) => {
    output[product.source] = (output[product.source] || 0) + 1; return output;
  }, {})).map(([label, value]) => ({ label, value }));
  const bandCounts = (field: 'qualityBand' | 'dealBand') => Object.entries(products.reduce<Record<string, number>>((output, product) => {
    const value = product[field] || 'not_scored'; output[value] = (output[value] || 0) + 1; return output;
  }, {})).map(([label, value]) => ({ label, value }));
  const priceChangesByDay = Object.entries([...priceSnapshots]
    .sort((left, right) => left.productId.localeCompare(right.productId) || Date.parse(left.capturedAt) - Date.parse(right.capturedAt))
    .reduce<{ previous: Record<string, number>; days: Record<string, number> }>((output, snapshot) => {
      const current = Number(snapshot.salePrice || snapshot.price || 0);
      const previous = output.previous[snapshot.productId];
      if (current > 0 && previous > 0 && current !== previous) {
        const day = snapshot.capturedAt.slice(0, 10);
        output.days[day] = (output.days[day] || 0) + 1;
      }
      if (current > 0) output.previous[snapshot.productId] = current;
      return output;
    }, { previous: {}, days: {} }).days)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-30)
    .map(([label, value]) => ({ label, value }));
  return {
    kpis: {
      newProducts: products.filter(product => Date.parse(product.createdAt) >= todayCutoff).length,
      qualifiedProducts: products.filter(product => (product.qualityScore || 0) >= CONFIG.thresholds.qualityFair && product.qualityBand !== 'blocked').length,
      suspectedDuplicates: groups.filter(group => group.status === 'pending').length,
      averageQualityScore: scored.length ? Math.round(scored.reduce((sum, product) => sum + (product.qualityScore || 0), 0) / scored.length) : undefined,
      featuredDeals: products.filter(product => product.dealBand === 'featured').length,
      pendingContentReview: drafts.filter(draft => draft.status === 'pending_review').length,
      brokenLinks: products.filter(product => ['broken', 'not_found', 'product_unavailable', 'affiliate_error'].includes(String(product.linkHealthStatus || ''))).length,
      clicks: growth.clicks,
      unresolvedAlerts: activeAlerts.length,
    },
    charts: {
      productsBySource: sourceCounts,
      qualityBands: bandCounts('qualityBand'),
      dealBands: bandCounts('dealBand'),
      contentWorkflow: Object.entries(drafts.reduce<Record<string, number>>((output, draft) => { output[draft.status] = (output[draft.status] || 0) + 1; return output; }, {})).map(([label, value]) => ({ label, value })),
      alertSeverity: Object.entries(activeAlerts.reduce<Record<string, number>>((output, item) => { output[item.severity] = (output[item.severity] || 0) + 1; return output; }, {})).map(([label, value]) => ({ label, value })),
      priceChanges: priceChangesByDay,
      clicksByDay: growth.trend,
    },
  };
}

export async function getQualityDashboard(page = 1, pageSize = 20) {
  const [products, duplicateGroups] = await Promise.all([getAllProducts(), listDuplicateGroups()]);
  const sorted = [...products].sort((a, b) => (a.qualityScore ?? -1) - (b.qualityScore ?? -1) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const scored = products.filter(product => Number.isFinite(product.qualityScore));
  const pendingGroups = duplicateGroups.filter(group => group.status === 'pending');
  const suspectedDuplicateIds = new Set(pendingGroups.flatMap(group => group.productIds));
  const safePageSize = Math.max(1, Math.min(pageSize, CONFIG.limits.adminPageSize));
  const totalItems = sorted.length; const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize)); const safePage = Math.min(Math.max(1, page), totalPages);
  return {
    summary: {
      total: products.length,
      averageQualityScore: scored.length
        ? Math.round(scored.reduce((total, product) => total + Number(product.qualityScore || 0), 0) / scored.length)
        : undefined,
      good: products.filter(item => item.qualityBand === 'good').length,
      fair: products.filter(item => item.qualityBand === 'fair').length,
      needsData: products.filter(item => item.qualityBand === 'needs_data').length,
      poor: products.filter(item => item.qualityBand === 'poor').length,
      blocked: products.filter(item => item.qualityBand === 'blocked').length,
      duplicateGroups: pendingGroups.length,
      suspectedDuplicates: suspectedDuplicateIds.size,
    },
    items: sorted.slice((safePage - 1) * safePageSize, safePage * safePageSize).map(product => ({
      id: product.id, title: product.title, source: product.source, updatedAt: product.updatedAt,
      qualityScore: product.qualityScore, qualityBand: product.qualityBand,
      opportunityScore: product.opportunityScore, opportunityBand: product.opportunityBand,
      dealScore: product.dealScore, dealBand: product.dealBand,
      duplicateGroupId: product.duplicateGroupId, duplicateConfidence: product.duplicateConfidence,
      dataIssues: product.dataIssues || [], recommendedActions: product.recommendedActions || [],
    })),
    duplicateGroups: duplicateGroups.slice(0, 50),
    pagination: { page: safePage, pageSize: safePageSize, totalItems, totalPages },
  };
}

export async function getContentStudioDashboard() {
  const [products, drafts, jobs] = await Promise.all([getAllProducts(), listContentDrafts(), getAllAutomationJobs()]);
  return {
    items: products.filter(product => product.status !== 'archived').map(product => {
      const draft = drafts.find(item => item.productId === product.id && item.status !== 'archived');
      const productJobs = jobs.filter(job => job.payload.productId === product.id || (Array.isArray(job.payload.productIds) && job.payload.productIds.map(String).includes(product.id)) || job.payload.draftId === draft?.id)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      const currentJob = productJobs.find(job => ['PENDING', 'RUNNING', 'RETRY_SCHEDULED', 'WAITING_FOR_MANUAL_INPUT', 'WAITING_APPROVAL'].includes(job.status)) || productJobs[0];
      const blockers = [...new Set([...(product.dataIssues || []), ...(product.reviewContent?.reviewBlockReasons || []), ...(draft?.lastEditorialCheck?.issues.map(issue => issue.code) || [])])];
      const needsData = blockers.some(item => /needs_data|missing|source|price|link|image/i.test(item));
      return {
        product: { id: product.id, title: product.title, imageUrl: product.imageUrl, source: product.source, updatedAt: product.updatedAt },
        opportunityScore: product.opportunityScore,
        qualityBand: product.qualityBand,
        reviewStatus: product.reviewContent?.reviewStatus || 'pending',
        workflowStatus: draft?.status || product.contentWorkflowStatus || 'insufficient_data',
        assignee: draft?.assignee,
        warnings: [...(product.dataIssues || []), ...(product.reviewContent?.reviewBlockReasons || [])],
        publishStatus: product.status,
        draftId: draft?.id,
        editorialCheck: draft?.lastEditorialCheck,
        evidenceFacts: extractVerifiedProductFacts(product),
        operationalTruth: {
          blocker: blockers[0] || null,
          blockers,
          autoRemediationPossible: Boolean(currentJob?.status === 'FAILED' && currentJob.attemptCount < currentJob.maxAttempts) && !needsData,
          currentJob: currentJob ? { id: currentJob.id, status: currentJob.status, attemptCount: currentJob.attemptCount, maxAttempts: currentJob.maxAttempts, nextRetryAt: currentJob.nextRetryAt || null, lastAttemptAt: currentJob.startedAt || currentJob.updatedAt, lastSuccessAt: productJobs.find(job => job.status === 'SUCCEEDED')?.completedAt || null } : null,
          manualActionRequired: needsData || draft?.lastEditorialCheck?.status === 'BLOCKED',
          originalityScore: product.reviewContent?.originalityScore ?? null,
          seoReadiness: product.reviewContent?.seoReadinessScore ?? null,
          sourceVerified: product.verifiedSource === true || product.sourceVerified === true,
          paidAiAllowed: false,
        },
      };
    }).sort((a, b) => (b.opportunityScore || 0) - (a.opportunityScore || 0)),
    drafts,
  };
}
