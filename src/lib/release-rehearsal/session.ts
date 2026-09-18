import { createReleaseCandidate } from './manifest';
import { certifyRelease, validateReadinessCertificate } from './certification';
import { RELEASE_LIMITS } from './contracts';
import type { CertificationContext, ReadinessCertificate, ReleaseCandidate, ReleaseCandidateManifest } from './types';

export class LocalRehearsalSession {
  private readonly candidates = new Map<string, ReleaseCandidate>();
  private readonly certificates = new Map<string, ReadinessCertificate>();
  private activeId: string | null = null;
  constructor(environment: 'LOCAL' | 'TEST') {
    if (!['LOCAL', 'TEST'].includes(environment)) throw new Error('REHEARSAL_SESSION_LOCAL_ONLY');
  }
  activate(manifest: ReleaseCandidateManifest): ReleaseCandidate {
    const candidate = createReleaseCandidate(manifest);
    if (this.candidates.has(candidate.id) && this.activeId !== candidate.id) throw new Error('REHEARSAL_CANDIDATE_SUPERSEDED');
    if (!this.candidates.has(candidate.id) && this.candidates.size >= RELEASE_LIMITS.members) throw new Error('REHEARSAL_SESSION_CAPACITY');
    this.candidates.set(candidate.id, structuredClone(candidate));
    this.activeId = candidate.id;
    return candidate;
  }
  get(id: string): ReleaseCandidate | null {
    const candidate = this.candidates.get(id);
    return candidate ? structuredClone(candidate) : null;
  }
  certify(id: string, context: Omit<CertificationContext, 'activeCandidateId'>) {
    const candidate = this.candidates.get(id);
    if (!candidate || !this.activeId) throw new Error('REHEARSAL_CANDIDATE_UNKNOWN');
    const result = certifyRelease(candidate, { ...context, activeCandidateId: this.activeId });
    if (result.certificate) this.certificates.set(id, structuredClone(result.certificate));
    else this.certificates.delete(id);
    return result;
  }
  certificate(id: string, context: Omit<CertificationContext, 'activeCandidateId'>): ReadinessCertificate | null {
    const candidate = this.candidates.get(id), certificate = this.certificates.get(id);
    if (!candidate || !certificate || !this.activeId
      || !validateReadinessCertificate(certificate, candidate, { ...context, activeCandidateId: this.activeId })) return null;
    return structuredClone(certificate);
  }
}
