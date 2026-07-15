export type DashboardOperationStatus =
  | 'pending'
  | 'waiting_approval'
  | 'waiting_manual'
  | 'running'
  | 'waiting_retry'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'unavailable';

export interface DashboardOperation<T = unknown> {
  operationId: string;
  jobId: string | null;
  status: DashboardOperationStatus;
  progress: number | null;
  result: T | null;
  errorCode: string | null;
  message: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  canCancel: boolean;
  canRetry: boolean;
  requiresApproval: boolean;
}

export function createCompletedPreview<T>(operationId: string, result: T, message: string): DashboardOperation<T> {
  const now = new Date().toISOString();
  return {
    operationId,
    jobId: null,
    status: 'completed',
    progress: 100,
    result,
    errorCode: null,
    message,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    canCancel: false,
    canRetry: false,
    requiresApproval: false,
  };
}
