const SAFE_RELEASE_ID = /^[a-zA-Z0-9._-]{1,120}$/;
const GIT_SHA = /^[0-9a-f]{40}$/i;

function safeValue(value: string | undefined): string | undefined {
  const clean = String(value || '').trim();
  return SAFE_RELEASE_ID.test(clean) ? clean : undefined;
}

/**
 * The embedded build identity identifies the code artifact. Runtime env is
 * reported separately so stale PM2 env cannot silently relabel old/new code.
 */
export function getReleaseIdentity() {
  const embeddedBuildId = safeValue(process.env.SANDEAL_BUILD_COMMIT);
  const runtimeReleaseId = safeValue(process.env.SANDEAL_RELEASE_ID || process.env.GIT_COMMIT_SHA);
  const publicBuildId = safeValue(process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID);
  const fallback = process.env.NODE_ENV === 'production' ? 'unavailable' : 'development';
  const buildId = embeddedBuildId || runtimeReleaseId || publicBuildId || fallback;
  const releaseId = buildId;
  const runtimeIdentity = runtimeReleaseId || buildId;
  return {
    app: 'sandeal' as const,
    version: safeValue(process.env.SANDEAL_VERSION) || '0.1.0',
    buildId,
    releaseId,
    commitSha: GIT_SHA.test(buildId) ? buildId.toLowerCase() : null,
    runtimeReleaseId: runtimeIdentity,
    releaseMismatch: embeddedBuildId !== undefined && runtimeReleaseId !== undefined && embeddedBuildId !== runtimeReleaseId,
    releaseSource: embeddedBuildId ? 'embedded_git_commit' as const
      : runtimeReleaseId ? 'runtime_environment' as const
        : publicBuildId ? 'public_build_environment' as const
          : process.env.NODE_ENV === 'production' ? 'unavailable' as const : 'development' as const,
  };
}
