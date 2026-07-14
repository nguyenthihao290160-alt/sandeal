import { createHash } from 'crypto';
import type { Product } from '@/lib/types';
import { getProductById, saveCanonicalProduct } from '@/lib/storage/products';
import { readCollection, runTransaction } from '@/lib/storage/adapter';
import { PRODUCT_INTELLIGENCE_CONFIG as CONFIG } from './config';
import type { DuplicateCandidate, DuplicateGroup } from './types';

const COLLECTION = 'duplicate-groups';

function text(value: unknown): string {
  return String(value || '').trim().toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function canonicalUrl(value?: string): string {
  try {
    const url = new URL(value || '');
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|aff_|affiliate|tracking|ref|source|campaign)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch { return ''; }
}

function tokenSimilarity(a: string, b: string): number {
  const left = new Set(text(a).split(' ').filter(token => token.length > 1));
  const right = new Set(text(b).split(' ').filter(token => token.length > 1));
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter(token => right.has(token)).length;
  return intersection / (left.size + right.size - intersection);
}

function effectivePrice(product: Product): number | undefined {
  const value = Number(product.salePrice || product.price || 0);
  return value > 0 && Number.isFinite(value) ? value : undefined;
}

function sameText(a: unknown, b: unknown): boolean {
  return Boolean(text(a) && text(a) === text(b));
}

export function compareProducts(a: Product, b: Product): DuplicateCandidate | null {
  const matched: string[] = [];
  const different: string[] = [];
  let confidence = 0;
  const aSourceId = text(a.sourceId || a.externalId);
  const bSourceId = text(b.sourceId || b.externalId);
  if (a.source === b.source && aSourceId && aSourceId === bSourceId) {
    matched.push('source_external_id'); confidence = 1;
  }
  const aUrl = canonicalUrl(a.originalUrl);
  const bUrl = canonicalUrl(b.originalUrl);
  if (aUrl && aUrl === bUrl) { matched.push('canonical_url'); confidence = Math.max(confidence, 0.98); }
  if (a.gtin && b.gtin && sameText(a.gtin, b.gtin)) { matched.push('gtin'); confidence = Math.max(confidence, 0.99); }
  if (a.brand && b.brand && a.sku && b.sku && sameText(a.brand, b.brand) && sameText(a.sku, b.sku)) {
    matched.push('brand_sku'); confidence = Math.max(confidence, 0.96);
  }
  if (a.brand && b.brand && a.mpn && b.mpn && sameText(a.brand, b.brand) && sameText(a.mpn, b.mpn)) {
    matched.push('brand_mpn'); confidence = Math.max(confidence, 0.96);
  }

  const title = tokenSimilarity(a.title, b.title);
  if (title >= 0.55) matched.push(`title_similarity:${title.toFixed(2)}`); else different.push('title');
  const brand = a.brand && b.brand && sameText(a.brand, b.brand) ? 1 : 0;
  if (brand) matched.push('brand'); else if (a.brand && b.brand) different.push('brand');
  const category = a.category && b.category && sameText(a.category, b.category) ? 1 : 0;
  if (category) matched.push('category'); else if (a.category && b.category) different.push('category');
  const priceA = effectivePrice(a); const priceB = effectivePrice(b);
  const price = priceA && priceB ? Math.max(0, 1 - Math.abs(priceA - priceB) / Math.max(priceA, priceB)) : 0;
  if (price >= 0.8) matched.push('similar_price'); else if (priceA && priceB) different.push('price');
  const image = canonicalUrl(a.imageUrl) && canonicalUrl(a.imageUrl) === canonicalUrl(b.imageUrl) ? 1 : 0;
  if (image) matched.push('image_url'); else if (a.imageUrl && b.imageUrl) different.push('image');
  const specKeysA = new Set(Object.keys(a.specifications || {}).map(text));
  const specKeysB = new Set(Object.keys(b.specifications || {}).map(text));
  const sharedSpecs = [...specKeysA].filter(key => specKeysB.has(key)).length;
  const specifications = Math.min(1, sharedSpecs / 3);
  if (sharedSpecs) matched.push('specifications');

  if (confidence < CONFIG.thresholds.duplicateHigh) {
    const fuzzy = title * 0.5 + brand * 0.16 + category * 0.08 + price * 0.1 + image * 0.1 + specifications * 0.06;
    confidence = Math.max(confidence, fuzzy);
  }
  confidence = Math.round(confidence * 1000) / 1000;
  if (confidence < 0.45) return null;
  return {
    productId: b.id,
    confidence,
    matchedSignals: matched,
    differentSignals: different,
    reason: confidence >= CONFIG.thresholds.duplicateHigh
      ? 'Tín hiệu định danh mạnh trùng nhau; nên xem trước hợp nhất.'
      : confidence >= CONFIG.thresholds.duplicateMedium
        ? 'Nhiều thuộc tính gần giống; cần người quản trị xem xét.'
        : 'Tương đồng thấp; không tự hợp nhất.',
  };
}

function primaryProduct(products: Product[]): Product {
  return [...products].sort((a, b) =>
    Number(b.verifiedSource || b.sourceVerified) - Number(a.verifiedSource || a.sourceVerified)
    || Number(b.qualityScore || 0) - Number(a.qualityScore || 0)
    || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

function groupId(ids: string[]): string {
  return `dup-${createHash('sha256').update([...ids].sort().join(':')).digest('hex').slice(0, 16)}`;
}

export async function detectDuplicateGroups(
  products: Product[],
  operationId: string,
  options: { dryRun?: boolean } = {},
): Promise<{ groups: DuplicateGroup[]; compared: number; lowConfidencePairs: number; changed: boolean }> {
  const candidates = products.filter(product => product.status !== 'archived').slice(0, 500);
  const pairs: Array<{ a: Product; b: Product; candidate: DuplicateCandidate }> = [];
  let compared = 0; let lowConfidencePairs = 0;
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      compared += 1;
      const candidate = compareProducts(candidates[left], candidates[right]);
      if (!candidate) continue;
      if (candidate.confidence < CONFIG.thresholds.duplicateMedium) { lowConfidencePairs += 1; continue; }
      pairs.push({ a: candidates[left], b: candidates[right], candidate });
    }
  }
  const parent = new Map(candidates.map(product => [product.id, product.id]));
  const find = (id: string): string => {
    const current = parent.get(id) || id;
    if (current === id) return id;
    const root = find(current); parent.set(id, root); return root;
  };
  const union = (a: string, b: string) => { const left = find(a); const right = find(b); if (left !== right) parent.set(right, left); };
  pairs.forEach(pair => union(pair.a.id, pair.b.id));
  const sets = new Map<string, Product[]>();
  for (const product of candidates) {
    const root = find(product.id);
    sets.set(root, [...(sets.get(root) || []), product]);
  }
  const existing = await readCollection<DuplicateGroup>(COLLECTION);
  const groups = [...sets.values()].filter(set => set.length > 1).map(set => {
    const ids = set.map(product => product.id).sort();
    const id = groupId(ids);
    const primary = primaryProduct(set);
    const groupPairs = pairs.filter(pair => ids.includes(pair.a.id) && ids.includes(pair.b.id));
    const confidence = Math.max(...groupPairs.map(pair => pair.candidate.confidence));
    const previous = existing.find(item => item.id === id);
    return {
      id,
      productIds: ids,
      candidates: set.filter(item => item.id !== primary.id).map(item => {
        const pair = groupPairs.find(entry => entry.a.id === item.id || entry.b.id === item.id)!;
        return { ...pair.candidate, productId: item.id };
      }),
      suggestedPrimaryId: primary.id,
      confidence,
      status: previous?.status || 'pending',
      reason: previous?.reason,
      calculatedAt: new Date().toISOString(),
      algorithmVersion: CONFIG.versions.duplicate,
      operationId,
      mergeHistory: previous?.mergeHistory,
      reviewedAt: previous?.reviewedAt,
      reviewedBy: previous?.reviewedBy,
      reviewHistory: previous?.reviewHistory,
    } satisfies DuplicateGroup;
  });
  if (!options.dryRun) {
    await runTransaction<DuplicateGroup>(COLLECTION, () => groups.slice(-CONFIG.limits.collectionRecords));
    for (const group of groups) {
      for (const productId of group.productIds) {
        await saveCanonicalProduct(productId, { duplicateGroupId: group.id, duplicateConfidence: group.confidence });
      }
    }
  }
  return { groups, compared, lowConfidencePairs, changed: !options.dryRun };
}

export async function listDuplicateGroups(): Promise<DuplicateGroup[]> {
  return (await readCollection<DuplicateGroup>(COLLECTION)).sort((a, b) => b.confidence - a.confidence);
}

export async function previewDuplicateMerge(groupIdValue: string, primaryId: string) {
  const group = (await listDuplicateGroups()).find(item => item.id === groupIdValue);
  if (!group || !group.productIds.includes(primaryId)) throw new Error('DUPLICATE_GROUP_NOT_FOUND');
  const products = (await Promise.all(group.productIds.map(getProductById))).filter((item): item is Product => Boolean(item));
  const primary = products.find(item => item.id === primaryId);
  if (!primary) throw new Error('PRIMARY_PRODUCT_NOT_FOUND');
  const merged: Product = { ...primary };
  const filledFields: string[] = [];
  const conflicts: string[] = [];
  const scalarFields: Array<keyof Product> = ['description', 'imageUrl', 'category', 'brand', 'sku', 'gtin', 'mpn', 'originalUrl', 'affiliateUrl'];
  for (const secondary of products.filter(item => item.id !== primaryId)) {
    for (const field of scalarFields) {
      if (!merged[field] && secondary[field]) {
        (merged as unknown as Record<string, unknown>)[field] = secondary[field]; filledFields.push(String(field));
      } else if (merged[field] && secondary[field] && JSON.stringify(merged[field]) !== JSON.stringify(secondary[field])) conflicts.push(String(field));
    }
    merged.tags = [...new Set([...(merged.tags || []), ...(secondary.tags || [])])];
    merged.benefits = [...new Set([...(merged.benefits || []), ...(secondary.benefits || [])])];
    merged.specifications = { ...(secondary.specifications || {}), ...(merged.specifications || {}) };
  }
  return {
    groupId: group.id,
    primaryId,
    secondaryIds: products.filter(item => item.id !== primaryId).map(item => item.id),
    merged,
    filledFields: [...new Set(filledFields)],
    conflicts: [...new Set(conflicts)],
    businessDataChanged: false,
    requiresApproval: true,
  };
}

export async function applyDuplicateMerge(groupIdValue: string, primaryId: string, operationId: string) {
  const preview = await previewDuplicateMerge(groupIdValue, primaryId);
  const backup = (await Promise.all([primaryId, ...preview.secondaryIds].map(getProductById)))
    .filter((item): item is Product => Boolean(item)).map(item => ({ ...item }));
  await saveCanonicalProduct(primaryId, {
    ...preview.merged,
    id: primaryId,
    duplicateGroupId: groupIdValue,
    duplicateConfidence: 1,
    dataIssues: [...new Set([...(preview.merged.dataIssues || []), 'merged_duplicate_metadata'])],
  });
  for (const id of preview.secondaryIds) {
    await saveCanonicalProduct(id, {
      status: 'archived', publicHidden: true, autoPublished: false, needsVerification: true,
      archivedReason: `duplicate_merged_into:${primaryId}`, duplicateGroupId: groupIdValue,
    });
  }
  await runTransaction<DuplicateGroup>(COLLECTION, groups => {
    const group = groups.find(item => item.id === groupIdValue);
    if (!group) throw new Error('DUPLICATE_GROUP_NOT_FOUND');
    group.status = 'merged'; group.suggestedPrimaryId = primaryId; group.operationId = operationId;
    group.mergeHistory = [...(group.mergeHistory || []), {
      operationId, primaryId, secondaryIds: preview.secondaryIds, metadataBackup: backup,
      mergedAt: new Date().toISOString(),
    }].slice(-20);
    return groups;
  });
  return { groupId: groupIdValue, primaryId, archived: preview.secondaryIds.length, operationId };
}

export async function restoreDuplicateMerge(groupIdValue: string, operationId: string): Promise<boolean> {
  const group = (await listDuplicateGroups()).find(item => item.id === groupIdValue);
  const history = group?.mergeHistory?.find(item => item.operationId === operationId);
  if (!group || !history) return false;
  for (const backup of history.metadataBackup) await saveCanonicalProduct(backup.id, backup);
  await runTransaction<DuplicateGroup>(COLLECTION, groups => {
    const current = groups.find(item => item.id === groupIdValue);
    if (current) { current.status = 'pending'; current.reason = `restored:${operationId}`; }
    return groups;
  });
  return true;
}

export async function reviewDuplicateGroup(
  id: string,
  status: 'kept_separate' | 'ignored',
  reason: string,
  context: { operationId: string; actor: string },
): Promise<DuplicateGroup | null> {
  const cleanReason = reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  const operationId = context.operationId.trim().slice(0, 160);
  const actor = context.actor.trim().slice(0, 120);
  if (cleanReason.length < 5) throw new Error('REASON_REQUIRED');
  if (!operationId || !actor) throw new Error('OPERATION_CONTEXT_REQUIRED');
  let updated: DuplicateGroup | null = null;
  await runTransaction<DuplicateGroup>(COLLECTION, groups => {
    const group = groups.find(item => item.id === id);
    if (!group) return undefined;
    const reviewedAt = new Date().toISOString();
    group.status = status;
    group.reason = cleanReason;
    group.operationId = operationId;
    group.reviewedAt = reviewedAt;
    group.reviewedBy = actor;
    group.reviewHistory = [...(group.reviewHistory || []), {
      operationId,
      status,
      reason: cleanReason,
      actor,
      reviewedAt,
    }].slice(-20);
    updated = { ...group };
    return groups;
  });
  return updated;
}
