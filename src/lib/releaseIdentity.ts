const SAFE_RELEASE_ID = /^[a-zA-Z0-9._-]{1,120}$/;

function safeValue(value: string | undefined, fallback: string): string {
  const clean = String(value || '').trim();
  return SAFE_RELEASE_ID.test(clean) ? clean : fallback;
}

export function getReleaseIdentity() {
  return {
    app: 'sandeal' as const,
    version: safeValue(process.env.SANDEAL_VERSION, '0.1.0'),
    buildId: safeValue(
      process.env.SANDEAL_RELEASE_ID
        || process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID
        || process.env.GIT_COMMIT_SHA,
      process.env.NODE_ENV === 'production' ? 'unavailable' : 'development',
    ),
  };
}
