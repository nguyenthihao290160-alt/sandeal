import { createHash } from 'node:crypto';
import { domainJson } from '../storage/domainSerialization';
import type { ExecutionProposal } from './types';

export function executionFingerprint(value: unknown): string {
  function canonical(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item && typeof item === 'object') return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`).join(',')}}`;
    return JSON.stringify(item);
  }
  return createHash('sha256').update(canonical(domainJson(value))).digest('hex');
}
export function proposalFingerprint(proposal: ExecutionProposal): string { return executionFingerprint(proposal); }
export function proposalSemanticKey(proposal: ExecutionProposal): string {
  const material = { ...proposal, id: null, requestedAt: null, expiresAt: null, status: null };
  return executionFingerprint(material);
}
export function executionId(proposal: ExecutionProposal): string { return `exec-${proposalFingerprint(proposal)}`; }
export function validId(value: unknown): value is string { return typeof value === 'string' && /^[a-z0-9][a-z0-9:_-]{0,159}$/i.test(value); }
