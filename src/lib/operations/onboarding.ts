import { getAllAutomationJobs, getAutomationControl } from '@/lib/automation/store';
import type { AutomationJob, AutomationJobType } from '@/lib/automation/types';
import { listAlerts } from '@/lib/product-intelligence/alerts';
import { listContentDrafts } from '@/lib/product-intelligence/contentStudio';
import { listOutboundEvents } from '@/lib/product-intelligence/growth';
import { listPendingManualSources } from '@/lib/product-intelligence/importer';
import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { getAllProducts } from '@/lib/storage/products';
import { listProductSources } from '@/lib/storage/productSources';
import { getPrimaryCredential } from '@/lib/storage/tokenVault';

export type OnboardingStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED';

export interface OnboardingStep {
  id: string;
  title: string;
  status: OnboardingStatus;
  reason: string;
  cta: string;
  route: string;
  completionCriteria: string;
  updatedAt: string;
}

function activeJob(jobs: AutomationJob[], types: AutomationJobType[]): AutomationJob | null {
  return [...jobs]
    .filter(job => types.includes(job.type) && ['PENDING', 'WAITING_APPROVAL', 'WAITING_FOR_MANUAL_INPUT', 'RUNNING', 'RETRY_SCHEDULED'].includes(job.status))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null;
}

function latestSucceeded(jobs: AutomationJob[], types: AutomationJobType[]): AutomationJob | null {
  return [...jobs]
    .filter(job => types.includes(job.type) && job.status === 'SUCCEEDED')
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null;
}

function step(input: Omit<OnboardingStep, 'updatedAt'>, updatedAt: string): OnboardingStep {
  return { ...input, updatedAt };
}

export async function buildOperationsOnboarding() {
  const [jobs, products, sources, pendingSources, drafts, alerts, outboundEvents, settings, control, accessTrade] = await Promise.all([
    getAllAutomationJobs(), getAllProducts(), listProductSources(), listPendingManualSources(100), listContentDrafts(),
    listAlerts({ limit: 500 }), listOutboundEvents(), getAutomationSettings(), getAutomationControl(), getPrimaryCredential('accesstrade'),
  ]);
  const now = new Date().toISOString();
  const enabledSources = sources.filter(source => source.enabled);
  const activeImport = activeJob(jobs, ['IMPORT_PRODUCTS']);
  const activeQuality = activeJob(jobs, ['SCORE_PRODUCTS']);
  const activeDedupe = activeJob(jobs, ['DETECT_DUPLICATES']);
  const activeContent = activeJob(jobs, ['PREPARE_CONTENT_DRAFT']);
  const activeEditorial = activeJob(jobs, ['EDITORIAL_CHECK']);
  const activePublish = activeJob(jobs, ['SAFE_PUBLISH']);
  const activeGrowth = activeJob(jobs, ['EVALUATE_ALERTS', 'AGGREGATE_GROWTH_METRICS']);
  const scored = products.filter(product => Number.isFinite(product.qualityScore)).length;
  const editorialChecked = drafts.filter(draft => Boolean(draft.lastEditorialCheck)).length;
  const reviewed = drafts.filter(draft => ['approved', 'scheduled'].includes(draft.status)).length
    + products.filter(product => product.status === 'approved' || product.status === 'published').length;
  const published = products.filter(product => product.status === 'published' && product.publicHidden === false).length;

  const steps: OnboardingStep[] = [
    step({ id: 'system', title: 'Kiểm tra hệ thống và Safe Mode', status: control.killSwitch ? 'BLOCKED' : settings.safePublish && settings.freeOnly && !settings.allowPaidAi && control.workerHeartbeatAt ? 'COMPLETED' : 'IN_PROGRESS', reason: control.killSwitch ? 'Kill switch đang bật.' : !control.workerHeartbeatAt ? 'Policy an toàn đã khóa; chưa ghi nhận heartbeat worker.' : 'Safe Mode, Free Only và worker heartbeat đã được xác minh.', cta: 'Mở sức khỏe hệ thống', route: '/dashboard/app-health', completionCriteria: 'Safe Publish và Free Only bật, paid AI tắt, kill switch tắt và worker có heartbeat.' }, control.changedAt || control.workerHeartbeatAt || settings.updatedAt || now),
    step({ id: 'source', title: 'Thiết lập nguồn', status: enabledSources.length > 0 || accessTrade?.status === 'valid' ? 'COMPLETED' : pendingSources.length > 0 ? 'IN_PROGRESS' : 'NOT_STARTED', reason: enabledSources.length > 0 ? `${enabledSources.length} nguồn đang bật.` : accessTrade?.status === 'valid' ? 'AccessTrade đã có credential được kiểm tra hợp lệ.' : pendingSources.length > 0 ? `${pendingSources.length} nguồn thủ công đang chờ xử lý.` : 'Chưa có nguồn đang bật hoặc kết nối AccessTrade hợp lệ.', cta: 'Thiết lập nguồn', route: '/dashboard/product-sources', completionCriteria: 'Có nguồn được bật hoặc credential AccessTrade hợp lệ; không cần cung cấp secret cho UI.' }, sources[0]?.updatedAt || pendingSources[0]?.updatedAt || accessTrade?.updatedAt || now),
    step({ id: 'import', title: 'Nhập dữ liệu đầu tiên', status: products.length > 0 ? 'COMPLETED' : activeImport ? 'IN_PROGRESS' : 'NOT_STARTED', reason: products.length > 0 ? `Đã có ${products.length} sản phẩm trong storage.` : activeImport ? `Import job ${activeImport.status}.` : 'Kho sản phẩm đang trống.', cta: 'Mở Import Center', route: '/dashboard/import', completionCriteria: 'Có ít nhất một sản phẩm hợp lệ được nhập ở trạng thái không public.' }, products[0]?.updatedAt || activeImport?.updatedAt || now),
    step({ id: 'quality', title: 'Chấm chất lượng dữ liệu', status: !products.length ? 'BLOCKED' : scored === products.length ? 'COMPLETED' : activeQuality ? 'IN_PROGRESS' : 'NOT_STARTED', reason: !products.length ? 'Cần nhập sản phẩm trước.' : scored === products.length ? `${scored}/${products.length} sản phẩm đã có Quality Score.` : activeQuality ? `Score job ${activeQuality.status}.` : `${products.length - scored} sản phẩm chưa có Quality Score.`, cta: 'Mở chất lượng', route: '/dashboard/quality', completionCriteria: 'Mọi sản phẩm trong phạm vi vận hành có Quality Score phiên bản hóa hoặc blocker rõ ràng.' }, activeQuality?.updatedAt || latestSucceeded(jobs, ['SCORE_PRODUCTS'])?.updatedAt || now),
    step({ id: 'dedupe', title: 'Kiểm tra trùng lặp', status: !products.length ? 'BLOCKED' : latestSucceeded(jobs, ['DETECT_DUPLICATES']) ? 'COMPLETED' : activeDedupe ? 'IN_PROGRESS' : 'NOT_STARTED', reason: !products.length ? 'Cần nhập sản phẩm trước.' : activeDedupe ? `Dedupe job ${activeDedupe.status}.` : latestSucceeded(jobs, ['DETECT_DUPLICATES']) ? 'Đã có lần phát hiện trùng hoàn tất.' : 'Chưa chạy phát hiện trùng.', cta: 'Kiểm tra trùng', route: '/dashboard/quality?tab=duplicates', completionCriteria: 'Có lần phát hiện trùng hoàn tất; nhóm confidence thấp không tự gộp.' }, activeDedupe?.updatedAt || latestSucceeded(jobs, ['DETECT_DUPLICATES'])?.updatedAt || now),
    step({ id: 'content', title: 'Chuẩn bị nội dung', status: !products.length ? 'BLOCKED' : drafts.length > 0 ? 'COMPLETED' : activeContent ? 'IN_PROGRESS' : 'NOT_STARTED', reason: !products.length ? 'Cần dữ liệu sản phẩm trước.' : drafts.length > 0 ? `Đã có ${drafts.length} bản nháp.` : activeContent ? `Content job ${activeContent.status}.` : 'Chưa có bản nháp local/API/manual.', cta: 'Mở Content Studio', route: '/dashboard/content', completionCriteria: 'Có bản nháp dựa trên verified facts; local phải ghi aiRequests=0.' }, drafts[0]?.updatedAt || activeContent?.updatedAt || now),
    step({ id: 'editorial', title: 'Chạy Editorial Guard', status: !drafts.length ? 'BLOCKED' : editorialChecked > 0 ? 'COMPLETED' : activeEditorial ? 'IN_PROGRESS' : 'NOT_STARTED', reason: !drafts.length ? 'Cần tạo bản nháp trước.' : editorialChecked > 0 ? `${editorialChecked} bản nháp đã được kiểm tra.` : activeEditorial ? `Editorial job ${activeEditorial.status}.` : 'Chưa có kết quả Editorial Guard.', cta: 'Kiểm tra biên tập', route: '/dashboard/content', completionCriteria: 'Bản nháp có kết quả Editorial Guard và claim quan trọng thiếu evidence bị chặn.' }, activeEditorial?.updatedAt || drafts.find(draft => draft.lastEditorialCheck)?.lastEditorialCheck?.checkedAt || now),
    step({ id: 'review', title: 'Xem xét và duyệt nội dung', status: !drafts.length ? 'BLOCKED' : reviewed > 0 ? 'COMPLETED' : drafts.some(draft => ['pending_review', 'needs_verification'].includes(draft.status)) ? 'IN_PROGRESS' : 'NOT_STARTED', reason: !drafts.length ? 'Cần bản nháp và Editorial Guard trước.' : reviewed > 0 ? `${reviewed} nội dung/sản phẩm đã có quyết định review.` : 'Chưa có quyết định review đủ điều kiện.', cta: 'Mở hàng chờ review', route: '/dashboard/content', completionCriteria: 'Có quyết định review server-side; approval không lấy từ client.' }, drafts[0]?.updatedAt || now),
    step({ id: 'safe-publish', title: 'Safe Publish', status: published > 0 ? 'COMPLETED' : activePublish ? 'IN_PROGRESS' : reviewed > 0 ? 'NOT_STARTED' : 'BLOCKED', reason: published > 0 ? `${published} sản phẩm public qua cổng an toàn.` : activePublish ? `Safe Publish job ${activePublish.status}.` : reviewed > 0 ? 'Có dữ liệu đã review nhưng chưa tạo Safe Publish job.' : 'Cần hoàn tất review trước.', cta: 'Mở Product Operations', route: '/dashboard/products', completionCriteria: 'SAFE_PUBLISH durable job có approval hợp lệ và vượt toàn bộ blocker trung tâm.' }, activePublish?.updatedAt || products.find(product => product.status === 'published')?.publishedAt || now),
    step({ id: 'growth', title: 'Theo dõi click và cảnh báo', status: !published ? 'BLOCKED' : outboundEvents.length > 0 || latestSucceeded(jobs, ['EVALUATE_ALERTS', 'AGGREGATE_GROWTH_METRICS']) ? 'COMPLETED' : activeGrowth ? 'IN_PROGRESS' : 'NOT_STARTED', reason: !published ? 'Cần sản phẩm public trước khi đo funnel.' : outboundEvents.length > 0 ? `Đã ghi nhận ${outboundEvents.length} event outbound an toàn.` : activeGrowth ? `Analytics/alert job ${activeGrowth.status}.` : 'Chưa có event hoặc lần đánh giá cảnh báo.', cta: 'Mở cảnh báo', route: '/dashboard/alerts', completionCriteria: 'Có event không PII và lần đánh giá alert/metrics; không tạo doanh thu hoặc conversion giả.' }, activeGrowth?.updatedAt || outboundEvents[0]?.timestamp || alerts[0]?.updatedAt || now),
  ];

  const recommendations = steps.filter(item => item.status !== 'COMPLETED').slice(0, 5).map(item => ({ id: item.id, title: item.title, reason: item.reason, route: item.route, cta: item.cta, status: item.status }));
  const completed = steps.filter(item => item.status === 'COMPLETED').length;
  return {
    hasOperationalData: Boolean(products.length || jobs.length || sources.length || drafts.length || outboundEvents.length),
    compact: Boolean(products.length),
    summary: { completed, total: steps.length, blocked: steps.filter(item => item.status === 'BLOCKED').length, inProgress: steps.filter(item => item.status === 'IN_PROGRESS').length },
    facts: {
      products: products.length,
      sources: enabledSources.length,
      pendingSources: pendingSources.length,
      scored,
      unscored: Math.max(0, products.length - scored),
      drafts: drafts.length,
      editorialChecked,
      published,
      outboundEvents: outboundEvents.length,
      openAlerts: alerts.filter(alert => !['resolved', 'ignored'].includes(alert.status)).length,
    },
    steps,
    recommendations,
    updatedAt: now,
  };
}
