import type { ExecutionApproval, ExecutionProposal, RollbackPlan } from '../execution-control-plane/types';
import type { KillSwitchSnapshot } from '../execution-control-plane/killSwitch';
import type { ReleaseBundleInput } from '../execution-control-plane/releaseBundle';

export type ReleaseEnvironment = 'LOCAL' | 'PREVIEW_SIMULATION';
export type ReleaseReadiness = 'NOT_READY' | 'READY_FOR_REVIEW' | 'BLOCKED' | 'APPROVAL_REQUIRED' | 'CERTIFIED_LOCAL';
export type MigrationClassification = 'ADDITIVE_SAFE' | 'REVIEW_REQUIRED' | 'DESTRUCTIVE' | 'UNKNOWN';
export type RollbackCoverage = 'FULL' | 'PARTIAL' | 'NONE' | 'UNKNOWN';
export interface SourceManifest { head: string; fingerprint: string; files: Record<string, string> }
export interface ArtifactFile { path: string; sha256: string; bytes: number }
export interface ReleaseArtifact {
  kind: 'WORKER' | 'STATIC'; sourceHead: string; sourceFingerprint: string;
  fingerprint: string; files: ArtifactFile[];
}
export interface ReleaseMigration {
  name: string; sha256: string; classification: MigrationClassification; statements: number;
}
export interface BindingContract {
  d1: readonly string[]; queues: readonly string[]; assets: readonly string[]; databaseReferences: readonly string[];
  queueReferences: readonly string[]; crons: readonly string[]; secretReferences: readonly string[];
}
export interface ResourceBudget {
  queueBatch: number; d1Batch: number; proposals: number; approvalBacklog: number;
  routeScope: number; attempts: number; dispatches: number; retryDelayMs: number;
  workerRequestsPerMinute: number | null; queueMessagesPerMinute: number | null;
  d1ReadsPerWork: number | null; d1WritesPerWork: number | null;
}
export interface RuntimeContract {
  version: string; configFingerprint: string; runtime: 'cloudflare'; localOnly: true;
  production: false; executionMode: 'SHADOW'; directShopeeEnabled: false;
  aiExecutionEnabled: false; autopilotEnabled: false; moneyEngineEnabled: false;
  budget: ResourceBudget;
}
export interface ReleaseDependency { id: string; dependsOn: string[] }
export interface ObservabilitySignal { name: string; abortAbove: number | null; unit: string }
export interface ObservabilityPlan {
  source: 'CONFIGURED_LOCAL_REHEARSAL_NOT_PRODUCTION_TELEMETRY'; signals: ObservabilitySignal[];
  productionSloApproved: false;
}
export interface CanaryPlan {
  environment: ReleaseEnvironment; worker: string; contentDomain: string; routes: string[];
  blastRadius: 'BOUNDED' | 'UNKNOWN'; productionTrafficPercent: 0;
  stages: { name: string; futurePercent: number; executable: false }[];
  migrationFingerprint: string; observabilityFingerprint: string; abortConditions: string[];
}
export interface ReleaseCandidateManifest {
  schema: 'sandeal-local-preprod-v1'; algorithmVersion: string; environment: ReleaseEnvironment;
  source: SourceManifest; artifacts: ReleaseArtifact[]; migrations: ReleaseMigration[];
  baselineMigrations: { name: string; sha256: string }[]; requiredMigrations: string[];
  runtime: RuntimeContract; bindings: BindingContract; registryFingerprint: string;
  registryVersion: string; policyVersion: string; algorithmVersions: Record<string, string>;
  bundleFingerprint: string; rollbackCoverage: RollbackCoverage; dependencies: ReleaseDependency[];
  canary: CanaryPlan; observability: ObservabilityPlan; futureActions: string[];
  provider: { provider: 'accesstrade'; platform: 'shopee' };
  productionAuthorized: false;
}
export interface ReleaseCandidate { id: string; fingerprint: string; manifest: ReleaseCandidateManifest }
export interface RehearsalEvidence {
  gate: string; sourceFingerprint: string; subjectFingerprint: string;
  passed: boolean; reportFingerprint: string; origin: 'TEST_FIXTURE' | 'LOCAL_RUNNER';
}
export interface ReleaseApproval { proposal: ExecutionProposal; approval: ExecutionApproval | null; approverIds: readonly string[] }
export interface CertificationContext {
  now: number; expiresAt: number; environment: ReleaseEnvironment; activeCandidateId: string;
  current: ReleaseCandidateManifest; bundle: ReleaseBundleInput; killSwitch: KillSwitchSnapshot | null;
  approval: ReleaseApproval; availableBindings: { d1: string[]; queues: string[]; assets: string[]; secretReferences: string[] };
  d1Available: boolean; queueAvailable: boolean; providerAvailable: boolean;
  evidence: RehearsalEvidence[]; evidenceOrigin: 'TEST_FIXTURE' | 'LOCAL_RUNNER';
}
export interface ReadinessCertificate {
  id: string; candidateId: string; candidateFingerprint: string; environment: ReleaseEnvironment;
  state: 'CERTIFIED_LOCAL_PREPROD'; evidenceFingerprint: string; issuedAt: number; expiresAt: number;
  productionAuthorized: false; approvalScope: 'LOCAL_REHEARSAL_ONLY';
}
export interface OperatorReviewSummary {
  candidateId: string; readiness: ReleaseReadiness; changes: string[]; why: string; capabilities: string[];
  entities: string[]; migrations: string[]; bindings: string[]; risk: 'LOW' | 'HIGH' | 'UNKNOWN';
  rollbackCoverage: RollbackCoverage; rollbackLimitations: string[]; abortConditions: string[];
  monitoring: string[]; approval: string; reasons: string[]; futureProductionAuthorizationRequired: true;
}
export interface ReleaseCertification {
  readiness: ReleaseReadiness; blockers: string[]; certificate: ReadinessCertificate | null;
  summary: OperatorReviewSummary;
}
export interface RollbackDrill {
  passed: boolean; proposalId: string; planFingerprint: string | null;
  restored: false; scope: 'CAPABILITY_SCOPED_PLAN_VALIDATION_ONLY';
}
export type SubmittedRollbackPlan = RollbackPlan | null;
