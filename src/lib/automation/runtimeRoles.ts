import { generateId, readCollection, runTransaction } from '@/lib/storage/adapter';

const ROLE_COLLECTION = 'runtime-role-leases';
const CONFLICT_COLLECTION = 'runtime-role-conflicts';
export const RUNTIME_ROLE_SCHEMA_VERSION = 1;
export const DEFAULT_ROLE_LEASE_MS = 45_000;

export type RuntimeRole = 'WEB' | 'WORKER' | 'SCHEDULER';

export interface RuntimeRoleLease {
  schemaVersion: number;
  id: RuntimeRole;
  role: RuntimeRole;
  holderId: string;
  pid?: number;
  status: 'ACTIVE' | 'RELEASED';
  startedAt: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
  previousHolderId?: string;
  takeoverCount: number;
  updatedAt: string;
}

interface RuntimeRoleConflict {
  schemaVersion: number;
  id: string;
  role: RuntimeRole;
  activeHolderId: string;
  rejectedHolderId: string;
  observedAt: string;
}

function clone(lease: RuntimeRoleLease): RuntimeRoleLease {
  return { ...lease };
}

export async function acquireRuntimeRole(input: {
  role: RuntimeRole;
  holderId: string;
  pid?: number;
  leaseMs?: number;
  now?: number;
}): Promise<{ acquired: boolean; lease: RuntimeRoleLease; reason?: 'ROLE_ALREADY_ACTIVE' }> {
  if (!input.holderId.trim()) throw new Error('RUNTIME_ROLE_HOLDER_REQUIRED');
  const nowMs = input.now ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const leaseMs = Math.max(5_000, Math.min(5 * 60_000, input.leaseMs || DEFAULT_ROLE_LEASE_MS));
  let output!: { acquired: boolean; lease: RuntimeRoleLease; reason?: 'ROLE_ALREADY_ACTIVE' };
  await runTransaction<RuntimeRoleLease>(ROLE_COLLECTION, leases => {
    const existing = leases.find(item => item.role === input.role);
    const active = existing?.status === 'ACTIVE' && Date.parse(existing.leaseExpiresAt) > nowMs;
    if (existing && active && existing.holderId !== input.holderId) {
      output = { acquired: false, lease: clone(existing), reason: 'ROLE_ALREADY_ACTIVE' };
      return undefined;
    }
    const lease: RuntimeRoleLease = {
      schemaVersion: RUNTIME_ROLE_SCHEMA_VERSION,
      id: input.role,
      role: input.role,
      holderId: input.holderId,
      pid: input.pid,
      status: 'ACTIVE',
      startedAt: existing?.holderId === input.holderId ? existing.startedAt : now,
      heartbeatAt: now,
      leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
      previousHolderId: existing && existing.holderId !== input.holderId ? existing.holderId : existing?.previousHolderId,
      takeoverCount: (existing?.takeoverCount || 0) + (existing && existing.holderId !== input.holderId ? 1 : 0),
      updatedAt: now,
    };
    if (existing) Object.assign(existing, lease); else leases.push(lease);
    output = { acquired: true, lease: clone(lease) };
    return leases;
  });
  if (!output.acquired) {
    await runTransaction<RuntimeRoleConflict>(CONFLICT_COLLECTION, conflicts => [...conflicts.slice(-499), {
      schemaVersion: 1, id: generateId(), role: input.role, activeHolderId: output.lease.holderId,
      rejectedHolderId: input.holderId, observedAt: now,
    }]);
  }
  return output;
}

export async function heartbeatRuntimeRole(role: RuntimeRole, holderId: string, leaseMs = DEFAULT_ROLE_LEASE_MS, nowMs = Date.now()): Promise<boolean> {
  let updated = false;
  await runTransaction<RuntimeRoleLease>(ROLE_COLLECTION, leases => {
    const lease = leases.find(item => item.role === role);
    if (!lease || lease.status !== 'ACTIVE' || lease.holderId !== holderId) return undefined;
    lease.heartbeatAt = new Date(nowMs).toISOString();
    lease.leaseExpiresAt = new Date(nowMs + Math.max(5_000, Math.min(5 * 60_000, leaseMs))).toISOString();
    lease.updatedAt = lease.heartbeatAt;
    updated = true;
    return leases;
  });
  return updated;
}

export async function releaseRuntimeRole(role: RuntimeRole, holderId: string, nowMs = Date.now()): Promise<boolean> {
  let released = false;
  await runTransaction<RuntimeRoleLease>(ROLE_COLLECTION, leases => {
    const lease = leases.find(item => item.role === role);
    if (!lease || lease.holderId !== holderId) return undefined;
    lease.status = 'RELEASED';
    lease.heartbeatAt = new Date(nowMs).toISOString();
    lease.leaseExpiresAt = lease.heartbeatAt;
    lease.updatedAt = lease.heartbeatAt;
    released = true;
    return leases;
  });
  return released;
}

export async function listRuntimeRoleLeases(): Promise<RuntimeRoleLease[]> {
  return (await readCollection<RuntimeRoleLease>(ROLE_COLLECTION)).map(clone);
}

export async function listRecentRuntimeRoleConflicts(sinceMs: number): Promise<RuntimeRoleConflict[]> {
  return (await readCollection<RuntimeRoleConflict>(CONFLICT_COLLECTION)).filter(item => Date.parse(item.observedAt) >= sinceMs);
}
