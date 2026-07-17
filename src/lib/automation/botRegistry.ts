import type { ActualExecutionMode, AutomationJobType, BotRegistryEntry, RequestedExecutionMode } from './types';
import { applyPolicyToBotEntry, getAutomationPolicy } from './policyRegistry';

const REGISTRY_UPDATED_AT = '2026-07-15T00:00:00.000Z';

function entry(input: Omit<BotRegistryEntry, 'version' | 'inputSchemaVersion' | 'outputSchemaVersion' | 'timeoutMs' | 'maxAttempts' | 'shadowSupported' | 'manualSupported' | 'updatedAt'> & Partial<Pick<BotRegistryEntry, 'version' | 'inputSchemaVersion' | 'outputSchemaVersion' | 'timeoutMs' | 'maxAttempts' | 'shadowSupported' | 'manualSupported'>>): BotRegistryEntry {
  return {
    version: input.version || '1.0.0',
    inputSchemaVersion: input.inputSchemaVersion || '1',
    outputSchemaVersion: input.outputSchemaVersion || '1',
    timeoutMs: input.timeoutMs || 60_000,
    maxAttempts: input.maxAttempts || 3,
    shadowSupported: input.shadowSupported ?? true,
    manualSupported: input.manualSupported ?? true,
    updatedAt: REGISTRY_UPDATED_AT,
    ...input,
  };
}

const BOT_REGISTRY: readonly BotRegistryEntry[] = [
  entry({ id: 'OPERATIONS_ORCHESTRATOR', name: 'Điều phối vận hành', description: 'Lập kế hoạch và đưa công việc vào hàng đợi bền vững.', category: 'CONTROL_PLANE', capability: 'ORCHESTRATE_OPERATIONS', jobType: 'AUTO_PILOT', enabled: true, defaultExecutionMode: 'AUTO', risk: 'MEDIUM', approvalRequired: false, provider: 'system', fallback: ['LOCAL_RULES', 'MANUAL_INPUT'], rulesVersion: 'operations-plan-v1', writeScope: ['automation-jobs', 'automation-audit'], externalSideEffect: false }),
  entry({ id: 'POLICY_SAFETY_GUARD', name: 'Cổng chính sách an toàn', description: 'Kiểm tra Safe Mode, Free Only, kill switch và điều kiện đăng.', category: 'CONTROL_PLANE', capability: 'ENFORCE_SAFETY_POLICY', jobType: 'SAFE_PUBLISH', enabled: true, defaultExecutionMode: 'LOCAL_ONLY', risk: 'HIGH', approvalRequired: true, provider: 'system', fallback: ['LOCAL_RULES', 'MANUAL_INPUT'], rulesVersion: 'safe-publish-v2', writeScope: ['products', 'automation-audit'], externalSideEffect: true, shadowSupported: false }),
  entry({ id: 'PROVIDER_BUDGET_ROUTER', name: 'Bộ định tuyến provider', description: 'Chọn API, luật cục bộ hoặc tác vụ thủ công theo policy và trạng thái provider.', category: 'CONTROL_PLANE', capability: 'ROUTE_EXECUTION', enabled: true, defaultExecutionMode: 'AUTO', risk: 'MEDIUM', approvalRequired: false, provider: 'system', fallback: ['LOCAL_RULES', 'LOCAL_TEMPLATE', 'MANUAL_INPUT'], rulesVersion: 'provider-router-v1', writeScope: ['automation-ai-usage', 'automation-circuits'], externalSideEffect: false }),

  entry({ id: 'SOURCE_INTAKE', name: 'Tiếp nhận nguồn', description: 'Đưa dữ liệu nguồn vào hàng chờ xem xét, không tự đăng.', category: 'RULE_BASED_AUTOMATION', capability: 'INGEST_SOURCES', jobType: 'PRODUCT_SCAN', enabled: true, defaultExecutionMode: 'AUTO', risk: 'MEDIUM', approvalRequired: false, provider: 'local', fallback: ['LOCAL_RULES', 'MANUAL_INPUT'], rulesVersion: 'source-intake-v2', writeScope: ['source-candidates', 'product-review-queue'], externalSideEffect: true }),
  entry({ id: 'PRODUCT_NORMALIZER', name: 'Chuẩn hóa sản phẩm', description: 'Chuẩn hóa dữ liệu đã nhập bằng quy tắc xác định.', category: 'RULE_BASED_AUTOMATION', capability: 'NORMALIZE_PRODUCT', jobType: 'IMPORT_PRODUCTS', enabled: true, defaultExecutionMode: 'LOCAL_ONLY', risk: 'MEDIUM', approvalRequired: false, provider: 'local', fallback: ['LOCAL_RULES', 'MANUAL_INPUT'], rulesVersion: 'product-normalizer-v1', writeScope: ['products'], externalSideEffect: false }),
  entry({ id: 'HEALTH_INSPECTOR', name: 'Kiểm tra link và ảnh', description: 'Đánh giá sức khỏe dữ liệu và lưu kết quả kiểm tra.', category: 'RULE_BASED_AUTOMATION', capability: 'INSPECT_PRODUCT_HEALTH', jobType: 'RECHECK_PRODUCT_HEALTH', enabled: true, defaultExecutionMode: 'LOCAL_ONLY', risk: 'MEDIUM', approvalRequired: false, provider: 'local', fallback: ['LOCAL_RULES', 'MANUAL_INPUT'], rulesVersion: 'health-inspector-v1', writeScope: ['product-health'], externalSideEffect: true }),
  entry({ id: 'DUPLICATE_RESOLVER', name: 'Phát hiện trùng lặp', description: 'Nhóm sản phẩm trùng; không tự gộp hoặc xóa.', category: 'RULE_BASED_AUTOMATION', capability: 'DETECT_DUPLICATES', jobType: 'DETECT_DUPLICATES', enabled: true, defaultExecutionMode: 'LOCAL_ONLY', risk: 'MEDIUM', approvalRequired: false, provider: 'local', fallback: ['LOCAL_RULES', 'MANUAL_INPUT'], rulesVersion: 'dedupe-v1', writeScope: ['duplicate-groups'], externalSideEffect: false }),
  entry({ id: 'SCORING_ENGINE', name: 'Máy chấm điểm', description: 'Tính Quality, Opportunity và Deal Score bằng quy tắc phiên bản hóa.', category: 'RULE_BASED_AUTOMATION', capability: 'SCORE_PRODUCTS', jobType: 'SCORE_PRODUCTS', enabled: true, defaultExecutionMode: 'LOCAL_ONLY', risk: 'MEDIUM', approvalRequired: false, provider: 'local', fallback: ['LOCAL_RULES'], rulesVersion: 'scoring-v1', writeScope: ['product-scores'], externalSideEffect: false, manualSupported: false }),
  entry({ id: 'PRICE_WATCHER', name: 'Theo dõi giá', description: 'Ghi nhận snapshot và đánh giá thay đổi giá.', category: 'RULE_BASED_AUTOMATION', capability: 'CAPTURE_PRICE_HISTORY', jobType: 'CAPTURE_PRICE_HISTORY', enabled: true, defaultExecutionMode: 'LOCAL_ONLY', risk: 'MEDIUM', approvalRequired: false, provider: 'local', fallback: ['LOCAL_RULES', 'MANUAL_INPUT'], rulesVersion: 'price-watcher-v1', writeScope: ['price-history'], externalSideEffect: false }),
  entry({ id: 'ALERT_METRICS_ENGINE', name: 'Cảnh báo và chỉ số', description: 'Đánh giá cảnh báo có cooldown và tổng hợp chỉ số có mẫu số thật.', category: 'RULE_BASED_AUTOMATION', capability: 'EVALUATE_ALERTS', jobType: 'EVALUATE_ALERTS', enabled: true, defaultExecutionMode: 'LOCAL_ONLY', risk: 'LOW', approvalRequired: false, provider: 'local', fallback: ['LOCAL_RULES'], rulesVersion: 'alerts-v1', writeScope: ['alerts', 'growth-metrics'], externalSideEffect: false, manualSupported: false }),
  entry({ id: 'SYSTEM_HEALTH_INSPECTOR', name: 'Sức khỏe hệ thống', description: 'Đọc trạng thái runtime và dữ liệu mà không tạo side effect nghiệp vụ.', category: 'CONTROL_PLANE', capability: 'CHECK_SYSTEM_HEALTH', jobType: 'HEALTH_CHECK', enabled: true, defaultExecutionMode: 'LOCAL_ONLY', risk: 'LOW', approvalRequired: false, provider: 'system', fallback: ['LOCAL_RULES'], rulesVersion: 'system-health-v1', writeScope: [], externalSideEffect: false, manualSupported: false }),
  entry({ id: 'GROWTH_METRICS_AGGREGATOR', name: 'Tổng hợp tăng trưởng', description: 'Tổng hợp chỉ số tăng trưởng từ dữ liệu quan sát được.', category: 'RULE_BASED_AUTOMATION', capability: 'AGGREGATE_GROWTH_METRICS', jobType: 'AGGREGATE_GROWTH_METRICS', enabled: true, defaultExecutionMode: 'LOCAL_ONLY', risk: 'LOW', approvalRequired: false, provider: 'local', fallback: ['LOCAL_RULES'], rulesVersion: 'growth-metrics-v1', writeScope: ['growth-metrics'], externalSideEffect: false, manualSupported: false }),
  entry({ id: 'BULK_OPERATION_COORDINATOR', name: 'Thao tác hàng loạt', description: 'Điều phối thao tác hàng loạt trong write scope do policy giới hạn.', category: 'RULE_BASED_AUTOMATION', capability: 'BULK_PRODUCT_OPERATION', jobType: 'BULK_PRODUCT_OPERATION', enabled: true, defaultExecutionMode: 'LOCAL_ONLY', risk: 'MEDIUM', approvalRequired: false, provider: 'local', fallback: ['LOCAL_RULES'], rulesVersion: 'bulk-operation-v1', writeScope: ['products'], externalSideEffect: false }),
  entry({ id: 'EDITORIAL_GUARD', name: 'Kiểm tra biên tập', description: 'Chặn claim thiếu bằng chứng và nội dung không đủ điều kiện.', category: 'RULE_BASED_AUTOMATION', capability: 'VALIDATE_EDITORIAL', jobType: 'EDITORIAL_CHECK', enabled: true, defaultExecutionMode: 'LOCAL_ONLY', risk: 'HIGH', approvalRequired: false, provider: 'local', fallback: ['LOCAL_RULES', 'MANUAL_INPUT'], rulesVersion: 'editorial-guard-v1', writeScope: ['content-drafts'], externalSideEffect: false }),

  entry({ id: 'EVIDENCE_GROUNDED_ANALYST', name: 'Phân tích dựa trên bằng chứng', description: 'Đề xuất phân tích có evidence contract; không ghi fact chuẩn hoặc tự đăng.', category: 'AI_ASSISTED', capability: 'ANALYZE_WITH_EVIDENCE', jobType: 'AI_ANALYSIS', enabled: true, defaultExecutionMode: 'AUTO', risk: 'MEDIUM', approvalRequired: false, provider: 'gemini', modelId: 'configured-at-runtime', promptVersion: 'evidence-analysis-v1', fallback: ['LOCAL_TEMPLATE', 'MANUAL_INPUT'], writeScope: ['analysis-drafts'], externalSideEffect: true }),
  entry({ id: 'CONTENT_DRAFT_ASSISTANT', name: 'Trợ lý bản nháp nội dung', description: 'Tạo bản nháp cục bộ hoặc qua provider từ fact đã xác minh.', category: 'AI_ASSISTED', capability: 'PREPARE_CONTENT_DRAFT', jobType: 'PREPARE_CONTENT_DRAFT', enabled: true, defaultExecutionMode: 'AUTO', risk: 'MEDIUM', approvalRequired: false, provider: 'gemini', modelId: 'configured-at-runtime', promptVersion: 'content-draft-v1', templateVersion: 'content-template-v1', fallback: ['LOCAL_TEMPLATE', 'MANUAL_INPUT'], writeScope: ['content-drafts'], externalSideEffect: true }),
  entry({ id: 'EDITORIAL_ADJUDICATOR', name: 'Hỗ trợ xét duyệt biên tập', description: 'Đề xuất xử lý cảnh báo biên tập; quyết định vẫn do cổng an toàn.', category: 'AI_ASSISTED', capability: 'ADJUDICATE_EDITORIAL', enabled: false, defaultExecutionMode: 'MANUAL_ONLY', risk: 'HIGH', approvalRequired: true, provider: 'gemini', modelId: 'configured-at-runtime', promptVersion: 'editorial-adjudication-v1', fallback: ['MANUAL_INPUT'], writeScope: ['editorial-suggestions'], externalSideEffect: true }),
  entry({ id: 'MERCHANDISING_ADVISOR', name: 'Cố vấn sắp xếp nội dung', description: 'Chỉ tạo đề xuất; chưa bật vì chưa có model lưu trữ merchandising an toàn.', category: 'AI_ASSISTED', capability: 'ADVISE_MERCHANDISING', enabled: false, defaultExecutionMode: 'MANUAL_ONLY', risk: 'HIGH', approvalRequired: true, provider: 'gemini', modelId: 'configured-at-runtime', promptVersion: 'merchandising-advice-v1', fallback: ['MANUAL_INPUT'], writeScope: ['merchandising-suggestions'], externalSideEffect: false }),

  entry({ id: 'SAFE_PUBLISH_APPROVAL', name: 'Phê duyệt đăng an toàn', description: 'Cổng phê duyệt con người trước SAFE_PUBLISH.', category: 'HUMAN_APPROVAL_GATE', capability: 'APPROVE_SAFE_PUBLISH', enabled: true, defaultExecutionMode: 'MANUAL_ONLY', risk: 'HIGH', approvalRequired: true, provider: 'manual', fallback: ['MANUAL_INPUT'], writeScope: ['automation-jobs', 'automation-audit'], externalSideEffect: false, shadowSupported: false }),
  entry({ id: 'PRODUCT_LIFECYCLE_ENGINE', name: 'Vòng đời sản phẩm', description: 'Xử lý một candidate qua durable worker và tạo child job có idempotency.', category: 'RULE_BASED_AUTOMATION', capability: 'PROCESS_CANDIDATE', jobType: 'PROCESS_CANDIDATE', enabled: true, defaultExecutionMode: 'AUTO', risk: 'MEDIUM', approvalRequired: false, provider: 'local', fallback: ['LOCAL_RULES', 'LOCAL_TEMPLATE'], rulesVersion: 'product-lifecycle-v1', writeScope: ['candidate-queue', 'products', 'evidence-facts', 'automation-jobs'], externalSideEffect: true }),
  entry({ id: 'AUTONOMOUS_PUBLISH_GUARD', name: 'Đăng tự động an toàn', description: 'Tái tính eligibility phía server và chỉ publish khi mode, policy và budget cho phép.', category: 'CONTROL_PLANE', capability: 'AUTO_SAFE_PUBLISH', jobType: 'AUTO_SAFE_PUBLISH', enabled: true, defaultExecutionMode: 'LOCAL_ONLY', risk: 'LOW', approvalRequired: false, provider: 'system', fallback: ['LOCAL_RULES'], rulesVersion: 'auto-safe-publish-v1', writeScope: ['products', 'publication-audit', 'automation-jobs'], externalSideEffect: true, shadowSupported: true, manualSupported: false }),
  entry({ id: 'POST_PUBLISH_GUARDIAN', name: 'Giám sát sau đăng', description: 'Theo dõi public route, link, ảnh và giá; tự ẩn hoặc tạo recheck khi cần.', category: 'RULE_BASED_AUTOMATION', capability: 'POST_PUBLISH_MONITOR', jobType: 'POST_PUBLISH_MONITOR', enabled: true, defaultExecutionMode: 'LOCAL_ONLY', risk: 'MEDIUM', approvalRequired: false, provider: 'local', fallback: ['LOCAL_RULES'], rulesVersion: 'post-publish-monitor-v1', writeScope: ['products', 'evidence-facts', 'automation-jobs'], externalSideEffect: true }),
  entry({ id: 'AUTONOMOUS_RECONCILER', name: 'Đối soát tự động', description: 'Phát hiện và sửa orphan, stale state và child job thiếu khi việc sửa là an toàn.', category: 'CONTROL_PLANE', capability: 'RECONCILE_AUTOMATION', jobType: 'RECONCILE_AUTOMATION', enabled: true, defaultExecutionMode: 'LOCAL_ONLY', risk: 'MEDIUM', approvalRequired: false, provider: 'system', fallback: ['LOCAL_RULES'], rulesVersion: 'reconciler-v1', writeScope: ['automation-jobs', 'candidate-queue', 'products', 'operation-journal'], externalSideEffect: false }),
  entry({ id: 'RUNTIME_GUARDIAN', name: 'Giám sát runtime', description: 'Đánh giá role heartbeat, queue và storage để pause hoặc degrade publish lane.', category: 'CONTROL_PLANE', capability: 'RUNTIME_GUARDIAN', jobType: 'RUNTIME_GUARDIAN', enabled: true, defaultExecutionMode: 'LOCAL_ONLY', risk: 'MEDIUM', approvalRequired: false, provider: 'system', fallback: ['LOCAL_RULES'], rulesVersion: 'runtime-guardian-v1', writeScope: ['automation-control', 'runtime-health'], externalSideEffect: false }),
];

export function listBotRegistry(): BotRegistryEntry[] {
  return BOT_REGISTRY.map(item => applyPolicyToBotEntry({ ...item, fallback: [...item.fallback], writeScope: [...item.writeScope] }));
}

export function getBotRegistryEntry(id: string): BotRegistryEntry | null {
  const found = BOT_REGISTRY.find(item => item.id === id);
  return found ? applyPolicyToBotEntry({ ...found, fallback: [...found.fallback], writeScope: [...found.writeScope] }) : null;
}

export function findBotForCapability(capability: string): BotRegistryEntry | null {
  const normalized = capability.trim().toUpperCase();
  const found = BOT_REGISTRY.find(item => item.enabled && item.capability === normalized);
  return found ? applyPolicyToBotEntry({ ...found, fallback: [...found.fallback], writeScope: [...found.writeScope] }) : null;
}

export interface JobRegistryDefaults {
  botId: string;
  capability: string;
  requestedExecutionMode: RequestedExecutionMode;
  writeScope: string[];
  externalSideEffect: boolean;
  fallback: ActualExecutionMode[];
  maxAttempts: number;
}

export function getJobRegistryDefaults(type: AutomationJobType, _payload: Record<string, unknown>): JobRegistryDefaults {
  const jobPolicy = getAutomationPolicy(type);
  const registered = BOT_REGISTRY.find(item => item.enabled && item.id === jobPolicy.botId && item.jobType === type);
  if (!registered) throw new Error(`BOT_POLICY_CONTRACT_MISSING:${type}:${jobPolicy.botId}`);
  return {
    botId: jobPolicy.botId,
    capability: jobPolicy.capability,
    requestedExecutionMode: jobPolicy.defaultExecutionMode,
    writeScope: [...jobPolicy.writeScope],
    externalSideEffect: jobPolicy.externalSideEffect,
    fallback: [...jobPolicy.fallbackPolicy],
    maxAttempts: jobPolicy.retryPolicy.maxAttempts,
  };
}
