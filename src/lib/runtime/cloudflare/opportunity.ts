import { EventJobError } from '../../platform/cloudflareContracts';
import { D1OpportunityStore } from '../../storage/d1/d1OpportunityStore';
import type { D1DecisionStore } from '../../storage/d1/d1DecisionStore';
import type { D1Database } from '../../storage/d1/database';
import type { CloudflareEnvironment } from './context';

export function validateOpportunityRuntime(env: CloudflareEnvironment) {
  if ((env.SANDEAL_OPPORTUNITY_ENABLED !== undefined && !['true', 'false'].includes(env.SANDEAL_OPPORTUNITY_ENABLED))
    || (env.SANDEAL_OPPORTUNITY_ENABLED === 'true' && (env.SANDEAL_LOCAL_ONLY !== 'true' || env.SANDEAL_PRODUCTION !== 'false'
      || env.SANDEAL_RUNTIME !== 'cloudflare' || env.SANDEAL_DECISION_OS_ENABLED !== 'true' || env.SANDEAL_DEAL_INTELLIGENCE_ENABLED !== 'true'
      || env.SANDEAL_AUTOPILOT_ENABLED !== 'true' || !env.DB || !env.JOB_QUEUE || typeof env.JOB_QUEUE.send !== 'function')))
    throw new EventJobError('OPPORTUNITY_RUNTIME_FAIL_CLOSED', 'QUARANTINE');
}
export function cloudflareOpportunityStore(env: CloudflareEnvironment, db: D1Database, decisions: D1DecisionStore, testOnly = false) {
  validateOpportunityRuntime(env);
  if (env.SANDEAL_OPPORTUNITY_ENABLED !== 'true') throw new EventJobError('OPPORTUNITY_DISABLED', 'FINAL');
  return new D1OpportunityStore(db, decisions, testOnly);
}
