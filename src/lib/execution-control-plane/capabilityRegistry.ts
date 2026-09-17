import type { DecisionAction } from '../decision-os/types';
import type { Environment, ExecutionMode, RiskLevel, ApprovalRequirement, RollbackRequirement } from './types';
import type { DomainKillSwitches } from './killSwitch';

export interface ExecutionCapability {
  readonly name: string;
  readonly action: string;
  readonly decisionAction: DecisionAction;
  readonly domain: keyof DomainKillSwitches;
  readonly allowedModes: readonly ExecutionMode[];
  readonly maxRiskLevel: RiskLevel;
  readonly approvalRequirement: ApprovalRequirement;
  readonly rollbackRequirement: RollbackRequirement;
  readonly allowedEnvironments: readonly Environment[];
  readonly requiredBindings: readonly ('D1' | 'QUEUE')[];
  readonly changeWindowRequired: boolean;
  readonly productionMutation: boolean;
}

function capability(name: string, action: string, decisionAction: DecisionAction, domain: keyof DomainKillSwitches,
  risk: RiskLevel, review = false, disabled = false): ExecutionCapability {
  return Object.freeze({ name, action, decisionAction, domain,
    allowedModes: Object.freeze<ExecutionMode[]>(disabled ? [] : ['SHADOW', 'DRY_RUN', 'REVIEW_REQUIRED']),
    maxRiskLevel: risk, approvalRequirement: review ? 'REQUIRED' : 'NOT_REQUIRED',
    rollbackRequirement: review && !disabled ? 'REQUIRED' : disabled ? 'NOT_POSSIBLE' : 'NOT_REQUIRED',
    allowedEnvironments: Object.freeze<Environment[]>(['LOCAL', 'TEST', 'PREVIEW', 'STAGING']),
    requiredBindings: Object.freeze<('D1' | 'QUEUE')[]>(['D1', 'QUEUE']),
    changeWindowRequired: review && !disabled, productionMutation: disabled });
}

const entries = [
  capability('READ_PRODUCT_DATA', 'READ_PRODUCT', 'NO_ACTION', 'CONTENT_EXECUTION_DISABLED', 'READ_ONLY'),
  capability('WRITE_SHADOW_DECISION', 'RECORD_DECISION', 'REQUEST_REEVALUATION', 'CONTENT_EXECUTION_DISABLED', 'LOW'),
  capability('WRITE_SHADOW_LIFECYCLE', 'RECORD_LIFECYCLE', 'MARK_CONTENT_CANDIDATE', 'CONTENT_EXECUTION_DISABLED', 'LOW'),
  capability('PROPOSE_CONTENT_REFRESH', 'REFRESH_CONTENT', 'MARK_CONTENT_CANDIDATE', 'CONTENT_EXECUTION_DISABLED', 'LOW', true),
  capability('PROPOSE_EXPERIMENT', 'PROPOSE_EXPERIMENT', 'MARK_HIGH_PRIORITY', 'EXPERIMENT_EXECUTION_DISABLED', 'MEDIUM', true),
  capability('PROPOSE_DNS_CHANGE', 'PROPOSE_DNS_CHANGE', 'NO_ACTION', 'DNS_DISABLED', 'CRITICAL', true, true),
  capability('PUBLISH_CONTENT', 'PUBLISH_CONTENT', 'NO_ACTION', 'CONTENT_EXECUTION_DISABLED', 'HIGH', true, true),
  capability('CHANGE_DNS', 'CHANGE_DNS', 'NO_ACTION', 'DNS_DISABLED', 'CRITICAL', true, true),
  capability('DEPLOY', 'DEPLOY', 'NO_ACTION', 'DEPLOYMENT_DISABLED', 'CRITICAL', true, true),
  capability('UPDATE_PRODUCTION_SCHEMA', 'UPDATE_PRODUCTION_SCHEMA', 'NO_ACTION', 'DEPLOYMENT_DISABLED', 'CRITICAL', true, true),
  capability('MOVE_REAL_MONEY', 'MOVE_REAL_MONEY', 'NO_ACTION', 'AFFILIATE_WRITE_DISABLED', 'CRITICAL', true, true),
];
export const REGISTRY: Readonly<Record<string, ExecutionCapability>> = Object.freeze(Object.assign(Object.create(null),
  Object.fromEntries(entries.map(entry => [entry.name, entry]))));

export function getCapability(name: string): ExecutionCapability | null {
  return typeof name === 'string' && Object.hasOwn(REGISTRY, name) ? REGISTRY[name] : null;
}
