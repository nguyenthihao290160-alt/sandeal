// ===========================================
// Content Package Storage
// ===========================================

import type { ContentPackage, ComplianceStatus } from '../types';
import { readCollection, writeCollection, findById, updateOne, insertOne, generateId } from './adapter';

const COLLECTION = 'content-packages';

export async function createContentPackage(
  productId: string,
  data: Omit<ContentPackage, 'id' | 'generatedAt'>
): Promise<ContentPackage> {
  const pkg: ContentPackage = {
    ...data,
    id: generateId(),
    generatedAt: new Date().toISOString(),
  };
  return insertOne<ContentPackage>(COLLECTION, pkg);
}

export async function getContentPackageById(id: string): Promise<ContentPackage | null> {
  return findById<ContentPackage>(COLLECTION, id);
}

export async function getContentPackageByProductId(productId: string): Promise<ContentPackage | null> {
  const packages = await readCollection<ContentPackage>(COLLECTION);
  return packages.find(p => p.productId === productId) ?? null;
}

export async function listContentPackages(limit = 100): Promise<ContentPackage[]> {
  const packages = await readCollection<ContentPackage>(COLLECTION);
  return packages.slice(-limit).reverse(); // Most recent first
}

export async function updateContentPackage(
  id: string,
  updates: Partial<Omit<ContentPackage, 'id' | 'productId' | 'generatedAt'>>
): Promise<ContentPackage | null> {
  return updateOne<ContentPackage>(COLLECTION, id, updates);
}

export async function deleteContentPackage(id: string): Promise<boolean> {
  const packages = await readCollection<ContentPackage>(COLLECTION);
  const filtered = packages.filter(p => p.id !== id);
  if (filtered.length === packages.length) return false;
  await writeCollection(COLLECTION, filtered);
  return true;
}

export async function getContentPackageStats(): Promise<{
  totalPackages: number;
  safePackages: number;
  needsEditPackages: number;
  blockedPackages: number;
  lastGeneratedAt?: string;
}> {
  const packages = await readCollection<ContentPackage>(COLLECTION);
  const safe = packages.filter(p => p.complianceStatus === 'safe').length;
  const needsEdit = packages.filter(p => p.complianceStatus === 'needs_edit').length;
  const blocked = packages.filter(p => p.complianceStatus === 'blocked').length;
  const lastPkg = packages.length > 0 ? packages[packages.length - 1].generatedAt : undefined;

  return {
    totalPackages: packages.length,
    safePackages: safe,
    needsEditPackages: needsEdit,
    blockedPackages: blocked,
    lastGeneratedAt: lastPkg,
  };
}
