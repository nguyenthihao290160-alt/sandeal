import { executionFingerprint, validId } from './fingerprint';
import type { PreflightContext } from './preflightValidator';
import { executeDryRun } from './dryRunExecutor';
import type { Environment } from './types';

export interface ReleaseBundleInput {
  id: string;
  environment: Environment;
  members: { context: PreflightContext; dependsOn: string[] }[];
}
export function planReleaseBundle(input: ReleaseBundleInput) {
  if (!validId(input.id) || !['LOCAL', 'TEST'].includes(input.environment) || !Array.isArray(input.members)
    || input.members.length === 0 || input.members.length > 20) throw new Error('EXECUTION_BUNDLE_INVALID');
  const members = new Map(input.members.map(member => [member.context.proposal.id, member]));
  if (members.size !== input.members.length) throw new Error('EXECUTION_BUNDLE_DUPLICATE');
  const visiting = new Set<string>(), visited = new Set<string>(), order: string[] = [];
  function visit(id: string) {
    if (visiting.has(id)) throw new Error('EXECUTION_BUNDLE_CYCLE');
    if (visited.has(id)) return;
    const member = members.get(id);
    if (!member || !validId(id) || member.context.proposal.environment !== input.environment || member.context.currentEnvironment !== input.environment
      || !Array.isArray(member.dependsOn) || member.dependsOn.length > 20 || new Set(member.dependsOn).size !== member.dependsOn.length) throw new Error('EXECUTION_BUNDLE_DEPENDENCY');
    visiting.add(id);
    for (const dependency of [...member.dependsOn].sort()) visit(dependency);
    visiting.delete(id); visited.add(id); order.push(id);
  }
  for (const id of [...members.keys()].sort()) visit(id);
  const states = order.map(id => {
    const { receipt } = executeDryRun(members.get(id)!.context);
    return { proposalId: id, preflight: receipt.preflightResult, rollbackAvailable: receipt.rollbackAvailable };
  });
  const recoverable = states.filter(state => state.rollbackAvailable).length;
  const rollbackCoverage = recoverable === states.length ? 'FULL' : recoverable > 0 ? 'PARTIAL' : 'NONE';
  return { id: input.id, environment: input.environment, order, states, rollbackCoverage,
    preflightState: states.every(state => state.preflight === 'PASS') ? 'PASS' : 'BLOCKED',
    semanticKey: executionFingerprint({ environment: input.environment, members: order.map(id => ({ proposal: members.get(id)!.context.proposal,
      dependsOn: [...members.get(id)!.dependsOn].sort() })) }), dryRunOnly: true };
}
