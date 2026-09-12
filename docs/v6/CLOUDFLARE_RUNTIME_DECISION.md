# Cloudflare runtime decision

SELECTED_RUNTIME_ADAPTER=NEXT_STATIC_EXPORT_PLUS_WORKERS_ASSETS_AND_WORKER_API
ALTERNATIVES_REJECTED=OPENNEXT_FOR_THIS_PIN;VINEXT_BETA_FOR_THIS_FOUNDATION;NODE_OR_PM2_SERVER
REASONS=INSTALLED_NEXT_COMPATIBILITY;STATIC_PUBLIC_SHELLS;EXPLICIT_D1;NO_PERSISTENT_FILESYSTEM;LOCAL_TESTABILITY;ADDITIVE_ROLLBACK

The installed version is Next.js 16.2.11 with React 19.2.4 and Wrangler 4.129.1. Its bundled deployment, route-handler and static-export guides were read before coding. The selected path uses the existing Next compiler and officially supported static export, Workers Assets and a module Worker API. It adds `cloudflare/site/`, `cloudflare/worker.ts` and runtime modules without replacing the root app or root Next config.

On 2026-09-09, npm metadata for `@opennextjs/cloudflare@1.20.6` declares `next >=15.5.24 <16 || >=16.3.3`, excluding this repository's pin. OpenNext also documents limited Windows support and a Node middleware gap. Installing it would require a framework/version decision beyond simply attaching D1. Its general compatibility page says Next 16 is supported, but the exact package peer constraint controls this pinned build. See [OpenNext compatibility](https://opennext.js.org/cloudflare) and [package metadata](https://registry.npmjs.org/@opennextjs/cloudflare/1.20.6).

Cloudflare now recommends vinext but describes it as beta and requires checking compatibility. It reimplements Next APIs using Vite. This foundation prioritizes keeping the installed compiler and existing legacy behavior. It does not adopt a newer runtime merely because it is the default. See [Cloudflare Next.js guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/).

Next static export explicitly supports build-time Server Components and browser API fetching but excludes request-dependent route handlers, SSR, Server Actions, proxy and ISR. Those boundaries are used here: authored information pages reuse the existing page implementations; catalogue shells reuse the existing public components and CSS; live product facts come from the Worker API. See [Next static exports](https://nextjs.org/docs/app/guides/static-exports) and [Workers Assets bindings](https://developers.cloudflare.com/workers/static-assets/binding/).

## Actual compatibility audit

The application uses App Router only. Root, deals, product detail, comparison, taxonomy and sitemap use forced dynamic server rendering. Their services call whole-collection product/history functions, then filter, sort and rank in memory. Routing them unchanged through D1 would either fail its deliberately unsupported collection capability or introduce unbounded reads. The new catalogue API uses one indexed published-product page (maximum 50) and a cursor; it makes no total-catalogue count claim. Detail is an indexed slug read plus at most 30 history rows. Existing public eligibility and canonical validation remain authoritative.

`src/proxy.ts` implements dashboard/API Basic auth using Node crypto and environment variables. Legacy auth can be disabled; the new admin API requires configured credentials and never inherits that permissive default. Existing route handlers include privileged imports, token-vault operations, bot/automation commands, filesystem import handling and process/runtime diagnostics. They are classified LEGACY_ONLY instead of being pulled into the new Worker. No Server Actions, active ISR or `next/font` imports were found. Authored information uses `generateStaticParams`; `next/image` already has a passthrough loader and unoptimized product images. The static build also explicitly disables server image optimization.

Legacy libraries depend on FileStorage, file settings/locks, Mongo, `process.cwd`, process identity, heartbeat/lease loops, DNS-pinned Node HTTP probes and runtime roles. They remain available to the legacy build. The Worker graph has only `node:crypto` and `node:async_hooks` external imports. A build-scoped storage factory requires a request-scoped D1 adapter and cannot construct File/Mongo adapters. The build fails if those modules or filesystem settings appear in its graph. The only shared production edit is changing AccessTrade's URL-validator import from its Node networking re-export to the exact existing pure implementation; behavior is unchanged.

The root `next.config.ts` still resolves Git identity with build-time child_process and retains its headers and image configuration. `npm run build:validate` remains the repository's dirty-worktree-safe legacy build. The separate static config does not load root environment files or release credentials. Its artifacts are explicitly local and noindex.

## Scope and rollback

The Cloudflare foundation supports static public shells/information pages; live product, offer, publication and bounded history reads; liveness/readiness/provider status; authenticated non-secret settings and publication diagnostics; guarded stored affiliate redirects. Existing URLs `/deals/[slug]` serve a shell after a live publication check. HTML never embeds products, so an archived product cannot remain in a static catalogue artifact. Catalogue API responses and redirects use no-store. Static hashed assets can be immutable.

Compatibility gaps are explicit: advanced search/ranking and full-catalogue totals, taxonomy/comparison, dynamic product SEO/OG/sitemap generation, analytics, full dashboard/token-vault and live external provider operations stay legacy-only. No claim of feature-complete production cutover is made. These gaps do not block the requested local runtime and event foundation; each requires its own bounded D1 domain support before activation.

Rollback is selecting the existing root `dev`, `start`, `build`/`build:validate`, File/Mongo mode and existing worker/scheduler/PM2 configuration. No file, data store or legacy implementation was removed. No DNS, Cloudflare account, production resources or deployment was used.

Local proof uses the workerd-backed Miniflare installed with Wrangler. Its version 5 API requires the package's exported `convertV4MiniflareOptions` converter for the documented local options shape. No remote proxy or remote bindings are configured. The test includes actual compiled static assets and the same Worker-first route rules as the local Wrangler configuration.
