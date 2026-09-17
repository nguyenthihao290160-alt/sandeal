import { randomUUID } from 'node:crypto';
import type { D1Database, D1Statement, SqlValue } from './database';
import { safePayload } from './d1StorageAdapter';
import type { ExecutionProposal, ExecutionApproval, ExecutionReceipt, ExecutionAuditRecord, RollbackPlan } from '../../execution-control-plane/types';
import { executionFingerprint, executionId, proposalFingerprint, proposalSemanticKey, validId } from '../../execution-control-plane/fingerprint';
import { executeDryRun } from '../../execution-control-plane/dryRunExecutor';
import type { PreflightContext } from '../../execution-control-plane/preflightValidator';
import { KILL_SWITCH_DOMAINS, type KillSwitchSnapshot } from '../../execution-control-plane/killSwitch';
import { planReleaseBundle } from '../../execution-control-plane/releaseBundle';

type Row = Record<string, string | number | null>;
export type ExecutionEvidence = Pick<PreflightContext, 'currentPolicy' | 'currentEvidenceFingerprint' | 'target' | 'priorState' | 'changeWindow'>;
export interface ExecutionClaim { id: string; proposalId: string; claimToken: string; generation: number; leaseUntil: number; controlRevision: number }
export interface ExecutionStoreOptions { environment: 'LOCAL' | 'TEST'; testOnly: boolean; allowedApproverIds: readonly string[]; allowedHosts: readonly string[] }
export class ExecutionStoreError extends Error {
  constructor(readonly code: string) { super(code); }
}
export class D1ExecutionStore {
  readonly options: Readonly<ExecutionStoreOptions>;
  constructor(private readonly db: D1Database, options: ExecutionStoreOptions) {
    if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') throw new ExecutionStoreError('D1_EXECUTION_UNAVAILABLE');
    if (!options || !['LOCAL', 'TEST'].includes(options.environment) || typeof options.testOnly !== 'boolean'
      || !Array.isArray(options.allowedApproverIds) || options.allowedApproverIds.length > 10 || !options.allowedApproverIds.every(validId)
      || !Array.isArray(options.allowedHosts) || options.allowedHosts.length > 20) throw new ExecutionStoreError('EXECUTION_CONFIGURATION_INVALID');
    this.options = Object.freeze({ ...options, allowedApproverIds: Object.freeze([...options.allowedApproverIds]), allowedHosts: Object.freeze([...options.allowedHosts]) });
  }
  private statement(sql: string, values: SqlValue[] = []) {
    try { return this.db.prepare(sql).bind(...values); } catch { throw new ExecutionStoreError('D1_EXECUTION_UNAVAILABLE'); }
  }
  private async query(sql: string, values: SqlValue[] = []): Promise<Row[]> {
    try { const result = await this.statement(sql, values).all<Row>(); if (!result.success) throw new Error(); return result.results; }
    catch { throw new ExecutionStoreError('D1_EXECUTION_UNAVAILABLE'); }
  }
  private async batch(statements: D1Statement[]) {
    try { const result = await this.db.batch<Row>(statements); if (result.some(item => !item.success)) throw new Error(); return result; }
    catch { throw new ExecutionStoreError('EXECUTION_ATOMIC_CONFLICT'); }
  }
  private id(value: string) { if (!validId(value)) throw new ExecutionStoreError('EXECUTION_ID_INVALID'); return value; }
  private time(value: number) { if (!Number.isSafeInteger(value) || value < 0 || value > 8_000_000_000_000) throw new ExecutionStoreError('EXECUTION_TIME_INVALID'); return value; }
  private revision() { return this.statement("UPDATE execution_controls SET revision=revision+1 WHERE id='global'"); }
  private proposalFromRow(row: Row | undefined): ExecutionProposal | null {
    if (!row) return null;
    try {
      const proposal = JSON.parse(String(row.payload)) as ExecutionProposal;
      if (proposal.id !== row.id || proposalFingerprint(proposal) !== row.proposal_fingerprint) throw new Error();
      return proposal;
    } catch { throw new ExecutionStoreError('EXECUTION_PROPOSAL_CORRUPT'); }
  }
  async createProposal(proposal: ExecutionProposal): Promise<ExecutionProposal> {
    this.id(proposal.id); this.time(proposal.requestedAt); this.time(proposal.expiresAt);
    if (proposal.environment !== this.options.environment || proposal.origin !== (this.options.testOnly ? 'TEST_FIXTURE' : 'AUTHENTICATED_PROVIDER_API')
      || proposal.status !== 'PENDING' || proposal.expiresAt <= proposal.requestedAt || proposal.expiresAt - proposal.requestedAt > 86_400_000) throw new ExecutionStoreError('EXECUTION_PROPOSAL_INVALID');
    const payload = safePayload(proposal, 16384), semantic = proposalSemanticKey(proposal), fingerprint = proposalFingerprint(proposal);
    const values: SqlValue[] = [proposal.id, proposal.origin, proposal.proposalType, proposal.capability, proposal.sourceSubsystem, proposal.sourceRecordId,
      proposal.targetEntityId, proposal.environment, proposal.executionMode, proposal.riskLevel, JSON.stringify(proposal.reasonCodes), JSON.stringify(proposal.evidenceRefs),
      proposal.policyVersion, proposal.algorithmVersion, proposal.requestedAt, proposal.expiresAt, proposal.approvalRequirement, proposal.rollbackRequirement,
      proposal.evidenceFingerprint, proposal.status, semantic, fingerprint, payload];
    await this.query(`INSERT INTO execution_proposals(id,origin,proposal_type,capability,source_subsystem,source_record_id,target_entity_id,environment,
      execution_mode,risk_level,reason_codes,evidence_refs,policy_version,algorithm_version,requested_at,expires_at,approval_requirement,rollback_requirement,
      evidence_fingerprint,status,semantic_key,proposal_fingerprint,payload) VALUES(${values.map(() => '?').join(',')}) ON CONFLICT DO NOTHING`, values);
    const [row] = await this.query('SELECT id,payload,proposal_fingerprint FROM execution_proposals WHERE origin=? AND semantic_key=? AND semantic_key<>? LIMIT 1', [proposal.origin, semantic, '']);
    const stored = this.proposalFromRow(row);
    if (!stored) throw new ExecutionStoreError('EXECUTION_IDEMPOTENCY_CONFLICT');
    return stored;
  }
  async getProposal(id: string): Promise<ExecutionProposal | null> {
    const [row] = await this.query('SELECT id,payload,proposal_fingerprint FROM execution_proposals WHERE id=? AND environment=? LIMIT 1', [this.id(id), this.options.environment]);
    return this.proposalFromRow(row);
  }
  async supersedeProposal(id: string): Promise<void> {
    const proposal = await this.getProposal(id);
    if (!proposal || !['PENDING', 'APPROVED'].includes(proposal.status)) throw new ExecutionStoreError('EXECUTION_PROPOSAL_INVALID');
    const superseded = { ...proposal, status: 'SUPERSEDED' as const };
    await this.batch([this.statement("UPDATE execution_proposals SET status='SUPERSEDED',payload=?,proposal_fingerprint=? WHERE id=? AND proposal_fingerprint=?",
      [safePayload(superseded, 16384), proposalFingerprint(superseded), id, proposalFingerprint(proposal)]), this.revision()]);
  }
  async putEvidence(proposalId: string, evidence: ExecutionEvidence): Promise<void> {
    if (!await this.getProposal(proposalId)) throw new ExecutionStoreError('EXECUTION_PROPOSAL_MISSING');
    await this.batch([this.statement(`INSERT INTO execution_contexts(proposal_id,payload) VALUES(?,?)
      ON CONFLICT(proposal_id) DO UPDATE SET payload=excluded.payload`, [proposalId, safePayload(evidence, 32768)]), this.revision()]);
  }
  async initializeTestControls(now: number): Promise<void> {
    this.time(now);
    if (!this.options.testOnly) throw new ExecutionStoreError('EXECUTION_TEST_ONLY');
    const domains = Object.fromEntries(KILL_SWITCH_DOMAINS.map(domain => [domain, false]));
    await this.query(`INSERT INTO execution_controls(id,state,revision,observed_at,expires_at,payload) VALUES('global','INACTIVE',1,?,?,?) ON CONFLICT DO NOTHING`,
      [now, now + 300_000, safePayload(domains, 1024)]);
  }
  async getKillSwitchState(): Promise<KillSwitchSnapshot | null> {
    try {
      const [row] = await this.query("SELECT state,revision,observed_at,expires_at,payload FROM execution_controls WHERE id='global' LIMIT 1");
      return row ? { state: String(row.state) as KillSwitchSnapshot['state'], revision: Number(row.revision), observedAt: Number(row.observed_at),
        expiresAt: Number(row.expires_at), domains: JSON.parse(String(row.payload)) } : null;
    } catch { return null; }
  }
  async emergencyStop(approverId: string, now: number): Promise<void> {
    this.time(now);
    if (!this.options.allowedApproverIds.includes(approverId)) throw new ExecutionStoreError('EXECUTION_APPROVER_UNAUTHORIZED');
    const domains = Object.fromEntries(KILL_SWITCH_DOMAINS.map(domain => [domain, true]));
    await this.batch([this.statement(`INSERT INTO execution_controls(id,state,revision,observed_at,expires_at,payload) VALUES('global','ACTIVE',1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state='ACTIVE',revision=revision+1,observed_at=excluded.observed_at,expires_at=excluded.expires_at,payload=excluded.payload`,
      [now, now, safePayload(domains, 1024)]), this.statement('INSERT INTO execution_audit(id,proposal_id,event_type,timestamp,payload) VALUES(?,?,?,?,?)',
      [`stop-${randomUUID()}`, 'global', 'EMERGENCY_STOP', now, safePayload({ approverId }, 1024)])]);
  }
  async createApproval(approval: ExecutionApproval): Promise<void> {
    const proposal = await this.getProposal(approval.proposalId);
    this.id(approval.id); this.time(approval.createdAt); this.time(approval.expiresAt); safePayload(approval, 4096);
    if (!proposal || approval.proposalFingerprint !== proposalFingerprint(proposal) || approval.environment !== proposal.environment
      || approval.capability !== proposal.capability || approval.riskLevel !== proposal.riskLevel || approval.evidenceFingerprint !== proposal.evidenceFingerprint
      || !approval.approverId || !this.options.allowedApproverIds.includes(approval.approverId)
      || approval.createdAt < proposal.requestedAt || approval.expiresAt > proposal.expiresAt || approval.expiresAt <= approval.createdAt) throw new ExecutionStoreError('EXECUTION_APPROVAL_INVALID');
    await this.batch([this.statement(`INSERT INTO execution_approvals(id,proposal_id,environment,capability,risk_level,evidence_fingerprint,approver_id,status,created_at,expires_at,proposal_fingerprint)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [approval.id, approval.proposalId, approval.environment, approval.capability, approval.riskLevel, approval.evidenceFingerprint,
      approval.approverId, approval.status, approval.createdAt, approval.expiresAt, approval.proposalFingerprint]), this.revision()]);
  }
  async revokeApproval(id: string): Promise<void> {
    await this.batch([this.statement("UPDATE execution_approvals SET status='REVOKED' WHERE id=? AND status IN ('PENDING','APPROVED')", [this.id(id)]), this.revision()]);
  }
  private approvalFromRow(row: Row | undefined): ExecutionApproval | null {
    return row ? { id: String(row.id), proposalId: String(row.proposal_id), environment: String(row.environment) as ExecutionApproval['environment'],
      capability: String(row.capability), riskLevel: String(row.risk_level) as ExecutionApproval['riskLevel'], evidenceFingerprint: String(row.evidence_fingerprint),
      approverId: row.approver_id === null ? null : String(row.approver_id), status: String(row.status) as ExecutionApproval['status'],
      createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), proposalFingerprint: String(row.proposal_fingerprint) } : null;
  }
  approvalQuery(proposal: ExecutionProposal, now: number) {
    this.time(now);
    return { sql: `SELECT * FROM execution_approvals INDEXED BY execution_approval_valid WHERE proposal_id=? AND proposal_fingerprint=? AND environment=?
      AND capability=? AND risk_level=? AND status='APPROVED' AND expires_at>? AND created_at<=? AND created_at>=? AND expires_at<=?
      AND evidence_fingerprint=? AND approver_id IN (${this.options.allowedApproverIds.map(() => '?').join(',') || 'NULL'}) ORDER BY expires_at,id LIMIT 1`,
    values: [proposal.id, proposalFingerprint(proposal), proposal.environment, proposal.capability, proposal.riskLevel, now, now, proposal.requestedAt,
      proposal.expiresAt, proposal.evidenceFingerprint, ...this.options.allowedApproverIds] as SqlValue[] };
  }
  async getValidApprovalForProposal(proposalId: string, now: number): Promise<ExecutionApproval | null> {
    const proposal = await this.getProposal(proposalId);
    if (!proposal || !['PENDING', 'APPROVED'].includes(proposal.status) || proposal.requestedAt > now || proposal.expiresAt <= now) return null;
    const query = this.approvalQuery(proposal, now), [row] = await this.query(query.sql, query.values);
    return this.approvalFromRow(row);
  }
  async loadContext(proposalId: string, now: number, queueAvailable: boolean): Promise<PreflightContext> {
    this.time(now);
    const proposal = await this.getProposal(proposalId);
    if (!proposal) throw new ExecutionStoreError('EXECUTION_PROPOSAL_MISSING');
    const [row] = await this.query('SELECT payload FROM execution_contexts WHERE proposal_id=? LIMIT 1', [proposalId]);
    const evidence: ExecutionEvidence = row ? JSON.parse(String(row.payload)) : { currentEvidenceFingerprint: '', currentPolicy: null, target: null, priorState: null, changeWindow: null };
    let approval = await this.getValidApprovalForProposal(proposalId, now);
    if (!approval) {
      const [latest] = await this.query('SELECT * FROM execution_approvals WHERE proposal_id=? ORDER BY created_at DESC,id DESC LIMIT 1', [proposalId]);
      approval = this.approvalFromRow(latest);
    }
    return { ...evidence, proposal, approval, currentEnvironment: this.options.environment, currentProposalFingerprint: proposalFingerprint(proposal),
      killSwitch: await this.getKillSwitchState(), now, allowedHosts: this.options.allowedHosts, allowedApproverIds: this.options.allowedApproverIds,
      bindings: { D1: true, QUEUE: queueAvailable } };
  }
  async enqueue(proposalId: string, now: number): Promise<string> {
    this.time(now);
    const proposal = await this.getProposal(proposalId);
    if (!proposal || proposal.expiresAt <= now || !['PENDING', 'APPROVED'].includes(proposal.status)) throw new ExecutionStoreError('EXECUTION_PROPOSAL_INVALID');
    const id = executionId(proposal);
    await this.query(`INSERT INTO execution_jobs(id,proposal_id,proposal_fingerprint,environment,status,available_at,expires_at,dispatch_at)
      VALUES(?,?,?,?,'PENDING',?,?,?) ON CONFLICT(proposal_id) DO NOTHING`, [id, proposalId, proposalFingerprint(proposal), proposal.environment, now, proposal.expiresAt, now]);
    const [job] = await this.query('SELECT id FROM execution_jobs WHERE proposal_id=? LIMIT 1', [proposalId]);
    if (job?.id !== id) throw new ExecutionStoreError('EXECUTION_IDEMPOTENCY_CONFLICT');
    return id;
  }
  dueQuery(now: number, limit = 10) {
    this.time(now);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new ExecutionStoreError('EXECUTION_QUERY_BOUND');
    return { sql: `SELECT id FROM execution_jobs WHERE environment=? AND status='PENDING' AND available_at<=? ORDER BY available_at,id LIMIT ?`,
      values: [this.options.environment, now, limit] as SqlValue[] };
  }
  async dispatchDue(queue: { send(message: { version: 1; jobId: string }): Promise<void> } | null, now: number): Promise<number> {
    this.time(now);
    if (!queue || typeof queue.send !== 'function') throw new ExecutionStoreError('EXECUTION_QUEUE_UNAVAILABLE');
    const jobs = await this.query(`SELECT id,dispatch_count FROM execution_jobs WHERE environment=? AND status IN ('PENDING','RUNNING')
      AND dispatch_at<=? ORDER BY status,dispatch_at,id LIMIT 10`, [this.options.environment, now]);
    let sent = 0;
    for (const job of jobs) {
      const status = await this.jobStatus(String(job.id), now);
      if (['BLOCKED', 'SUCCEEDED', 'MISSING'].includes(status)) continue;
      if (Number(job.dispatch_count) >= 5) {
        await this.query("UPDATE execution_jobs SET status='BLOCKED',claim_token=NULL WHERE id=? AND status IN ('PENDING','RUNNING') AND lease_until<=?", [job.id, now]);
        continue;
      }
      await queue.send({ version: 1, jobId: String(job.id) });
      await this.query('UPDATE execution_jobs SET dispatch_at=?,dispatch_count=dispatch_count+1 WHERE id=? AND dispatch_count<5', [now + 60_000, job.id]);
      sent++;
    }
    return sent;
  }
  async claim(id: string, now: number): Promise<ExecutionClaim | null> {
    this.time(now); this.id(id);
    const claimToken = randomUUID();
    const [row] = await this.query(`UPDATE execution_jobs SET status='RUNNING',claim_token=?,generation=generation+1,lease_until=?,attempts=attempts+1
      WHERE id=? AND environment=? AND expires_at>? AND attempts<3 AND ((status='PENDING' AND available_at<=?) OR (status='RUNNING' AND lease_until<=?))
      RETURNING id,proposal_id,generation,lease_until,(SELECT revision FROM execution_controls WHERE id='global') AS control_revision`,
    [claimToken, now + 60_000, id, this.options.environment, now, now, now]);
    return row ? { id, proposalId: String(row.proposal_id), claimToken, generation: Number(row.generation), leaseUntil: Number(row.lease_until), controlRevision: Number(row.control_revision) } : null;
  }
  async getReceipt(jobId: string): Promise<ExecutionReceipt | null> {
    const [row] = await this.query(`SELECT receipt.result_json FROM execution_jobs job JOIN execution_receipts receipt ON receipt.id=job.receipt_id
      WHERE job.id=? AND job.environment=? LIMIT 1`, [this.id(jobId), this.options.environment]);
    return row ? JSON.parse(String(row.result_json)) as ExecutionReceipt : null;
  }
  async jobStatus(id: string, now: number): Promise<string> {
    this.time(now);
    await this.query(`UPDATE execution_jobs SET status='BLOCKED',claim_token=NULL WHERE id=? AND environment=? AND status IN ('PENDING','RUNNING')
      AND (expires_at<=? OR (attempts>=3 AND lease_until<=?) OR EXISTS(SELECT 1 FROM execution_proposals proposal WHERE proposal.id=execution_jobs.proposal_id
      AND (proposal.status NOT IN ('PENDING','APPROVED') OR proposal.proposal_fingerprint<>execution_jobs.proposal_fingerprint)))`, [this.id(id), this.options.environment, now, now]);
    const [row] = await this.query('SELECT status FROM execution_jobs WHERE id=? AND environment=? LIMIT 1', [id, this.options.environment]);
    return String(row?.status ?? 'MISSING');
  }
  async completeClaim(claim: ExecutionClaim, now: number, queueAvailable: boolean, clock: () => number = () => now): Promise<ExecutionReceipt> {
    const context = await this.loadContext(claim.proposalId, now, queueAvailable);
    context.now = this.time(clock());
    if (context.now < now) throw new ExecutionStoreError('EXECUTION_TIME_INVALID');
    const result = executeDryRun(context);
    return this.persistResult(result.receipt, result.rollbackPlan, claim, context);
  }
  async saveDryRunResult(receipt: ExecutionReceipt, rollbackPlan: RollbackPlan | null, claim: ExecutionClaim, now: number): Promise<ExecutionReceipt> {
    if (!claim) throw new ExecutionStoreError('EXECUTION_CLAIM_REQUIRED');
    const context = await this.loadContext(claim.proposalId, now, true), expected = executeDryRun(context);
    if (executionFingerprint({ receipt, rollbackPlan }) !== executionFingerprint(expected)) throw new ExecutionStoreError('EXECUTION_RECEIPT_INVALID');
    return this.persistResult(receipt, rollbackPlan, claim, context);
  }
  private async persistResult(receipt: ExecutionReceipt, rollbackPlan: RollbackPlan | null, claim: ExecutionClaim, context: PreflightContext): Promise<ExecutionReceipt> {
    const { proposal, now } = context, guard = `guard-${randomUUID()}`;
    if (!claim || receipt.id !== executionId(proposal) || claim.proposalId !== proposal.id || claim.id !== receipt.id) throw new ExecutionStoreError('EXECUTION_CLAIM_REQUIRED');
    const statements = [this.statement(`INSERT INTO execution_commit_guards(id,valid) VALUES(?,CASE WHEN EXISTS(
      SELECT 1 FROM execution_jobs WHERE id=? AND claim_token=? AND generation=? AND status='RUNNING' AND lease_until>? AND expires_at>?
      AND proposal_fingerprint=?) AND COALESCE((SELECT revision FROM execution_controls WHERE id='global'),0)=? THEN 1 ELSE 0 END)`,
    [guard, claim.id, claim.claimToken, claim.generation, now, now, proposalFingerprint(proposal), claim.controlRevision]),
    this.statement(`INSERT INTO execution_receipts(id,proposal_id,execution_mode,preflight_result,would_execute,blocked_effects,risk_level,approval_state,
      rollback_available,fingerprint,timestamp,payload,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [receipt.id, receipt.proposalId, receipt.executionMode, receipt.preflightResult, Number(receipt.wouldExecute), Number(receipt.blockedEffects), receipt.riskLevel,
      receipt.approvalState, Number(receipt.rollbackAvailable), receipt.fingerprint, now, safePayload(receipt.wouldEffects, 16384), safePayload(receipt, 32768)])];
    for (const [index, effect] of receipt.wouldEffects.entries()) statements.push(this.statement(`INSERT INTO execution_side_effects(id,receipt_id,effect_type,target,risk,
      reversible,requires_approval,production_mutation,external_call,dry_run_only,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [`${receipt.id}-${index}`, receipt.id, effect.effectType, effect.target, effect.risk, Number(effect.reversible), Number(effect.requiresApproval), 0, 0, 1, safePayload(effect.payload, 4096)]));
    if (rollbackPlan) statements.push(this.statement(`INSERT INTO rollback_plans(id,proposal_id,original_state_evidence,target_state,reversal_steps,preconditions,limitations,receipt_id,payload)
      VALUES(?,?,?,?,?,?,?,?,?)`, [`${receipt.id}-rb`, proposal.id, safePayload(rollbackPlan.originalStateEvidence, 16384), safePayload(rollbackPlan.targetState, 4096),
      safePayload(rollbackPlan.reversalSteps, 4096), JSON.stringify(rollbackPlan.preconditions), JSON.stringify(rollbackPlan.limitations), receipt.id, safePayload(rollbackPlan, 32768)]));
    statements.push(this.statement('INSERT INTO execution_audit(id,proposal_id,event_type,timestamp,payload) VALUES(?,?,?,?,?)',
      [`${receipt.id}-audit`, proposal.id, 'DRY_RUN_RECORDED', now, safePayload({ receiptId: receipt.id, preflight: receipt.preflightResult, fingerprint: receipt.fingerprint }, 4096)]),
    this.statement("UPDATE execution_jobs SET status='SUCCEEDED',receipt_id=?,claim_token=NULL,lease_until=0 WHERE id=?", [receipt.id, claim.id]),
    this.statement('DELETE FROM execution_commit_guards WHERE id=?', [guard]));
    await this.batch(statements);
    return receipt;
  }
  async writeAudit(audit: ExecutionAuditRecord): Promise<void> {
    this.id(audit.id); this.id(audit.proposalId); this.time(audit.timestamp);
    await this.query('INSERT INTO execution_audit(id,proposal_id,event_type,timestamp,payload) VALUES(?,?,?,?,?)',
      [audit.id, audit.proposalId, audit.eventType, audit.timestamp, safePayload(audit.payload, 4096)]);
  }
  async saveReleaseBundle(id: string, members: { proposalId: string; dependsOn: string[] }[], now: number) {
    this.id(id); this.time(now);
    if (!Array.isArray(members) || members.length === 0 || members.length > 20) throw new ExecutionStoreError('EXECUTION_BUNDLE_BOUND');
    const revision = (await this.getKillSwitchState())?.revision ?? 0;
    const contexts = await Promise.all(members.map(async member => ({ context: await this.loadContext(member.proposalId, now, true), dependsOn: member.dependsOn })));
    const plan = planReleaseBundle({ id, environment: this.options.environment, members: contexts });
    if (plan.preflightState !== 'PASS') throw new ExecutionStoreError('EXECUTION_BUNDLE_BLOCKED');
    const guard = `guard-${randomUUID()}`;
    if (contexts.some(member => member.context.killSwitch?.revision !== revision)) throw new ExecutionStoreError('EXECUTION_ATOMIC_CONFLICT');
    const result = await this.batch([this.statement(`INSERT INTO execution_commit_guards(id,valid) VALUES(?,CASE WHEN (SELECT revision FROM execution_controls WHERE id='global')=? THEN 1 ELSE 0 END)`, [guard, revision]),
      this.statement(`INSERT INTO release_bundles(id,environment,risk,preflight_state,rollback_coverage,payload,semantic_key) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT DO NOTHING RETURNING id`, [id, plan.environment, 'REVIEW_REQUIRED', plan.preflightState, plan.rollbackCoverage, safePayload(plan, 16384), plan.semanticKey]),
      ...plan.order.map((proposalId, ordinal) => this.statement(`INSERT INTO release_bundle_proposals(bundle_id,proposal_id,ordinal)
        SELECT id,?,? FROM release_bundles WHERE environment=? AND semantic_key=? ON CONFLICT DO NOTHING`, [proposalId, ordinal, plan.environment, plan.semanticKey])),
      this.statement('DELETE FROM execution_commit_guards WHERE id=?', [guard])]);
    const [stored] = await this.query('SELECT payload FROM release_bundles WHERE environment=? AND semantic_key=? AND semantic_key<>? LIMIT 1', [plan.environment, plan.semanticKey, '']);
    if (!stored) throw new ExecutionStoreError('EXECUTION_IDEMPOTENCY_CONFLICT');
    return { plan: JSON.parse(String(stored.payload)) as typeof plan, created: result[1].results.length > 0 };
  }
}
