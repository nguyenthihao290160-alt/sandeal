// ===========================================
// Content Storage
// ===========================================

import type { ContentItem } from '../types';
import { readCollection, writeCollection, findById, generateId } from './adapter';

const COLLECTION = 'content';

export async function getAllContent(): Promise<ContentItem[]> {
  return readCollection<ContentItem>(COLLECTION);
}

export async function getContentById(id: string): Promise<ContentItem | null> {
  return findById<ContentItem>(COLLECTION, id);
}

export async function getContentByProductId(productId: string): Promise<ContentItem[]> {
  const items = await readCollection<ContentItem>(COLLECTION);
  return items.filter(c => c.productId === productId);
}

export async function createContent(data: Omit<ContentItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<ContentItem> {
  const items = await readCollection<ContentItem>(COLLECTION);
  const item: ContentItem = {
    ...data,
    id: generateId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  items.push(item);
  await writeCollection(COLLECTION, items);
  return item;
}

export async function updateContent(id: string, updates: Partial<ContentItem>): Promise<ContentItem | null> {
  const items = await readCollection<ContentItem>(COLLECTION);
  const index = items.findIndex(item => item.id === id);
  if (index === -1) return null;
  items[index] = { ...items[index], ...updates, updatedAt: new Date().toISOString() };
  await writeCollection(COLLECTION, items);
  return items[index];
}

export async function getContentStats(): Promise<{
  total: number;
  safe: number;
  needsReview: number;
  blocked: number;
}> {
  const items = await readCollection<ContentItem>(COLLECTION);
  return {
    total: items.length,
    safe: items.filter(c => c.complianceStatus === 'safe').length,
    needsReview: items.filter(c => c.complianceStatus === 'needs_review').length,
    blocked: items.filter(c => c.complianceStatus === 'blocked').length,
  };
}
