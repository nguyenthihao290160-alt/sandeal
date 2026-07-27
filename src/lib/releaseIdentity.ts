const SAFE_RELEASE_ID = /^[a-zA-Z0-9._-]{1,120}$/;
const GIT_SHA = /^[0-9a-f]{40}$/i;

function safeValue(value: string | undefined): string | undefined {
  const clean = String(value || '').trim();
  if (!SAFE_RELEASE_ID.test(clean)) return undefined;
  return GIT_SHA.test(clean) ? clean.toLowerCase() : clean;
}

export interface ReleaseIdentityInput {
  embeddedManifestId?: string;
  embeddedEnvironmentId?: string;
  runtimeReleaseId?: string;
  gitCommitSha?: string;
  publicBuildId?: string;
  nodeEnv?: string;
  version?: string;
}

export function deriveReleaseIdentity(input: ReleaseIdentityInput) {
  const production = input.nodeEnv === 'production';
  const embeddedManifestId = safeValue(input.embeddedManifestId);
  const embeddedEnvironmentId = safeValue(input.embeddedEnvironmentId);
  const runtimeReleaseId = safeValue(input.runtimeReleaseId);
  const gitCommitSha = safeValue(input.gitCommitSha);
  const publicBuildId = safeValue(input.publicBuildId);
  const fallback = production ? 'unavailable' : 'development';
  const embeddedBuildId = embeddedManifestId || embeddedEnvironmentId;
  const buildId = embeddedBuildId || runtimeReleaseId || gitCommitSha || publicBuildId || fallback;
  const mismatchReasons: string[] = [];
  const addMismatch = (condition: boolean, reason: string) => {
    if (condition && !mismatchReasons.includes(reason)) mismatchReasons.push(reason);
  };

  addMismatch(Boolean(embeddedManifestId && embeddedEnvironmentId && embeddedManifestId !== embeddedEnvironmentId), 'BUILD_MANIFEST_ENVIRONMENT_MISMATCH');
  addMismatch(Boolean(embeddedBuildId && runtimeReleaseId && embeddedBuildId !== runtimeReleaseId), 'EMBEDDED_RUNTIME_RELEASE_MISMATCH');
  addMismatch(Boolean(embeddedBuildId && gitCommitSha && embeddedBuildId !== gitCommitSha), 'EMBEDDED_GIT_COMMIT_MISMATCH');
  addMismatch(Boolean(embeddedBuildId && publicBuildId && embeddedBuildId !== publicBuildId), 'EMBEDDED_PUBLIC_BUILD_MISMATCH');
  addMismatch(Boolean(runtimeReleaseId && gitCommitSha && runtimeReleaseId !== gitCommitSha), 'RUNTIME_GIT_COMMIT_MISMATCH');
  addMismatch(Boolean(runtimeReleaseId && publicBuildId && runtimeReleaseId !== publicBuildId), 'RUNTIME_PUBLIC_BUILD_MISMATCH');

  if (production) {
    addMismatch(!embeddedManifestId, 'BUILD_MANIFEST_MISSING');
    addMismatch(!embeddedEnvironmentId, 'SANDEAL_BUILD_COMMIT_MISSING');
    addMismatch(!runtimeReleaseId, 'SANDEAL_RELEASE_ID_MISSING');
    addMismatch(!gitCommitSha, 'GIT_COMMIT_SHA_MISSING');
    addMismatch(!publicBuildId, 'NEXT_PUBLIC_SANDEAL_RELEASE_ID_MISSING');
    addMismatch(Boolean(embeddedManifestId && !GIT_SHA.test(embeddedManifestId)), 'BUILD_MANIFEST_SHA_INVALID');
    addMismatch(Boolean(embeddedEnvironmentId && !GIT_SHA.test(embeddedEnvironmentId)), 'SANDEAL_BUILD_COMMIT_SHA_INVALID');
    addMismatch(Boolean(runtimeReleaseId && !GIT_SHA.test(runtimeReleaseId)), 'SANDEAL_RELEASE_ID_SHA_INVALID');
    addMismatch(Boolean(gitCommitSha && !GIT_SHA.test(gitCommitSha)), 'GIT_COMMIT_SHA_INVALID');
    addMismatch(Boolean(publicBuildId && !GIT_SHA.test(publicBuildId)), 'NEXT_PUBLIC_SANDEAL_RELEASE_ID_SHA_INVALID');
  }

  return {
    app: 'sandeal' as const,
    version: safeValue(input.version) || '0.1.0',
    buildId,
    embeddedBuildId: embeddedBuildId || fallback,
    releaseId: buildId,
    commitSha: GIT_SHA.test(buildId) ? buildId.toLowerCase() : null,
    runtimeReleaseId: runtimeReleaseId || fallback,
    gitCommitSha: gitCommitSha && GIT_SHA.test(gitCommitSha) ? gitCommitSha.toLowerCase() : null,
    publicBuildId: publicBuildId || fallback,
    buildManifestAvailable: Boolean(embeddedManifestId),
    releaseMismatch: mismatchReasons.length > 0,
    releaseMismatchReasons: mismatchReasons,
    releaseSource: embeddedManifestId ? 'immutable_build_manifest' as const
      : embeddedEnvironmentId ? 'embedded_git_commit' as const
        : runtimeReleaseId ? 'runtime_environment' as const
          : publicBuildId ? 'public_build_environment' as const
            : production ? 'unavailable' as const : 'development' as const,
  };
}

/**
 * The embedded build identity identifies the code artifact. Runtime env is
 * reported separately so stale PM2 env cannot silently relabel old/new code.
 */
export function getReleaseIdentity() {
  return deriveReleaseIdentity({
    embeddedManifestId: process.env.SANDEAL_BUILD_MANIFEST_COMMIT,
    embeddedEnvironmentId: process.env.SANDEAL_BUILD_COMMIT,
    runtimeReleaseId: process.env.SANDEAL_RELEASE_ID,
    gitCommitSha: process.env.GIT_COMMIT_SHA,
    publicBuildId: process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID,
    nodeEnv: process.env.NODE_ENV,
    version: process.env.SANDEAL_VERSION,
  });
}
