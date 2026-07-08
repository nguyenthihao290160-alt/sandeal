import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
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