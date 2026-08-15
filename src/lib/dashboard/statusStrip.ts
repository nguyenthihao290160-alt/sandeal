import type { RuntimeHealthSnapshot } from '@/lib/automation/runtimeGuardian';
import type { RuntimeRoleLease } from '@/lib/automation/runtimeRoles';
import type { AutomationControlState } from '@/lib/automation/types';

export type CompactHealthTone = 'healthy' | 'warning' | 'error' | 'unknown';

export interface CompactHealthItem {
  id: 'web' | 'worker' | 'scheduler' | 'publish';
  label: string;
  value: string;
  technicalValue: string;
  tone: CompactHealthTone;
}

export interface DashboardStatusStrip {
  items: CompactHealthItem[];
  runtimeGuardian: {
    tone: CompactHealthTone;
    value: string;
    technicalValue: string;
    checkedAt: string | null;
    fresh: boolean;
    reasons: string[];
  };
  updatedAt: string;
}

const RUNTIME_FRESH_MS = 2 * 60_000;

function freshTimestamp(value: string | undefined | null, now: number, maximumAge = RUNTIME_FRESH_MS): boolean {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) && parsed <= now + 60_000 && now - parsed <= maximumAge;
}

function activeLease(role: 'WORKER' | 'SCHEDULER', leases: RuntimeRoleLease[], now: number): RuntimeRoleLease | undefined {
  return leases.find(lease => lease.role === role
    && lease.status === 'ACTIVE'
    && Date.parse(lease.leaseExpiresAt) > now
    && freshTimestamp(lease.heartbeatAt, now, 90_000));
}

function roleItem(input: {
  role: 'WORKER' | 'SCHEDULER';
  paused: boolean;
  enabled?: boolean;
  leases: RuntimeRoleLease[];
  runtime: RuntimeHealthSnapshot | null;
  runtimeFresh: boolean;
  now: number;
}): CompactHealthItem {
  const id = input.role === 'WORKER' ? 'worker' as const : 'scheduler' as const;
  const label = input.role === 'WORKER' ? 'Worker' : 'Scheduler';
  const status = input.role === 'WORKER' ? input.runtime?.worker.status : input.runtime?.scheduler.status;
  if (input.paused) return { id, label, value: 'Tạm dừng', technicalValue: `${input.role}_PAUSED`, tone: 'warning' };
  if (input.role === 'SCHEDULER' && input.enabled === false) {
    return { id, label, value: 'Chưa bật', technicalValue: 'SCHEDULER_DISABLED', tone: 'warning' };
  }
  if (input.runtimeFresh && status === 'crashed') {
    return { id, label, value: 'Lỗi tiến trình', technicalValue: `${input.role}_CRASHED`, tone: 'error' };
  }
  if (activeLease(input.role, input.leases, input.now)) {
    return { id, label, value: 'Hoạt động', technicalValue: `${input.role}_ACTIVE`, tone: 'healthy' };
  }
  if (input.runtimeFresh && status === 'stale') {
    return { id, label, value: 'Chậm nhịp', technicalValue: `${input.role}_STALE`, tone: 'warning' };
  }
  if (input.runtimeFresh && status === 'active') {
    return { id, label, value: 'Đang xác minh', technicalValue: `${input.role}_LEASE_UNVERIFIED`, tone: 'unknown' };
  }
  return { id, label, value: 'Không xác định', technicalValue: `${input.role}_UNVERIFIED`, tone: 'unknown' };
}

export function buildDashboardStatusStrip(input: {
  control: AutomationControlState;
  runtime: RuntimeHealthSnapshot | null;
  leases: RuntimeRoleLease[];
  schedulerEnabled: boolean;
  now?: number;
}): DashboardStatusStrip {
  const now = input.now ?? Date.now();
  const runtimeFresh = freshTimestamp(input.runtime?.checkedAt, now);
  const runtimeReasons = runtimeFresh ? [...new Set(input.runtime?.reasons || [])] : [];
  const web: CompactHealthItem = {
    id: 'web',
    label: 'Web',
    value: 'Hoạt động',
    technicalValue: 'WEB_REQUEST_SERVED',
    tone: 'healthy',
  };
  const worker = roleItem({
    role: 'WORKER',
    paused: input.control.workerPaused,
    leases: input.leases,
    runtime: input.runtime,
    runtimeFresh,
    now,
  });
  const scheduler = roleItem({
    role: 'SCHEDULER',
    paused: input.control.schedulerPaused,
    enabled: input.schedulerEnabled,
    leases: input.leases,
    runtime: input.runtime,
    runtimeFresh,
    now,
  });
  const publishBlocked = input.control.killSwitch
    || input.control.publishPaused
    || input.control.publishPausedByOperator
    || input.control.publishBlockedByRuntime
    || input.control.publishBlockedByPolicy
    || (runtimeFresh && input.runtime?.publishSafe === false);
  const publish: CompactHealthItem = !runtimeFresh
    ? { id: 'publish', label: 'Publish', value: 'Không xác định', technicalValue: 'SAFE_PUBLISH_UNVERIFIED', tone: 'unknown' }
    : publishBlocked
      ? { id: 'publish', label: 'Publish', value: 'Đang chờ an toàn', technicalValue: 'SAFE_PUBLISH_BLOCKED', tone: 'warning' }
      : { id: 'publish', label: 'Publish', value: 'Sẵn sàng', technicalValue: 'SAFE_PUBLISH_READY', tone: 'healthy' };
  const guardianTone: CompactHealthTone = !runtimeFresh ? 'unknown'
    : input.runtime?.publishSafe ? 'healthy' : 'warning';
  return {
    items: [web, worker, scheduler, publish],
    runtimeGuardian: {
      tone: guardianTone,
      value: !runtimeFresh ? 'Không xác định' : input.runtime?.publishSafe ? 'Đang bảo vệ' : 'Đang giữ chế độ an toàn',
      technicalValue: !runtimeFresh ? 'RUNTIME_GUARDIAN_UNVERIFIED' : input.runtime?.publishSafe ? 'RUNTIME_GUARDIAN_HEALTHY' : 'RUNTIME_GUARDIAN_BLOCKING',
      checkedAt: input.runtime?.checkedAt || null,
      fresh: runtimeFresh,
      reasons: runtimeReasons,
    },
    updatedAt: new Date(now).toISOString(),
  };
}
