import path from 'node:path';
import { fileURLToPath } from 'node:url';
const siteDirectory = path.dirname(fileURLToPath(import.meta.url));
const nextConfig = {
  output: 'export', trailingSlash: true,
  images: { unoptimized: true },
  turbopack: { root: path.resolve(siteDirectory, '../..') },
  env: { NEXT_PUBLIC_SANDEAL_RUNTIME: 'cloudflare' },
};
export default nextConfig;
