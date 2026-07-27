import type { NextConfig } from 'next';
import { execFileSync } from 'node:child_process';

const GIT_SHA = /^[0-9a-f]{40}$/i;

export function resolveBuildCommit(input: {
    explicitReleaseId?: string;
    gitCommitOverride?: string | null;
    nodeEnv?: string;
} = {}): string {
    const explicit = String(input.explicitReleaseId ?? process.env.SANDEAL_RELEASE_ID ?? process.env.GIT_COMMIT_SHA ?? '').trim();
    const nodeEnv = input.nodeEnv ?? process.env.NODE_ENV;
    let gitCommit = '';
    if (input.gitCommitOverride !== undefined) {
        gitCommit = String(input.gitCommitOverride || '').trim().toLowerCase();
    } else {
        try {
            gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim().toLowerCase();
        } catch {
            // Production builds fail below; development can retain an explicit label.
        }
    }
    const explicitCommit = GIT_SHA.test(explicit) ? explicit.toLowerCase() : '';
    if (explicit && !explicitCommit && nodeEnv === 'production') throw new Error('SANDEAL_RELEASE_ID_GIT_SHA_REQUIRED');
    if (gitCommit && !GIT_SHA.test(gitCommit)) throw new Error('GIT_HEAD_SHA_INVALID');
    if (explicitCommit && gitCommit && explicitCommit !== gitCommit) throw new Error('SANDEAL_RELEASE_ID_GIT_HEAD_MISMATCH');
    if (explicitCommit || gitCommit) return explicitCommit || gitCommit;
    if (nodeEnv === 'production') throw new Error('SANDEAL_RELEASE_ID_GIT_SHA_REQUIRED');
    return explicit || 'development';
}

const buildCommit = resolveBuildCommit();
const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "media-src 'self' https:",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    ...(process.env.NODE_ENV === 'production' ? ['upgrade-insecure-requests'] : []),
].join('; ');

const nextConfig: NextConfig = {
    deploymentId: buildCommit,
    env: {
        SANDEAL_BUILD_MANIFEST_COMMIT: buildCommit,
        SANDEAL_BUILD_COMMIT: buildCommit,
        NEXT_PUBLIC_SANDEAL_RELEASE_ID: buildCommit,
    },
    images: {
        remotePatterns: [
            {
                protocol: 'https',
                hostname: 'product.hstatic.net',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 'hstatic.net',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 'cdn.hstatic.net',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 'file.hstatic.net',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 'cf.shopee.vn',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 'down-vn.img.susercontent.com',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 'img.lazcdn.com',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 'salt.tikicdn.com',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 'salt.tikicdn.com',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 'salt.tikicdn.com',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 'salt.tikicdn.com',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: '*.alicdn.com',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: '*.alicdn.com',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: '*.lazcdn.com',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: '*.susercontent.com',
                pathname: '/**',
            },
        ],
        formats: ['image/avif', 'image/webp'],
    },

    async headers() {
        return [
            {
                source: '/:path*',
                headers: [
                    {
                        key: 'X-DNS-Prefetch-Control',
                        value: 'on',
                    },
                    {
                        key: 'X-SanDeal-Build-Id',
                        value: buildCommit,
                    },
                    {
                        key: 'X-SanDeal-Release-Id',
                        value: buildCommit,
                    },
                    {
                        key: 'Content-Security-Policy',
                        value: contentSecurityPolicy,
                    },
                    {
                        key: 'Referrer-Policy',
                        value: 'strict-origin-when-cross-origin',
                    },
                    {
                        key: 'X-Content-Type-Options',
                        value: 'nosniff',
                    },
                    {
                        key: 'Permissions-Policy',
                        value: 'camera=(), microphone=(), geolocation=()',
                    },
                    {
                        key: 'Cross-Origin-Opener-Policy',
                        value: 'same-origin',
                    },
                ],
            },
        ];
    },
};

export default nextConfig;
