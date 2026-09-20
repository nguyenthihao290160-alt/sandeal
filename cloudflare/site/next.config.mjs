import path from 'node:path';
import { fileURLToPath } from 'node:url';
import builder from '../../scripts/v6-cloudflare-build.cjs';
const siteDirectory = path.dirname(fileURLToPath(import.meta.url));
const buildEnvironment = builder.siteBuildEnvironment({ environment: process.env.SANDEAL_SITE_ENVIRONMENT ?? 'LOCAL', origin: process.env.NEXT_PUBLIC_SITE_URL });
const nextConfig = {
  output: 'export', trailingSlash: true,
  images: { unoptimized: true },
  turbopack: { root: path.resolve(siteDirectory, '../..') },
  env: { NEXT_PUBLIC_SANDEAL_RUNTIME: 'cloudflare', NEXT_PUBLIC_SITE_URL: buildEnvironment.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_SANDEAL_ENVIRONMENT: buildEnvironment.NEXT_PUBLIC_SANDEAL_ENVIRONMENT },
};
export default nextConfig;
