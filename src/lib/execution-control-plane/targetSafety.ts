import { validId } from './fingerprint';
import { validateExternalUrl } from '../product-intelligence/urlValidation';
import type { ExecutionProposal, ExecutionTarget } from './types';

export function safeExecutionUrl(value: string, allowedHosts: readonly string[]): boolean {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|2f|5c|2e)/i.test(value)) return false;
  if (/^\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\/?$/.test(value)) return true;
  try {
    const url = new URL(value);
    return validateExternalUrl(value).safe && url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && !url.search
      && /^[a-z][a-z0-9.-]*\.[a-z]{2,}$/.test(url.hostname) && !url.hostname.endsWith('.')
      && !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)
      && allowedHosts.includes(url.hostname) && url.href === value;
  } catch { return false; }
}
export function validTarget(proposal: ExecutionProposal, target: ExecutionTarget | null, allowedHosts: readonly string[]): boolean {
  return !!target && validId(target.id) && validId(target.version) && validId(target.policyProductId)
    && target.id === proposal.targetEntityId && target.environment === proposal.environment && target.url === proposal.targetUrl
    && (target.url === null || safeExecutionUrl(target.url, allowedHosts))
    && [null, 'accesstrade'].includes(target.provider) && [null, 'shopee', 'tiktok'].includes(target.platform)
    && (target.platform === null || target.provider === 'accesstrade');
}
