import {
  generateId,
  readBoundedCollectionSnapshot,
  readCollection,
  runTransaction,
} from '@/lib/storage/adapter';
import { recordFencingRejection, recordRoleHeartbeatRenewal } from '@/lib/storage/diagnostics';
import { getReleaseIdentity } from '@/lib/releaseIdentity';

const ROLE_COLLECTION = 'runtime-role-leases';
const CONFLICT_COLLECTION = 'runtime-role-conflicts';
const ROLE_FENCE_COLLECTION = 'runtime-role-fencing';
const ROLE_FENCE_LEASE_MS = Math.max(15_000, Math.min(5 * 60_000, Number(process.env.SANDEAL_ROLE_FENCE_LEASE_MS) || 90_000));
const ROLE_FENCE_WAIT_MS = Math.max(5_000, Math.min(2 * 60_000, Number(process.env.SANDEAL_ROLE_FENCE_WAIT_MS) || 90_000));
const ROLE_FENCE_HEARTBEAT_MS = Math.max(2_000, Math.min(10_000, Math.floor(ROLE_FENCE_LEASE_MS / 3)));
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
  /** ISO timestamps for bounded, windowed restart detection. */
  takeoverHistory?: string[];
  lastTakeoverAt?: string;
  takeoverCount: number;
  updatedAt: string;
}

export interface RuntimeRoleOwnership {
  ownerId: string;
  instanceId: string;
  fencingToken: number;
  releaseId?: string;
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

interface RuntimeRoleFenceLease {
  schemaVersion: 1;
  id: RuntimeRole;
  role: RuntimeRole;
  ownerId: string;
  instanceId: string;
  token: string;
  status: 'ACTIVE' | 'RELEASED';
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  updatedAt: string;
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
    && (lease.fencingToken || 0) === ownership.fencingToken
    && (!ownership.releaseId || lease.releaseId === ownership.releaseId);
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
    takeoverHistory: Array.isArray(lease.takeoverHistory)
      ? lease.takeoverHistory.filter(value => Number.isFinite(Date.parse(value))).slice(-100)
      : [],
  };
}

type RuntimeFenceAssertion = () => Promise<void>;

interface RuntimeFenceHandle {
  assertHeld: RuntimeFenceAssertion;
  release: () => Promise<void>;
}

/**
 * Serialize role takeover and final fenced job mutations without holding the
 * role-lease collection lock across the business mutation. The role lease is
 * renewed in the small role collection, while this short-lived fence is
 * renewed independently and released in a finally path.
 */
async function acquireRuntimeFence(
  role: RuntimeRole,
  ownerId: string,
  instanceId: string,
  shouldRenew?: () => Promise<boolean>,
): Promise<RuntimeFenceHandle> {
  const token = generateId();
  const startedAt = Date.now();
  let acquired = false;
  while (!acquired && Date.now() - startedAt < ROLE_FENCE_WAIT_MS) {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    await runTransaction<RuntimeRoleFenceLease>(ROLE_FENCE_COLLECTION, items => {
      const current = items.find(item => item.id === role);
      const live = current?.status === 'ACTIVE' && Date.parse(current.expiresAt) > nowMs;
      if (live && current?.token !== token) return undefined;
      const next: RuntimeRoleFenceLease = {
        schemaVersion: 1,
        id: role,
        role,
        ownerId,
        instanceId,
        token,
        status: 'ACTIVE',
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(nowMs + ROLE_FENCE_LEASE_MS).toISOString(),
        updatedAt: now,
      };
      acquired = true;
      return [...items.filter(item => item.id !== role), next];
    });
    if (!acquired) {
      const delay = Math.min(500, Math.max(25, 25 * 2 ** Math.min(5, Math.floor((Date.now() - startedAt) / 500))));
      await new Promise(resolve => setTimeout(resolve, delay + Math.floor(Math.random() * 20)));
    }
  }
  if (!acquired) throw new Error('ROLE_FENCE_LOCK_TIMEOUT');

  let lost = false;
  let heartbeatInFlight: Promise<void> | undefined;
  const renew = async (): Promise<void> => {
    const nowMs = Date.now();
    let renewed = false;
    try {
      if (shouldRenew && !await shouldRenew()) {
        lost = true;
        return;
      }
      await runTransaction<RuntimeRoleFenceLease>(ROLE_FENCE_COLLECTION, items => {
        const current = items.find(item => item.id === role);
        if (!current || current.status !== 'ACTIVE' || current.token !== token || Date.parse(current.expiresAt) <= nowMs) return undefined;
        const now = new Date(nowMs).toISOString();
        current.heartbeatAt = now;
        current.expiresAt = new Date(nowMs + ROLE_FENCE_LEASE_MS).toISOString();
        current.updatedAt = now;
        renewed = true;
        return items;
      });
    } catch {
      renewed = false;
    }
    if (!renewed) lost = true;
  };
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = renew().finally(() => {
      heartbeatInFlight = undefined;
    });
  }, ROLE_FENCE_HEARTBEAT_MS);
  heartbeat.unref?.();

  const assertHeld: RuntimeFenceAssertion = async () => {
    if (lost) throw new Error('ROLE_FENCE_LOST');
    const current = (await readCollection<RuntimeRoleFenceLease>(ROLE_FENCE_COLLECTION))
      .find(item => item.id === role);
    if (!current || current.status !== 'ACTIVE' || current.token !== token || Date.parse(current.expiresAt) <= Date.now()) {
      lost = true;
      throw new Error('ROLE_FENCE_LOST');
    }
  };

  return {
    assertHeld,
    release: async () => {
      clearInterval(heartbeat);
      await heartbeatInFlight?.catch(() => undefined);
      await runTransaction<RuntimeRoleFenceLease>(ROLE_FENCE_COLLECTION, items => {
        const current = items.find(item => item.id === role);
        if (!current || current.token !== token) return undefined;
        const now = new Date().toISOString();
        current.status = 'RELEASED';
        current.expiresAt = now;
        current.updatedAt = now;
        return items;
      }).catch(() => undefined);
    },
  };
}

async function withRuntimeFence<T>(
  role: RuntimeRole,
  ownerId: string,
  instanceId: string,
  work: (assertHeld: RuntimeFenceAssertion) => Promise<T>,
  shouldRenew?: () => Promise<boolean>,
): Promise<T> {
  const fence = await acquireRuntimeFence(role, ownerId, instanceId, shouldRenew);
  try {
    await fence.assertHeld();
    return await work(fence.assertHeld);
  } finally {
    await fence.release();
  }
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
  await withRuntimeFence(input.role, `acquire:${ownerId}`, instanceId, async () => {
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
      const takeoverHistory = [
        ...(existing?.takeoverHistory || []),
        ...(takeover ? [now] : []),
      ].filter(value => Number.isFinite(Date.parse(value))).slice(-100);
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
        takeoverHistory,
        lastTakeoverAt: takeover ? now : existing?.lastTakeoverAt,
        takeoverCount: (existing?.takeoverCount || 0) + (takeover ? 1 : 0),
        updatedAt: now,
      };
      if (stored) Object.assign(stored, lease); else leases.push(lease);
      output = {
        acquired: true,
        lease: clone(lease),
        ownership: { ownerId, instanceId, fencingToken, releaseId: lease.releaseId },
        event: takeover ? 'TAKEN_OVER' : sameInstance ? 'RENEWED' : 'ACQUIRED',
        staleLease: takeover ? existing : undefined,
      };
      return leases;
    });
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
  const startedAt = Date.now();
  try {
    const currentReleaseId = getReleaseIdentity().releaseId;
    await runTransaction<RuntimeRoleLease>(ROLE_COLLECTION, leases => {
      const lease = leases.find(item => item.role === role);
      if (!lease
        || lease.status !== 'ACTIVE'
        || !ownsLease(lease, ownership)
        || (ownership.releaseId && currentReleaseId !== ownership.releaseId)
        || Date.parse(expiryOf(lease)) <= nowMs) return undefined;
      lease.heartbeatAt = new Date(nowMs).toISOString();
      lease.releaseId = currentReleaseId;
      lease.expiresAt = new Date(nowMs + Math.max(5_000, Math.min(5 * 60_000, leaseMs))).toISOString();
      lease.leaseExpiresAt = lease.expiresAt;
      lease.updatedAt = lease.heartbeatAt;
      updated = true;
      return leases;
    });
  } finally {
    recordRoleHeartbeatRenewal(Date.now() - startedAt, updated);
  }
  return updated;
}

export async function releaseRuntimeRole(role: RuntimeRole, ownership: RuntimeRoleOwnership, nowMs = Date.now()): Promise<boolean> {
  let released = false;
  await withRuntimeFence(role, `release:${ownership.ownerId}`, ownership.instanceId, async () => {
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
  });
  return released;
}

export async function isRuntimeRoleOwner(role: RuntimeRole, ownership: RuntimeRoleOwnership, nowMs = Date.now()): Promise<boolean> {
  const lease = (await readCollection<RuntimeRoleLease>(ROLE_COLLECTION)).find(item => item.role === role);
  return Boolean(lease
    && lease.status === 'ACTIVE'
    && Date.parse(expiryOf(lease)) > nowMs
    && ownsLease(lease, ownership)
    && (!ownership.releaseId || lease.releaseId === ownership.releaseId));
}

/**
 * Linearize a final durable job mutation with a separate role fence. The
 * role-lease collection remains available to the independent heartbeat while
 * takeover and final mutations are serialized by the fence.
 */
export async function withRuntimeRoleAuthority<T>(
  role: RuntimeRole,
  ownership: RuntimeRoleOwnership,
  work: (assertAuthority: RuntimeFenceAssertion) => Promise<T>,
  nowMs = Date.now(),
): Promise<T> {
  return withRuntimeFence(role, `authority:${ownership.ownerId}`, ownership.instanceId, async assertFence => {
    let authorized = false;
    await runTransaction<RuntimeRoleLease>(ROLE_COLLECTION, leases => {
      const lease = leases.find(item => item.role === role);
      if (!lease
        || lease.status !== 'ACTIVE'
        || Date.parse(expiryOf(lease)) <= Math.max(nowMs, Date.now())
        || !ownsLease(lease, ownership)
        || (ownership.releaseId && lease.releaseId !== ownership.releaseId)) {
        return undefined;
      }
      authorized = true;
      return undefined;
    });
    if (!authorized) {
      recordFencingRejection();
      throw new Error('WORKER_FENCING_REJECTED');
    }
    const assertAuthority: RuntimeFenceAssertion = async () => {
      await assertFence();
      if (!await isRuntimeRoleOwner(role, ownership)) {
        recordFencingRejection();
        throw new Error('WORKER_FENCING_REJECTED');
      }
    };
    await assertAuthority();
    return work(assertAuthority);
  }, () => isRuntimeRoleOwner(role, ownership));
}

export async function listRuntimeRoleLeases(): Promise<RuntimeRoleLease[]> {
  return (await readCollection<RuntimeRoleLease>(ROLE_COLLECTION)).map(item => clone(normalizeLease(item)));
}

export async function listRecentRuntimeRoleConflicts(sinceMs: number): Promise<RuntimeRoleConflict[]> {
  const snapshot = await readBoundedCollectionSnapshot<RuntimeRoleConflict>(CONFLICT_COLLECTION, {
    maximumItems: 500,
    maximumBytes: 512 * 1024,
  });
  return snapshot.items.filter(item => Date.parse(item.observedAt) >= sinceMs);
}
