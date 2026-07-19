import { createHash } from 'node:crypto';
import { classifyRecord, type RecordClassification } from '@/lib/autonomous/recordClassification';
import { appendAutomationAudit } from '@/lib/automation/store';
import { readCollection, runTransaction } from '@/lib/storage/adapter';

const SOURCE_RECORDS = 'candidate-queue';
export type CleanupClassification = 'PRODUCT' | 'VOUCHER' | 'STORE_OFFER' | 'CAMPAIGN' | 'CATEGORY_PAGE' | 'UNKNOWN' | 'INVALID';
type CleanupRecordClassification = Omit<RecordClassification, 'recordType'> & { recordType: RecordClassification['recordType'] | 'INVALID' };

export interface AccessTradeCleanupRecord extends Record<string, unknown> {
  id: string;
  source?: string;
  payload?: Record<string, unknown>;
  classification?: CleanupRecordClassification & { classifiedAt?: string };
  quarantineState?: string;
  rollbackClassification?: CleanupRecordClassification & { classifiedAt?: string };
  cleanupOperationId?: string;
}

export interface AccessTradeCleanupReport {
  scanned: number;
  changedClassification: number;
  quarantined: number;
  unchanged: number;
  blocked: number;
  countsBefore: Record<string, number>;
  countsAfter: Record<string, number>;
  sampleIds: string[];
  nextCursor: string | null;
  dryRun: boolean;
}

function cleanupDecision(record: AccessTradeCleanupRecord): CleanupRecordClassification {
  const input = { ...(record.payload || {}), ...record };
  const classified = classifyRecord(input);
  const hasIdentity = ['title', 'name', 'sourceId', 'itemId', 'productId', 'originalUrl', 'productUrl', 'url']
    .some(key => typeof input[key] === 'string' && String(input[key]).trim());
  if (hasIdentity) return classified;
  return { ...classified, recordType: 'INVALID', confidence: 1, action: 'QUARANTINE', reasons: ['invalid_record_missing_identity'], decisionId: `classification-${createHash('sha256').update(`${classified.decisionId}:INVALID`).digest('hex').slice(0, 24)}` };
}

function cleanupType(record: AccessTradeCleanupRecord): CleanupClassification {
  const classified = cleanupDecision(record);
  if (classified.recordType === 'CATEGORY_OR_LANDING_PAGE') return 'CATEGORY_PAGE';
  return classified.recordType as CleanupClassification;
}

function storedType(record: AccessTradeCleanupRecord): CleanupClassification {
  const type = record.classification?.recordType || 'UNKNOWN';
  return type === 'CATEGORY_OR_LANDING_PAGE' ? 'CATEGORY_PAGE' : type as CleanupClassification;
}

function count(records: AccessTradeCleanupRecord[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const record of records) { const type = cleanupType(record); result[type] = (result[type] || 0) + 1; }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function countStored(records: AccessTradeCleanupRecord[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const record of records) { const type = storedType(record); result[type] = (result[type] || 0) + 1; }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

export async function cleanupAccessTradeRecords(options: { dryRun?: boolean; apply?: boolean; limit?: number; cursor?: string; actor?: string; operationId?: string } = {}): Promise<AccessTradeCleanupReport> {
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit || 100)));
  const all = (await readCollection<AccessTradeCleanupRecord>(SOURCE_RECORDS))
    .filter(item => String(item.source || item.payload?.source || '').toLowerCase() === 'accesstrade')
    .sort((a, b) => a.id.localeCompare(b.id));
  const start = options.cursor ? Math.max(0, all.findIndex(item => item.id === options.cursor) + 1) : 0;
  const records = all.slice(start, start + limit);
  const before = countStored(records);
  const operationId = options.operationId || `accesstrade-cleanup:${createHash('sha256').update(`${options.cursor || 'start'}:${limit}`).digest('hex').slice(0, 24)}`;
  let changedClassification = 0; let quarantined = 0; let unchanged = 0; let blocked = 0;
  const sampleIds: string[] = [];
  const changes = records.map(record => {
    try {
      const decision = cleanupDecision(record);
      const previous = record.classification?.recordType;
      const changed = previous !== decision.recordType || record.classification?.ruleVersion !== decision.ruleVersion;
      if (changed) changedClassification += 1; else unchanged += 1;
      const quarantine = decision.recordType !== 'PRODUCT';
      if (quarantine) quarantined += 1;
      if ((changed || quarantine) && sampleIds.length < 20) sampleIds.push(record.id);
      return { id: record.id, decision, changed, quarantine, previous: record.classification };
    } catch { blocked += 1; return null; }
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const apply = options.apply === true && options.dryRun !== true;
  if (apply) {
    await runTransaction<AccessTradeCleanupRecord>(SOURCE_RECORDS, items => {
      let changed = false;
      for (const update of changes) {
        const record = items.find(item => item.id === update.id);
        if (!record) continue;
        if (record.cleanupOperationId === operationId && record.classification?.decisionId === update.decision.decisionId) continue;
        if (!record.rollbackClassification && record.classification) record.rollbackClassification = structuredClone(record.classification);
        record.classification = { ...update.decision, classifiedAt: new Date().toISOString() };
        if (update.quarantine) record.quarantineState = 'NON_PRODUCT_OFFER';
        record.cleanupOperationId = operationId;
        changed = true;
      }
      return changed ? items : undefined;
    });
    for (const update of changes.filter(item => item.changed)) await appendAutomationAudit({
      correlationId: operationId, operationId: `${operationId}:${update.id}`.slice(0, 160), operationType: 'ACCESSTRADE_CLASSIFICATION_CHANGED',
      actor: options.actor || 'local-cleanup', target: update.id, risk: 'MEDIUM', reasons: update.decision.reasons,
      result: { recordType: update.decision.recordType, ruleVersion: update.decision.ruleVersion, quarantined: update.quarantine }, dryRun: false, attempts: 1,
    });
  }
  const projected = records.map(record => {
    const update = changes.find(item => item.id === record.id);
    return update ? { ...record, classification: { ...update.decision, classifiedAt: new Date().toISOString() } } : record;
  });
  return { scanned: records.length, changedClassification, quarantined, unchanged, blocked, countsBefore: before, countsAfter: count(projected), sampleIds, nextCursor: start + records.length < all.length ? records.at(-1)?.id || null : null, dryRun: !apply };
}
