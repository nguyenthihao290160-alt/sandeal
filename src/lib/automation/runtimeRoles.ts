import {
  generateId,
  readBoundedCollectionSnapshot,
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
const ROLE_FENCE_SAFETY_MARGIN_MS = Math.max(
    1_000,
    Math.min(10_000, Math.floor(ROLE_FENCE_LEASE_MS / 6)),
);
const ROLE_FENCE_RELEASE_WAIT_MS = Math.max(
    250,
    Math.min(2_000, Math.floor(ROLE_FENCE_SAFETY_MARGIN_MS / 2)),
);

export const RUNTIME_ROLE_SCHEMA_VERSION = 3;
export const DEFAULT_ROLE_LEASE_MS = 45_000;

function normalizeRuntimeRoleLeaseMs(value: number | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
      ? Math.max(5_000, Math.min(5 * 60_000, Math.floor(parsed)))
      : DEFAULT_ROLE_LEASE_MS;
}

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

async function readRuntimeRoleLease(
    role: RuntimeRole,
): Promise<RuntimeRoleLease | undefined> {
  const snapshot = await readBoundedCollectionSnapshot<RuntimeRoleLease>(
      ROLE_COLLECTION,
      { maximumItems: 10, maximumBytes: 128 * 1024 },
  );
  return snapshot.items.find(item => item.role === role);
}

async function readRuntimeRoleFenceLease(
    role: RuntimeRole,
): Promise<RuntimeRoleFenceLease | undefined> {
  const snapshot = await readBoundedCollectionSnapshot<RuntimeRoleFenceLease>(
      ROLE_FENCE_COLLECTION,
      { maximumItems: 10, maximumBytes: 128 * 1024 },
  );
  return snapshot.items.find(item => item.id === role);
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

async function settlesWithin(
    operation: Promise<unknown>,
    maximumWaitMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true, () => true),
      new Promise<false>(resolve => {
        timeout = setTimeout(() => resolve(false), maximumWaitMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
    maximumWaitMs?: number,
): Promise<RuntimeFenceHandle> {
  const token = generateId();
  const startedAt = Date.now();
  const boundedMaximumWaitMs = maximumWaitMs === undefined
      ? ROLE_FENCE_WAIT_MS
      : Math.max(1, Math.min(ROLE_FENCE_WAIT_MS, maximumWaitMs));
  let acquired = false;
  let knownExpiresAtMs = 0;

  while (!acquired && Date.now() - startedAt < boundedMaximumWaitMs) {
    let acquiredExpiresAtMs = 0;

    await runTransaction<RuntimeRoleFenceLease>(ROLE_FENCE_COLLECTION, items => {
      const transactionNowMs = Date.now();
      if (transactionNowMs - startedAt >= boundedMaximumWaitMs) {
        return undefined;
      }

      const current = items.find(item => item.id === role);
      const live = current?.status === 'ACTIVE'
          && Date.parse(current.expiresAt) > transactionNowMs;
      if (live && current?.token !== token) return undefined;

      const now = new Date(transactionNowMs).toISOString();
      acquiredExpiresAtMs = transactionNowMs + ROLE_FENCE_LEASE_MS;
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
        expiresAt: new Date(acquiredExpiresAtMs).toISOString(),
        updatedAt: now,
      };
      acquired = true;
      return [...items.filter(item => item.id !== role), next];
    });

    if (acquired) {
      knownExpiresAtMs = acquiredExpiresAtMs;
      break;
    }

    const delay = Math.min(
        500,
        Math.max(
            25,
            25 * 2 ** Math.min(5, Math.floor((Date.now() - startedAt) / 500)),
        ),
    );
    await new Promise(resolve => {
      setTimeout(
          resolve,
          delay + Math.floor(Math.random() * 20),
      );
    });
  }

  if (!acquired) throw new Error('ROLE_FENCE_LOCK_TIMEOUT');

  let lost = false;
  let closing = false;
  let heartbeatInFlight: Promise<void> | undefined;

  const renew = async (): Promise<void> => {
    if (lost || closing) return;

    if (shouldRenew) {
      let authorized = false;
      try {
        authorized = await shouldRenew();
      } catch {
        if (Date.now() + ROLE_FENCE_SAFETY_MARGIN_MS >= knownExpiresAtMs) {
          lost = true;
        }
        return;
      }
      if (!authorized) {
        lost = true;
        return;
      }
    }

    if (lost || closing) return;

    let renewed = false;
    let nextExpiresAtMs = knownExpiresAtMs;
    try {
      await runTransaction<RuntimeRoleFenceLease>(
          ROLE_FENCE_COLLECTION,
          items => {
            if (lost || closing) return undefined;

            const transactionNowMs = Date.now();
            const current = items.find(item => item.id === role);
            if (
                !current
                || current.status !== 'ACTIVE'
                || current.token !== token
                || Date.parse(current.expiresAt) <= transactionNowMs
            ) {
              return undefined;
            }

            const now = new Date(transactionNowMs).toISOString();
            nextExpiresAtMs = transactionNowMs + ROLE_FENCE_LEASE_MS;
            current.heartbeatAt = now;
            current.expiresAt = new Date(nextExpiresAtMs).toISOString();
            current.updatedAt = now;
            renewed = true;
            return items;
          },
      );
    } catch {
      if (Date.now() + ROLE_FENCE_SAFETY_MARGIN_MS >= knownExpiresAtMs) {
        lost = true;
      }
      return;
    }

    if (closing) {
      lost = true;
      return;
    }

    if (!renewed) {
      lost = true;
      return;
    }

    knownExpiresAtMs = nextExpiresAtMs;
  };

  const heartbeat = setInterval(() => {
    if (heartbeatInFlight || lost || closing) return;
    heartbeatInFlight = renew().finally(() => {
      heartbeatInFlight = undefined;
    });
    void heartbeatInFlight.catch(() => undefined);
  }, ROLE_FENCE_HEARTBEAT_MS);
  heartbeat.unref?.();

  const assertHeld: RuntimeFenceAssertion = async () => {
    if (
        lost
        || Date.now() + ROLE_FENCE_SAFETY_MARGIN_MS >= knownExpiresAtMs
    ) {
      lost = true;
      throw new Error('ROLE_FENCE_LOST');
    }

    const current = await readRuntimeRoleFenceLease(role);
    if (
        !current
        || current.status !== 'ACTIVE'
        || current.token !== token
        || Date.parse(current.expiresAt) <= Date.now()
    ) {
      lost = true;
      throw new Error('ROLE_FENCE_LOST');
    }

    knownExpiresAtMs = Date.parse(current.expiresAt);
  };

  return {
    assertHeld,
    release: async () => {
      closing = true;
      lost = true;
      clearInterval(heartbeat);

      const pendingHeartbeat = heartbeatInFlight;
      if (
          pendingHeartbeat
          && !await settlesWithin(pendingHeartbeat, ROLE_FENCE_RELEASE_WAIT_MS)
      ) {
        /*
         * Promise timeouts cannot cancel storage work. Do not queue a release
         * behind a hung renewal on the same collection; abandon this token to
         * its finite durable expiry. `closing` prevents a delayed renewal that
         * has not crossed its commit boundary from extending the fence.
         */
        return;
      }

      const releaseOperation = runTransaction<RuntimeRoleFenceLease>(
          ROLE_FENCE_COLLECTION,
          items => {
            const current = items.find(item => item.id === role);
            if (!current || current.token !== token) return undefined;
            const now = new Date().toISOString();
            current.status = 'RELEASED';
            current.expiresAt = now;
            current.updatedAt = now;
            return items;
          },
      ).catch(() => undefined);
      await settlesWithin(releaseOperation, ROLE_FENCE_RELEASE_WAIT_MS);
    },
  };
}

async function withRuntimeFence<T>(
    role: RuntimeRole,
    ownerId: string,
    instanceId: string,
    work: (assertHeld: RuntimeFenceAssertion) => Promise<T>,
    shouldRenew?: () => Promise<boolean>,
    maximumWaitMs?: number,
): Promise<T> {
  const fence = await acquireRuntimeFence(
      role,
      ownerId,
      instanceId,
      shouldRenew,
      maximumWaitMs,
  );
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

  const leaseMs = normalizeRuntimeRoleLeaseMs(input.leaseMs);

  let output!: {
    acquired: boolean;
    lease: RuntimeRoleLease;
    ownership?: RuntimeRoleOwnership;
    event?: 'ACQUIRED' | 'RENEWED' | 'TAKEN_OVER';
    staleLease?: RuntimeRoleLease;
    reason?: 'ROLE_ALREADY_ACTIVE';
  };

  let observedAt = new Date(input.now ?? Date.now()).toISOString();

  await withRuntimeFence(
      input.role,
      `acquire:${ownerId}`,
      instanceId,
      async () => {
        /*
         * Capture production wall-clock time after the fence has actually
         * been acquired. Waiting for the fence must never consume the newly
         * issued role lease before that lease is committed.
         *
         * Explicit input.now remains deterministic for tests/recovery probes.
         */
        await runTransaction<RuntimeRoleLease>(ROLE_COLLECTION, leases => {
          const transactionNowMs = input.now ?? Date.now();
          const now = new Date(transactionNowMs).toISOString();
          observedAt = now;

          const stored = leases.find(item => item.role === input.role);
          const existing = stored ? normalizeLease(stored) : undefined;

          const sameInstance = Boolean(
              existing && instanceOf(existing) === instanceId,
          );

          const active = Boolean(
              existing
              && existing.status === 'ACTIVE'
              && Date.parse(expiryOf(existing)) > transactionNowMs,
          );

          const continuingLease = Boolean(
              existing && sameInstance && active,
          );

          if (existing && active && !sameInstance) {
            output = {
              acquired: false,
              lease: clone(existing),
              reason: 'ROLE_ALREADY_ACTIVE',
            };
            return undefined;
          }

          const takeover = Boolean(existing && !sameInstance);

          const takeoverHistory = [
            ...(existing?.takeoverHistory || []),
            ...(takeover ? [now] : []),
          ]
              .filter(value => Number.isFinite(Date.parse(value)))
              .slice(-100);

          /*
           * Reuse a fencing epoch only for a genuinely live renewal by the
           * exact same process instance. Expired/released authority always
           * receives a new fencing token.
           */
          const fencingToken = continuingLease
              ? Math.max(1, existing?.fencingToken || 1)
              : Math.max(1, (existing?.fencingToken || 0) + 1);

          const expiresAt = new Date(
              transactionNowMs + leaseMs,
          ).toISOString();

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
            acquiredAt: continuingLease ? existing!.acquiredAt : now,
            startedAt: continuingLease ? existing!.startedAt : now,
            heartbeatAt: now,
            expiresAt,
            leaseExpiresAt: expiresAt,
            fencingToken,
            previousHolderId: takeover && existing
                ? ownerOf(existing)
                : existing?.previousHolderId,
            previousInstanceId: takeover && existing
                ? instanceOf(existing)
                : existing?.previousInstanceId,
            takeoverHistory,
            lastTakeoverAt: takeover
                ? now
                : existing?.lastTakeoverAt,
            takeoverCount: (existing?.takeoverCount || 0)
                + (takeover ? 1 : 0),
            updatedAt: now,
          };

          if (stored) Object.assign(stored, lease);
          else leases.push(lease);

          output = {
            acquired: true,
            lease: clone(lease),
            ownership: {
              ownerId,
              instanceId,
              fencingToken,
              releaseId: lease.releaseId,
            },
            event: takeover
                ? 'TAKEN_OVER'
                : continuingLease
                    ? 'RENEWED'
                    : 'ACQUIRED',
            staleLease: takeover ? existing : undefined,
          };

          return leases;
        });
      },
  );

  if (!output.acquired) {
    await runTransaction<RuntimeRoleConflict>(
        CONFLICT_COLLECTION,
        conflicts => [
          ...conflicts.slice(-499),
          {
            schemaVersion: 2,
            id: generateId(),
            role: input.role,
            activeHolderId: ownerOf(output.lease),
            rejectedHolderId: ownerId,
            activeInstanceId: instanceOf(output.lease),
            rejectedInstanceId: instanceId,
            observedAt,
          },
        ],
    );
  }

  return output;
}

export async function heartbeatRuntimeRole(
    role: RuntimeRole,
    ownership: RuntimeRoleOwnership,
    leaseMs = DEFAULT_ROLE_LEASE_MS,
    nowMs?: number,
): Promise<boolean> {
  let updated = false;
  const startedAt = Date.now();

  try {
    const currentReleaseId = getReleaseIdentity().releaseId;

    await runTransaction<RuntimeRoleLease>(ROLE_COLLECTION, leases => {
      /*
       * Production time is captured after the storage transaction has gained
       * authority over ROLE_COLLECTION. Lock wait time must not allow an
       * already-expired role to be resurrected.
       *
       * Explicit nowMs remains deterministic for tests.
       */
      const transactionNowMs = nowMs ?? Date.now();

      const lease = leases.find(item => item.role === role);

      if (
          !lease
          || lease.status !== 'ACTIVE'
          || !ownsLease(lease, ownership)
          || (ownership.releaseId && currentReleaseId !== ownership.releaseId)
          || Date.parse(expiryOf(lease)) <= transactionNowMs
      ) {
        return undefined;
      }

      const heartbeatAt = new Date(transactionNowMs).toISOString();

      lease.heartbeatAt = heartbeatAt;
      lease.releaseId = currentReleaseId;
      lease.expiresAt = new Date(
          transactionNowMs + normalizeRuntimeRoleLeaseMs(leaseMs),
      ).toISOString();
      lease.leaseExpiresAt = lease.expiresAt;
      lease.updatedAt = heartbeatAt;
      updated = true;

      return leases;
    });
  } finally {
    recordRoleHeartbeatRenewal(Date.now() - startedAt, updated);
  }

  return updated;
}

export async function releaseRuntimeRole(
    role: RuntimeRole,
    ownership: RuntimeRoleOwnership,
    nowMs?: number,
): Promise<boolean> {
  let released = false;

  await withRuntimeFence(
      role,
      `release:${ownership.ownerId}`,
      ownership.instanceId,
      async () => {
        await runTransaction<RuntimeRoleLease>(ROLE_COLLECTION, leases => {
          const lease = leases.find(item => item.role === role);

          if (
              !lease
              || lease.status !== 'ACTIVE'
              || !ownsLease(lease, ownership)
          ) {
            return undefined;
          }

          /*
           * Capture release time only after the role transaction has actually
           * started, unless a deterministic test time was explicitly supplied.
           */
          const transactionNowMs = nowMs ?? Date.now();
          const releasedAt = new Date(transactionNowMs).toISOString();

          lease.status = 'RELEASED';
          lease.heartbeatAt = releasedAt;
          lease.expiresAt = releasedAt;
          lease.leaseExpiresAt = releasedAt;
          lease.updatedAt = releasedAt;
          released = true;

          return leases;
        });
      },
  );

  return released;
}

export async function isRuntimeRoleOwner(
    role: RuntimeRole,
    ownership: RuntimeRoleOwnership,
    nowMs?: number,
): Promise<boolean> {
  const lease = await readRuntimeRoleLease(role);

  /*
   * For live production checks, evaluate expiry after the storage read has
   * completed so read latency cannot make an expired lease appear current.
   */
  const evaluationNowMs = nowMs ?? Date.now();

  return Boolean(
      lease
      && lease.status === 'ACTIVE'
      && Date.parse(expiryOf(lease)) > evaluationNowMs
      && ownsLease(lease, ownership)
      && (!ownership.releaseId || lease.releaseId === ownership.releaseId),
  );
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
    maximumWaitMs?: number,
    onFenceAcquired?: () => void,
): Promise<T> {
  return withRuntimeFence(
      role,
      `authority:${ownership.ownerId}`,
      ownership.instanceId,
      async assertFence => {
        onFenceAcquired?.();

        let authorized = false;

        await runTransaction<RuntimeRoleLease>(ROLE_COLLECTION, leases => {
          const lease = leases.find(item => item.role === role);

          if (
              !lease
              || lease.status !== 'ACTIVE'
              || Date.parse(expiryOf(lease)) <= Math.max(nowMs, Date.now())
              || !ownsLease(lease, ownership)
              || (ownership.releaseId && lease.releaseId !== ownership.releaseId)
          ) {
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
      },
      () => isRuntimeRoleOwner(role, ownership),
      maximumWaitMs,
  );
}

export async function listRuntimeRoleLeases(): Promise<RuntimeRoleLease[]> {
  const snapshot = await readBoundedCollectionSnapshot<RuntimeRoleLease>(
      ROLE_COLLECTION,
      { maximumItems: 10, maximumBytes: 128 * 1024 },
  );

  return snapshot.items.map(item => clone(normalizeLease(item)));
}

export async function listRecentRuntimeRoleConflicts(
    sinceMs: number,
): Promise<RuntimeRoleConflict[]> {
  const snapshot = await readBoundedCollectionSnapshot<RuntimeRoleConflict>(
      CONFLICT_COLLECTION,
      {
        maximumItems: 500,
        maximumBytes: 512 * 1024,
      },
  );

  return snapshot.items.filter(
      item => Date.parse(item.observedAt) >= sinceMs,
  );
}
