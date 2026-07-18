import { createHash } from 'node:crypto';
import { CandidateRetryScheduledError, processCandidateFromDurableJob, scanSourcesToQueue, selectOperationMode } from '@/lib/bots/productPipeline';
import { buildDashboardProducts } from '@/lib/dashboard/products';
import { executeProductIntelligenceJob } from '@/lib/product-intelligence/jobs';
import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { bridgeCandidatesToDurableJobs } from './candidateBridge';
import { executeAutoSafePublish } from './autoPublish';
import { runAutonomousReconciler } from './reconciler';
import { executePostPublishMonitor } from './postPublishMonitor';
import { runRuntimeGuardian } from './runtimeGuardian';
import { getProductById, getAllProducts, getPublicProducts, publishCanonicalProductTransaction } from '@/lib/storage/products';
import { completeManualTask, createManualTask, getManualTask } from './manualTasks';
import { routeProviderExecution } from './providerRouter';
import { approvalStatusForPolicy, getAutomationPolicy } from './policyRegistry';
import {
  canUseCircuit,
  claimAutomationJobs,
  completeAutomationJob,
  AUTOMATION_JOB_SCHEMA_VERSION,
  createAutomationJob,
  failAutomationJob,
  getAutomationControl,
  getAutomationJob,
  heartbeatAutomationJob,
  recordCircuitResult,
  updateAutomationControl,
  updateAutomationJobExecution,
  waitAutomationJobForChildren,
  waitAutomationJobForManual,
} from './store';
import type { AutomationCheckpoint, AutomationExecutionDisclosure, AutomationJob, ActualExecutionMode } from './types';
import { recordSourceQualityObservation } from '@/lib/autonomous/sourceQuality';

function assertUnhandledJobType(type: never): never {
  throw new Error(`UNSUPPORTED_JOB_TYPE:${String(type)}`);
}

export interface WorkerRunResult {
  workerId: string;
  claimed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  waitingManual: number;
  waitingChildren: number;
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertWorkerPolicy(job: AutomationJob): void {
  const policy = getAutomationPolicy(job.type);
  const riskRank = { LOW: 0, MEDIUM: 1, HIGH: 2, BLOCKER: 3 } as const;
  if (job.schemaVersion !== AUTOMATION_JOB_SCHEMA_VERSION) throw new Error('AUTOMATION_JOB_SCHEMA_UNSUPPORTED');
  if (!job.policyVersion || job.policyVersion !== policy.policyVersion) throw new Error('STALE_POLICY_SNAPSHOT');
  if (!job.handlerVersion || job.handlerVersion !== policy.handlerVersion) throw new Error('STALE_HANDLER_VERSION');
  if (!job.botId || job.botId !== policy.botId) throw new Error('POLICY_BOT_MISMATCH');
  if (!job.capability || job.capability !== policy.capability) throw new Error('POLICY_CAPABILITY_MISMATCH');
  if (riskRank[job.riskLevel] < riskRank[policy.defaultRisk]) throw new Error('POLICY_RISK_UNDERSTATED');
  if (job.maxAttempts !== policy.retryPolicy.maxAttempts) throw new Error('POLICY_RETRY_MISMATCH');
  const expectedApproval = approvalStatusForPolicy(policy, job.riskLevel);
  if (expectedApproval === 'PENDING' && job.approvalStatus !== 'APPROVED') throw new Error('APPROVAL_REQUIRED');
  if (expectedApproval === 'NOT_REQUIRED' && job.approvalStatus !== 'NOT_REQUIRED') throw new Error('POLICY_APPROVAL_MISMATCH');
  if ((job.executionPlan || []).some(step => step.approvalRequired !== (expectedApproval === 'PENDING'))) throw new Error('POLICY_PLAN_APPROVAL_MISMATCH');
  if ((job.executionPlan || []).some(step => step.externalCall !== policy.externalSideEffect)) throw new Error('POLICY_PLAN_SIDE_EFFECT_MISMATCH');
  if ((job.executionPlan || []).some(step => JSON.stringify(step.expectedWrite) !== JSON.stringify(policy.writeScope))) throw new Error('POLICY_PLAN_WRITE_SCOPE_MISMATCH');
  if (job.requestedBy === 'scheduler' && !policy.autonomousAllowed) throw new Error('POLICY_AUTONOMY_BLOCKED');
  if (policy.externalSideEffect && job.dryRun && job.executionMode === 'API') throw new Error('DRY_RUN_EXTERNAL_SIDE_EFFECT_BLOCKED');
}

function disclosure(
  job: AutomationJob,
  executionMode: ActualExecutionMode,
  input: Partial<AutomationExecutionDisclosure> = {},
): AutomationExecutionDisclosure {
  return {
    status: input.status || (executionMode === 'LOCAL_TEMPLATE' ? 'COMPLETED_WITH_LOCAL_TEMPLATE' : executionMode === 'MANUAL_INPUT' ? 'COMPLETED_WITH_MANUAL_INPUT' : executionMode === 'API' ? 'COMPLETED_WITH_API' : 'COMPLETED_WITH_LOCAL_RULES'),
    requestedMode: job.requestedExecutionMode || 'AUTO',
    executionMode,
    provider: input.provider || (executionMode === 'MANUAL_INPUT' ? 'manual' : executionMode === 'API' ? 'gemini' : 'local'),
    modelId: input.modelId,
    promptVersion: input.promptVersion,
    rulesVersion: input.rulesVersion,
    templateVersion: input.templateVersion,
    manualActor: input.manualActor,
    fallbackReason: input.fallbackReason,
    confidence: input.confidence,
    evidenceCoverage: input.evidenceCoverage,
    warnings: input.warnings || [],
    limitations: input.limitations || [],
    aiRequests: input.aiRequests || 0,
    externalRequests: input.externalRequests || 0,
    completedSteps: input.completedSteps || [],
    pendingSteps: input.pendingSteps || [],
    completedAt: input.completedAt,
  };
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/TEMPORARY_ERROR/i.test(message)) return 'TEMPORARY_ERROR';
  if (/not.?implemented|handler.?unavailable/i.test(message)) return 'PROVIDER_NOT_IMPLEMENTED';
  if (/invalid.?credential|401/i.test(message)) return 'INVALID_CREDENTIAL';
  if (/credential.?expired|403/i.test(message)) return 'CREDENTIAL_EXPIRED';
  if (/timeout|abort/i.test(message)) return 'TIMEOUT';
  if (/429|rate.?limit/i.test(message)) return 'RATE_LIMITED';
  if (/network|fetch|socket/i.test(message)) return 'NETWORK_ERROR';
  if (/credential|api.?key|configuration/i.test(message)) return 'CONFIGURATION_REQUIRED';
  if (/budget|quota/i.test(message)) return 'QUOTA_EXCEEDED';
  if (/schema/i.test(message)) return 'SCHEMA_VALIDATION_FAILED';
  if (/provider.?response|json.?response/i.test(message)) return 'INVALID_PROVIDER_RESPONSE';
  if (/publish.*(?:paused|disabled|blocked)|mode.*blocked|dry.?run.*publish/i.test(message)) return 'SAFETY_POLICY_BLOCKED';
  if (/safety|policy|kill.?switch|paid.?provider/i.test(message)) return 'SAFETY_POLICY_BLOCKED';
  if (/validation|invalid/i.test(message)) return 'VALIDATION_ERROR';
  return 'INTERNAL_ERROR';
}

async function dryRunPreview(job: AutomationJob): Promise<Record<string, unknown>> {
  const products = await getAllProducts();
  const requestedLimit = Number(job.payload.limit);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, Math.floor(requestedLimit))) : 10;
  const selected = products.slice(0, limit);
  const dashboard = buildDashboardProducts(selected, { sort: 'updated_desc', page: 1, pageSize: 50 });
  return {
    preview: true,
    inspected: selected.length,
    qualified: dashboard.summary.qualifiedForPublish,
    needsReview: dashboard.summary.needsReview,
    blocked: dashboard.summary.blocked + dashboard.summary.rejectedItems,
    estimatedAiRequests: job.type === 'AI_ANALYSIS' ? selected.length : 0,
    requiresApproval: job.riskLevel === 'HIGH',
    businessDataChanged: false,
    externalSideEffect: false,
  };
}

async function assertKillSwitchInactive(): Promise<void> {
  const control = await getAutomationControl();
  if (control.killSwitch) throw new Error('KILL_SWITCH_ACTIVE');
}

async function executeAutoPilotJob(
  job: AutomationJob,
  mode: 'source_scan' | 'full_safe_run',
): Promise<Record<string, unknown>> {
  if (job.dryRun) return dryRunPreview(job);
  await assertKillSwitchInactive();
  const circuit = await canUseCircuit('autopilot');
  if (!circuit.allowed) throw new Error('CIRCUIT_OPEN');
  try {
    const settings = await getAutomationSettings();
    const operationMode = selectOperationMode((await getPublicProducts()).length);
    const deadline = Date.now() + settings.maxRunDurationMs;
    const scan = await scanSourcesToQueue(operationMode, deadline, {
      runId: `automation-job:${job.id}:attempt:${job.attemptCount}`,
    });
    await assertKillSwitchInactive();
    const bridge = mode === 'full_safe_run' && Date.now() < deadline
      ? await bridgeCandidatesToDurableJobs({ parentJobId: job.id, requestedBy: 'autopilot-worker', limit: settings.maxItemsPerRun })
      : null;
    const failed = scan.failed;
    const completedSteps = ['runtime-preflight', 'source-budget-check', 'source-discovery', 'candidate-ingestion'];
    const pendingSteps = bridge?.jobs.length
      ? ['classification', 'normalization', 'evidence-capture', 'health-validation', 'duplicate-resolution', 'price-verification', 'scoring', 'content-preparation', 'editorial-validation', 'readiness-evaluation', 'autonomous-publish-or-quarantine', 'monitoring-schedule', 'cycle-summary']
      : [];
    const result = {
      executionStatus: failed > 0 || pendingSteps.length ? 'PARTIALLY_COMPLETED' : 'COMPLETED_WITH_LOCAL_RULES',
      executionMode: 'LOCAL_RULES',
      provider: 'local',
      rulesVersion: 'product-pipeline-v2',
      aiRequests: 0,
      externalRequests: scan.sourceRequests,
      fallbackReason: null,
      limitations: ['Candidate được xử lý bởi durable child job; publish chỉ chạy qua policy AUTO_SAFE_PUBLISH.'],
      completedSteps: pendingSteps.length ? completedSteps : [...completedSteps, 'cycle-summary'],
      pendingSteps,
      operationMode,
      sourceStatus: scan.sourceStatus,
      sourceReason: scan.reason,
      sourceCheckedAt: new Date().toISOString(),
      nextEligibleAt: scan.nextEligibleAt || null,
      retryAfter: scan.retryAfter || null,
      sourceMetrics: {
        normalized: scan.normalized,
        fastRejected: scan.rejected,
        timeout: scan.timeout,
        rateLimited: scan.rateLimited,
        durationMs: scan.durationMs,
      },
      summary: {
        sourceRequests: scan.sourceRequests,
        found: scan.found,
        queued: scan.queued,
        normalized: scan.normalized,
        rejected: scan.rejected,
        reviewed: 0,
        created: bridge?.created || 0,
        updated: bridge?.existing || 0,
        needsReview: 0,
        published: 0,
        failed,
      },
    };
    await recordCircuitResult('autopilot', true);
    return result;
  } catch (error) {
    if (['TIMEOUT', 'RATE_LIMITED', 'NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(errorCode(error))) {
      await recordCircuitResult('autopilot', false);
    }
    throw error;
  }
}

async function executeLocalIntelligenceJob(job: AutomationJob): Promise<Record<string, unknown>> {
  const output = await executeProductIntelligenceJob(job);
  const executionMode: ActualExecutionMode = job.dryRun
    ? 'SHADOW_MODE'
    : job.type === 'PREPARE_CONTENT_DRAFT'
      ? 'LOCAL_TEMPLATE'
      : 'LOCAL_RULES';
  return {
    ...output,
    executionStatus: output.executionStatus === 'PARTIALLY_COMPLETED'
      ? 'PARTIALLY_COMPLETED'
      : job.dryRun
      ? 'COMPLETED_WITH_LOCAL_RULES'
      : executionMode === 'LOCAL_TEMPLATE'
        ? 'COMPLETED_WITH_LOCAL_TEMPLATE'
        : 'COMPLETED_WITH_LOCAL_RULES',
    executionMode,
    provider: 'local',
    rulesVersion: executionMode === 'LOCAL_RULES' ? 'product-intelligence-v1' : undefined,
    templateVersion: executionMode === 'LOCAL_TEMPLATE' ? 'content-template-v1' : undefined,
    aiRequests: 0,
    fallbackReason: null,
    limitations: ['Kết quả local không tạo canonical fact mới và không tự đăng sản phẩm.'],
  };
}

async function executeEvidenceAnalysis(job: AutomationJob, workerId: string): Promise<Record<string, unknown>> {
  if (job.dryRun) {
    return {
      ...(await dryRunPreview(job)),
      executionStatus: 'COMPLETED_WITH_LOCAL_RULES',
      executionMode: 'SHADOW_MODE',
      provider: 'local',
      rulesVersion: 'evidence-contract-v1',
      aiRequests: 0,
      externalRequests: 0,
      warnings: ['Không gọi provider và không ghi draft trong chế độ chạy thử.'],
    };
  }
  await assertKillSwitchInactive();

  if (job.manualTaskId) {
    const task = await getManualTask(job.manualTaskId);
    if (!task || task.jobId !== job.id || !['SUBMITTED', 'COMPLETED'].includes(task.status) || !task.submittedInput) throw new Error('MANUAL_INPUT_NOT_READY');
    const completedAt = new Date().toISOString();
    const completedDisclosure = disclosure(job, 'MANUAL_INPUT', {
      provider: 'manual',
      manualActor: task.submittedBy,
      aiRequests: 0,
      externalRequests: 0,
      evidenceCoverage: 0,
      warnings: ['Nội dung là draft do người vận hành cung cấp; claim vẫn phải qua Editorial Guard.'],
      limitations: ['Không chuyển dữ liệu thủ công thành canonical fact hoặc phê duyệt đăng.'],
      completedSteps: ['provider-routing', 'manual-evidence-draft'],
      pendingSteps: ['editorial-validation'],
      completedAt,
    });
    const checkpoint: AutomationCheckpoint = {
      version: 1,
      completedSteps: ['provider-routing', 'manual-evidence-draft'],
      pendingSteps: ['editorial-validation'],
      outputs: { manualDraftHash: hashValue(task.submittedInput), validationStatus: 'UNVERIFIED' },
      executionModes: ['MANUAL_INPUT'],
      providerStatus: { provider: 'manual', status: 'SUBMITTED' },
      inputHash: job.checkpoint?.inputHash || hashValue(job.payload),
      outputHash: hashValue(task.submittedInput),
      updatedAt: completedAt,
    };
    const editorialChild = await createAutomationJob({
      type: 'EDITORIAL_CHECK',
      payload: { analysisJobId: job.id, manualTaskId: task.id, limit: Number(job.payload.limit) || 1 },
      idempotencyKey: `editorial-after-analysis:${job.id}:${hashValue(task.submittedInput)}`.slice(0, 160),
      operationId: `editorial-after-analysis:${job.operationId}`.slice(0, 160),
      requestedBy: workerId,
      parentJobId: job.id,
      priority: Math.max(1, job.priority - 1),
    });
    await updateAutomationJobExecution(job.id, workerId, { executionMode: 'MANUAL_INPUT', outcomeStatus: 'PARTIALLY_COMPLETED', checkpoint, disclosure: completedDisclosure });
    await completeManualTask(task.id, job.id, workerId);
    return {
      executionStatus: 'PARTIALLY_COMPLETED',
      executionMode: 'MANUAL_INPUT',
      provider: 'manual',
      manualActor: task.submittedBy,
      draftSuggestion: task.submittedInput,
      validationStatus: 'UNVERIFIED',
      evidenceCoverage: 0,
      aiRequests: 0,
      externalRequests: 0,
      canonicalDataChanged: false,
      published: false,
      childJobId: editorialChild.job.id,
      warnings: completedDisclosure.warnings,
      limitations: completedDisclosure.limitations,
    };
  }

  const decision = await routeProviderExecution({
    capability: job.capability || 'ANALYZE_WITH_EVIDENCE',
    requestedMode: job.requestedExecutionMode || 'AUTO',
    provider: 'gemini',
    providerAdapterAvailable: false,
    localMode: 'LOCAL_TEMPLATE',
    deterministicFirst: false,
    allowLocalFallback: true,
    allowManualFallback: true,
    allowPaidFallback: false,
    shadowMode: false,
    estimatedRequests: Math.max(1, Math.min(10, Number(job.payload.limit) || 1)),
    estimatedTokens: 2_000,
  });

  // A local template can prepare verified fields, but cannot satisfy evidence-grounded analysis by itself.
  const task = await createManualTask({
    jobId: job.id,
    operationId: job.operationId,
    capability: job.capability || 'ANALYZE_WITH_EVIDENCE',
    targetType: 'product-set',
    title: 'Bổ sung phân tích dựa trên bằng chứng',
    reasonCode: decision.failureCode || (decision.executionMode === 'LOCAL_TEMPLATE' ? 'LOCAL_TEMPLATE_INSUFFICIENT' : 'MANUAL_INPUT_REQUIRED'),
    instructions: [
      'Chỉ sử dụng dữ kiện đã được xác minh trong màn hình sản phẩm.',
      'Nêu rõ giới hạn và không đưa ra claim về trải nghiệm, tồn kho, rating hoặc hiệu quả khi thiếu bằng chứng.',
    ],
    verifiedFacts: {},
    evidence: [],
    missingInformation: ['Phân tích có liên kết evidence fact rõ ràng.'],
    questions: ['Tóm tắt phân tích nào được dữ kiện hiện có hỗ trợ?', 'Những giới hạn nào cần hiển thị công khai?'],
    expectedInputSchema: { version: 1, fields: [
      { name: 'analysisSummary', label: 'Bản nháp phân tích', type: 'string', required: true, maximumLength: 2_000 },
      { name: 'evidenceFactIds', label: 'Mã dữ kiện bằng chứng', type: 'string_array', required: true, maximumLength: 120 },
      { name: 'limitations', label: 'Giới hạn cần công bố', type: 'string_array', required: true, maximumLength: 300 },
    ] },
    validationRules: ['Claim quan trọng thiếu evidence sẽ giữ trạng thái UNVERIFIED.', 'Dữ liệu thủ công không tự phê duyệt hoặc đăng.'],
    risk: 'MEDIUM',
    approvalRequired: false,
    resumeCheckpoint: 'manual-evidence-draft',
    actor: workerId,
  });
  const now = new Date().toISOString();
  const checkpoint: AutomationCheckpoint = {
    version: 1,
    completedSteps: ['provider-routing'],
    pendingSteps: ['manual-evidence-draft', 'editorial-validation'],
    outputs: { providerFailureCode: decision.failureCode || null, localTemplatePrepared: decision.executionMode === 'LOCAL_TEMPLATE' },
    executionModes: decision.executionMode === 'LOCAL_TEMPLATE' ? ['LOCAL_TEMPLATE'] : ['MANUAL_INPUT'],
    providerStatus: { provider: 'gemini', configured: decision.providerConfigured, ready: decision.providerReady, failureCode: decision.failureCode },
    inputHash: job.checkpoint?.inputHash || hashValue(job.payload),
    updatedAt: now,
  };
  const waitingDisclosure = disclosure(job, 'MANUAL_INPUT', {
    status: 'WAITING_FOR_MANUAL_INPUT',
    provider: 'manual',
    fallbackReason: decision.failureCode || 'LOCAL_TEMPLATE_INSUFFICIENT',
    warnings: ['Chưa có phân tích hoàn chỉnh; không hiển thị là AI đã hoàn thành.'],
    limitations: decision.limitations,
    aiRequests: 0,
    externalRequests: 0,
    completedSteps: checkpoint.completedSteps,
    pendingSteps: checkpoint.pendingSteps,
  });
  const waiting = await waitAutomationJobForManual(job.id, workerId, task.id, checkpoint, waitingDisclosure);
  if (!waiting) throw new Error('MANUAL_WAIT_TRANSITION_FAILED');
  return { waitingForManualInput: true, taskId: task.id, executionStatus: 'WAITING_FOR_MANUAL_INPUT' };
}

async function executeJob(job: AutomationJob, workerId: string): Promise<Record<string, unknown>> {
  switch (job.type) {
    case 'PROCESS_CANDIDATE': {
      if (job.dryRun) return dryRunPreview(job);
      await assertKillSwitchInactive();
      const candidateId = typeof job.payload.candidateId === 'string' ? job.payload.candidateId : '';
      if (!candidateId) throw new Error('VALIDATION_CANDIDATE_ID_REQUIRED');
      return { ...(await processCandidateFromDurableJob({ candidateId, jobId: job.id, operationId: job.operationId, workerId })) };
    }
    case 'AUTO_SAFE_PUBLISH':
      if (job.dryRun) return dryRunPreview(job);
      await assertKillSwitchInactive();
      return executeAutoSafePublish(job, workerId);
    case 'RECONCILE_AUTOMATION':
      if (job.dryRun) return dryRunPreview(job);
      return { ...(await runAutonomousReconciler()), executionStatus: 'COMPLETED_WITH_LOCAL_RULES', executionMode: 'LOCAL_RULES', provider: 'local', rulesVersion: 'reconciler-v1', aiRequests: 0, externalRequests: 0 };
    case 'POST_PUBLISH_MONITOR':
      if (job.dryRun) return dryRunPreview(job);
      await assertKillSwitchInactive();
      return executePostPublishMonitor(job, workerId);
    case 'RUNTIME_GUARDIAN':
      if (job.dryRun) return dryRunPreview(job);
      return { ...(await runRuntimeGuardian({ apply: true })), executionStatus: 'COMPLETED_WITH_LOCAL_RULES', executionMode: 'LOCAL_RULES', provider: 'system', rulesVersion: 'runtime-guardian-v1', aiRequests: 0, externalRequests: 0 };
    case 'IMPORT_PRODUCTS':
    case 'RECHECK_PRODUCT_HEALTH':
    case 'DETECT_DUPLICATES':
    case 'SCORE_PRODUCTS':
    case 'CAPTURE_PRICE_HISTORY':
    case 'PREPARE_CONTENT_DRAFT':
    case 'EDITORIAL_CHECK':
    case 'EVALUATE_ALERTS':
    case 'AGGREGATE_GROWTH_METRICS':
    case 'BULK_PRODUCT_OPERATION': {
      if (!job.dryRun) await assertKillSwitchInactive();
      return executeLocalIntelligenceJob(job);
    }
    case 'PRODUCT_SCAN':
      return executeAutoPilotJob(job, 'source_scan');
    case 'AUTO_PILOT':
      return executeAutoPilotJob(job, 'full_safe_run');
    case 'HEALTH_CHECK': {
      if (job.dryRun) return dryRunPreview(job);
      const products = await getAllProducts();
      return { checkedAt: new Date().toISOString(), productCount: products.length, businessDataChanged: false };
    }
    case 'SAFE_PUBLISH': {
      if (job.dryRun) return dryRunPreview(job);
      await assertKillSwitchInactive();
      if (job.approvalStatus !== 'APPROVED') throw new Error('APPROVAL_REQUIRED');
      const productId = typeof job.payload.productId === 'string' ? job.payload.productId : '';
      const product = await getProductById(productId);
      if (!product) throw new Error('VALIDATION_PRODUCT_NOT_FOUND');
      const published = await publishCanonicalProductTransaction(productId, { status: 'published' }, {
        jobId: job.id,
        workerId: job.claimedBy,
        dryRun: false,
        idempotencyKey: job.idempotencyKey,
        operationId: job.operationId,
        runId: job.id,
      });
      if (!published || published.status !== 'published') throw new Error('SAFE_PUBLISH_BLOCKED');
      await recordSourceQualityObservation(published.source, {
        idempotencyKey: `source-publish:manual:${job.id}`.slice(0, 200),
        observedAt: published.publishedAt || job.createdAt,
        publishedProducts: 1,
      });
      return { productId, status: published.status, publishedAt: published.publishedAt || null };
    }
    case 'AI_ANALYSIS': {
      if (job.dryRun) return dryRunPreview(job);
      await assertKillSwitchInactive();
      return executeEvidenceAnalysis(job, workerId);
    }
    default:
      return assertUnhandledJobType(job.type);
  }
}

export async function processAutomationBatch(workerId: string, limit = 2): Promise<WorkerRunResult> {
  const result: WorkerRunResult = { workerId, claimed: 0, succeeded: 0, failed: 0, skipped: 0, waitingManual: 0, waitingChildren: 0 };
  const initialControl = await getAutomationControl();
  const lastHeartbeat = Date.parse(initialControl.workerHeartbeatAt || '');
  if (initialControl.workerId !== workerId || !Number.isFinite(lastHeartbeat) || Date.now() - lastHeartbeat >= 15_000) {
    await updateAutomationControl({ workerHeartbeatAt: new Date().toISOString(), workerId }, workerId);
  }
  const claimed = await claimAutomationJobs(workerId, limit);
  result.claimed = claimed.length;

  const processJob = async (job: AutomationJob): Promise<void> => {
    const freshControl = await getAutomationControl();
    if (freshControl.killSwitch && job.type !== 'RUNTIME_GUARDIAN') {
      await failAutomationJob(job.id, workerId, 'KILL_SWITCH_ACTIVE', 'Dừng khẩn cấp đang được bật.');
      result.skipped += 1;
      return;
    }
    await updateAutomationControl({ workerHeartbeatAt: new Date().toISOString(), workerId, workerCurrentJobId: job.id }, workerId);
    const heartbeat = setInterval(() => {
      void Promise.all([
        heartbeatAutomationJob(job.id, workerId),
        updateAutomationControl({ workerHeartbeatAt: new Date().toISOString(), workerId, workerCurrentJobId: job.id }, workerId),
      ]);
    }, 20_000);
    try {
      assertWorkerPolicy(job);
      const startedPlan = (job.executionPlan || []).map((step, index) => index === 0 && step.status === 'PENDING' ? { ...step, status: 'RUNNING' as const } : step);
      await updateAutomationJobExecution(job.id, workerId, {
        executionPlan: startedPlan,
        progress: { processed: 0, total: startedPlan.length || undefined, succeeded: 0, skipped: 0, failed: 0, updatedAt: new Date().toISOString() },
      });
      const output = await executeJob(job, workerId);
      const latest = await getAutomationJob(job.id);
      if (latest?.status === 'CANCELLED') { result.skipped += 1; return; }
      if (latest?.status === 'WAITING_FOR_MANUAL_INPUT') { result.waitingManual += 1; return; }
      const rawMode = output.executionMode;
      const executionMode: ActualExecutionMode = ['API', 'LOCAL_RULES', 'LOCAL_TEMPLATE', 'MANUAL_INPUT', 'SHADOW_MODE'].includes(String(rawMode))
        ? rawMode as ActualExecutionMode
        : job.dryRun
          ? 'SHADOW_MODE'
          : 'LOCAL_RULES';
      const rawStatus = String(output.executionStatus || '');
      const outcomeStatus = rawStatus === 'PARTIALLY_COMPLETED'
        ? 'PARTIALLY_COMPLETED' as const
        : executionMode === 'API'
          ? 'COMPLETED_WITH_API' as const
          : executionMode === 'LOCAL_TEMPLATE'
            ? 'COMPLETED_WITH_LOCAL_TEMPLATE' as const
            : executionMode === 'MANUAL_INPUT'
              ? 'COMPLETED_WITH_MANUAL_INPUT' as const
              : 'COMPLETED_WITH_LOCAL_RULES' as const;
      const completedAt = new Date().toISOString();
      const reportedCompletedSteps = Array.isArray(output.completedSteps) ? output.completedSteps.filter((item): item is string => typeof item === 'string') : null;
      const reportedPendingSteps = Array.isArray(output.pendingSteps) ? output.pendingSteps.filter((item): item is string => typeof item === 'string') : null;
      const completedPlan = (latest?.executionPlan || startedPlan).map(step => ({
        ...step,
        status: reportedPendingSteps?.includes(step.id)
          ? 'PENDING' as const
          : reportedCompletedSteps
            ? reportedCompletedSteps.includes(step.id) ? 'COMPLETED' as const : 'SKIPPED' as const
            : step.status === 'SKIPPED' ? 'SKIPPED' as const : 'COMPLETED' as const,
      }));
      const completedSteps = completedPlan.filter(step => step.status === 'COMPLETED').map(step => step.id);
      const pendingSteps = reportedPendingSteps
        || (outcomeStatus === 'PARTIALLY_COMPLETED' && latest?.checkpoint?.pendingSteps.length
          ? latest.checkpoint.pendingSteps
          : []);
      const progressTotal = Math.max(1, completedSteps.length + pendingSteps.length);
      const progressPercentage = Math.floor((completedSteps.length / progressTotal) * 100);
      await updateAutomationJobExecution(job.id, workerId, {
        executionMode,
        outcomeStatus,
        executionPlan: completedPlan,
        progress: { processed: completedSteps.length, total: progressTotal, succeeded: completedSteps.length, skipped: 0, failed: 0, percentage: progressPercentage, updatedAt: completedAt },
        checkpoint: {
          version: 1,
          completedSteps,
          pendingSteps,
          outputs: { resultHash: hashValue(output) },
          executionModes: [...new Set([...(latest?.checkpoint?.executionModes || []), executionMode])],
          providerStatus: latest?.checkpoint?.providerStatus,
          inputHash: latest?.checkpoint?.inputHash || job.checkpoint?.inputHash || hashValue(job.payload),
          outputHash: hashValue(output),
          updatedAt: completedAt,
        },
        disclosure: latest?.disclosure || disclosure(job, executionMode, {
          status: outcomeStatus,
          provider: typeof output.provider === 'string' ? output.provider : undefined,
          rulesVersion: typeof output.rulesVersion === 'string' ? output.rulesVersion : undefined,
          templateVersion: typeof output.templateVersion === 'string' ? output.templateVersion : undefined,
          fallbackReason: typeof output.fallbackReason === 'string' ? output.fallbackReason : undefined,
          warnings: Array.isArray(output.warnings) ? output.warnings.filter((item): item is string => typeof item === 'string') : [],
          limitations: Array.isArray(output.limitations) ? output.limitations.filter((item): item is string => typeof item === 'string') : [],
          aiRequests: Number(output.aiRequests) || 0,
          externalRequests: Number(output.externalRequests) || 0,
          completedSteps,
          pendingSteps,
          completedAt,
        }),
      });
      if (outcomeStatus === 'PARTIALLY_COMPLETED' && pendingSteps.length) {
        const waiting = await waitAutomationJobForChildren(job.id, workerId, output);
        if (waiting) result.waitingChildren += 1; else result.skipped += 1;
        return;
      }
      const completed = await completeAutomationJob(job.id, workerId, output);
      if (completed) result.succeeded += 1; else result.skipped += 1;
    } catch (error) {
      const latest = await getAutomationJob(job.id);
      if (latest?.status === 'CANCELLED') {
        result.skipped += 1;
        return;
      }
      await failAutomationJob(job.id, workerId, errorCode(error), error, {
        nextRetryAt: error instanceof CandidateRetryScheduledError ? error.nextRetryAt : undefined,
      });
      result.failed += 1;
    } finally {
      clearInterval(heartbeat);
      await updateAutomationControl({ workerHeartbeatAt: new Date().toISOString(), workerId, workerCurrentJobId: undefined }, workerId);
    }
  };
  if (claimed.every(job => job.type === 'PROCESS_CANDIDATE')) {
    await Promise.all(claimed.map(processJob));
  } else {
    for (const job of claimed) await processJob(job);
  }
  return result;
}
