// ===========================================
// Link Health Storage
// ===========================================

import type { LinkHealthCheck, LinkHealthStatus } from '../types';
import { readCollection, writeCollection, findById, updateOne, insertOne, generateId } from './adapter';

const COLLECTION = 'link-health';

export async function createLinkHealthCheck(
  productId: string,
  productUrlStatus: LinkHealthStatus,
  productUrlHttpCode?: number
): Promise<LinkHealthCheck> {
  const check: LinkHealthCheck = {
    id: `link-${productId}-${Date.now()}`,
    productId,
    productUrlStatus,
    productUrlHttpCode,
    checkedAt: new Date().toISOString(),
    failureCount: productUrlStatus === 'ok' || productUrlStatus === 'redirect_ok' ? 0 : 1,
  };
  return insertOne<LinkHealthCheck>(COLLECTION, check);
}

export async function getLinkHealthByProductId(productId: string): Promise<LinkHealthCheck | null> {
  const checks = await readCollection<LinkHealthCheck>(COLLECTION);
  return checks.find(c => c.productId === productId) ?? null;
}

export async function updateLinkHealth(
  productId: string,
  updates: Partial<Omit<LinkHealthCheck, 'productId'>>
): Promise<LinkHealthCheck | null> {
  const checks = await readCollection<LinkHealthCheck>(COLLECTION);
  const existing = checks.find(c => c.productId === productId);

  if (!existing) {
    return null;
  }

  const index = checks.findIndex(c => c.productId === productId);
  checks[index] = {
    ...checks[index],
    ...updates,
  };
  await writeCollection(COLLECTION, checks);
  return checks[index];
}

export async function incrementLinkFailureCount(productId: string, reason: string): Promise<LinkHealthCheck | null> {
  const check = await getLinkHealthByProductId(productId);
  if (!check) return null;

  check.failureCount = (check.failureCount || 0) + 1;
  check.lastFailureReason = reason;
  check.checkedAt = new Date().toISOString();

  const checks = await readCollection<LinkHealthCheck>(COLLECTION);
  const index = checks.findIndex(c => c.productId === productId);
  if (index === -1) return null;

  checks[index] = check;
  await writeCollection(COLLECTION, checks);
  return check;
}

export async function getBrokenLinks(
  threshold = 2 // Failure count threshold
): Promise<LinkHealthCheck[]> {
  const checks = await readCollection<LinkHealthCheck>(COLLECTION);
  return checks.filter(c => c.failureCount >= threshold);
}

export async function getLinkHealthStats(): Promise<{
  totalChecked: number;
  healthy: number;
  broken: number;
  needsReview: number;
  lastCheckedAt?: string;
}> {
  const checks = await readCollection<LinkHealthCheck>(COLLECTION);

  const healthy = checks.filter(
    c => c.productUrlStatus === 'ok' || c.productUrlStatus === 'redirect_ok'
  ).length;
  const needsReview = checks.filter(c => c.productUrlStatus === 'needs_manual_check').length;
  const broken = checks.filter(
    c =>
      c.productUrlStatus === 'not_found' ||
      c.productUrlStatus === 'server_error' ||
      c.productUrlStatus === 'timeout'
  ).length;

  const lastCheck = checks.length > 0 ? checks[checks.length - 1].checkedAt : undefined;

  return {
    totalChecked: checks.length,
    healthy,
    broken,
    needsReview,
    lastCheckedAt: lastCheck,
  };
}
