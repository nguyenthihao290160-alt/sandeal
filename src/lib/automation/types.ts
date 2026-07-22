export type AutomationJobType =
  | 'PRODUCT_SCAN'
  | 'AUTO_PILOT'
  | 'PROCESS_CANDIDATE'
  | 'AUTO_SAFE_PUBLISH'
  | 'POST_PUBLISH_MONITOR'
  | 'RECONCILE_AUTOMATION'
  | 'RUNTIME_GUARDIAN'
  | 'SAFE_PUBLISH'
  | 'AI_ANALYSIS'
  | 'HEALTH_CHECK'
  | 'IMPORT_PRODUCTS'
  | 'RECHECK_PRODUCT_HEALTH'
  | 'DETECT_DUPLICATES'
  | 'SCORE_PRODUCTS'
  | 'CAPTURE_PRICE_HISTORY'
  | 'PREPARE_CONTENT_DRAFT'
  | 'EDITORIAL_CHECK'
  | 'EVALUATE_ALERTS'
  | 'AGGREGATE_GROWTH_METRICS'
  | 'BULK_PRODUCT_OPERATION';
export type AutomationJobStatus = 'PENDING' | 'WAITING_APPROVAL' | 'WAITING_FOR_MANUAL_INPUT' | 'WAITING_CHILDREN' | 'RUNNING' | 'RETRY_SCHEDULED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'BLOCKED' | 'PAUSED';
export type AutomationRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKER';
export type ApprovalStatus = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type AutonomousMode = 'OBSERVE' | 'SHADOW' | 'CANARY' | 'AUTONOMOUS' | 'EMERGENCY_STOP';
export type AutomationErrorCategory =
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMIT'
  | 'LINK_NOT_FOUND'
  | 'IMAGE_HOTLINK_BLOCKED'
  | 'INVALID_SOURCE_DATA'
  | 'VALIDATION_FAILED'
  | 'DUPLICATE'
  | 'STORAGE_ERROR'
  | 'INTERNAL_CODE_ERROR'
  | 'UNKNOWN_ERROR';

export type BotCategory = 'CONTROL_PLANE' | 'RULE_BASED_AUTOMATION' | 'AI_ASSISTED' | 'EXTERNAL_INTEGRATION' | 'HUMAN_APPROVAL_GATE';
export type RequestedExecutionMode = 'AUTO' | 'API_ONLY' | 'LOCAL_ONLY' | 'MANUAL_ONLY';
export type ActualExecutionMode = 'API' | 'LOCAL_RULES' | 'LOCAL_TEMPLATE' | 'MANUAL_INPUT' | 'SHADOW_MODE';
export type AutomationOutcomeStatus =
  | 'COMPLETED_WITH_API'
  | 'COMPLETED_WITH_LOCAL_RULES'
  | 'COMPLETED_WITH_LOCAL_TEMPLATE'
  | 'COMPLETED_WITH_MANUAL_INPUT'
  | 'PARTIALLY_COMPLETED'
  | 'WAITING_FOR_MANUAL_INPUT'
  | 'CONFIGURATION_REQUIRED'
  | 'QUOTA_EXCEEDED'
  | 'PROVIDER_UNAVAILABLE'
  | 'NOT_IMPLEMENTED'
  | 'BLOCKED_BY_SAFETY'
  | 'FAILED';

export interface AutomationExecutionPlanStep {
  id: string;
  capability: string;
  dependsOn: string[];
  reason: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'SKIPPED' | 'FAILED' | 'WAITING_MANUAL';
  risk: AutomationRiskLevel;
  approvalRequired: boolean;
  expectedWrite: string[];
  externalCall: boolean;
  fallback: string[];
  skipReason?: string;
}

export interface AutomationProgress {
  processed: number;
  total?: number;
  succeeded: number;
  skipped: number;
  failed: number;
  percentage?: number;
  updatedAt: string;
}

export interface AutomationCheckpoint {
  version: 1;
  completedSteps: string[];
  pendingSteps: string[];
  failedStep?: string;
  outputs: Record<string, unknown>;
  executionModes: ActualExecutionMode[];
  providerStatus?: Record<string, unknown>;
  inputHash: string;
  outputHash?: string;
  updatedAt: string;
}

export interface EvidenceClaim {
  claim: string;
  claimType: string;
  evidenceFactIds: string[];
  confidence: number;
  missingEvidence: string[];
  warnings: string[];
  limitations: string[];
  provider: string;
  modelId?: string;
  promptVersion?: string;
  generatedAt: string;
  responseHash: string;
  validationStatus: 'VERIFIED' | 'UNVERIFIED' | 'REJECTED';
}

export interface AutomationExecutionDisclosure {
  status: AutomationOutcomeStatus;
  requestedMode: RequestedExecutionMode;
  executionMode: ActualExecutionMode;
  provider: string;
  modelId?: string;
  promptVersion?: string;
  rulesVersion?: string;
  templateVersion?: string;
  manualActor?: string;
  fallbackReason?: string;
  confidence?: number;
  evidenceCoverage?: number;
  warnings: string[];
  limitations: string[];
  aiRequests: number;
  externalRequests: number;
  completedSteps: string[];
  pendingSteps: string[];
  completedAt?: string;
}

export interface AutomationJob {
  schemaVersion: number;
  policyVersion: string;
  handlerVersion: string;
  id: string;
  correlationId?: string;
  type: AutomationJobType;
  status: AutomationJobStatus;
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
  priority: number;
  idempotencyKey: string;
  operationId: string;
  requestedBy: string;
  sourceMetadata?: {
    producer: string;
    source?: string;
    trigger?: string;
  };
  parentJobId?: string;
  botId?: string;
  capability?: string;
  requestedExecutionMode?: RequestedExecutionMode;
  executionMode?: ActualExecutionMode;
  outcomeStatus?: AutomationOutcomeStatus;
  executionPlan?: AutomationExecutionPlanStep[];
  progress?: AutomationProgress;
  checkpoint?: AutomationCheckpoint;
  disclosure?: AutomationExecutionDisclosure;
  manualTaskId?: string;
  approvedBy?: string;
  approvalStatus: ApprovalStatus;
  approvalReason?: string;
  approvalExpiresAt?: string;
  riskLevel: AutomationRiskLevel;
  dryRun: boolean;
  attemptCount: number;
  maxAttempts: number;
  queuedAt: string;
  scheduledAt: string;
  nextRetryAt?: string;
  claimedAt?: string;
  claimedBy?: string;
  claimToken?: string;
  workerOwnerId?: string;
  workerInstanceId?: string;
  workerFencingToken?: number;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  lastErrorCode?: string;
  lastErrorCategory?: AutomationErrorCategory;
  lastErrorMessage?: string;
  retryable?: boolean;
  deadLetterReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationControlState {
  schemaVersion: number;
  id: 'automation-control';
  mode: AutonomousMode;
  effectiveMode: Exclude<AutonomousMode, 'EMERGENCY_STOP'>;
  publishPaused: boolean;
  ingestionPaused: boolean;
  workerPaused: boolean;
  schedulerPaused: boolean;
  pausedAt?: string;
  pauseReason?: string;
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
  guardianHeartbeatAt?: string;
  degradedAt?: string;
  degradedReason?: string;
  timezone: 'Asia/Ho_Chi_Minh';
  updatedAt: string;
}

export interface AutomationAuditEvent {
  schemaVersion: number;
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

export type ManualTaskStatus = 'WAITING' | 'DRAFT' | 'SUBMITTED' | 'REVISION_REQUIRED' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';

export interface ManualTaskFieldSchema {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'string_array';
  required: boolean;
  maximumLength?: number;
  minimum?: number;
  maximum?: number;
  options?: string[];
}

export interface ManualTask {
  id: string;
  operationId: string;
  jobId: string;
  capability: string;
  targetType: string;
  targetId?: string;
  title: string;
  reasonCode: string;
  instructions: string[];
  verifiedFacts: Record<string, unknown>;
  evidence: EvidenceClaim[];
  missingInformation: string[];
  questions: string[];
  expectedInputSchema: { version: 1; fields: ManualTaskFieldSchema[] };
  validationRules: string[];
  risk: AutomationRiskLevel;
  approvalRequired: boolean;
  resumeCheckpoint: string;
  status: ManualTaskStatus;
  submittedInput?: Record<string, unknown>;
  submittedBy?: string;
  submittedAt?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface BotRegistryEntry {
  id: string;
  name: string;
  description: string;
  category: BotCategory;
  capability: string;
  jobType?: AutomationJobType;
  version: string;
  enabled: boolean;
  defaultExecutionMode: RequestedExecutionMode;
  inputSchemaVersion: string;
  outputSchemaVersion: string;
  risk: AutomationRiskLevel;
  approvalRequired: boolean;
  provider: 'local' | 'gemini' | 'accesstrade' | 'manual' | 'system';
  modelId?: string;
  promptVersion?: string;
  rulesVersion?: string;
  templateVersion?: string;
  fallback: ActualExecutionMode[];
  timeoutMs: number;
  maxAttempts: number;
  writeScope: string[];
  externalSideEffect: boolean;
  shadowSupported: boolean;
  manualSupported: boolean;
  lastRunAt?: string;
  updatedAt: string;
}
