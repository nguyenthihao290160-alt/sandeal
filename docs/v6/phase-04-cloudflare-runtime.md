# Phase 4 — local Cloudflare runtime

SELECTED_RUNTIME_ADAPTER=NEXT_STATIC_EXPORT_PLUS_WORKERS_ASSETS_AND_WORKER_API
STATIC_STOREFRONT=PASS
STATIC_SITE=PASS
WORKER_API=PASS
ASSET_ROUTING=PASS
CLOUDFLARE_LOCAL_RUNTIME=PASS
D1=PASS_LOCAL
D1_LOCAL=PASS
FILE_STORAGE_CALLS=0
FILESYSTEM_SETTINGS_CALLS=0
PM2_REQUIRED=NO
VPS_REQUIRED=NO
LONG_RUNNING_PROCESS_REQUIRED=NO
SHOPEE_REQUIRED=NO
LEGACY_RUNTIME_PRESERVED=YES
CLOUDFLARE_LOGIN_USED=NO
PRODUCTION_RESOURCE_CREATED=NO
REMOTE_DATA_MIGRATED=NO
DEPLOYED=NO
TESTS_PASSED=207
TESTS_FAILED=0
RESULT=PASS
SAFE_FOR_PHASE_4_5=YES

Closed locally on 2026-09-09, branch `master`, HEAD `3f2ee7d8bd1ef57fa9207f021cc03519b7eecde7`. The pre-existing dirty worktree is preserved. Phase 3's 159 focused cases and Phase 3.5's 14-case shadow proof are reused: their migration/storage implementation hashes and shadow fixture/test hashes match the captured evidence. No expensive migration matrix was repeated. The 98/98 parity, zero missing/extra/conflicting records and zero-change second apply remain recorded in the Phase 3.5 checkpoint.

## Resume boundary and fixes

Persisted evidence contained 14 Worker API passes and four completed site passes, although the long-run state still said RUNNING. The Worker entrypoint and static config had subsequently changed. The first unverified step was therefore integrated routing against those sources, including actual JS/CSS responses. The static build was rerun once for the changed config; the Worker was rebuilt after its routing fix.

Eleven added routing cases exposed two defects: the exact `/api` root fell through to static assets, and direct Worker static handling constructed D1 context. Exact `/api` and `/go` roots now use Worker-first routing and sanitized 501 responses; static handling occurs before D1 construction. Both negative checks now pass. The first 9-pass/2-failure reproduction is retained in `.test-tmp/v6-resume-3-9P80ZY/`.

## Routing and data proof

The repeatable tests instantiate actual workerd/Miniflare, compiled Worker code, Next export assets and ephemeral local D1. The asset rules are read from the same local Wrangler config. Tests retrieve every JavaScript/CSS URL referenced by the home HTML and verify content type, non-HTML bytes and immutable caching. `/`, `/deals/`, authored information pages and the static product shell work. `/deals/[slug]` checks live D1 publication before serving `/product/`; withdrawal makes both the public detail API and product URL return 404. Unknown static routes use the exported 404 with HTTP 404, including without D1.

`/api/health`, `/api/health/live`, `/api/health/ready` (repository readiness equivalent), `/api/public/products` (catalogue equivalent), authenticated admin settings/publication diagnostics, and `/go/[productId]` are exercised through the combined router. Navigation headers do not make APIs fall through to HTML. Unknown APIs and legacy dashboard routes return sanitized 501; public POST requests cannot mutate settings. There is no SPA fallback for API paths.

All exported HTML and flight text is checked for mutable fixture records/private fields. Catalogue data comes from one published-status/ID indexed D1 page, limit 1–50, with a keyset cursor. The unchanged publication gate additionally filters hidden/unsafe/canary products. A page is not refilled by scanning; there is no fabricated total. SQL EXPLAIN proves `SEARCH ... products_status_id`. Detail uses a slug lookup and at most 30 history records. Public DTO allowlists exclude affiliate targets, source mappings, admin notes and commission/revenue fields.

The complete [route map](CLOUDFLARE_ROUTE_MAP.md) has 124 route patterns with ROUTE, CLASS, DATA_SOURCE, WORKER_REQUIRED, CACHE_STRATEGY and PRIVATE_DATA. Static revalidation is deliberately unused; catalogue API, private responses and redirects are no-store. Advanced legacy search/ranking, taxonomy/SEO, analytics and the full dashboard remain explicitly LEGACY_ONLY.

## Security and legacy evidence

Configured Basic authentication is mandatory for admin APIs. Missing credentials/binding fail closed; invalid headers reject. Writes require same origin, JSON, an allowlisted non-secret settings object, and a 65,536-byte body limit including chunked bodies. URL input cannot supply an affiliate destination: redirects use a published stored HTTPS URL, the existing URL validator, verified affiliate status and an exact configured host allowlist. Invalid scheme/port/subdomain, unpublished records and absent allowlists reject. Security headers cover assets, JSON and errors. Driver error text and secret bindings are neither logged nor returned; a logging spy verifies sanitized failures.

The Worker build rejects FileStorage, Mongo, filesystem-settings and legacy process imports, and permits only `node:crypto`/`node:async_hooks` external dependencies. The nine-case zero-VPS storage regression also uses throwing FileStorage/filesystem spies with measured zero calls. Build-time tooling and the local emulator use filesystem/processes; deployed event handling has no SanDeal daemon or persistent-filesystem requirement.

The root Next app/config, FileStorage, Mongo, PM2 ecosystem, `automation-worker.cjs`, `automation-scheduler.cjs`, and legacy queue/scheduler remain present. Existing runtime, scheduler, rollout, publication and affiliate regressions pass. The legacy build uses the existing dirty-worktree validation mode and isolated test data; it is a local rollback/build proof, not a release artifact. Its existing Turbopack tracing warning remains. No commit/push occurred.

## Validation ledger

| Suite | Passed | Failed |
| --- | ---: | ---: |
| v6-cloudflare-runtime | 14 | 0 |
| v6-cloudflare-site | 4 | 0 |
| v6-cloudflare-routing | 11 | 0 |
| v6-d1 | 25 | 0 |
| v6-zero-vps-storage | 9 | 0 |
| v6-stabilization | 20 | 0 |
| scheduler-incumbent-regression | 1 | 0 |
| scheduler-role-heartbeat-regression | 3 | 0 |
| prompt10-runtime | 18 | 0 |
| prompt10-autopublish | 25 | 0 |
| accesstrade-link-safety | 34 | 0 |
| accesstrade-tiktok-integration | 43 | 0 |

TYPESCRIPT=PASS
ESLINT=PASS_0_ERRORS_14_EXISTING_SOURCE_WARNINGS_PLUS_20_GENERATED_WORKER_WARNINGS
SECRET_SCAN=PASS
BUILD_LEGACY=PASS_VALIDATION_ONLY
BUILD_CLOUDFLARE=PASS_STATIC_AND_WORKER
TESTS_SKIPPED=0
ASSERTIONS_WEAKENED=NO
BROWSER_INTERACTIVE=UNAVAILABLE_NO_BROWSER_CONNECTION

Suite ledger: `.test-tmp/v6-resume-3-SnTU7e/results.json`; runtime test recheck after the synthetic marker correction: `.test-tmp/v6-resume-3-iCHPX1/`. Quality logs: `.test-tmp/v6-runtime-quality-S8ZM0w/` and `.test-tmp/v6-runtime-quality-wBktyJ/`. Static build log: `.test-tmp/v6-cloudflare-worker/site-build.log`. Per-command hashes/exits are in `docs/v6/evidence/` and referenced by LONG_RUN_STATE. No live browser assertion is claimed; actual asset/Worker HTTP integration is tested locally.

The initial secret scan flagged a synthetic negative-test value; the fixture now uses the scanner's existing `local-test` convention. No scanner rule or negative assertion changed. The quality runner's first CLI-path lookup was corrected to the installed ESLint executable before successful validation.

Phase 4 passed before any Phase 4.5 implementation began. Local event-driven Queue/Cron foundation is the next authorized phase; production rollout remains disabled.
