import { type NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import {
  listAlertIncidents,
  getAlertIncidentSummary,
  listIncidentOccurrences,
  queueIncidentRemediation,
  synchronizeAlertIncidents,
  updateIncidentStatus,
  type AlertIncidentStatus,
} from '@/lib/product-intelligence/alertIncidents';
import { generateId } from '@/lib/storage/adapter';

export const dynamic = 'force-dynamic';
const STATUSES = new Set<AlertIncidentStatus>(['NEW', 'ACKNOWLEDGED', 'REMEDIATION_QUEUED', 'REMEDIATION_RUNNING', 'RECHECK_REQUIRED', 'RESOLVED', 'HUMAN_DECISION_REQUIRED', 'IGNORED', 'EXHAUSTED']);

export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_ALERTS');
  if (denied) return denied;
  const incidentId = request.nextUrl.searchParams.get('incidentId');
  const page = Math.max(1, Number(request.nextUrl.searchParams.get('page')) || 1);
  const pageSize = Math.max(1, Math.min(50, Number(request.nextUrl.searchParams.get('pageSize')) || 20));
  if (incidentId) {
    return NextResponse.json({ ok: true, code: 'OK', data: await listIncidentOccurrences(incidentId, page, pageSize) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const rawStatus = request.nextUrl.searchParams.get('status');
  if (rawStatus && !STATUSES.has(rawStatus as AlertIncidentStatus)) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  const [data, summary] = await Promise.all([
    listAlertIncidents({ status: rawStatus as AlertIncidentStatus || undefined, page, pageSize }),
    getAlertIncidentSummary(),
  ]);
  return NextResponse.json({ ok: true, code: 'OK', data: { ...data, summary } }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_ALERTS');
  if (denied) return denied;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 }); }
  const action = String(body.action || '');
  const operationId = typeof body.operationId === 'string' ? body.operationId : generateId();
  try {
    if (action === 'synchronize') return NextResponse.json({ ok: true, code: 'OK', operationId, data: await synchronizeAlertIncidents() });
    if (action === 'queue_remediation') {
      const result = await queueIncidentRemediation(String(body.incidentId || ''), getServerActor(), operationId);
      return NextResponse.json({ ok: true, code: result.code, operationId, data: { jobId: result.job.id, status: result.job.status } }, { status: result.created ? 202 : 200 });
    }
    // Evidence is produced by a server-side checker. Browser supplied evidence
    // must never be able to resolve an operational incident.
    if (action === 'recheck_evidence') return NextResponse.json({ ok: false, code: 'SERVER_RECHECK_REQUIRED' }, { status: 409 });
    return NextResponse.json({ ok: false, code: 'INVALID_ACTION' }, { status: 400 });
  } catch (error) {
    const code = error instanceof Error ? error.message.split(':')[0] : 'INCIDENT_ACTION_FAILED';
    const status = code === 'INCIDENT_NOT_FOUND' ? 404 : ['REMEDIATION_COOLDOWN_ACTIVE', 'REMEDIATION_ATTEMPTS_EXHAUSTED', 'AUTO_REMEDIATION_NOT_ALLOWED', 'PERMANENT_REMEDIATION_BLOCKED'].includes(code) ? 409 : 400;
    return NextResponse.json({ ok: false, code, message: 'Không thể thực hiện thao tác incident.' }, { status });
  }
}

export async function PATCH(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_ALERTS');
  if (denied) return denied;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 }); }
  const action = String(body.action || '');
  if (!['acknowledge', 'assign', 'ignore'].includes(action)) return NextResponse.json({ ok: false, code: action === 'resolve' ? 'RECHECK_EVIDENCE_REQUIRED' : 'INVALID_ACTION' }, { status: 409 });
  try {
    const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 100) : [String(body.id || '')];
    const data = await updateIncidentStatus({ ids, action: action as 'acknowledge' | 'assign' | 'ignore', actor: getServerActor(), reason: typeof body.reason === 'string' ? body.reason : undefined, assignee: typeof body.assignee === 'string' ? body.assignee : undefined, operationId: typeof body.operationId === 'string' ? body.operationId : undefined });
    return NextResponse.json({ ok: true, code: 'OK', data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'INCIDENT_UPDATE_FAILED';
    return NextResponse.json({ ok: false, code }, { status: code === 'INCIDENT_NOT_FOUND' ? 404 : 400 });
  }
}
