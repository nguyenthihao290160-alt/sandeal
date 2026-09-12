# Phase 2 — local D1 foundation

BRANCH=master
HEAD=3f2ee7d8bd1ef57fa9207f021cc03519b7eecde7
WORKTREE_DIRTY=YES
D1_LOCAL_ONLY=YES
PRODUCTION_D1_CREATED=NO
CLOUDFLARE_LOGIN_USED=NO
SHOPEE_CREDENTIALS_USED=NO
REAL_DATA_MIGRATED=NO

Phase 1.7R passed before any dependency, configuration, migration, or D1 implementation was created. The architecture gate and operation inventory remain the scope boundary; this is not a second application or a Cloudflare deployment of Next.js.

## Tooling and runtime boundary

WRANGLER_CONFIG=config/cloudflare/wrangler.local.jsonc
D1_ADAPTER=src/lib/storage/d1/d1StorageAdapter.ts:createD1StorageAdapter

Pinned official Wrangler 4.129.1 as the sole new direct development dependency. Its Node requirement is >=22; the verified machine uses Node 24.13.0. The legacy application's existing Node engine declaration is unchanged. npm-generated lockfile comparison found no existing package version upgrades; new optional/transitive tooling packages and lock metadata changed. Install used `--ignore-scripts`; local workerd bindings successfully ran without executing installation scripts.

The configuration contains only a documented all-zero local UUID, no account/zone/routes/entrypoint, disabled remote binding and telemetry, and an empty production binding environment. Local helpers pass the exact config, `envFiles: []`, `remoteBindings: false`, and either explicit ignored local persistence or `persist: false`. They never accept arbitrary remote DB/config/environment arguments. Wrangler's local binding API is used only by scripts, never imported by legacy application modules. [Official Wrangler API](https://developers.cloudflare.com/workers/wrangler/api/)

LEGACY_STORAGE_PRESERVED=YES_FILE_AND_MONGO
CLOUDFLARE_FILE_FALLBACK=NO

`createStorage({runtime:'cloudflare',bindings:{DB}})` selects the injected D1 implementation. Missing/invalid binding and unknown runtime reject before legacy construction. The default remains legacy. D1 methods do not import Cloudflare globals at module load. Request-scoped adapter injection is explicit and isolated; no global mutable DB singleton is used.

## Versioned domain schema

MIGRATIONS=src/lib/storage/d1/migrations/0001_product_storage.sql
TABLES=products; product_identities; product_offers; price_history; system_settings; product_audits
INFRASTRUCTURE_TABLES=d1_migrations; Cloudflare-managed local metadata

| Table | Existing authority and reason |
| --- | --- |
| products | Existing Product aggregate, including canonical ID, status/lifecycle/publication, revision and timestamps. Bounded private JSON preserves supported fields; not a public API DTO. |
| product_identities | Indexed projections of the three verified source/create/canonical identity namespaces; source mapping provenance stays in Product.sourceMappings. It is not the existing `product-sources` configuration collection. |
| product_offers | Atomic projection of existing Product.offers, not a new independent offer authority. Exact (product,id) uniqueness; source, merchant, prices, affiliate URL, health and observation fields preserved. |
| price_history | Maps the existing `price-history` / PriceSnapshot domain rather than inventing a second snapshot model. |
| system_settings | Only the existing automation and scheduler non-secret singleton domains. Environment/runtime/provider credentials excluded. |
| product_audits | Existing duplicate/evidence/publication audit events with effect-key replay identity; not a new job/lifecycle event model. |

DEFERRED_TABLES=standalone_merchants; standalone_categories; affiliate_links; conversions; commissions; deal_scores; content_versions; affiliate_click_aggregates; scheduled_tasks; job_runs; source_health

Merchants/categories/links and observed commissions are existing aggregate fields, not standalone canonical entities. No conversion or realized-commission ledger exists to migrate. Scores/reviews/content retain their existing ownership. Legacy source quality/reliability/circuit records and the distinct old/durable job domains require future capabilities; creating speculative tables would not implement them. Queue/Cron work remains outside this run.

Schema constraints include NOT NULL IDs/required fields, status checks, FK child ownership, exact source identity uniqueness, bounded JSON/text sizes and normalized UTC ISO timestamps. Canonical IDs are preserved when supplied; normal ingestion converges by deterministic indexed external identity. Product identity and offer projections are SQLite triggers in the same entity write: a constraint error rolls back the parent and every projection. Conditional updates return their own committed version, not a potentially newer readback.

INDEXED_DOMAIN_OPERATIONS=getProduct; getProductBySlug; findProductIdentity; listProducts; createProduct; replaceProduct; getPriceHistory; appendPriceSnapshot; appendProductAudit
CONDITIONAL_WRITE=ATOMIC_WHERE_ID_REVISION_CONTENT_TOKEN; APPLIED_CONFLICT_NOT_FOUND
BOUNDED_HISTORY=PRODUCT_TIME_ID_CURSOR_LIMIT_1_TO_730
SETTINGS_D1=ALLOWLISTED_NON_SECRET_SINGLETONS

## Index justification

INDEXES=DECLARED_BELOW_PLUS_REQUIRED_PRIMARY_AND_UNIQUE_CONSTRAINT_INDEXES

| INDEX_NAME | TABLE | QUERY_PATH | REASON |
| --- | --- | --- | --- |
| products ID unique | products | getProduct and CAS | Point entity lookup and conditional mutation |
| products slug unique | products | getProductBySlug / publication slug | Point lookup and race-safe slug uniqueness |
| products_status_id | products | listProducts(status,afterId,limit) | Bounded status-keyset page |
| product_source_identity_unique | product_identities | Exact source/external identity | Prevent two canonical owners; broad affiliate/title aliases deliberately not globally unique |
| product_identity_lookup | product_identities | namespace/key, ordered canonical insertion, LIMIT 2 | Preserve legacy first-match order and source ambiguity detection without scanning a catalog |
| product_identity_owner | product_identities | Projection replacement for one product | Bounded entity-owned deletion/reprojection |
| product_offers primary(product_id,id) | product_offers | Existing aggregate offer lookup/update | Entity-scoped uniqueness and projection replacement |
| price_history_product_time | price_history | Latest/recent product history and cursor | Indexed descending product/time/ID range; EXPLAIN verified |
| system_settings primary ID | system_settings | Settings read/write | Singleton point lookup |
| product_audits unique(kind,effect_key) | product_audits | Publication audit replay | Point idempotency lookup |

No updated-time, merchant, category, revenue, queue or source-health index was added for a query API that does not yet exist.

## Idempotency and query limits

IDEMPOTENCY=UNIQUE_SOURCE_IDENTITIES; PRODUCT_CAS; OFFER_PRIMARY_KEYS; AUDIT_EFFECT_KEYS; ATOMIC_PRICE_APPEND_IF_CHANGED

Concurrent source creates converge; conflicting identities leave no parent or orphan projections. Equivalent offer updates retain one projected row. A stale writer cannot overwrite prices, offers or publication state. Product-audit effect replay preserves the original event. Price replay by ID and adjacent unchanged hash is suppressed; a later return to a previous price remains a legitimate observation. The two-statement latest/read-plus-insert batch is atomic in D1. [D1 batch contract](https://developers.cloudflare.com/d1/worker-api/d1-database/)

Runtime lists have explicit limits/keyset or time cursors: products <=365; price history <=730; identity query <=8 keys, each LIMIT 2, then at most two product point reads. Writes bound each aggregate to 256 KiB, <=256 identities, <=50 offers; settings <=64 KiB; snapshots <=4 KiB; audits <=16 KiB. Raw provider payload fields and credential-shaped fields/URLs reject rather than being copied to hot rows. Non-finite/cyclic/executable JSON rejects. Telemetry exposes returned rows_read/rows_written metadata, not SQL parameters or invented billing amounts. Reads never write heartbeats or settings.

UNSUPPORTED_METHODS=GENERIC_COLLECTION_READ_SCAN_PAGE_WRITE_TRANSACTION_STREAMING_FILESYSTEM_EXCLUSIVE_AND_BULK_OPERATIONS

These return explicit D1_COLLECTION_OPERATION_UNSUPPORTED or the existing capability error; no full-array SQL emulation, FileStorage fallback or fake transaction capability exists. Storage-level publication state and CAS are supported. The full legacy safe-publish job/lifecycle authorization workflow remains unsupported until its own storage capabilities exist; unauthorized public-state changes still reject. A successful storage fixture is not authorization to publish.

## Retention and public/private boundaries

Price rows support ordered retained windows. A later version can materialize older daily/weekly min/max/last/count summaries while retaining recent higher-resolution observations. No destructive compaction, global history scan, history rewrite, polling requirement or heartbeat table was introduced. Local fixtures do not prove a production capacity/retention policy: before real migration, implement bounded maintenance, decide audit replay retention, and size retained evidence. Initial D1 audits are append-only; legacy audit retention is not claimed to be physically byte-identical. No event/job subsystem depends on these tables yet.

Aggregate JSON and observed commissions/evidence are private infrastructure state. Existing public DTO allowlists and safe-publication checks remain the public boundary; no route returns D1 rows or aggregate JSON directly. Ordinary settings rows cannot contain secrets. The revision content token is a SHA-256 concurrency digest, not an authorization credential.

## Local commands and proof

LOCAL_D1_COMMANDS=

- `npm.cmd run d1:local:plan` — read-only schema plan; no ledger/domain writes on dry-run.
- `npm.cmd run d1:local:init` — create/apply local-only development schema.
- `npm.cmd run d1:local:migrate` — apply pending local versions; second run ALREADY_APPLIED.
- `npm.cmd run d1:local:inspect` — bounded local schema inspection.
- `npm.cmd run d1:test:reset` — requires hard-coded `--test-only`; creates a fresh ephemeral database and disposes it, never deletes a directory/database.
- `npm.cmd run test:v6:d1` — actual local D1 adapter/migration tests.

The helper accepts only handles it itself created through local Wrangler. Migration plans include version filenames and SHA-256 checksums; applied filenames use the conventional d1_migrations ledger. Each migration's statements and ledger insert are atomic. Never edit an applied migration for a future release. Official versioned SQL migration conventions are documented by Cloudflare. [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)

PARITY_TESTS=SHARED_FILE_MONGO_D1_DOMAIN_ASSERTIONS_PLUS_SIDE_BY_SIDE_FILE_D1_NORMALIZED_SCENARIO

Focused D1 suite passes 25 cases: initialization/plan/reapply, constraints, indexes, create/read/dedupe, source collision rollback, offer CRUD, publication readiness state, CAS success/stale/concurrent conflict, 100-of-105 bounded history, settings, explicit unsupported/invalid runtime failures, safe SQL errors, guarded reset and domain parity. No real affiliate API or operator source data is used.

TEST_COMMANDS=FULL_V6_VALIDATION_RUNNER; TYPECHECK; ESLINT; SECRET_SCAN; LOCAL_VALIDATION_BUILD; LOCAL_D1_INIT_MIGRATE_RESET_INSPECT
PASSED_CASES=699
FAILED_CASES=0
SECRET_EXPOSURE_FOUND=NO
RESULT=PASS
SAFE_TO_BEGIN_PHASE_2_5=YES

Full matrix: `.test-tmp/v6-validation-kNBg0F/results.json`, **41 commands / 699 passed / zero failed / all exit 0**, including the unchanged archive, scheduler and rollout suites. Latest focused D1 recheck also passed 25/0 after the read-only migration-plan and timestamp-coherence checks. TypeScript, full ESLint, SQL/JSONC-inclusive secret scan and local validation build pass. No test was skipped, removed, weakened or given relaxed safety/performance bounds. Phase 2 gate passed before creating the Phase 2.5 proof harness.

The local Next validation build completed (43 static pages), deliberately using the existing non-release identity and an isolated test data directory. One existing Turbopack whole-project tracing warning points from next.config.ts through backupManager/control route; this build is not deployable proof. TypeScript and ESLint pass; lint retains 14 old warnings. The secret scan now additionally covers SQL/JSONC. Negative-test credential markers were renamed to the scanner's existing explicit test convention; the secret rules were not relaxed.

KNOWN_RISKS=SCOPED_STORAGE_ONLY; LEGACY_CATALOG_AND_AUTOMATION_CAPABILITIES_DEFERRED; RETENTION_MAINTENANCE_NOT_IMPLEMENTED; NO_LIVE_MONGO_ACCEPTANCE; VALIDATION_BUILD_TRACING_WARNING
NEXT_RECOMMENDED_PHASE=PHASE_2_5_LOCAL_ZERO_VPS_STORAGE_PROOF

No cloud deployment, production resource, Cloudflare login, real data migration, commit, push or DNS operation occurred. No production database identifier is present in configuration. The ignored local development DB contains schema only; test fixtures use ephemeral D1 or isolated legacy test directories.
