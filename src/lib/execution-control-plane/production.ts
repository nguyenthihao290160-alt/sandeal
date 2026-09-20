import { createPublicKey, verify } from 'node:crypto';
import { executionFingerprint, validId } from './fingerprint';
import { getGlobalKillSwitchState, KILL_SWITCH_DOMAINS, type KillSwitchSnapshot } from './killSwitch';
import { exactKeys, isHash } from '../release-rehearsal/contracts';

export const PRODUCTION_CAPABILITIES = Object.freeze(['READ_PRODUCTION_HEALTH'] as const);
export const PRODUCTION_SECRET_REFERENCES = Object.freeze(['BASIC_AUTH_USER', 'BASIC_AUTH_PASSWORD'] as const);
export const PRODUCTION_REQUIREMENTS = Object.freeze(['authentication', 'resources', 'bindings', 'secretReferences',
  'migrationBaseline', 'recovery', 'observability', 'canaryRouting', 'changeWindow', 'rollbackTargets', 'staticArtifact'] as const);
export const PRODUCTION_SIGNALS = Object.freeze(['WORKER_ERRORS', 'HTTP_FAILURES', 'D1_FAILURES', 'QUEUE_FAILURES',
  'CRON_FAILURES', 'PROVIDER_FAILURES', 'UNEXPECTED_WRITES', 'MONEY_INVARIANT_FAILURES', 'KILL_SWITCH_EVENTS',
  'DEPLOYMENT_HEALTH', 'LATENCY', 'RATE_LIMITING'] as const);
export const PRODUCTION_EVIDENCE_TTL_MS = 300_000;

export interface ProductionTargets {
  accountId: string; workerName: string; staticTarget: string; databaseId: string; queueName: string;
  route: string; domain: string;
}
export interface ProductionIdentity {
  head: string; candidateFingerprint: string; workerFingerprint: string; staticFingerprint: string;
  environment: 'PRODUCTION'; targets: ProductionTargets; migrations: { name: string; sha256: string }[];
  capabilities: string[]; configFingerprint: string; secretReferences: string[];
}
export interface ProductionProof {
  state: 'VERIFIED'; environment: 'PRODUCTION'; targetsFingerprint: string; candidateFingerprint: string;
  reportFingerprint: string; reference: string; observedAt: number; expiresAt: number;
}
export interface ProductionBundle {
  schema: 'sandeal-production-release-v1'; identity: ProductionIdentity;
  requirements: Record<typeof PRODUCTION_REQUIREMENTS[number], ProductionProof | null>;
}
export interface ProductionApproval {
  schema: 'sandeal-production-approval-v1'; status: 'APPROVED'; environment: 'PRODUCTION';
  identity: ProductionIdentity; bundleFingerprint: string; approverId: string; keyId: string;
  issuedAt: number; expiresAt: number; signature: string;
}
export interface ProductionTrust { approverId: string; keyId: string; publicKey: string }
export interface ProductionControls {
  environment: 'PRODUCTION'; targetsFingerprint: string; bundleFingerprint: string;
  killSwitch: KillSwitchSnapshot;
  emergencyStop: { state: 'AVAILABLE'; environment: 'PRODUCTION'; revision: number; observedAt: number;
    expiresAt: number; procedureReference: string; verificationFingerprint: string };
}

function fresh(observedAt: number, expiresAt: number, now: number) {
  return [observedAt, expiresAt, now].every(value => Number.isSafeInteger(value) && value >= 0)
    && observedAt <= now && expiresAt > now && expiresAt > observedAt && expiresAt - observedAt <= PRODUCTION_EVIDENCE_TTL_MS;
}
function uniqueNames(values: unknown, maximum: number): values is string[] {
  return Array.isArray(values) && values.length > 0 && values.length <= maximum && values.every(validId)
    && new Set(values).size === values.length && values.join('\n') === [...values].sort().join('\n');
}
export function validProductionIdentity(identity: ProductionIdentity): boolean {
  try {
    if (!exactKeys(identity, ['head', 'candidateFingerprint', 'workerFingerprint', 'staticFingerprint', 'environment',
      'targets', 'migrations', 'capabilities', 'configFingerprint', 'secretReferences'])
      || !/^[a-f0-9]{40}$/.test(identity.head) || identity.environment !== 'PRODUCTION'
      || ![identity.candidateFingerprint, identity.workerFingerprint, identity.staticFingerprint, identity.configFingerprint].every(isHash)) return false;
    const targets = identity.targets;
    if (!exactKeys(targets, ['accountId', 'workerName', 'staticTarget', 'databaseId', 'queueName', 'route', 'domain'])
      || !/^[a-f0-9]{32}$/.test(targets.accountId) || /^0+$/.test(targets.accountId)
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(targets.databaseId)
      || /^0+(?:-0+)+$/.test(targets.databaseId) || !validId(targets.workerName) || !validId(targets.queueName)
      || targets.staticTarget !== targets.workerName || /local|placeholder|unknown/i.test(`${targets.workerName} ${targets.queueName}`)
      || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(targets.domain)
      || targets.route !== `${targets.domain}/*`) return false;
    if (!uniqueNames(identity.capabilities, 10) || identity.capabilities.some(name => !PRODUCTION_CAPABILITIES.includes(name as typeof PRODUCTION_CAPABILITIES[number]))
      || !uniqueNames(identity.secretReferences, 10) || identity.secretReferences.some(name => !PRODUCTION_SECRET_REFERENCES.includes(name as typeof PRODUCTION_SECRET_REFERENCES[number]))
      || PRODUCTION_SECRET_REFERENCES.some(name => !identity.secretReferences.includes(name))) return false;
    return Array.isArray(identity.migrations) && identity.migrations.length > 0 && identity.migrations.length <= 50
      && identity.migrations.every((migration, index) => exactKeys(migration, ['name', 'sha256'])
        && /^\d{4}_[a-z0-9_]+\.sql$/.test(migration.name) && Number(migration.name.slice(0, 4)) === index + 1 && isHash(migration.sha256));
  } catch { return false; }
}
export function productionApprovalMessage(approval: Omit<ProductionApproval, 'signature'>): string {
  return `SANDEAL_PRODUCTION_APPROVAL_V1:${executionFingerprint(approval)}`;
}
export function validateProductionApproval(bundle: ProductionBundle, current: ProductionIdentity, approval: ProductionApproval | null,
  trusted: readonly ProductionTrust[], now: number): boolean {
  try {
    if (!exactKeys(bundle, ['schema', 'identity', 'requirements']) || bundle.schema !== 'sandeal-production-release-v1'
      || !validProductionIdentity(bundle.identity) || !validProductionIdentity(current)
      || executionFingerprint(bundle.identity) !== executionFingerprint(current)
      || !approval || !exactKeys(approval, ['schema', 'status', 'environment', 'identity', 'bundleFingerprint', 'approverId', 'keyId', 'issuedAt', 'expiresAt', 'signature'])
      || approval.schema !== 'sandeal-production-approval-v1' || approval.status !== 'APPROVED' || approval.environment !== 'PRODUCTION'
      || !validProductionIdentity(approval.identity) || executionFingerprint(approval.identity) !== executionFingerprint(current)
      || approval.bundleFingerprint !== executionFingerprint(bundle) || !fresh(approval.issuedAt, approval.expiresAt, now)
      || !validId(approval.approverId) || !validId(approval.keyId) || !Array.isArray(trusted) || trusted.length > 10
      || typeof approval.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(approval.signature)) return false;
    const matches = trusted.filter(key => exactKeys(key, ['approverId', 'keyId', 'publicKey'])
      && key.approverId === approval.approverId && key.keyId === approval.keyId);
    if (matches.length !== 1 || typeof matches[0].publicKey !== 'string' || matches[0].publicKey.length > 1024) return false;
    const publicKey = createPublicKey(matches[0].publicKey);
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;
    const { signature, ...claims } = approval;
    return verify(null, Buffer.from(productionApprovalMessage(claims)), publicKey, Buffer.from(signature, 'base64'));
  } catch { return false; }
}
export function productionControlsReady(controls: ProductionControls | null, bundle: ProductionBundle, now: number): boolean {
  try {
    if (!controls || !exactKeys(controls, ['environment', 'targetsFingerprint', 'bundleFingerprint', 'killSwitch', 'emergencyStop'])
      || controls.environment !== 'PRODUCTION' || controls.targetsFingerprint !== executionFingerprint(bundle.identity.targets)
      || controls.bundleFingerprint !== executionFingerprint(bundle) || getGlobalKillSwitchState(controls.killSwitch, now) !== 'INACTIVE'
      || KILL_SWITCH_DOMAINS.some(domain => controls.killSwitch.domains[domain] !== false)) return false;
    const stop = controls.emergencyStop;
    return exactKeys(stop, ['state', 'environment', 'revision', 'observedAt', 'expiresAt', 'procedureReference', 'verificationFingerprint'])
      && stop.state === 'AVAILABLE' && stop.environment === 'PRODUCTION' && stop.revision === controls.killSwitch.revision
      && fresh(stop.observedAt, stop.expiresAt, now) && validId(stop.procedureReference) && isHash(stop.verificationFingerprint);
  } catch { return false; }
}
export function productionPreflight(input: {
  enabled: boolean; bundle: ProductionBundle; current: ProductionIdentity; approval: ProductionApproval | null;
  trusted: readonly ProductionTrust[]; controls: ProductionControls | null; now: number; capability: string;
  bindings: { DB: boolean; JOB_QUEUE: boolean; ASSETS: boolean }; availableSecretReferences: string[];
}): { allowed: boolean; blockers: string[]; mutationAllowed: false } {
  const blockers: string[] = [];
  try {
    if (input.enabled !== true) blockers.push('PRODUCTION_EXECUTION_DISABLED');
    if (!validProductionIdentity(input.current)) blockers.push('UNKNOWN_ENVIRONMENT_OR_TARGET');
    if (!PRODUCTION_CAPABILITIES.includes(input.capability as typeof PRODUCTION_CAPABILITIES[number])
      || !input.current.capabilities.includes(input.capability)) blockers.push('CAPABILITY_DEFAULT_DENY');
    for (const name of ['DB', 'JOB_QUEUE', 'ASSETS'] as const) if (input.bindings[name] !== true) blockers.push(`MISSING_${name}`);
    if (!Array.isArray(input.availableSecretReferences) || PRODUCTION_SECRET_REFERENCES.some(name => !input.availableSecretReferences.includes(name))) blockers.push('MISSING_SECRET_REFERENCE');
    if (!validateProductionApproval(input.bundle, input.current, input.approval, input.trusted, input.now)) blockers.push('PRODUCTION_APPROVAL_INVALID');
    if (!productionControlsReady(input.controls, input.bundle, input.now)) blockers.push('PRODUCTION_CONTROLS_UNAVAILABLE_OR_STOPPED');
    if (!exactKeys(input.bundle.requirements, [...PRODUCTION_REQUIREMENTS])) blockers.push('PREFLIGHT_REQUIREMENTS_INVALID');
    for (const name of PRODUCTION_REQUIREMENTS) {
      const proof = input.bundle.requirements?.[name];
      if (!proof || !exactKeys(proof, ['state', 'environment', 'targetsFingerprint', 'candidateFingerprint', 'reportFingerprint', 'reference', 'observedAt', 'expiresAt'])
        || proof.state !== 'VERIFIED' || proof.environment !== 'PRODUCTION'
        || proof.targetsFingerprint !== executionFingerprint(input.current.targets) || proof.candidateFingerprint !== input.current.candidateFingerprint
        || !isHash(proof.reportFingerprint) || !validId(proof.reference) || !fresh(proof.observedAt, proof.expiresAt, input.now)) blockers.push(`UNVERIFIED_${name}`);
    }
  } catch { blockers.push('MALFORMED_PRODUCTION_INPUT'); }
  return { allowed: blockers.length === 0, blockers, mutationAllowed: false };
}
