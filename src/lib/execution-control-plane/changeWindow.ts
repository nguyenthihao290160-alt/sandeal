import { validId } from './fingerprint';
import type { ChangeWindow, ExecutionProposal } from './types';

export function validChangeWindow(proposal: ExecutionProposal, window: ChangeWindow | null, now: number): boolean {
  return !!window && validId(window.id) && window.id === proposal.changeWindowId && window.environment === proposal.environment
    && window.status === 'OPEN' && Array.isArray(window.capabilities) && window.capabilities.length <= 20
    && window.capabilities.includes(proposal.capability) && Number.isSafeInteger(window.startsAt) && Number.isSafeInteger(window.endsAt)
    && window.startsAt <= now && now < window.endsAt && window.endsAt - window.startsAt <= 86_400_000;
}
