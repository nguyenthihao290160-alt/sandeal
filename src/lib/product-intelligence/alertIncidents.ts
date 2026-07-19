import { createHash } from 'node:crypto';
import { appendAutomationAudit, createAutomationJob } from '@/lib/automation/store';
import { generateId, readCollection, runTransaction } from '@/lib/storage/adapter';
import type { ProductAlert } from './types';

const INCIDENTS = 'alert-incidents';
const OCCURRENCES = 'alert-occurrences';
const REMEDIATIONS = 'alert-remediation-runs';
const SECRET_KEY = /token|secret|password|cookie|authorization|api[_-]?key|credential|mongodb/i;

export type AlertIncidentStatus = 'NEW' | 'ACKNOWLEDGED' | 'REMEDIATION_QUEUED' | 'REMEDIATION_RUNNING' | 'RECHECK_REQUIRED' | 'RESOLVED' | 'HUMAN_DECISION_REQUIRED' | 'IGNORED' | 'EXHAUSTED';
export type AlertEvidenceResult = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface AlertOccurrence {
  id: string;
  incidentId: string;
  sourceAlertId: string;
  entityType: string;
  entityId: string;
  reasonCode: string;
  active: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  clearedAt: string | null;
}

export interface RemediationEvidence {
  checker: string;
  checkerVersion: string;
  checkedAt: string;
  result: AlertEvidenceResult;
  affectedCountBefore: number;
  affectedCountAfter: number;
  sampleEntityIds: string[];
  metadata: Record<string, unknown>;
}

export interface AlertIncident {
  id: string;
  rootCauseKey: string;
  category: string;
  severity: string;
  status: AlertIncidentStatus;
  affectedEntityType: string;
  affectedEntityIds: string[];
  affectedCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastCheckedAt: string | null;
  nextEligibleRemediationAt: string | null;
  remediationAttemptCount: number;
  maxRemediationAttempts: number;
  humanDecisionRequired: boolean;
  autoRemediationAllowed: boolean;
  evidenceStatus: 'NONE' | 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  evidence: RemediationEvidence | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  ignoredReason: string | null;
  assignedTo: string | null;
  idempotencyKey: string;
  updatedAt: string;
}

export interface AlertRootCause {
  category: string;
  reasonCode: string;
  provider: string;
  failureClass: string;
  rootCauseKey: string;
  autoRemediationAllowed: boolean;
  humanDecisionRequired: boolean;
  maxAttempts: number;
}

const ROOT_CAUSE_BY_TYPE: Record<string, { category: string; failure: string; auto: boolean; human?: boolean; max?: number }> = {
  broken_affiliate_link: { category: 'affiliate_link_invalid', failure: 'invalid_or_broken', auto: true },
  broken_link: { category: 'affiliate_link_unreachable', failure: 'unreachable', auto: true },
  broken_image: { category: 'image_unreachable', failure: 'unreachable', auto: true },
  image_missing: { category: 'image_missing', failure: 'missing', auto: false, human: true, max: 0 },
  stale_price: { category: 'price_missing', failure: 'stale_or_missing', auto: true },
  low_quality: { category: 'needs_data', failure: 'quality_data_missing', auto: false, human: true, max: 0 },
  low_originality: { category: 'low_originality', failure: 'editorial_originality', auto: false, human: true, max: 0 },
  low_seo_readiness: { category: 'low_seo_readiness', failure: 'seo_readiness', auto: false, human: true, max: 0 },
  worker_stale: { category: 'stale_job', failure: 'worker_heartbeat_stale', auto: false, human: true, max: 0 },
  stale_job: { category: 'stale_job', failure: 'expired_job_lease', auto: true },
  scheduler_stale: { category: 'scheduler_state_inconsistent', failure: 'scheduler_runtime_stale', auto: false, human: true, max: 0 },
  circuit_open: { category: 'provider_not_ready', failure: 'provider_circuit_open', auto: false, human: true, max: 0 },
  credential_missing: { category: 'credential_not_generation_ready', failure: 'credential_not_ready', auto: false, human: true, max: 0 },
  public_recheck: { category: 'lifecycle_blocked', failure: 'public_evidence_stale', auto: true },
  duplicate_product: { category: 'duplicate_source_record', failure: 'deterministic_duplicate_candidate', auto: false, human: true, max: 0 },
  access_trade_non_product_offer: { category: 'access_trade_non_product_offer', failure: 'non_product_classification', auto: true },
};

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 120) || 'unknown';
}

function providerOf(alert: ProductAlert): string {
  if (alert.entityType === 'credential' || alert.entityType === 'circuit' || alert.entityType === 'source') return normalized(alert.entityId || 'unknown');
  return alert.type.includes('affiliate') ? 'affiliate' : 'local';
}

export function deriveAlertRootCause(alert: ProductAlert): AlertRootCause {
  const mapped = ROOT_CAUSE_BY_TYPE[alert.type] || { category: normalized(alert.type), failure: normalized(alert.type), auto: false, human: true, max: 0 };
  const provider = providerOf(alert);
  const reasonCode = normalized(alert.type);
  const rootCauseKey = [mapped.category, reasonCode, provider, mapped.failure].map(normalized).join(':');
  return {
    category: mapped.category,
    reasonCode,
    provider,
    failureClass: mapped.failure,
    rootCauseKey,
    autoRemediationAllowed: mapped.auto,
    humanDecisionRequired: mapped.human === true,
    maxAttempts: mapped.max ?? 3,
  };
}

function incidentId(rootCauseKey: string): string {
  return `incident-${createHash('sha256').update(rootCauseKey).digest('hex').slice(0, 24)}`;
}

function occurrenceEntityIds(alert: ProductAlert): string[] {
  const ids = [...(alert.relatedEntityIds || []), ...(alert.entityId ? [alert.entityId] : [])]
    .map(String).map(item => item.trim()).filter(Boolean);
  return [...new Set(ids.length ? ids : [alert.id])].slice(0, 2_000);
}

export function groupAlertsIntoIncidents(alerts: ProductAlert[], now = Date.now()): { incidents: AlertIncident[]; occurrences: AlertOccurrence[] } {
  const nowIso = new Date(now).toISOString();
  const groups = new Map<string, { root: AlertRootCause; alerts: ProductAlert[] }>();
  for (const item of alerts.filter(alert => !['resolved', 'ignored'].includes(alert.status))) {
    const root = deriveAlertRootCause(item);
    const group = groups.get(root.rootCauseKey) || { root, alerts: [] };
    group.alerts.push(item);
    groups.set(root.rootCauseKey, group);
  }
  const occurrences: AlertOccurrence[] = [];
  const incidents = [...groups.values()].map(({ root, alerts: grouped }) => {
    const id = incidentId(root.rootCauseKey);
    for (const source of grouped) for (const entityId of occurrenceEntityIds(source)) occurrences.push({
      id: `occ-${createHash('sha256').update(`${id}:${source.id}:${entityId}`).digest('hex').slice(0, 24)}`,
      incidentId: id, sourceAlertId: source.id, entityType: source.entityType, entityId,
      reasonCode: root.reasonCode, active: true, firstSeenAt: source.firstSeenAt || source.createdAt,
      lastSeenAt: source.lastSeenAt || source.updatedAt, clearedAt: null,
    });
    const entityIds = [...new Set(occurrences.filter(item => item.incidentId === id).map(item => item.entityId))];
    const firstSeenAt = grouped.map(item => item.firstSeenAt || item.createdAt).sort()[0] || nowIso;
    const lastSeenAt = grouped.map(item => item.lastSeenAt || item.updatedAt).sort().at(-1) || nowIso;
    const severityRank: Record<string, number> = { info: 0, attention: 1, important: 2, critical: 3 };
    const severity = [...grouped].sort((a, b) => (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0))[0]?.severity || 'attention';
    return {
      id, rootCauseKey: root.rootCauseKey, category: root.category, severity,
      status: root.humanDecisionRequired ? 'HUMAN_DECISION_REQUIRED' as const : 'NEW' as const,
      affectedEntityType: grouped[0]?.entityType || 'unknown', affectedEntityIds: entityIds.slice(0, 2_000), affectedCount: entityIds.length,
      firstSeenAt, lastSeenAt, lastCheckedAt: null, nextEligibleRemediationAt: null,
      remediationAttemptCount: 0, maxRemediationAttempts: root.maxAttempts,
      humanDecisionRequired: root.humanDecisionRequired, autoRemediationAllowed: root.autoRemediationAllowed,
      evidenceStatus: 'NONE' as const, evidence: null, resolvedAt: null, resolutionReason: null,
      ignoredReason: null, assignedTo: null, idempotencyKey: `remediate:${id}`, updatedAt: nowIso,
    };
  }).sort((a, b) => b.severity.localeCompare(a.severity) || b.affectedCount - a.affectedCount || a.rootCauseKey.localeCompare(b.rootCauseKey));
  return { incidents, occurrences };
}

export async function synchronizeAlertIncidents(now = Date.now()): Promise<{ incidents: number; occurrences: number; reopened: number }> {
  const alerts = await readCollection<ProductAlert>('product-alerts');
  const grouped = groupAlertsIntoIncidents(alerts, now);
  const nowIso = new Date(now).toISOString();
  let reopened = 0;
  await runTransaction<AlertOccurrence>(OCCURRENCES, stored => {
    const activeIds = new Set(grouped.occurrences.map(item => item.id));
    for (const item of stored) if (item.active && !activeIds.has(item.id)) { item.active = false; item.clearedAt = nowIso; }
    for (const next of grouped.occurrences) {
      const current = stored.find(item => item.id === next.id);
      if (current) Object.assign(current, next, { firstSeenAt: current.firstSeenAt }); else stored.push(next);
    }
    return stored;
  });
  await runTransaction<AlertIncident>(INCIDENTS, stored => {
    const activeIncidentIds = new Set(grouped.incidents.map(item => item.id));
    for (const incoming of grouped.incidents) {
      const current = stored.find(item => item.id === incoming.id);
      if (!current) { stored.push(incoming); continue; }
      if (current.status === 'RESOLVED') reopened += 1;
      const preserveStatus = ['ACKNOWLEDGED', 'REMEDIATION_QUEUED', 'REMEDIATION_RUNNING', 'RECHECK_REQUIRED'].includes(current.status);
      Object.assign(current, incoming, {
        firstSeenAt: current.firstSeenAt,
        remediationAttemptCount: current.remediationAttemptCount,
        nextEligibleRemediationAt: current.nextEligibleRemediationAt,
        lastCheckedAt: current.lastCheckedAt,
        evidence: current.evidence,
        evidenceStatus: current.evidenceStatus,
        status: current.status === 'RESOLVED' ? (incoming.humanDecisionRequired ? 'HUMAN_DECISION_REQUIRED' : 'NEW') : preserveStatus ? current.status : incoming.status,
        resolvedAt: null,
        resolutionReason: null,
      });
    }
    for (const current of stored) {
      if (activeIncidentIds.has(current.id) || ['RESOLVED', 'IGNORED'].includes(current.status)) continue;
      current.status = 'RECHECK_REQUIRED';
      current.affectedEntityIds = [];
      current.affectedCount = 0;
      current.updatedAt = nowIso;
    }
    return stored;
  });
  return { incidents: grouped.incidents.length, occurrences: grouped.occurrences.length, reopened };
}

export async function listAlertIncidents(options: { status?: AlertIncidentStatus; page?: number; pageSize?: number } = {}) {
  let items = await readCollection<AlertIncident>(INCIDENTS);
  if (options.status) items = items.filter(item => item.status === options.status);
  items.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) || a.id.localeCompare(b.id));
  const pageSize = Math.max(1, Math.min(50, options.pageSize || 20));
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.max(1, Math.min(totalPages, options.page || 1));
  return { items: items.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, totalItems, totalPages } };
}

export async function getAlertIncidentSummary() {
  const active = (await readCollection<AlertIncident>(INCIDENTS)).filter(item => !['RESOLVED', 'IGNORED'].includes(item.status));
  return {
    active: active.length,
    critical: active.filter(item => item.severity === 'critical').length,
    humanDecision: active.filter(item => item.humanDecisionRequired).length,
    autoFixable: active.filter(item => item.autoRemediationAllowed && !item.humanDecisionRequired).length,
  };
}

export async function getAlertIncident(incidentIdValue: string): Promise<AlertIncident | null> {
  return (await readCollection<AlertIncident>(INCIDENTS)).find(item => item.id === incidentIdValue) || null;
}

export async function listIncidentOccurrences(incidentIdValue: string, page = 1, pageSize = 25) {
  const bounded = Math.max(1, Math.min(50, pageSize));
  const items = (await readCollection<AlertOccurrence>(OCCURRENCES)).filter(item => item.incidentId === incidentIdValue)
    .sort((a, b) => Number(b.active) - Number(a.active) || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  return { items: items.slice((Math.max(1, page) - 1) * bounded, Math.max(1, page) * bounded), totalItems: items.length, page: Math.max(1, page), pageSize: bounded };
}

function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 300);
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeMetadata(item, depth + 1));
  if (!value || typeof value !== 'object') return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    if (!SECRET_KEY.test(key)) output[key] = sanitizeMetadata(item, depth + 1);
  }
  return output;
}

export function safeRemediationEvidence(input: RemediationEvidence): RemediationEvidence {
  return { ...input, checker: input.checker.slice(0, 100), checkerVersion: input.checkerVersion.slice(0, 80), sampleEntityIds: input.sampleEntityIds.map(String).slice(0, 20), metadata: sanitizeMetadata(input.metadata) as Record<string, unknown> };
}

export async function recordIncidentRecheck(incidentIdValue: string, evidenceInput: RemediationEvidence): Promise<AlertIncident> {
  const sanitized = safeRemediationEvidence(evidenceInput);
  if (!Number.isFinite(Date.parse(sanitized.checkedAt)) || !sanitized.checker || !sanitized.checkerVersion) throw new Error('INVALID_RECHECK_EVIDENCE');
  const activeOccurrenceCount = (await readCollection<AlertOccurrence>(OCCURRENCES))
    .filter(item => item.incidentId === incidentIdValue && item.active).length;
  const evidence: RemediationEvidence = sanitized.affectedCountAfter === activeOccurrenceCount
    ? sanitized
    : { ...sanitized, result: 'INCONCLUSIVE', affectedCountAfter: activeOccurrenceCount, metadata: { ...sanitized.metadata, occurrenceCountMismatch: true } };
  let output: AlertIncident | null = null;
  await runTransaction<AlertIncident>(INCIDENTS, items => {
    const incident = items.find(item => item.id === incidentIdValue);
    if (!incident) throw new Error('INCIDENT_NOT_FOUND');
    incident.lastCheckedAt = evidence.checkedAt;
    incident.evidence = evidence;
    incident.evidenceStatus = evidence.result;
    incident.affectedCount = evidence.affectedCountAfter;
    if (evidence.result === 'PASS' && evidence.affectedCountAfter === 0 && activeOccurrenceCount === 0) {
      incident.status = 'RESOLVED'; incident.resolvedAt = evidence.checkedAt; incident.resolutionReason = 'RECHECK_PASS_ZERO_ACTIVE_OCCURRENCES'; incident.affectedEntityIds = [];
    } else {
      incident.status = incident.remediationAttemptCount >= incident.maxRemediationAttempts && incident.autoRemediationAllowed ? 'EXHAUSTED'
        : incident.humanDecisionRequired ? 'HUMAN_DECISION_REQUIRED' : 'RECHECK_REQUIRED';
      incident.resolvedAt = null; incident.resolutionReason = null;
    }
    incident.updatedAt = evidence.checkedAt;
    output = structuredClone(incident);
    return items;
  });
  return output!;
}

export async function recordServerIncidentRecheck(input: {
  incidentId: string;
  checker: string;
  checkerVersion: string;
  checkedAt?: string;
  affectedCountBefore: number;
  metadata?: Record<string, unknown>;
}): Promise<AlertIncident> {
  const active = (await readCollection<AlertOccurrence>(OCCURRENCES))
    .filter(item => item.incidentId === input.incidentId && item.active);
  return recordIncidentRecheck(input.incidentId, {
    checker: input.checker,
    checkerVersion: input.checkerVersion,
    checkedAt: input.checkedAt || new Date().toISOString(),
    result: active.length === 0 ? 'PASS' : 'FAIL',
    affectedCountBefore: Math.max(0, input.affectedCountBefore),
    affectedCountAfter: active.length,
    sampleEntityIds: active.map(item => item.entityId).slice(0, 20),
    metadata: input.metadata || {},
  });
}

export async function updateIncidentStatus(input: { ids: string[]; action: 'acknowledge' | 'assign' | 'ignore'; actor: string; reason?: string; assignee?: string; operationId?: string }) {
  const ids = [...new Set(input.ids)].slice(0, 100);
  if (!ids.length) throw new Error('INCIDENT_ID_REQUIRED');
  if (input.action === 'ignore' && (!input.reason || input.reason.trim().length < 5)) throw new Error('REASON_REQUIRED');
  const now = new Date().toISOString();
  const changed: AlertIncident[] = [];
  await runTransaction<AlertIncident>(INCIDENTS, items => {
    for (const incident of items.filter(item => ids.includes(item.id))) {
      if (input.action === 'acknowledge' && incident.status === 'NEW') incident.status = 'ACKNOWLEDGED';
      if (input.action === 'assign') incident.assignedTo = (input.assignee || '').trim().slice(0, 120) || null;
      if (input.action === 'ignore') { incident.status = 'IGNORED'; incident.ignoredReason = input.reason!.trim().slice(0, 500); }
      incident.updatedAt = now; changed.push(structuredClone(incident));
    }
    return changed.length ? items : undefined;
  });
  if (!changed.length) throw new Error('INCIDENT_NOT_FOUND');
  const operationId = input.operationId || generateId();
  await appendAutomationAudit({ correlationId: operationId, operationId, operationType: `ALERT_INCIDENT_${input.action.toUpperCase()}`, actor: input.actor, target: ids.join(','), risk: 'LOW', reasons: input.reason ? [input.reason] : [], dryRun: false, attempts: 0 });
  return changed;
}

export async function queueIncidentRemediation(incidentIdValue: string, actor: string, operationId?: string, now = Date.now()) {
  const incident = (await readCollection<AlertIncident>(INCIDENTS)).find(item => item.id === incidentIdValue);
  if (!incident) throw new Error('INCIDENT_NOT_FOUND');
  if (!incident.autoRemediationAllowed || incident.humanDecisionRequired) throw new Error('AUTO_REMEDIATION_NOT_ALLOWED');
  if (incident.remediationAttemptCount >= incident.maxRemediationAttempts) throw new Error('REMEDIATION_ATTEMPTS_EXHAUSTED');
  if (incident.nextEligibleRemediationAt && Date.parse(incident.nextEligibleRemediationAt) > now) throw new Error('REMEDIATION_COOLDOWN_ACTIVE');
  if (['credential_not_generation_ready', 'provider_not_ready'].includes(incident.category)) throw new Error('PERMANENT_REMEDIATION_BLOCKED');
  const attempt = incident.remediationAttemptCount + 1;
  const jobType = incident.category === 'stale_job' ? 'RECONCILE_AUTOMATION' as const : 'RECHECK_PRODUCT_HEALTH' as const;
  const result = await createAutomationJob({
    type: jobType,
    payload: { incidentId: incident.id, productIds: incident.affectedEntityType === 'product' ? incident.affectedEntityIds.slice(0, 100) : [], remediationCategory: incident.category },
    idempotencyKey: `${incident.idempotencyKey}:${attempt}`.slice(0, 160), operationId,
    requestedBy: actor, riskLevel: 'MEDIUM', dryRun: false,
  });
  if (result.created) {
    const cooldownMs = Math.min(24 * 60 * 60_000, 5 * 60_000 * 2 ** (attempt - 1));
    await runTransaction<AlertIncident>(INCIDENTS, items => {
      const current = items.find(item => item.id === incident.id);
      if (!current || current.remediationAttemptCount >= attempt) return undefined;
      current.remediationAttemptCount = attempt; current.status = 'REMEDIATION_QUEUED';
      current.nextEligibleRemediationAt = new Date(now + cooldownMs).toISOString(); current.updatedAt = new Date(now).toISOString();
      return items;
    });
    await runTransaction<Record<string, unknown>>(REMEDIATIONS, items => [...items, { id: `remediation-${result.job.id}`, incidentId: incident.id, jobId: result.job.id, attempt, status: 'QUEUED', createdAt: new Date(now).toISOString() }]);
    await appendAutomationAudit({ correlationId: result.job.operationId, operationId: result.job.operationId, jobId: result.job.id, operationType: 'ALERT_REMEDIATION_QUEUED', actor, target: incident.id, risk: 'MEDIUM', reasons: [incident.category], dryRun: false, attempts: attempt });
  }
  return result;
}
