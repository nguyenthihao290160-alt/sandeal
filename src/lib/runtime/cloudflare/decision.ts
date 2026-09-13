import { EventJobError } from '../../platform/cloudflareContracts';
import { D1DecisionStore } from '../../storage/d1/d1DecisionStore';
import { DECISION_CONFIG, type DecisionConfig } from '../../decision-os/config';
import type { DecisionConstraints, DecisionModelRoles } from '../../decision-os/types';
import type { D1Database } from '../../storage/d1/database';
import type { CloudflareEnvironment } from './context';
import type { DecisionAiBatchBudget } from '../../decision-os/reasoner';

export interface DecisionRuntimeOptions { config: DecisionConfig; roles: DecisionModelRoles; batchBudget?: DecisionAiBatchBudget }
export function validateDecisionRuntimeFlags(env: CloudflareEnvironment) {
  if ((env.SANDEAL_DECISION_OS_ENABLED !== undefined && !['true', 'false'].includes(env.SANDEAL_DECISION_OS_ENABLED))
    || (env.SANDEAL_DECISION_EXECUTION_MODE !== undefined && env.SANDEAL_DECISION_EXECUTION_MODE !== 'SHADOW'))
    throw new EventJobError('DECISION_RUNTIME_FAIL_CLOSED', 'QUARANTINE');
}
export function cloudflareDecisionStore(env: CloudflareEnvironment, db: D1Database, testOnly = false, options?: DecisionRuntimeOptions) {
  validateDecisionRuntimeFlags(env);
  if (env.SANDEAL_DECISION_OS_ENABLED !== 'true' || env.SANDEAL_DEAL_INTELLIGENCE_ENABLED !== 'true'
    || env.SANDEAL_AUTOPILOT_ENABLED !== 'true' || env.SANDEAL_RUNTIME !== 'cloudflare' || env.SANDEAL_LOCAL_ONLY !== 'true'
    || env.SANDEAL_PRODUCTION !== 'false' || (env.SANDEAL_DECISION_EXECUTION_MODE ?? 'SHADOW') !== 'SHADOW'
    || !env.DB || !env.JOB_QUEUE || typeof env.JOB_QUEUE.send !== 'function')
    throw new EventJobError('DECISION_RUNTIME_FAIL_CLOSED', 'QUARANTINE');
  const constraints: DecisionConstraints = { executionMode: 'SHADOW', systemHealth: 'AVAILABLE', systemVersion: 'local-d1-queue-v1',
    securityRisk: false, quarantined: false, runtimeValid: true };
  return new D1DecisionStore(db, constraints, testOnly, options?.config || DECISION_CONFIG, options?.roles, options?.batchBudget);
}
