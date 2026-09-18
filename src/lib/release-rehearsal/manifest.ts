import { executionFingerprint } from '../execution-control-plane/fingerprint';
import { REGISTRY } from '../execution-control-plane/capabilityRegistry';
import { DECISION_POLICY_VERSION } from '../decision-os/config';
import { DEAL_CONFIG } from '../deal-intelligence/config';
import { OPPORTUNITY_CONFIG } from '../opportunity/config';
import { CONTENT_INTELLIGENCE_VERSION } from '../content/config';
import { LIFECYCLE_CONFIG } from '../content/lifecycle/config';
import { RELEASE_ALGORITHM_VERSION, RELEASE_LIMITS, assertSafeRelease, isHash, exactKeys, dependencyOrder } from './contracts';
import type { ReleaseArtifact, ReleaseCandidate, ReleaseCandidateManifest } from './types';

export function artifactFingerprint(artifact: Pick<ReleaseArtifact, 'kind' | 'files'>): string {
  return executionFingerprint({ kind: artifact.kind, files: artifact.files });
}
export function registryFingerprint(): string { return executionFingerprint(REGISTRY); }
export function algorithmVersions(): Record<string, string> {
  return { execution: 'execution-v1', deal: DEAL_CONFIG.algorithmVersion, decision: DECISION_POLICY_VERSION,
    opportunity: OPPORTUNITY_CONFIG.algorithmVersion, content: CONTENT_INTELLIGENCE_VERSION,
    lifecycle: LIFECYCLE_CONFIG.algorithmVersion, release: RELEASE_ALGORITHM_VERSION };
}
export function validArtifact(artifact: ReleaseArtifact, manifest: ReleaseCandidateManifest): boolean {
  return exactKeys(artifact, ['kind', 'sourceHead', 'sourceFingerprint', 'fingerprint', 'files'])
    && ['WORKER', 'STATIC'].includes(artifact.kind) && artifact.sourceHead === manifest.source.head
    && artifact.sourceFingerprint === manifest.source.fingerprint && isHash(artifact.fingerprint)
    && Array.isArray(artifact.files) && artifact.files.length > 0 && artifact.files.length <= RELEASE_LIMITS.artifactFiles
    && artifact.files.every(file => exactKeys(file, ['path', 'sha256', 'bytes']) && typeof file.path === 'string'
      && /^[a-zA-Z0-9_.$/\[\]-]{1,240}$/.test(file.path) && !file.path.startsWith('/') && !file.path.split('/').includes('..')
      && isHash(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0)
    && new Set(artifact.files.map(file => file.path)).size === artifact.files.length
    && (artifact.kind === 'WORKER' ? artifact.files.length === 1 && artifact.files[0].path === 'worker.mjs'
      : artifact.files.some(file => file.path === 'index.html'))
    && artifact.files.map(file => file.path).join('\n') === artifact.files.map(file => file.path).sort().join('\n')
    && artifact.files.reduce((total, file) => total + file.bytes, 0) <= RELEASE_LIMITS.artifactBytes
    && artifact.fingerprint === artifactFingerprint(artifact);
}
export function assertManifest(manifest: ReleaseCandidateManifest): void {
  assertSafeRelease(manifest);
  if (!exactKeys(manifest, ['schema', 'algorithmVersion', 'environment', 'source', 'artifacts', 'migrations', 'baselineMigrations', 'requiredMigrations',
    'runtime', 'bindings', 'registryFingerprint', 'registryVersion', 'policyVersion', 'algorithmVersions', 'bundleFingerprint', 'rollbackCoverage',
    'dependencies', 'canary', 'observability', 'futureActions', 'provider', 'productionAuthorized'])
    || manifest.schema !== 'sandeal-local-preprod-v1' || manifest.algorithmVersion !== RELEASE_ALGORITHM_VERSION
    || !['LOCAL', 'PREVIEW_SIMULATION'].includes(manifest.environment) || manifest.productionAuthorized !== false) throw new Error('RELEASE_MANIFEST_INVALID');
  const source = manifest.source;
  if (!exactKeys(source, ['head', 'fingerprint', 'files']) || !/^[a-f0-9]{40}$/.test(source.head) || !isHash(source.fingerprint)
    || !source.files || typeof source.files !== 'object' || Array.isArray(source.files)
    || Object.keys(source.files).length < 1 || Object.keys(source.files).length > RELEASE_LIMITS.sourceFiles
    || !Object.entries(source.files).every(([name, hash]) => /^[a-zA-Z0-9_./@()\[\]-]{1,240}$/.test(name)
      && !name.startsWith('/') && !name.split('/').includes('..') && (name === '.env.example' || !/(^|\/)\.env(\.|$)/.test(name)) && isHash(hash))
    || executionFingerprint(source.files) !== source.fingerprint) throw new Error('RELEASE_SOURCE_INVALID');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 2
    || new Set(manifest.artifacts.map(artifact => artifact.kind)).size !== 2
    || !manifest.artifacts.every(artifact => validArtifact(artifact, manifest))) throw new Error('RELEASE_ARTIFACT_MISMATCH');
  if (manifest.registryFingerprint !== registryFingerprint() || manifest.registryVersion !== `registry-sha256-${registryFingerprint()}`
    || manifest.policyVersion !== DECISION_POLICY_VERSION || !isHash(manifest.bundleFingerprint)
    || executionFingerprint(manifest.algorithmVersions) !== executionFingerprint(algorithmVersions())) throw new Error('RELEASE_VERSION_MISMATCH');
  if (!Array.isArray(manifest.migrations) || manifest.migrations.length < 10 || manifest.migrations.length > RELEASE_LIMITS.migrations
    || !manifest.migrations.every((migration, index) => exactKeys(migration, ['name', 'sha256', 'classification', 'statements'])
      && /^\d{4}_[a-z0-9_]+\.sql$/.test(migration.name) && Number(migration.name.slice(0, 4)) === index + 1 && isHash(migration.sha256)
      && ['ADDITIVE_SAFE', 'REVIEW_REQUIRED', 'DESTRUCTIVE', 'UNKNOWN'].includes(migration.classification)
      && Number.isSafeInteger(migration.statements) && migration.statements > 0 && migration.statements <= RELEASE_LIMITS.migrationStatements)
    || !Array.isArray(manifest.baselineMigrations) || manifest.baselineMigrations.length > manifest.migrations.length
    || !manifest.baselineMigrations.every((migration, index) => exactKeys(migration, ['name', 'sha256'])
      && migration.name === manifest.migrations[index].name && migration.sha256 === manifest.migrations[index].sha256)
    || !Array.isArray(manifest.requiredMigrations) || manifest.requiredMigrations.length !== manifest.migrations.length
    || manifest.requiredMigrations.some((name, index) => name !== manifest.migrations[index].name)
    || !manifest.requiredMigrations.includes('0010_execution_control_plane.sql')) throw new Error('RELEASE_MIGRATION_MISMATCH');
  dependencyOrder(manifest.dependencies);
}
export function createReleaseCandidate(manifest: ReleaseCandidateManifest): ReleaseCandidate {
  assertManifest(manifest);
  const fingerprint = executionFingerprint(manifest);
  return { id: `rc-${fingerprint}`, fingerprint, manifest: structuredClone(manifest) };
}
