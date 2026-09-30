import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import builder from '../../scripts/v6-cloudflare-build.cjs';

const GIT_SHA = /^[0-9a-f]{40}$/i;

function resolveBuildCommit() {
    const sandealId = String(process.env.SANDEAL_RELEASE_ID ?? '').trim();
    const gitCommitSha = String(process.env.GIT_COMMIT_SHA ?? '').trim();
    const nodeEnv = process.env.NODE_ENV ?? 'production';

    if (sandealId && gitCommitSha && sandealId !== gitCommitSha) {
        throw new Error('CONFLICTING_RELEASE_IDS');
    }

    const explicit = sandealId || gitCommitSha;
    const explicitCommit = GIT_SHA.test(explicit) ? explicit.toLowerCase() : '';

    if (nodeEnv === 'production' && !explicitCommit) {
        throw new Error('SANDEAL_RELEASE_ID_GIT_SHA_REQUIRED');
    }

    let gitCommit = '';
    try {
        gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim().toLowerCase();
    } catch {
        // Fallthrough
    }

    if (nodeEnv === 'production' && !gitCommit) {
        throw new Error('GIT_HEAD_UNAVAILABLE');
    }

    if (gitCommit && !GIT_SHA.test(gitCommit)) {
        throw new Error('GIT_HEAD_SHA_INVALID');
    }

    if (explicitCommit && gitCommit && explicitCommit !== gitCommit) {
        throw new Error('SANDEAL_RELEASE_ID_GIT_HEAD_MISMATCH');
    }

    if (explicitCommit || gitCommit) {
        return explicitCommit || gitCommit;
    }

    if (nodeEnv === 'production') {
        throw new Error('SANDEAL_RELEASE_ID_GIT_SHA_REQUIRED');
    }

    return explicit || 'development';
}

const buildCommit = resolveBuildCommit();
const publicReleaseId = String(process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID ?? '').trim().toLowerCase();
if (publicReleaseId && publicReleaseId !== buildCommit) throw new Error('NEXT_PUBLIC_SANDEAL_RELEASE_ID_GIT_HEAD_MISMATCH');

const siteDirectory = path.dirname(fileURLToPath(import.meta.url));
const buildEnvironment = builder.siteBuildEnvironment({ environment: process.env.SANDEAL_SITE_ENVIRONMENT ?? 'LOCAL', origin: process.env.NEXT_PUBLIC_SITE_URL });

const nextConfig = {
  deploymentId: buildCommit,
  output: 'export', trailingSlash: true,
  images: { unoptimized: true },
  turbopack: { root: path.resolve(siteDirectory, '../..') },
  env: {
    NEXT_PUBLIC_SANDEAL_RELEASE_ID: buildCommit,
    NEXT_PUBLIC_SANDEAL_RUNTIME: 'cloudflare',
    NEXT_PUBLIC_SITE_URL: buildEnvironment.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_SANDEAL_ENVIRONMENT: buildEnvironment.NEXT_PUBLIC_SANDEAL_ENVIRONMENT
  },
};
export default nextConfig;
