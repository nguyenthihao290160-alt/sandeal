import type { NextConfig } from 'next';
import { execFileSync } from 'node:child_process';

const GIT_SHA = /^[0-9a-f]{40}$/i;

function resolveBuildCommit(): string {
    const explicit = String(process.env.SANDEAL_RELEASE_ID || process.env.GIT_COMMIT_SHA || '').trim();
    let gitCommit = '';
    try {
        gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim().toLowerCase();
    } catch {
        // Production builds fail below; development can retain an explicit label.
    }
    const explicitCommit = GIT_SHA.test(explicit) ? explicit.toLowerCase() : '';
    if (explicit && !explicitCommit && process.env.NODE_ENV === 'production') throw new Error('SANDEAL_RELEASE_ID_GIT_SHA_REQUIRED');
    if (gitCommit && !GIT_SHA.test(gitCommit)) throw new Error('GIT_HEAD_SHA_INVALID');
    if (explicitCommit && gitCommit && explicitCommit !== gitCommit) throw new Error('SANDEAL_RELEASE_ID_GIT_HEAD_MISMATCH');
    if (explicitCommit || gitCommit) return explicitCommit || gitCommit;
    if (process.env.NODE_ENV === 'production') throw new Error('SANDEAL_RELEASE_ID_GIT_SHA_REQUIRED');
    return explicit || 'development';
}

const buildCommit = resolveBuildCommit();

const nextConfig: NextConfig = {
    deploymentId: buildCommit,
    env: {
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
                ],
            },
        ];
    },
};

export default nextConfig;
