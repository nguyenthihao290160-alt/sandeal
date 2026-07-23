import type {
  ProviderHealthStatus,
  SchedulerHealthStatus,
  WebHealthStatus,
  WorkerHealthStatus,
} from '@/lib/automation/runtimeGuardian';

export type OperationalCapabilityStatus = 'OPERATIONAL' | 'PAUSED' | 'DEGRADED' | 'STOPPED';
export type PublishingCapabilityStatus = 'READY' | 'PAUSED' | 'BLOCKED';
export type AiCapabilityStatus = 'READY' | 'LIMITED' | 'BLOCKED' | 'UNAVAILABLE';
export type EmergencyCapabilityStatus = 'OFF' | 'ON';
export type OverallCapabilityStatus = 'OPERATIONAL' | 'LIMITED' | 'PAUSED' | 'EMERGENCY_STOP';

export interface SystemCapabilityInput {
  web?: { status?: WebHealthStatus | string };
  worker: { status: WorkerHealthStatus | string };
  scheduler: { status: SchedulerHealthStatus | string };
  queue?: { pending?: number; running?: number; stuck?: number; staleJobs?: number };
  control: {
    publishPaused: boolean;
    publishPausedByOperator?: boolean;
    publishBlockedByRuntime?: boolean;
    publishBlockedByPolicy?: boolean;
    publishRuntimeReasons?: string[];
    publishPolicyReasons?: string[];
    workerPaused: boolean;
    schedulerPaused: boolean;
    ingestionPaused: boolean;
    killSwitch: boolean;
  };
  runtime?: { publishSafe: boolean; reasons?: string[] } | null;
  release?: { releaseMismatch?: boolean } | null;
  ai?: {
    providerStatus?: ProviderHealthStatus | string;
    budgetAvailable?: boolean;
    policyAllowed?: boolean;
  };
}

export interface SystemCapabilityStatus {
  operationalStatus: OperationalCapabilityStatus;
  publishingStatus: PublishingCapabilityStatus;
  aiStatus: AiCapabilityStatus;
  emergencyStatus: EmergencyCapabilityStatus;
  overallStatus: OverallCapabilityStatus;
  overallLabel: 'Đang hoạt động' | 'Hoạt động có giới hạn' | 'Đã tạm dừng' | 'Dừng khẩn cấp';
  pausedComponents: Array<'worker' | 'scheduler' | 'ingestion'>;
  operationalReasons: string[];
  publishingReasons: string[];
  aiReasons: string[];
  summary: string;
  technicalReasonCodes: string[];
}

const RUNTIME_REASON_MESSAGES: Record<string, string> = {
  REPEATED_PROCESS_RESTART: 'Hệ thống ghi nhận nhiều lần khởi động lại trong cửa sổ giám sát hiện tại.',
  DUPLICATE_PROCESS_ROLE: 'Có nhiều tiến trình đang nhận cùng một vai trò runtime.',
  STALE_JOB: 'Có tác vụ đang chạy đã quá hạn lease.',
  QUEUE_STUCK: 'Hàng đợi có tác vụ chờ quá lâu.',
  PROVIDER_DEGRADED: 'Một nhà cung cấp đang suy giảm hoặc chưa sẵn sàng.',
  WEB_BUILD_MISMATCH: 'Phiên bản web đang chạy không khớp bản phát hành.',
  WEB_BUILD_MISSING: 'Không xác minh được build artifact của web.',
  WEB_UNHEALTHY: 'Web runtime chưa vượt qua kiểm tra sức khỏe.',
  STORAGE_DEGRADED: 'Lưu trữ đang suy giảm.',
  STORAGE_BLOCKED: 'Lưu trữ đang bị chặn.',
  WORKER_STALE: 'Tín hiệu bộ xử lý nền đã cũ.',
  WORKER_MISSING: 'Chưa ghi nhận bộ xử lý nền.',
  WORKER_CRASHED: 'Bộ xử lý nền đã dừng bất thường.',
  SCHEDULER_STALE: 'Tín hiệu lịch tự động đã cũ.',
  SCHEDULER_MISSING: 'Chưa ghi nhận lịch tự động.',
  SCHEDULER_CRASHED: 'Lịch tự động đã dừng bất thường.',
};

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function reasonMessage(code: string): string {
  return RUNTIME_REASON_MESSAGES[code] || 'Một cổng an toàn kỹ thuật chưa đạt yêu cầu.';
}

function deriveAiStatus(input: SystemCapabilityInput['ai']): { status: AiCapabilityStatus; reasons: string[] } {
  if (input?.policyAllowed === false) return { status: 'BLOCKED', reasons: ['AI đang bị chặn bởi chính sách vận hành.'] };
  if (input?.budgetAvailable === false) return { status: 'LIMITED', reasons: ['Hạn mức AI hiện không còn khả dụng.'] };
  if (input?.providerStatus === 'ready') return { status: 'READY', reasons: [] };
  if (input?.providerStatus === 'blocked_by_policy') return { status: 'BLOCKED', reasons: ['Chưa có kết nối AI đáp ứng chính sách Free-only.'] };
  if (['configured', 'configured_not_ready', 'degraded', 'rate_limited', 'quota_exhausted', 'last_check_failed'].includes(String(input?.providerStatus || ''))) {
    return { status: 'LIMITED', reasons: ['Kết nối AI đã được lưu nhưng chưa sẵn sàng tạo nội dung.'] };
  }
  return { status: 'UNAVAILABLE', reasons: ['Chưa có tuyến AI sẵn sàng.'] };
}

/**
 * Pure capability derivation. Automation Control is authoritative for
 * intentional pauses; Runtime Guardian and release checks only contribute
 * degradation/blocking signals.
 */
export function deriveSystemCapabilityStatus(input: SystemCapabilityInput): SystemCapabilityStatus {
  const killSwitch = input.control.killSwitch;
  const pausedComponents: SystemCapabilityStatus['pausedComponents'] = [];
  if (input.control.workerPaused || input.worker.status === 'paused') pausedComponents.push('worker');
  if (input.control.schedulerPaused || input.scheduler.status === 'paused') pausedComponents.push('scheduler');
  if (input.control.ingestionPaused) pausedComponents.push('ingestion');

  const runtimeCodes = unique([
    ...(input.runtime?.reasons || []),
    ...(input.control.publishRuntimeReasons || []),
    ...(input.control.publishPolicyReasons || []),
    input.release?.releaseMismatch ? 'WEB_BUILD_MISMATCH' : undefined,
  ]);
  const operationalReasons: string[] = [];
  const workerHealthy = input.worker.status === 'active';
  const schedulerHealthy = input.scheduler.status === 'active';
  const webHealthy = !input.web?.status || ['alive', 'ready'].includes(String(input.web.status));
  const queueHealthy = !Number(input.queue?.stuck || 0) && !Number(input.queue?.staleJobs || 0);

  let operationalStatus: OperationalCapabilityStatus;
  if (killSwitch) {
    operationalStatus = 'STOPPED';
    operationalReasons.push('Dừng khẩn cấp đang bật.');
  } else if (pausedComponents.length) {
    operationalStatus = 'PAUSED';
    operationalReasons.push('Một hoặc nhiều phạm vi automation đang được tạm dừng chủ động.');
  } else if (!workerHealthy || !schedulerHealthy || !webHealthy || !queueHealthy || input.release?.releaseMismatch) {
    operationalStatus = 'DEGRADED';
    if (!workerHealthy) operationalReasons.push('Bộ xử lý nền chưa ở trạng thái hoạt động.');
    if (!schedulerHealthy) operationalReasons.push('Lịch tự động chưa ở trạng thái hoạt động.');
    if (!webHealthy || input.release?.releaseMismatch) operationalReasons.push('Web hoặc bản phát hành chưa đạt kiểm tra đồng nhất.');
    if (!queueHealthy) operationalReasons.push('Hàng đợi có tác vụ kẹt hoặc quá hạn.');
  } else {
    operationalStatus = 'OPERATIONAL';
  }

  const hasExplicitPauseSource = typeof input.control.publishPausedByOperator === 'boolean'
    || typeof input.control.publishBlockedByRuntime === 'boolean'
    || typeof input.control.publishBlockedByPolicy === 'boolean';
  const operatorPublishPause = input.control.publishPausedByOperator === true
    || (!hasExplicitPauseSource && input.control.publishPaused);
  const runtimePublishBlock = input.control.publishBlockedByRuntime === true || input.runtime?.publishSafe === false;
  const policyPublishBlock = input.control.publishBlockedByPolicy === true || Boolean(input.release?.releaseMismatch);
  const publishingStatus: PublishingCapabilityStatus = operatorPublishPause
    ? 'PAUSED'
    : runtimePublishBlock || policyPublishBlock || input.control.publishPaused ? 'BLOCKED' : 'READY';
  const publishingReasons = unique([
    operatorPublishPause ? 'Đăng an toàn đang được tạm dừng theo điều khiển vận hành.' : undefined,
    runtimePublishBlock ? 'Đăng an toàn đang bị Runtime Guardian chặn.' : undefined,
    policyPublishBlock ? 'Đăng an toàn đang bị chặn bởi policy hoặc bản phát hành.' : undefined,
    ...runtimeCodes.map(reasonMessage),
  ]);

  const ai = deriveAiStatus(input.ai);
  const emergencyStatus: EmergencyCapabilityStatus = killSwitch ? 'ON' : 'OFF';
  const overallStatus: OverallCapabilityStatus = killSwitch
    ? 'EMERGENCY_STOP'
    : operationalStatus === 'PAUSED' ? 'PAUSED'
      : operationalStatus === 'DEGRADED' || publishingStatus !== 'READY' || ai.status !== 'READY' ? 'LIMITED'
        : 'OPERATIONAL';
  const overallLabel = overallStatus === 'EMERGENCY_STOP' ? 'Dừng khẩn cấp'
    : overallStatus === 'PAUSED' ? 'Đã tạm dừng'
      : overallStatus === 'LIMITED' ? 'Hoạt động có giới hạn' : 'Đang hoạt động';

  const runtimeExplanation = runtimeCodes.includes('REPEATED_PROCESS_RESTART')
    ? ' Đăng an toàn hiện bị chặn do hệ thống ghi nhận nhiều lần khởi động lại.'
    : publishingStatus === 'PAUSED' ? ' Đăng an toàn hiện đang tạm dừng.'
      : publishingStatus === 'BLOCKED' ? ' Đăng an toàn hiện đang bị chặn.' : '';
  const summary = overallStatus === 'LIMITED' && workerHealthy && schedulerHealthy
    ? `Bộ xử lý nền và lịch tự động vẫn hoạt động.${runtimeExplanation || ' Một số chức năng đang bị giới hạn.'}`
    : overallStatus === 'OPERATIONAL' ? 'Web, bộ xử lý nền và lịch tự động đang hoạt động; các cổng an toàn đều sẵn sàng.'
      : overallStatus === 'EMERGENCY_STOP' ? 'Dừng khẩn cấp đang bật; hệ thống không nhận tác vụ vận hành mới.'
        : overallStatus === 'PAUSED' ? 'Automation đang được tạm dừng chủ động theo phạm vi điều khiển.'
          : 'Hệ thống đang suy giảm; hãy xem các lý do vận hành bên dưới.';

  return {
    operationalStatus,
    publishingStatus,
    aiStatus: ai.status,
    emergencyStatus,
    overallStatus,
    overallLabel,
    pausedComponents,
    operationalReasons: unique(operationalReasons),
    publishingReasons,
    aiReasons: ai.reasons,
    summary,
    technicalReasonCodes: runtimeCodes,
  };
}
