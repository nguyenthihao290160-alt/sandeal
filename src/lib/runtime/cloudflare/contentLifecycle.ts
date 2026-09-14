import { EventJobError } from '../../platform/cloudflareContracts';
import { D1ContentLifecycleStore } from '../../storage/d1/d1ContentLifecycleStore';
import { cloudflareContext, type CloudflareEnvironment } from './context';
import { cloudflareDecisionStore } from './decision';
import { cloudflareOpportunityStore } from './opportunity';

export function validateContentLifecycleRuntime(env: CloudflareEnvironment) {
  if ((env.SANDEAL_CONTENT_LIFECYCLE_ENABLED !== undefined && !['true', 'false'].includes(env.SANDEAL_CONTENT_LIFECYCLE_ENABLED))
    || (env.SANDEAL_CONTENT_LIFECYCLE_ENABLED === 'true' && (env.SANDEAL_LOCAL_ONLY !== 'true' || env.SANDEAL_PRODUCTION !== 'false'
      || env.SANDEAL_RUNTIME !== 'cloudflare' || env.SANDEAL_OPPORTUNITY_ENABLED !== 'true' || env.SANDEAL_DECISION_OS_ENABLED !== 'true'
      || env.SANDEAL_DEAL_INTELLIGENCE_ENABLED !== 'true' || env.SANDEAL_AUTOPILOT_ENABLED !== 'true'
      || !env.DB || !env.JOB_QUEUE || typeof env.JOB_QUEUE.send !== 'function')))
    throw new EventJobError('CONTENT_LIFECYCLE_RUNTIME_FAIL_CLOSED', 'QUARANTINE');
}
export function cloudflareContentLifecycleStore(env: CloudflareEnvironment, testOnly = false) {
  validateContentLifecycleRuntime(env);
  if (env.SANDEAL_CONTENT_LIFECYCLE_ENABLED !== 'true') throw new EventJobError('CONTENT_LIFECYCLE_DISABLED', 'FINAL');
  const { db } = cloudflareContext(env), decisions = cloudflareDecisionStore(env, db, testOnly);
  const opportunities = cloudflareOpportunityStore(env, db, decisions, testOnly);
  return new D1ContentLifecycleStore(db, decisions, opportunities, (env.AFFILIATE_REDIRECT_HOSTS || '').split(',').map(host => host.trim()).filter(Boolean), testOnly);
}
