import type { D1Database } from '../storage/d1/database';
import { safePayload } from '../storage/d1/d1StorageAdapter';
import { executionFingerprint } from '../execution-control-plane/fingerprint';
import { RELEASE_LIMITS, isHash } from './contracts';

export const REHEARSAL_EVENTS = Object.freeze(['CANDIDATE_CREATED', 'CANDIDATE_INVALIDATED', 'ARTIFACT_VERIFIED', 'MIGRATION_PASS', 'MIGRATION_FAIL',
  'KILL_SWITCH_DRILL', 'ROLLBACK_DRILL', 'CERTIFICATE_ISSUED', 'CERTIFICATE_BLOCKED']);
export interface RehearsalJournalEvent { candidateId: string; event: string; timestamp: number; evidenceFingerprint: string }
export class RehearsalJournal {
  constructor(private readonly db: D1Database, environment: 'LOCAL' | 'TEST') {
    if (!db || typeof db.prepare !== 'function' || !['LOCAL', 'TEST'].includes(environment)) throw new Error('REHEARSAL_JOURNAL_LOCAL_ONLY');
  }
  async append(event: RehearsalJournalEvent): Promise<string> {
    if (!/^rc-[a-f0-9]{64}$/.test(event.candidateId) || !REHEARSAL_EVENTS.includes(event.event) || !isHash(event.evidenceFingerprint)
      || !Number.isSafeInteger(event.timestamp) || event.timestamp < 0) throw new Error('REHEARSAL_JOURNAL_INVALID');
    const id = `rehearsal-${executionFingerprint({ candidateId: event.candidateId, event: event.event, evidenceFingerprint: event.evidenceFingerprint })}`;
    const result = await this.db.prepare('INSERT INTO execution_audit(id,proposal_id,event_type,timestamp,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .bind(id, event.candidateId, `REHEARSAL_${event.event}`, event.timestamp, safePayload(event, 2048)).all();
    if (!result.success) throw new Error('REHEARSAL_JOURNAL_UNAVAILABLE');
    return id;
  }
  async get(id: string) {
    if (!/^rehearsal-[a-f0-9]{64}$/.test(id)) throw new Error('REHEARSAL_JOURNAL_ID_INVALID');
    const result = await this.db.prepare('SELECT id,event_type,timestamp,payload FROM execution_audit WHERE id=? LIMIT 1').bind(id).all();
    if (!result.success) throw new Error('REHEARSAL_JOURNAL_UNAVAILABLE');
    return result.results[0] ?? null;
  }
  query(candidateId: string, before: number, limit = RELEASE_LIMITS.journalRead) {
    if (!/^rc-[a-f0-9]{64}$/.test(candidateId) || !Number.isSafeInteger(before) || before < 0
      || !Number.isInteger(limit) || limit < 1 || limit > RELEASE_LIMITS.journalRead) throw new Error('REHEARSAL_JOURNAL_BOUND');
    return { sql: 'SELECT id,event_type,timestamp,payload FROM execution_audit WHERE proposal_id=? AND timestamp<? ORDER BY timestamp DESC LIMIT ?',
      values: [candidateId, before, limit] };
  }
  async list(candidateId: string, before: number, limit = RELEASE_LIMITS.journalRead) {
    const query = this.query(candidateId, before, limit), result = await this.db.prepare(query.sql).bind(...query.values).all();
    if (!result.success) throw new Error('REHEARSAL_JOURNAL_UNAVAILABLE');
    return result.results;
  }
}
