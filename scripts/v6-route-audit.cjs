/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const { root } = require('./v6-run-state.cjs');
const routes = new Map();
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filename);
    else if (/^(?:page|route)\.(?:ts|tsx)$/.test(entry.name)) {
      const relative = path.relative(path.join(root, 'src/app'), filename).replaceAll('\\', '/');
      const route = '/' + relative.replace(/(?:^|\/)(?:page|route)\.(?:ts|tsx)$/, '');
      routes.set(route, `src/app/${relative}`);
    }
  }
}
walk(path.join(root, 'src/app'));
for (const route of ['/_next/static/*', '/* (unknown static)', '/api', '/api/* (unsupported)', '/go', '/product', '/api/public/products/[slug]/offers', '/api/public/affiliate/health',
  '/api/admin/settings/automation', '/api/admin/settings/scheduler', '/api/admin/products/[id]/publication']) routes.set(route, 'Cloudflare additive entrypoint');
for (const name of ['robots', 'sitemap', 'manifest', 'icon', 'apple-icon', 'opengraph-image']) routes.set('/' + name + ({ robots: '.txt', sitemap: '.xml', manifest: '.webmanifest' }[name] || ''), `src/app/${name}`);
function classify(route) {
  if (route === '/_next/static/*') return ['STATIC', 'Next export JS/CSS assets', 'NO', 'public max-age=31536000 immutable', 'NO'];
  if (route === '/* (unknown static)') return ['STATIC', 'Exported application 404 page; HTTP 404', 'NO', 'Static asset host revalidation', 'NO'];
  if (['/api', '/api/* (unsupported)', '/go'].includes(route)) return ['DYNAMIC_API', 'Worker sanitized 501; no asset fallback', 'YES', 'no-store', 'NO'];
  if (['/', '/deals', '/product', '/review-methodology', '/thong-tin/[slug]'].includes(route)) return ['STATIC', 'Next export shell or authored content; catalogue uses live API', 'NO', 'HTML revalidate on build; hashed assets immutable', 'NO'];
  if (route === '/deals/[slug]') return ['STATIC', 'Static detail shell gated by live D1 publication', 'YES', 'no-store; product data never embedded', 'NO'];
  if (route.startsWith('/api/admin/')) return ['ADMIN_DYNAMIC', 'D1; explicit Basic auth and same-origin writes', 'YES', 'no-store', 'YES'];
  if (['/api/health', '/api/health/live', '/api/health/ready', '/api/public/products', '/api/public/products/[slug]', '/api/public/products/[slug]/offers', '/api/public/affiliate/health', '/go/[productId]'].includes(route)) return ['DYNAMIC_API', route.includes('health') ? 'Runtime/D1/configured provider state' : 'D1 domain storage; existing public eligibility gate', 'YES', 'no-store; redirects recheck stored publication and allowlist', 'NO'];
  return ['LEGACY_ONLY', 'Existing Next/File/Mongo/provider/automation services; unavailable in Cloudflare foundation', 'NO (legacy server)', 'Existing legacy policy; no Cloudflare caching', route.startsWith('/api/') && !route.startsWith('/api/public/') || route.startsWith('/dashboard') ? 'YES' : 'NO'];
}
const rows = [...routes].sort(([a], [b]) => a.localeCompare(b)).map(([route, source]) => [route, ...classify(route), source]);
const counts = Object.fromEntries(['STATIC', 'STATIC_REVALIDATABLE', 'DYNAMIC_API', 'ADMIN_DYNAMIC', 'LEGACY_ONLY'].map(kind => [kind, rows.filter(row => row[1] === kind).length]));
const text = `# Cloudflare route map\n\nGenerated from every existing App Router page/route and metadata route plus the additive Worker API. Regenerate with \`node scripts/v6-route-audit.cjs\`. No Pages Router, Server Actions, or ISR configuration is present. This classifies the Cloudflare foundation, not the legacy Next rendering mode.\n\n${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join('\n')}\n\nSTATIC_REVALIDATABLE is deliberately unused until durable invalidation and withdrawal correctness are implemented. Public shell assets contain no mutable catalogue data. The legacy SSR search, ranking, comparison, taxonomy/SEO, analytics and full dashboard remain available only through the preserved legacy app. Unsupported API requests return a sanitized 501; no File fallback is allowed.\n\n| ROUTE | CLASS | DATA_SOURCE | WORKER_REQUIRED | CACHE_STRATEGY | PRIVATE_DATA | SOURCE |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.map(row => '| ' + row.join(' | ') + ' |').join('\n')}\n`;
fs.writeFileSync(path.join(root, 'docs/v6/CLOUDFLARE_ROUTE_MAP.md'), text);
console.log(JSON.stringify({ routes: rows.length, counts }));
