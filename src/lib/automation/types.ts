export type AutomationJobType = 'PRODUCT_SCAN' | 'AUTO_PILOT' | 'SAFE_PUBLISH' | 'AI_ANALYSIS' | 'HEALTH_CHECK';
export type AutomationJobStatus = 'PENDING' | 'WAITING_APPROVAL' | 'RUNNING' | 'RETRY_SCHEDULED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'BLOCKED' | 'PAUSED';
export type AutomationRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKER';
export type ApprovalStatus = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface AutomationJob {
  id: string;
  type: AutomationJobType;
  status: AutomationJobStatus;
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
  priority: number;
  idempotencyKey: string;
  operationId: string;
  requestedBy: string;
  approvedBy?: string;
  approvalStatus: ApprovalStatus;
  approvalReason?: string;
  approvalExpiresAt?: string;
  riskLevel: AutomationRiskLevel;
  dryRun: boolean;
  attemptCount: number;
  maxAttempts: number;
  scheduledAt: string;
  nextRetryAt?: string;
  claimedAt?: string;
  claimedBy?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationControlState {
  id: 'automation-control';
  workerPaused: boolean;
  schedulerPaused: boolean;
  killSwitch: boolean;
  reason?: string;
  changedBy?: string;
  changedAt?: string;
  workerHeartbeatAt?: string;
  workerId?: string;
  workerCurrentJobId?: string;
  schedulerHeartbeatAt?: string;
  schedulerLastRunAt?: string;
  schedulerNextRunAt?: string;
  timezone: 'Asia/Ho_Chi_Minh';
  updatedAt: string;
}

export interface AutomationAuditEvent {
  id: string;
  correlationId: string;
  operationId: string;
  jobId?: string;
  operationType: string;
  actor: string;
  target?: string;
  previousState?: string;
  nextState?: string;
  risk: AutomationRiskLevel;
  result?: Record<string, unknown>;
  reasons: string[];
  dryRun: boolean;
  attempts: number;
  createdAt: string;
}

export interface AiUsageRecord {
  id: string;
  day: string;
  requests: number;
  tokens: number;
  fallbacks: number;
  blocked: number;
  requestLimit: number;
  tokenLimit: number;
  updatedAt: string;
}

export interface CircuitBreakerRecord {
  id: string;
  provider: string;
  state: CircuitState;
  consecutiveFailures: number;
  openedAt?: string;
  lastFailureAt?: string;
  lastSuccessAt?: string;
  nextProbeAt?: string;
  updatedAt: string;
}
