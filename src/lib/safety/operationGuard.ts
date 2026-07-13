import { createHash, randomUUID } from 'crypto';

export type OperationRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKER';
export type OperationEnvironment = 'local' | 'test' | 'production' | 'unknown';

export interface OperationGuardInput {
  operationId?: string;
  operationType: string;
  actor: string;
  environment: OperationEnvironment;
  target: string;
  approval?: boolean;
  riskLevel: OperationRisk;
  dryRun?: boolean;
  idempotencyKey?: string;
}

export type GuardedOperationResult<T> =
  | { status: 'COMPLETED'; operationId: string; value: T }
  | { status: 'DRY_RUN' | 'APPROVAL_REQUIRED' | 'BLOCKED' | 'ALREADY_PROCESSED' | 'IN_PROGRESS'; operationId: string };

type RegistryEntry = { state: 'in_progress' | 'completed'; touchedAt: number };
const processRegistry = new Map<string, RegistryEntry>();
const REGISTRY_TTL_MS = 24 * 60 * 60_000;
const REGISTRY_MAX = 2_000;

export function getOperationEnvironment(): OperationEnvironment {
  if (process.env.NODE_ENV === 'production') return 'production';
  if (process.env.NODE_ENV === 'test') return 'test';
  if (process.env.NODE_ENV === 'development') return 'local';
  return 'unknown';
}

export function sanitizeSensitiveValue(value: unknown): unknown {
  const sensitive = /^(authorization|api[-_]?key|token|access[-_]?token|refresh[-_]?token|password|secret|cookie|private[-_]?key|credential)$/i;
  if (Array.isArray(value)) return value.map(sanitizeSensitiveValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      sensitive.test(key) ? '[REDACTED]' : sanitizeSensitiveValue(item),
    ]));
  }
  return typeof value === 'string' ? sanitizeErrorMessage(value) : value;
}

export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(api[-_]?key|token|access[-_]?token|refresh[-_]?token|password|secret|cookie|private[-_]?key|credential)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]');
}

function registryKey(input: OperationGuardInput): string | null {
  if (!input.idempotencyKey) return null;
  return createHash('sha256').update(`${input.operationType}:${input.idempotencyKey}`).digest('hex');
}

function pruneRegistry(now: number): void {
  for (const [key, entry] of processRegistry) {
    if (now - entry.touchedAt > REGISTRY_TTL_MS) processRegistry.delete(key);
  }
  if (processRegistry.size <= REGISTRY_MAX) return;
  const oldest = [...processRegistry.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  for (const [key] of oldest.slice(0, processRegistry.size - REGISTRY_MAX)) processRegistry.delete(key);
}

/** Process-local idempotency; callers still need a durable lock for multi-process safety. */
export async function runGuardedOperation<T>(
  input: OperationGuardInput,
  sideEffect: () => Promise<T>,
): Promise<GuardedOperationResult<T>> {
  const operationId = input.operationId || randomUUID();
  if (input.riskLevel === 'BLOCKER') return { status: 'BLOCKED', operationId };
  if (input.dryRun) return { status: 'DRY_RUN', operationId };
  if (input.riskLevel === 'HIGH' && (!input.approval || input.environment === 'unknown')) {
    return { status: 'APPROVAL_REQUIRED', operationId };
  }

  const now = Date.now();
  pruneRegistry(now);
  const key = registryKey(input);
  if (key) {
    const existing = processRegistry.get(key);
    if (existing?.state === 'completed') return { status: 'ALREADY_PROCESSED', operationId };
    if (existing?.state === 'in_progress') return { status: 'IN_PROGRESS', operationId };
    processRegistry.set(key, { state: 'in_progress', touchedAt: now });
  }
  try {
    const value = await sideEffect();
    if (key) processRegistry.set(key, { state: 'completed', touchedAt: Date.now() });
    return { status: 'COMPLETED', operationId, value };
  } catch (error) {
    if (key) processRegistry.delete(key);
    throw error;
  }
}

export function clearOperationGuardRegistryForTests(): void {
  if (process.env.NODE_ENV === 'test') processRegistry.clear();
}
