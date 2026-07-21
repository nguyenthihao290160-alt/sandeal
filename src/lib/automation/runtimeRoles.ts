import { generateId, readCollection, runTransaction } from '@/lib/storage/adapter';
import { getReleaseIdentity } from '@/lib/releaseIdentity';

const ROLE_COLLECTION = 'runtime-role-leases';
const CONFLICT_COLLECTION = 'runtime-role-conflicts';
export const RUNTIME_ROLE_SCHEMA_VERSION = 3;
export const DEFAULT_ROLE_LEASE_MS = 45_000;

export type RuntimeRole = 'WEB' | 'WORKER' | 'SCHEDULER';

export interface RuntimeRoleLease {
  schemaVersion: number;
  id: RuntimeRole;
  role: RuntimeRole;
  ownerId: string;
  instanceId: string;
  holderId: string;
  hostname?: string;
  pid?: number;
  releaseId?: string;
  status: 'ACTIVE' | 'RELEASED';
  processStartedAt?: string;
  acquiredAt: string;
  startedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  leaseExpiresAt: string;
  fencingToken: number;
  previousHolderId?: string;
  previousInstanceId?: string;
  takeoverCount: number;
  updatedAt: string;
}

export interface RuntimeRoleOwnership {
  ownerId: string;
  instanceId: string;
  fencingToken: number;
}

export interface RuntimeRoleConflict {
  schemaVersion: number;
  id: string;
  role: RuntimeRole;
  activeHolderId: string;
  rejectedHolderId: string;
  activeInstanceId: string;
  rejectedInstanceId: string;
  observedAt: string;
}

function clone(lease: RuntimeRoleLease): RuntimeRoleLease {
  return { ...lease };
}

function ownerOf(lease: Partial<RuntimeRoleLease>): string {
  return lease.ownerId || lease.holderId || 'unknown-owner';
}

function instanceOf(lease: Partial<RuntimeRoleLease>): string {
  return lease.instanceId || lease.holderId || ownerOf(lease);
}

function expiryOf(lease: Partial<RuntimeRoleLease>): string {
  return lease.expiresAt || lease.leaseExpiresAt || new Date(0).toISOString();
}

function ownsLease(lease: RuntimeRoleLease, ownership: RuntimeRoleOwnership): boolean {
  return ownerOf(lease) === ownership.ownerId
    && instanceOf(lease) === ownership.instanceId
    && (lease.fencingToken || 0) === ownership.fencingToken;
}

function normalizeLease(lease: RuntimeRoleLease): RuntimeRoleLease {
  const ownerId = ownerOf(lease);
  const instanceId = instanceOf(lease);
  const expiresAt = expiryOf(lease);
  return {
    ...lease,
    schemaVersion: RUNTIME_ROLE_SCHEMA_VERSION,
    ownerId,
    instanceId,
    holderId: lease.holderId || ownerId,
    acquiredAt: lease.acquiredAt || lease.startedAt || lease.updatedAt,
    startedAt: lease.startedAt || lease.acquiredAt || lease.updatedAt,
    expiresAt,
    leaseExpiresAt: expiresAt,
    fencingToken: Math.max(1, lease.fencingToken || 1),
  };
}

export async function acquireRuntimeRole(input: {
  role: RuntimeRole;
  ownerId?: string;
  holderId?: string;
  instanceId?: string;
  hostname?: string;
  pid?: number;
  processStartedAt?: string;
  releaseId?: string;
  leaseMs?: number;
  now?: number;
}): Promise<{
  acquired: boolean;
  lease: RuntimeRoleLease;
  ownership?: RuntimeRoleOwnership;
  event?: 'ACQUIRED' | 'RENEWED' | 'TAKEN_OVER';
  staleLease?: RuntimeRoleLease;
  reason?: 'ROLE_ALREADY_ACTIVE';
}> {
  const ownerId = (input.ownerId || input.holderId || '').trim();
  const instanceId = (input.instanceId || input.holderId || ownerId).trim();
  if (!ownerId) throw new Error('RUNTIME_ROLE_OWNER_REQUIRED');
  if (!instanceId) throw new Error('RUNTIME_ROLE_INSTANCE_REQUIRED');
  const nowMs = input.now ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const leaseMs = Math.max(5_000, Math.min(5 * 60_000, input.leaseMs || DEFAULT_ROLE_LEASE_MS));
  let output!: {
    acquired: boolean;
    lease: RuntimeRoleLease;
    ownership?: RuntimeRoleOwnership;
    event?: 'ACQUIRED' | 'RENEWED' | 'TAKEN_OVER';
    staleLease?: RuntimeRoleLease;
    reason?: 'ROLE_ALREADY_ACTIVE';
  };
  await runTransaction<RuntimeRoleLease>(ROLE_COLLECTION, leases => {
    const stored = leases.find(item => item.role === input.role);
    const existing = stored ? normalizeLease(stored) : undefined;
    const sameInstance = existing && instanceOf(existing) === instanceId;
    const active = existing?.status === 'ACTIVE' && Date.parse(expiryOf(existing)) > nowMs;
    if (existing && active && !sameInstance) {
      output = { acquired: false, lease: clone(existing), reason: 'ROLE_ALREADY_ACTIVE' };
      return undefined;
    }
    const takeover = Boolean(existing && !sameInstance);
    const fencingToken = sameInstance
      ? Math.max(1, existing?.fencingToken || 1)
      : Math.max(1, (existing?.fencingToken || 0) + 1);
    const lease: RuntimeRoleLease = {
      schemaVersion: RUNTIME_ROLE_SCHEMA_VERSION,
      id: input.role,
      role: input.role,
      ownerId,
      instanceId,
      holderId: ownerId,
      hostname: input.hostname,
      pid: input.pid,
      releaseId: input.releaseId || getReleaseIdentity().releaseId,
      status: 'ACTIVE',
      processStartedAt: input.processStartedAt,
      acquiredAt: sameInstance ? existing.acquiredAt : now,
      startedAt: sameInstance ? existing.startedAt : now,
      heartbeatAt: now,
      expiresAt: new Date(nowMs + leaseMs).toISOString(),
      leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
      fencingToken,
      previousHolderId: takeover && existing ? ownerOf(existing) : existing?.previousHolderId,
      previousInstanceId: takeover && existing ? instanceOf(existing) : existing?.previousInstanceId,
      takeoverCount: (existing?.takeoverCount || 0) + (takeover ? 1 : 0),
      updatedAt: now,
    };
    if (stored) Object.assign(stored, lease); else leases.push(lease);
    output = {
      acquired: true,
      lease: clone(lease),
      ownership: { ownerId, instanceId, fencingToken },
      event: takeover ? 'TAKEN_OVER' : sameInstance ? 'RENEWED' : 'ACQUIRED',
      staleLease: takeover ? existing : undefined,
    };
    return leases;
  });
  if (!output.acquired) {
    await runTransaction<RuntimeRoleConflict>(CONFLICT_COLLECTION, conflicts => [...conflicts.slice(-499), {
      schemaVersion: 2, id: generateId(), role: input.role, activeHolderId: ownerOf(output.lease),
      rejectedHolderId: ownerId, activeInstanceId: instanceOf(output.lease), rejectedInstanceId: instanceId, observedAt: now,
    }]);
  }
  return output;
}

export async function heartbeatRuntimeRole(
  role: RuntimeRole,
  ownership: RuntimeRoleOwnership,
  leaseMs = DEFAULT_ROLE_LEASE_MS,
  nowMs = Date.now(),
): Promise<boolean> {
  let updated = false;
  await runTransaction<RuntimeRoleLease>(ROLE_COLLECTION, leases => {
    const lease = leases.find(item => item.role === role);
    if (!lease || lease.status !== 'ACTIVE' || !ownsLease(lease, ownership) || Date.parse(expiryOf(lease)) <= nowMs) return undefined;
    lease.heartbeatAt = new Date(nowMs).toISOString();
    lease.releaseId = getReleaseIdentity().releaseId;
    lease.expiresAt = new Date(nowMs + Math.max(5_000, Math.min(5 * 60_000, leaseMs))).toISOString();
    lease.leaseExpiresAt = lease.expiresAt;
    lease.updatedAt = lease.heartbeatAt;
    updated = true;
    return leases;
  });
  return updated;
}

export async function releaseRuntimeRole(role: RuntimeRole, ownership: RuntimeRoleOwnership, nowMs = Date.now()): Promise<boolean> {
  let released = false;
  await runTransaction<RuntimeRoleLease>(ROLE_COLLECTION, leases => {
    const lease = leases.find(item => item.role === role);
    if (!lease || lease.status !== 'ACTIVE' || !ownsLease(lease, ownership)) return undefined;
    lease.status = 'RELEASED';
    lease.heartbeatAt = new Date(nowMs).toISOString();
    lease.expiresAt = lease.heartbeatAt;
    lease.leaseExpiresAt = lease.heartbeatAt;
    lease.updatedAt = lease.heartbeatAt;
    released = true;
    return leases;
  });
  return released;
}

export async function isRuntimeRoleOwner(role: RuntimeRole, ownership: RuntimeRoleOwnership, nowMs = Date.now()): Promise<boolean> {
  const lease = (await readCollection<RuntimeRoleLease>(ROLE_COLLECTION)).find(item => item.role === role);
  return Boolean(lease && lease.status === 'ACTIVE' && Date.parse(expiryOf(lease)) > nowMs && ownsLease(lease, ownership));
}

export async function listRuntimeRoleLeases(): Promise<RuntimeRoleLease[]> {
  return (await readCollection<RuntimeRoleLease>(ROLE_COLLECTION)).map(item => clone(normalizeLease(item)));
}

export async function listRecentRuntimeRoleConflicts(sinceMs: number): Promise<RuntimeRoleConflict[]> {
  return (await readCollection<RuntimeRoleConflict>(CONFLICT_COLLECTION)).filter(item => Date.parse(item.observedAt) >= sinceMs);
}
