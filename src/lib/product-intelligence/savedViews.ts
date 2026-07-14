import { generateId, readCollection, runTransaction } from '@/lib/storage/adapter';
import { PRODUCT_INTELLIGENCE_CONFIG as CONFIG } from './config';
import type { SavedView } from './types';

const COLLECTION = 'saved-views';
const FILTERS: Record<SavedView['page'], Set<string>> = {
  products: new Set(['q', 'platform', 'source', 'status', 'qualityBand', 'opportunityBand', 'dealBand', 'hasImage']),
  quality: new Set(['q', 'qualityBand', 'hasBlocker', 'hasIssue']),
  duplicates: new Set(['status', 'confidence']),
  content: new Set(['q', 'status', 'opportunityBand', 'assignee']),
  tasks: new Set(['status', 'type', 'riskLevel']),
  alerts: new Set(['status', 'type', 'severity']),
};

function validate(input: Partial<SavedView>): Omit<SavedView, 'id' | 'createdAt' | 'updatedAt'> {
  if (!input.page || !FILTERS[input.page]) throw new Error('INVALID_PAGE');
  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 80) throw new Error('INVALID_NAME');
  const rawFilters = input.filters && typeof input.filters === 'object' && !Array.isArray(input.filters) ? input.filters : {};
  if (Object.keys(rawFilters).length > 20 || Object.keys(rawFilters).some(key => !FILTERS[input.page!].has(key))) throw new Error('INVALID_FILTER');
  const filters = Object.fromEntries(Object.entries(rawFilters).map(([key, value]) => {
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error('INVALID_FILTER');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('INVALID_FILTER');
    return [key, typeof value === 'string' ? value.trim().slice(0, 200) : value];
  }));
  const columns = Array.isArray(input.columns) ? input.columns.map(String).map(value => value.slice(0, 80)).slice(0, 30) : [];
  const viewMode = input.viewMode && ['list', 'table', 'kanban', 'calendar'].includes(input.viewMode) ? input.viewMode : 'table';
  return {
    name, page: input.page, filters, sort: typeof input.sort === 'string' ? input.sort.slice(0, 80) : undefined,
    columns, viewMode, createdBy: String(input.createdBy || 'dashboard-admin').slice(0, 120), isDefault: input.isDefault === true,
  };
}

export async function listSavedViews(page?: SavedView['page'], createdBy?: string): Promise<SavedView[]> {
  const items = await readCollection<SavedView>(COLLECTION);
  return items
    .filter(item => (!page || item.page === page) && (!createdBy || item.createdBy === createdBy))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

export async function createSavedView(input: Partial<SavedView>): Promise<SavedView> {
  const valid = validate(input); const now = new Date().toISOString();
  const item: SavedView = { ...valid, id: generateId(), createdAt: now, updatedAt: now };
  await runTransaction<SavedView>(COLLECTION, items => {
    if (item.isDefault) items.forEach(current => { if (current.page === item.page && current.createdBy === item.createdBy) current.isDefault = false; });
    return [...items, item].slice(-CONFIG.limits.savedViews);
  });
  return item;
}

export async function updateSavedView(id: string, input: Partial<SavedView>, createdBy?: string): Promise<SavedView | null> {
  let output: SavedView | null = null;
  await runTransaction<SavedView>(COLLECTION, items => {
    const index = items.findIndex(item => item.id === id && (!createdBy || item.createdBy === createdBy)); if (index < 0) return undefined;
    const current = items[index];
    const valid = validate({ ...current, ...input, page: current.page, createdBy: current.createdBy });
    if (valid.isDefault) items.forEach(current => { if (current.id !== id && current.page === valid.page && current.createdBy === valid.createdBy) current.isDefault = false; });
    items[index] = { ...items[index], ...valid, id, updatedAt: new Date().toISOString() }; output = { ...items[index] }; return items;
  });
  return output;
}

export async function deleteSavedView(id: string, createdBy?: string): Promise<boolean> {
  let deleted = false;
  await runTransaction<SavedView>(COLLECTION, items => {
    const next = items.filter(item => item.id !== id || (createdBy !== undefined && item.createdBy !== createdBy));
    deleted = next.length !== items.length;
    return deleted ? next : undefined;
  });
  return deleted;
}
