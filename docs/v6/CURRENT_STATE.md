# SanDeal V6 current-state audit

Audit date: 2026-09-06  
Starting branch: `master`  
Starting HEAD: `3f2ee7d8bd1ef57fa9207f021cc03519b7eecde7`  
Starting worktree: DIRTY (pre-existing user changes were present and preserved)  
Audit scope: local repository only. Production, VPS, PM2, provider accounts, live credentials, DNS, and deployed health are **UNVERIFIED**.

The initial worktree already contained modifications to `docs/operations/AUTOMATION_JOB_HISTORY_ARCHIVE.md`, `ecosystem.config.cjs`, `package.json`, `scripts/automation-scheduler.cjs`, `scripts/automation-worker.cjs`, `scripts/prompt10-self-healing-tests.cjs`, `scripts/runtime-fence-commit-window-tests.cjs`, `src/lib/automation/featureRollout.ts`, `src/lib/automation/jobHistoryArchive.ts`, `src/lib/automation/postPublishMonitor.ts`, `src/lib/automation/runtimeRoles.ts`, `src/lib/storage/adapter.ts`, `src/lib/storage/fileStorageAdapter.ts`, and `src/lib/storage/types.ts`, plus untracked V5 history/repair/scheduler test and implementation files. Those changes are not Phase 1 output.

## 1. CURRENT ARCHITECTURE

- Application: one existing Next.js App Router application in `src/app`; this audit did not create a second application.
- Versions: Next.js `16.2.11`, React/React DOM `19.2.4`, TypeScript `^5`, Node engine `>=20.9.0 <25`, npm `11.6.2`.
- TypeScript: `strict: true`, `noEmit: true`, bundler module resolution, `@/*` mapped to `src/*`.
- Build: `npm run build` runs `scripts/write-build-manifest.cjs` then `next build`. `next.config.ts` embeds and validates Git/release identity, configures remote images, and emits CSP and security headers.
- Rendering/runtime: storefront pages and many API routes explicitly use `force-dynamic`; several routes explicitly select `nodejs`. `next.config.ts` does not set `output: 'export'`. No Edge runtime declaration was found.
- Server/API: about 75 App Router API route files cover products, automation, AI bots, dashboard, product sources, public events, health, and token-vault operations.
- Durable automation: `automation-jobs` is the main queue in `src/lib/automation/store.ts`; `src/lib/automation/worker.ts` claims and executes jobs; `src/lib/automation/scheduler.ts` enqueues due jobs.
- Runtime processes: `scripts/automation-worker.cjs` and `scripts/automation-scheduler.cjs` are long-lived Node entry points. `ecosystem.config.cjs` defines web plus opt-in worker/scheduler PM2 processes.
- Cloudflare target state: no Cloudflare, Wrangler, D1, Cloudflare Queue, Cloudflare Cron Trigger, Next static-export, or Edge-runtime implementation was found in tracked application/configuration code.
- Production deployment state: **UNVERIFIED**.

## 2. STORAGE MAP

- Existing boundary: `StorageAdapter` is already defined in `src/lib/storage/types.ts`; the compatibility facade is `src/lib/storage/adapter.ts`, and selection is in `src/lib/storage/storageFactory.ts`/`storageConfig.ts`.
- Default: `SANDEAL_STORAGE_DRIVER` defaults to `file`. Unknown drivers fail with `INVALID_STORAGE_DRIVER`.
- File implementation: `src/lib/storage/fileStorageAdapter.ts`; defaults to `<repository>/.data` and can be redirected by `SANDEAL_DATA_DIR`. It implements JSON collection reads/writes, bounded reads, pagination, scanning, transactions, streaming transactions, atomic replacement, backups, renewable filesystem locks, exclusive scopes, bulk mutation, and health checks.
- Mongo implementation: `src/lib/storage/mongoStorageAdapter.ts`; opt-in only, requires `MONGODB_URI`, checks schema version, implements the same logical collection contract, and has no file fallback.
- Migration/acceptance tooling: inventory, manifest/checksum, isolated migration, shadow validation, logical backup/restore, rollback readiness, schema inspection/apply, and acceptance safety exist under `src/lib/storage` and `scripts`.
- Planned logical collections in `mongoSchema.ts` include products, product sources, candidate queue, content/drafts/packages, prices, alerts, growth/outbound events, evidence/lifecycle/publication, source quality/reliability, job/control/audit/attempt/circuit/SLO collections, role/fencing/recovery collections, bot/run/scheduler state, and token vault.
- Sensitive storage: `token-vault` exists and is excluded from migration inventory. Secret encryption uses AES-256-GCM when `TOKEN_VAULT_SECRET_KEY` is valid; new writes fail closed without the key. Legacy plaintext/base64 read compatibility remains.
- Local `.data` directory at audit time: present and empty. Whether deployed production uses this directory, an external path, or Mongo is **UNVERIFIED**.
- Cloudflare D1 storage adapter: not present.

## 3. AUTOMATION MAP

- Queue creation and idempotency: `createAutomationJob`/`createAutomationJobsBatch` in `src/lib/automation/store.ts` persist job contracts, attempts, control state, audit, AI usage, and circuits.
- Worker: `src/lib/automation/worker.ts` provides bounded batch and continuous-pool execution, job ordering, handler dispatch, retries, checkpoints, job leases, abort handling, and completion/failure persistence.
- Worker entry: `scripts/automation-worker.cjs` loops until stopped (unless `--once`), polls for work, backs off while idle/failing, acquires a single durable WORKER role, renews role heartbeat timers, and fails closed on fencing/lease loss.
- Scheduler core: `src/lib/automation/scheduler.ts` schedules Runtime Guardian, reconciliation, AutoPilot, health rechecks, scoring, price history, alerts, and growth aggregation as durable jobs.
- Scheduler entry: `scripts/automation-scheduler.cjs` polls every 30 seconds (unless `--once`), acquires a durable SCHEDULER role, uses heartbeat/watchdog timers, and checks ownership between enqueue stages.
- HTTP scheduler: `/api/ai-bots/scheduler/tick` is a secret-protected enqueue-only endpoint. Legacy scheduler settings/state also exist under `src/lib/bots/automationScheduler.ts` and `schedulerConfig.ts`.
- Coordination: filesystem/Mongo transactions, job claim leases, runtime role leases, renewable role fencing, run locks, heartbeats, idempotency keys, operation journal, and projection manifests are all used.
- Cloudflare Queue and Cron implementations: not present.

## 4. AFFILIATE MAP

- AccessTrade integration: `src/lib/integrations/accesstrade.ts` implements bounded requests to AccessTrade datafeeds and offers endpoints, local keyword matching/pagination, normalization, kind classification, provider/canonical/affiliate URL separation, sanitized diagnostics, and credential readiness. Credentials come from Token Vault or `ACCESS_TRADE_API_KEY`.
- AccessTrade source adapter: `createAccessTradeSourceAdapter` in `src/lib/autonomous/sourceAdapterPlatform.ts` wraps discovery, health/configuration, budget, error classification, retry-after, normalization, and safe disclosure.
- TikTok integration: `src/lib/integrations/accesstradeTikTokShop.ts` implements AccessTrade TikTok Shop Product Feed V2 discovery and create-link operations with bounded pages/items/attempts/timeouts, per-domain circuits, typed errors, sanitized request logs, tracking fields, and deterministic normalization.
- TikTok source adapter: `createAccessTradeTikTokSourceAdapter` wraps discovery and post-selection affiliate-link creation; source identity is `accesstrade_tiktok_shop` and credential authority remains AccessTrade.
- Product model: `ProductOffer`, multi-offer selection fields, source mappings, commission fields, affiliate health, tracking status, and redirect destination fields already exist.
- Shopee: domain/source/UI/type placeholders and legacy example names `SHOPEE_AFFILIATE_APP_ID`/`SHOPEE_AFFILIATE_SECRET` exist, but no Shopee API client/provider was found. The product-sources dashboard labels Shopee a future provider. Live Open API access and credentials are **UNVERIFIED** by code and, per phase input, pending/unavailable.
- Transactions/commission synchronization: no provider-neutral sync implementation was found. Existing commission values are offer/product observations, not transaction reconciliation.

## 5. AI MAP

- Registry/router: `src/lib/automation/providerRegistry.ts` declares deterministic-rules, Gemini, and local-AI provider metadata; `providerRouter.ts` chooses API/local/manual execution using policy, credentials, circuits, and quotas.
- Gemini: credential truth/probing/routing, free-model allowlist, quota groups, daily usage, diagnostics, strict canonical proposal parsing, and evidence-bound editorial review are implemented under `src/lib/ai`.
- Local AI: `LocalAiAdapter` permits loopback HTTP only, applies resource/concurrency/queue/response-size gates, checks a versioned canonical contract, and is feature-gated.
- Cost safety: `config.ts`/`costGuard.ts` default to safe/free behavior; paid AI is not enabled by this audit.
- Gap: the existing registry is a declaration/routing contract, not one common executable `AiProvider` interface across implementations.

## 6. STOREFRONT MAP

- Public routes: `/`, `/deals`, `/deals/[slug]`, category and brand taxonomy routes, `/compare`, review methodology, and `/go/[productId]`.
- Read model: `src/lib/product-intelligence/publicProducts.ts` produces allowlisted card/detail/comparison/taxonomy DTOs with bounded filters, pagination, ranking, suggestions, related items, price movement, and public-safe review projection.
- Safety: `src/lib/publicProductFilter.ts` is the central public-product filter; only eligible products reach storefront DTOs. Recovery-canary pending records are hidden from detail output.
- UX: shared public header/footer/search/filter/cards/gallery/comparison/tracking components and CSS modules are present.
- Current pages are dynamically rendered from server storage. Static-first storefront generation is not implemented.

## 7. SEO MAP

- Root metadata, manifest/icons/Open Graph images, robots, and sitemap are implemented in `src/app`.
- Product SEO: canonical URLs, indexability decisions, safe metadata, Product JSON-LD, breadcrumbs, related products, evidence-bound FAQ, and stable modified dates are in `src/lib/seo/productSeo.ts`.
- Taxonomy SEO: canonical paginated routes, thin/filtered noindex decisions, breadcrumbs, item lists, and FAQ JSON-LD are in `taxonomySeo.ts`.
- Structured-data safety: centralized serialization escapes script/HTML breakers; only verified public HTTPS URLs are emitted.
- Sitemap reads current public products dynamically. Static SEO publication/export automation is not present.

## 8. REVENUE MAP

- Redirect integrity: `/go/[productId]` selects the best/primary offer, validates public eligibility, affiliate/product URL consistency, merchant/source consistency, health/expiry/tracking, and external URL safety before a 302 redirect.
- Click attribution: countable outbound clicks are recorded server-side; bot/prefetch traffic is excluded.
- Analytics: `src/lib/product-intelligence/growth.ts` stores allowlisted categorical events in `outbound-events`, aggregates `growth-daily`, calculates funnel/CTR/top product/source/content summaries, and reports revenue-integrity health.
- Privacy: public event ingestion stores classified referrer/device categories, bounded IDs, and no raw IP/full user-agent/full referrer URL in the event contract.
- Revenue truth: `revenueAvailable` is explicitly `false`; redirect successes, transactions, commissions, and realized revenue attribution are not implemented. Provider transaction/commission sync is absent.

## 9. VPS-COUPLED COMPONENTS

- `ecosystem.config.cjs`: PM2 process topology, fork mode, auto-restart, memory/restart limits, release environment, and shared absolute data path.
- `scripts/automation-worker.cjs`: persistent process lifetime, OS hostname/PID/process uptime/signals, polling/backoff loops, timers, role leases, role heartbeats, and watchdog shutdown.
- `scripts/automation-scheduler.cjs`: persistent process lifetime, OS hostname/PID/signals, 30-second polling, timers, role leases, heartbeats, and watchdog shutdown.
- `src/lib/storage/fileStorageAdapter.ts`: local `.data` path, Node filesystem/path/OS/process APIs, filesystem lock files, temporary files, backups, PID liveness, and atomic rename/sync behavior.
- `src/lib/autonomous/backupManager.ts`: local filesystem snapshots and storage inspection.
- `src/lib/health/readiness.ts`: filesystem `statfs` disk checks and local storage-root inspection.
- `src/lib/automation/runtimeGuardian.ts`: reads `.next/BUILD_ID`, evaluates process role leases/heartbeats/restarts, and inspects local storage/disk state.
- Release/deploy tooling and runbooks: PM2, `/var/www/...`, VPS cron, Nginx, shell deploy/rollback, and Ubuntu/VPS operator checks are explicit.
- `src/lib/bots/schedulerConfig.ts` directly reads/writes `scheduler-config.json` below `getDataDir()` instead of a logical storage collection.
- `src/lib/product-intelligence/importer.ts` writes rejection artifacts to a local test path; migrations and repair/release scripts also use filesystem paths.

## 10. COMPONENTS TO KEEP

- Canonical product, offer, lifecycle, evidence, price truth, confidence, policy, public safety, and revenue-integrity domain logic.
- Existing `StorageAdapter` contract and both FileStorage/Mongo implementations.
- Durable automation job schema, idempotency, journal, audit, policy registry, handler separation, and fail-closed publication gates.
- AccessTrade and AccessTrade TikTok clients plus their existing source adapters and regression suites.
- Gemini canonical/evidence contracts, credential safety, cost guard, and deterministic/local fallback logic.
- Public DTO/filtering boundary, storefront components, SEO helpers, structured-data safety, analytics event allowlist, auth helpers, health response separation, and secret redaction/encryption.

## 11. COMPONENTS TO ADAPT

- Wrap AccessTrade/TikTok behavior behind a provider-neutral affiliate contract without changing their working integrations.
- Add explicit runtime selection with legacy default and fail-closed unknown values.
- Put existing durable job enqueue, scheduler ticks, AI execution metadata, and growth analytics behind named adapter contracts.
- Add future Cloudflare implementations for storage, queue, scheduler, and analytics without changing business service signatures.
- Split Runtime Guardian/readiness checks into platform-neutral capability checks plus legacy filesystem/process checks.
- Move remaining direct scheduler-config file access behind storage/config adapters.
- Evolve dynamic storefront reads toward a generated/static public projection in a later phase.

## 12. COMPONENTS TO RETIRE

Retirement is future work; nothing is deleted in Phase 1.

- PM2 ecosystem and guarded VPS deploy/rollback paths after Cloudflare parity and rollback evidence exist.
- Persistent worker/scheduler polling loops after Cloudflare Queue consumers and Cron Triggers are proven.
- Filesystem lock/PID-liveness/heartbeat mechanisms after no active workload depends on FileStorage coordination.
- VPS cron shell template and legacy direct-workflow compatibility flag after replacement runtime acceptance.
- Legacy direct JSON config files after all config is on an adapter-backed durable store.

## 13. TEST INVENTORY

Test harness: repository-owned Node `.cjs` regression scripts plus `tsc`, ESLint, build, release scans, and smoke scripts. There is no Jest/Vitest dependency.

- Product-first: `product-first-bounded-accesstrade-tests.cjs`, `product-first-pipeline-worker-tests.cjs`.
- AccessTrade: `accesstrade-link-safety-tests.cjs`, product-first suites, `prompt10-business-source-tests.cjs`, and cleanup/probe tools (the live probe is not a regression test and was not run in this phase).
- AccessTrade TikTok: `accesstrade-tiktok-integration-tests.cjs`; includes normalization, bounded pagination/retry/abort, secret safety, create-link, source isolation, idempotency, candidate flow, and FileStorage compatibility.
- Prompt 08: product intelligence, import/dedupe, Content Studio, growth/alerts/links, backend hardening.
- Prompt 09: bot foundation, operations, storefront, SEO/analytics, and an isolated runtime smoke.
- Prompt 10: foundation, runtime, job schema, shadow safety, orchestration, lifecycle/storage/security, zero-touch, autopublish, SLO, self-healing, resilience, backup, source, search/SEO, revenue integrity, dashboard, and launch inventory.
- Storage: file adapter Phase 1A, fake-Mongo adapter, migration, shadow, acceptance, bounded parity/projection, V5 history durability, locks/fences/leases.
- SEO/storefront/analytics: Prompt 09 C/D, Prompt 10 business search/SEO, Master M5 platform/SEO, PWA metadata.
- Production readiness/health: Prompt 13 production readiness, production health/readiness regression, operational truth, master runtime/health/release suites, local CSP/security suites.
- Package scripts expose focused groups including `test:product-first`, `test:accesstrade`, `test:accesstrade-tiktok`, `test:prompt08`, `test:prompt09`, `test:prompt10:*`, `test:source-reliability`, `test:storage*`, `test:production-readiness`, `typecheck`, `lint`, and `build`.
- Historical test results written in existing documentation were not treated as current evidence. Phase 1 execution results belong in `docs/v6/phase-01-foundation.md`.

## 14. RISKS

- The worktree was already dirty in critical runtime/storage files. Phase 1 must avoid overwriting or attributing those changes and cannot provide a clean-tree release result.
- Current production runtime/storage/data/credentials/health are **UNVERIFIED**.
- FileStorage and the current Worker/Scheduler coordination rely on Node filesystem and persistent-process semantics unavailable in Cloudflare Workers.
- Storefront/API routes are dynamic and use features unsupported by plain Next static export; a static-first cutover needs a separate projection/route plan.
- No Cloudflare resource/configuration code exists yet, so D1/Queue/Cron parity is **UNVERIFIED**.
- Shopee Open API is not implemented and external approval/credentials are unavailable; any healthy/live state would be false.
- AccessTrade configured state is intentionally not equivalent to live readiness; live provider behavior was not probed during this audit.
- Real transaction, commission, redirect-success, and revenue synchronization are absent; analytics must not claim revenue.
- Basic Auth is optional and disabled unless configured; many admin handlers rely on the shared proxy/`requireAuth` policy. Production auth configuration is **UNVERIFIED**.
- `src/lib/security/secrets.ts` retains legacy plaintext/base64 read compatibility. New writes are protected, but the state of historical production records is **UNVERIFIED**.
- Health/readiness currently reports process, disk, `.next`, and file-storage concepts that require platform-specific adaptation.
- The repository contains both current durable automation and older bot scheduler/config compatibility paths, increasing migration and accidental-execution complexity.
- The initial `.env.example` used Shopee variable names that do not match the requested future contract; compatibility and migration naming must be explicit.
