# V6 Phase 1.7 storage architecture gate

Date: 2026-09-07. Branch `master`, HEAD `3f2ee7d8bd1ef57fa9207f021cc03519b7eecde7`, dirty worktree preserved. Phase 1.6 passed before this audit began. No D1 schema, adapter, dependency, configuration, local database, or migration was started.

```text
EXISTING_STORAGE_BOUNDARY=StorageAdapter in src/lib/storage/types.ts; compatibility facade src/lib/storage/adapter.ts; selection src/lib/storage/storageFactory.ts
D1_IMPLEMENTATION_POINT=existing storage factory and StorageAdapter; indexed domain operations and conditional commit seam must first be defined within this architecture
LEGACY_DRIVER=file by default; mongo remains explicit and supported
CLOUDFLARE_DRIVER=UNAVAILABLE; throws CLOUDFLARE_STORAGE_BINDING_UNAVAILABLE
DOMAIN_MAP=table below
DUPLICATE_DOMAIN_RISK=HIGH if product-sources is mistaken for source identity, embedded offers/publication are duplicated, or old jobs and durable automation jobs are conflated
CLOUDFLARE_IMPORT_LEAK_RISK=no Cloudflare imports introduced into legacy; shared factory still eagerly imports Node FileStorage and is not yet a Cloudflare entry module
D1_REQUIRED_TABLES=conceptual map below; schema deliberately not created
D1_REQUIRED_INDEXES_CONCEPT=identity, source identity, product/offer, publication, updated time, product/price time, job idempotency and due time
MIGRATION_STRATEGY=fixture-first dry-run and deterministic identity manifest; legacy stays authoritative; no real data touched
FREE_TIER_STORAGE_STRATEGY=indexed bounded access and conditional row writes; whole-collection callback emulation is not accepted for hot domains
SAFE_TO_BEGIN_PHASE_2=NO
BLOCKERS=A1,A2,A3
RESULT=FAIL
```

## Gate decision and precise blockers

The existing adapter is a sound **legacy collection-storage boundary**, but it is not yet a proven bounded D1 domain seam. An adapter that implements only page/bulk methods could be a SQL experiment; it would not establish the requested product/source-dedupe/publication parity through SanDeal's actual repositories. Marking their required operations unsupported would leave the critical parity requirement unproven. Emulating them with full collection reads/replacements would violate the requested hot-path constraints. This is why this gate fails before Phase 2, rather than declaring an unused adapter sufficient.

### A1 — Indexed product and price operations are absent from the shared contract

- `storage/adapter.ts:findById` scans a whole collection; it is a facade helper, not an indexed adapter operation.
- `storage/products.ts:readCanonicalProducts` reads and normalizes all products. Product lookups, list filtering, uniqueness, and publication reuse this path.
- `storage/products.ts:upsertSourceCandidateProduct` passes the complete array to an arbitrary transaction callback. It matches both source identity and canonical URL, rejects ambiguous multiple matches, merges only missing/stronger evidence, preserves canonical IDs, and generates a unique slug across products. These are important domain semantics, not interchangeable with SQL `INSERT OR REPLACE`.
- `product-intelligence/priceHistory.ts:listPriceHistory` and `listPriceHistories` load all history before filtering. Snapshot capture finds the last snapshot and applies retention across all products in an array callback.
- `readCollectionPage` bounds returned data but permits arbitrary safe-named filter/sort fields and offset pagination. It does not specify the indexed query set needed for these actual repository paths.

Required closure: add indexed lookup/query and conditional mutation capabilities within the existing storage architecture; route these existing repository operations through them while retaining legacy implementations and normalization. Prove source/canonical identity ambiguity, deterministic convergence, verified-evidence preservation, ordering, and bounded history reads using shared domain fixtures. This is more than a factory/type-only change and was not silently folded into this mostly audit/minimal-code gate.

### A2 — Transaction and publication semantics are not mapped to bounded D1 writes

`StorageTransaction<T>` accepts an asynchronous arbitrary callback over the entire collection. `StorageTransactionOptions` includes before-commit and external commit-guard callbacks. FileStorage holds renewable locks around preparation/atomic replacement; Mongo reads a revision under a session transaction, stages a new revision, and commits under the guard, preserving callback errors and prepared-write conflict behavior. `runExclusive` is an optional FileStorage coordination capability, not a claim of multi-collection atomicity.

`publishCanonicalProductTransaction` checks durable job authorization, lifecycle, prior product revision, slug uniqueness, idempotent publication effect, guarded product persistence, readback, and audit/recovery. V5 history additionally has immutable segments, indexes, a manifest, publication intents, and an exclusive coordinator. These guarantees cannot be replaced by a SQL lock-row simulation or an arbitrary callback rerun without new conflict/side-effect tests.

Cloudflare documents prepared-statement batches with rollback of the sequence on failure. That supports planned conditional writes, but does not supply the repository's existing callback transaction semantics automatically. [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

Required closure: specify expected-version/identity checks, atomic product/source/offer commits, conflict return semantics and retry ownership, publication effect uniqueness, and explicit unsupported callback/lease operations. Preserve existing domain merge/publication logic above SQL. Prove that a conditional-write conflict neither loses updates nor repeats external side effects. Durable history/queue orchestration stays legacy and outside this D1 foundation until separately adapted.

### A3 — Runtime construction and settings still lack an explicit D1 binding seam

Before the minimal correction, a read-only probe returned `file` from `getStorageAdapter()` for BOTH `SANDEAL_RUNTIME=cloudflare` and an unknown runtime. The new V6 platform selectors were not controlling the existing storage facade. This fallback defect is fixed: the factory now resolves the existing runtime authority first, rejects unknown runtime, and rejects cloudflare with `CLOUDFLARE_STORAGE_BINDING_UNAVAILABLE` before legacy selection.

However, valid D1 binding injection/selection is not implemented or proven. The factory imports FileStorage at module load; it cannot be the eventual Cloudflare entry without isolating its Node dependencies. `storage/automationSettings.ts` directly persists `automation-settings.json` using fs/path and adapter `getDataDir`; `bots/schedulerConfig.ts` does the same for `scheduler-config.json`. This is a real settings seam gap, not an ordinary collection alias.

Required closure: explicit per-runtime construction with a required D1 binding argument, lazy/separate legacy module construction, and a non-secret settings capability backed by the current legacy files. Unknown runtime, missing/malformed binding and conflicting legacy-driver/D1 selections must reject. No module-global mutable DB, process.env encoding of DB objects, or fallback FileStorage is acceptable.

The unresolved A1/A2 contracts also determine what a valid D1 construction can honestly advertise. Defining those operations and proving legacy parity is the next architecture step. No Cloudflare login, production access, Shopee key, or paid service is needed to close them.

## Storage authority findings

| Existing abstraction | Current semantics | Retain / adapt |
| --- | --- | --- |
| StorageAdapter | Collection reads, scans, coherent pages, bounded snapshots, array/streaming callbacks, optional bounded bulk and exclusive scope | Retain as the shared storage architecture; add capabilities instead of a parallel repository tree |
| FileStorageAdapter | Existing JSON format, .data/configurable root, backups, renewable locks, atomic replacement, PRIMARY_ONLY opt-in | Preserve unchanged; legacy default |
| MongoStorageAdapter | Schema v1, collection revision/order envelopes, session commits and sanitized typed errors; no file fallback | Preserve unchanged; opt-in legacy alternative |
| storageFactory/storageConfig | File default; strict mongo URI/config identity; cached Mongo adapter keyed by full effective config | Runtime rejection added; eventual D1 construction belongs here or a separate platform entry sharing this contract |
| Product repository | Canonical normalization, evidence-aware merge, identity/slug dedupe, guarded publication in the existing module | Keep ownership here; SQL must not duplicate merge policy |
| Offers/publication | Embedded Product fields; no independent offer repository | Preserve aggregate ownership or use adapter-owned child projections with explicit coherence |
| Job storage | `jobs` legacy UI/scheduler records versus `automation-jobs` durable v2 queue and attempts/projections | Distinct existing concepts; do not merge by name |
| History | Versioned immutable segments/index/manifest/intents plus exclusive publication coordination | Keep legacy implementation; not a generic new job_runs table |
| Settings | Automation and scheduler singleton files outside collection contract | Add a clean capability before claiming D1 settings parity |

## Domain ownership map

All V6 destinations are **design only**. MIGRATION_REQUIRED describes a later cutover, not work executed now. Retention marked TBD means no invented retention policy is being imposed on current data.

| Domain | CURRENT_STORAGE | CURRENT_SCHEMA/TYPE | V6_DESTINATION | MIGRATION_REQUIRED | HOT_PATH | RETENTION_REQUIREMENT |
| --- | --- | --- | --- | --- | --- | --- |
| Products | products collection | `types.ts:Product`, canonical v2 normalization | products; current IDs and semantics preserved | YES at future cutover | ID, slug, public status, update/ranking | Durable current product; deletion policy TBD |
| External product identity | Product.sourceMappings and identity/sourceId/externalId | ProductSourceMapping; SOURCE_ID_EXACT/CANONICAL_URL_EXACT | product_source_mappings child relation | YES, ambiguity-aware | (source, sourceId), normalized canonical URL | Lifetime of canonical identity; replay protection |
| Source configuration | product-sources collection | storage/productSources.ts:ProductSourceConfig | product_sources configuration table | YES | ID, normalized source URL, enabled | Durable until operator removal |
| Offers | Product.offers, bestOfferId and legacy affiliate fields | ProductOffer | product_offers or coherent aggregate projection | YES if extracted | product ID, offer ID, eligibility | Current offers; stale observation retention TBD |
| Merchant | Strings on Product, ProductOffer, source mappings | merchant/merchantDomain; no owned merchant entity | Embedded; independent merchants FUTURE | NO independent migration yet | Merchant filtering/ranking | Product/source lifecycle |
| Category | Product.category plus taxonomy derivation | Canonical category string; smart-categorization suggestion | Embedded; categories FUTURE | NO independent migration yet | Taxonomy/page selection | Preserve canonical category |
| Price/history | price-history collection | product-intelligence/types.ts:PriceSnapshot | price_history | YES | productId + capturedAt | Existing 730 days, per-product/collection caps; unchanged checkpoints after 24h only when forced |
| Affiliate links | Product/ProductOffer URLs, tracking/health/evidence fields | Existing aggregate fields | Keep offer ownership; affiliate_links FUTURE if independent lifecycle introduced | As part of products/offers | Selected offer and redirect | Current link plus evidence/audit needs |
| Click attribution | outbound-events; growth-daily | OutboundEvent, GrowthDaily | outbound_events + growth_daily; avoid duplicate affiliate_click_aggregates | YES later | Product/day/source/category aggregates | 90-day events; 730-day daily aggregates |
| Conversion | Provider contract operation only; no persisted reconciliation | syncTransactions unsupported | conversions FUTURE/DEFERRED | NO current records/schema | Future (provider, external transaction ID) | Financial retention decision not invented |
| Commission | Offer/product observations; no settlement ledger | Existing observed values, syncCommissions unsupported | commissions FUTURE/DEFERRED | No settled-revenue migration | Future transaction/status/time | Private financial retention TBD |
| Deal intelligence | Product scores/confidences/reasons; evidence-facts | Product fields, DealScoreResultV2, evidence contracts | Current aggregate plus evidence; deal_scores deferred if independent versions needed | YES existing fields/evidence | Product score/public selection | Current decision plus bounded evidence history |
| Content | content, content-drafts, content-packages; Product.reviewContent | ContentItem, ContentDraft, ContentPackage, ReviewContent/version | Preserve these concepts; content_versions only if version history is introduced deliberately | YES | ID, product ID, workflow status | Current content and approved evidence/version provenance; historical policy TBD |
| Publication | Product status/lifecycle/effect key, publication-audit, lifecycle events, operation journal | PublicationAudit, Product lifecycle v1, job/effect references | Coherent product/publication fields + existing audit/event concepts | YES | Product/effect ID, status, updatedAt | Current state plus replay/audit guarantees |
| Scheduled tasks | scheduler-config.json; scheduler-state; automation-control next run; older jobs | SchedulerConfig, Job, AutomationControl | Settings and current durable job schedule; scheduled_tasks only after ownership mapping | YES | nextRunAt, enabled, job status | Current schedule; old task history bounded |
| Job runs | automation-jobs, automation-job-attempts, bot-runs; V5 archive | AutomationJob schema v2, attempts, BotRun | Preserve names/ownership; job_runs not a universal replacement | YES later, not Phase 2 queue work | Idempotency key, state/due time, attempt ID | Terminal active-job retention default 30 days; archive durability/replay must survive |
| Source health | source-quality, source-reliability-state, domain-circuit-breakers | SourceQualitySnapshot v2; commerce/sourceReliability.ts state | Preserve quality/reliability/circuit concepts | YES | Source ID/domain, next eligible time | Existing bounded observations/circuit history; no per-read heartbeat |
| System settings | automation-settings.json, scheduler-config.json, environment configuration | AutomationSettings, SchedulerConfig; immutable free-only controls | Non-secret typed singleton settings; environment credentials excluded | YES via explicit allowlist | Singleton keyed read, low-frequency update | Durable configuration revisions; no secrets |
| Secrets | token-vault and environment | Existing encrypted token vault and credential readers | EXCLUDED from ordinary D1 rows | NO in this plan | Provider readiness via credential boundary | Separate credential ownership |

`product-sources` is **configuration**, not the external identity mapping. Products already own offers and publication; a new table name must not create a second authority. Analytics explicitly reports revenueAvailable=false, so click records must not be relabelled as conversions or realized commissions.

## Locked design constraints for the next gate

1. Versioned SQL migrations with an applied-migration ledger; never silently edit an applied version. Cloudflare's migration mechanism records sequential SQL migrations. [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
2. Preserve existing canonical product IDs. Fixture migration plans select deterministic mappings from stable source identities, detect ambiguous source/canonical matches, and record any convergence decisions before apply. Repeated plans over the same fixture must match; generated runtime IDs are not a migration identity algorithm.
3. Unique source identity and publication effect keys; future provider transaction identity unique per provider. SQL uniqueness is necessary but must retain existing merge/conflict semantics.
4. Bounded indexed page/lookup operations; reject unsupported filters/sorts. No per-request product/history scan, unbounded offset, or whole-array replacement on hot paths.
5. Conditional writes carry expected revision and exact affected-row checks. Related product/source/offer changes use an atomic bounded batch where appropriate. Do not reconstruct file lease architecture in SQL.
6. No write-on-read, high-frequency heartbeat rows, or polling-dependent feature. Batch meaningful updates and omit unchanged writes. Measure returned rows read/written without inventing billing prices. Query/batch limits apply per statement; bound both statement count and payload size. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
7. Price snapshots preserve operation identity and last-value comparison; unchanged adjacent observations are omitted except the existing explicit periodic checkpoint. Never use a global UNIQUE(product, price) rule that would erase a legitimate later return to an earlier price.
8. Plan recent fine-resolution observations and older daily/weekly summaries compatible with existing retention. Record min/max/last/count and period bounds for future compaction. No destructive compaction in Phase 2.
9. Jobs/events require bounded pagination and explicit expiry/retention. Idempotency tombstones/keys must not disappear before the replay horizon. Queue/Cron implementation remains outside this run.
10. Public projections use existing public DTO allowlists, distinct from private commission/revenue/attribution intelligence. No raw aggregate JSON dump may become a public endpoint.
11. No secrets in ordinary rows; settings require a typed allowlist. Reject credential-shaped fields and URL credentials in fixture migration. Raw provider payloads stay out of hot tables; existing intentional evidence storage remains separately bounded.
12. Dry-run before any future apply. Reuse inventory/checksum/manifest concepts, preserve sensitive exclusions, and validate exact destination scope. No production database creation or real source data read/apply is required for fixture parity.
13. Legacy source remains authoritative until a separately authorized and verified cutover. Adding a D1 class must not change legacy selection or import Cloudflare globals into legacy tests.
14. Local/test setup must explicitly select local mode and a guarded isolated test path; no default command may reset development/operator/production data. No Cloudflare login or token required for local work. [D1 local development](https://developers.cloudflare.com/d1/best-practices/local-development/)

## Required index concepts, justified by current queries

| INDEX (conceptual) | QUERY_PATH | WHY_REQUIRED |
| --- | --- | --- |
| products primary ID; unique slug | getProductById/getProductBySlug; unique publication slug | Exact lookup without collection scan |
| product_source_mappings unique(source, source_id) | upsertSourceCandidateProduct/candidateEvidence | Concurrent identity convergence; canonical URL secondary lookup retains ambiguity checks |
| product_source_mappings(normalized_original_url) | Canonical URL dedupe | Existing alternate identity evidence |
| product_offers(product_id, offer_id) | Best/alternate offer selection and product projection | Bound offer reads to the selected product |
| products(status, updated_at, id) and justified taxonomy predicate indexes | Public listing/publication state | Stable bounded filtering/page traversal; actual index set awaits query capability contract |
| price_history(product_id, captured_at, id); replay identity | listPriceHistory/capturePriceSnapshot | Latest snapshot and bounded history range without full history scan |
| publication effect uniqueness / product audit time | publishCanonicalProductTransaction | Idempotent replay and bounded product audit |
| product_sources normalized URL uniqueness / enabled | createProductSource/listProductSources | Preserve source-config dedupe and enabled lookup |
| source quality/reliability source ID | source health and ranking | Exact source snapshot read |
| automation job idempotency; status/scheduledAt | Existing queue create/claim/due work, future adaptation | Document requirement only; no Queue/Cron changes |
| outbound product/time and growth day | Existing analytics aggregation/summary | Bounded windows and retained daily summaries |
| settings primary key | Existing singleton configuration | Bounded settings read/update |

Merchant/category/standalone link/conversion/commission/content-version tables are deferred when they would invent ownership absent from the current model. No speculative index was created.

## Minimal correction and verification

Only architecture code change: storage factory checks `getSandealRuntime` before legacy selection. New `scripts/v6-storage-architecture-tests.cjs`: 4 passed / 0 failed, covering absent/explicit legacy identity, cloudflare under file/mongo/d1/blank driver config, and unknown runtime rejection. Valid D1 binding selection is intentionally NOT claimed.

The 33-suite Phase 1.6 matrix was rerun after this shared-factory correction: **529 passed / 0 failed**, all 33 commands exit 0. Results and full logs are in `.test-tmp/v6-validation-n6lnOw/results.json` and adjacent per-suite logs. Combined with the four architecture cases, final unique coverage is **533 passed / 0 failed across 34 scripts**. TypeScript passed. Full ESLint passed with 0 errors and 14 pre-existing warnings. Secret scan and `git diff --check` passed. Existing FileStorage/Mongo implementations, .data, AccessTrade/TikTok, legacy automation, and dirty operator changes remain present. No Cloudflare-specific global/type package or dependency was added.

Counting convention: 37 distinct authoritative validation commands = 34 regression scripts + TypeScript + full ESLint + secret scan. The run executed regression scripts 74 times in total including before-fix reproduction and reruns; final case counts use only the latest result of each suite. The 17 historical failing assertions/cases (3 scheduler, 12 new pre-fix rollout tests, 2 stale SEO fixtures) remain documented and are not counted as final failures. Targeted ESLint and diff checks are additional checks, not additional regression cases. No Next production build, live Mongo acceptance, or external provider test is claimed; the phase requiring the build was not entered.

Preservation check: of 573 entry files, only six changed: `scripts/automation-scheduler.cjs`, `scripts/master-m5-platform-seo-tests.cjs`, `src/lib/automation/featureRollout.ts`, `src/lib/automation/scheduler.ts`, `src/lib/storage/products.ts`, and `src/lib/storage/storageFactory.ts`. Every other entry file retained its SHA-256 digest. Six files were added: these two checkpoint reports, the isolated development fixture, stabilization tests, architecture tests, and regression runner. No entry file was deleted. Branch/HEAD unchanged; index empty; local `.data` still empty. No commit, push, deploy, DNS action, production resource operation, or real-data migration occurred.

NEXT_RECOMMENDED_PHASE=Phase 1.7 architecture remediation: indexed queries, conditional domain commits, explicit binding construction, and non-secret settings seam; rerun this gate before any Phase 2 work.

PHASE_2=NOT_STARTED_GATE_FAILED

docs/v6/phase-02-d1.md=NOT_CREATED (implementation did not proceed)
