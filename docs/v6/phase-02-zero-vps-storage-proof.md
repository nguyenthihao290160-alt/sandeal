# Phase 2.5 - local zero-VPS storage proof

RESULT=PASS
SAFE_FOR_PHASE_3=YES_SCOPED_STORAGE_FOUNDATION_ONLY
PRODUCTION_DEPLOYMENT_PROVEN=NO

Completed on 2026-09-09 (Asia/Saigon), resuming the interrupted long build #2. Phase 3 was not started. This proves the supported SanDeal domain-storage boundary locally; it does not prove that the complete Next application, catalog, publication-job workflow, or legacy automation can run on Cloudflare.

## Reconstructed state and preserved work

BRANCH=master
HEAD=3f2ee7d8bd1ef57fa9207f021cc03519b7eecde7
WORKTREE_DIRTY=YES_PREEXISTING
PHASE1_7R=PASS
PHASE2=PASS
PHASE2_5=PASS

Before modifications, branch, HEAD, status and diff stat were captured, both existing checkpoints were read completely, and the current migration, D1 adapter, factory, conditional contract, settings implementations, tooling, package scripts and tests were inspected. The [architecture remediation checkpoint](phase-01-architecture-remediation.md) and [D1 checkpoint](phase-02-d1.md) were already complete and remain unchanged. This Phase 2.5 checkpoint was missing. No application, migration, dependency or test implementation needed redoing.

The persisted Phase 2 matrix `.test-tmp/v6-validation-kNBg0F/results.json` contains 41 suites, 699 passes, zero failures and all exits 0. It finished at 2026-09-08T13:57:58.472Z. It is historical Phase 2 evidence, not substituted for newer affected-file validation.

The interrupted final matrix `.test-tmp/v6-validation-WNUFq0/results.json` contains 32 completed suites, 571 passes, zero failures and all exits 0. Its first completed suite is timestamped 2026-09-08T14:02:58.971Z; the last relevant source/test change is 2026-09-08T14:02:57.922Z. No relevant source, test, package, or configuration file was newer than this validation. Its actual D1 and zero-VPS logs contain 25 and 9 passing cases respectively. Those identifiable results were verified and reused, not needlessly rerun.

The first unfinished matrix step was `node scripts/active-job-history-archive-tests.cjs`; it and the remaining nine suites were run with their unchanged workloads, assertions and 240-second per-suite orchestration bound. TypeScript, lint, secret scan and isolated validation build were rerun because their final explicit exit records were not recoverable. The old build artifact alone was not treated as a command exit record.

Resume evidence is persisted in `.test-tmp/v6-resume-20260909/`:

- `snapshot.json`: SHA-256 and modification timestamps for 601 pre-existing non-ignored workspace files; snapshot-list digest `ac0ff94312d6492745a1eab7167ff9c6077f48b8b4ee41626fbbd724847ad2b2`.
- `branch.log`, `head.log`, `status.log`, `diff-stat.log`: entry baseline. The tracked textual diff was 31 files, 8,152 insertions / 3,529 deletions, plus existing untracked work.
- `matrix-results.json`: all 42 authoritative suites, explicit reused-result provenance, and timestamps/logs for the remaining ten executions.
- `check-results.json`, `lint-final-result.json`, `build-result.json`: final checks and the superseded temporary-helper lint result.
- `preservation.json`: all 601 pre-existing file contents unchanged during this resume. This is a resume-entry comparison, not a fabricated hash comparison against the beginning of the earlier long run.

Only this missing checkpoint and ignored local evidence artifacts were added during the resume. The temporary evidence helper initially had four CommonJS import-style lint errors; it was converted to ES modules. No lint rule, test assertion or safety threshold was disabled. The original lint failure remains recorded, and the final complete lint run exits 0 with the same 14 pre-existing warnings.

## Dedicated local scenario

RUNTIME=CLOUDFLARE
STORAGE=D1_LOCAL
LOCAL_ONLY=YES
FILE_STORAGE_CALLS=0
FILESYSTEM_SETTINGS_CALLS=0
PM2_REQUIRED=NO
VPS_REQUIRED=NO
SHOPEE_REQUIRED=NO
D1_BINDING_REQUIRED=YES
TEST_COMMAND=npm.cmd run test:v6:zero-vps-storage
TEST_IMPLEMENTATION=scripts/v6-zero-vps-storage-tests.cjs
TEST_RESULT=9_PASSED_0_FAILED_EXIT_0
DOMAIN_SCENARIOS=PASS
FAILURE_SCENARIOS=PASS

The harness uses the existing official local Wrangler binding helper with `persist: false`, no remote bindings and no environment credential files. After reading local config/migration source and initializing ephemeral D1, it sets `SANDEAL_RUNTIME=cloudflare` and injects D1 through `createStorage` and the explicit adapter scope.

During domain operations, every FileStorage method/getter is guarded to throw and count calls. The filesystem promise operations used by legacy settings/storage (`readFile`, `writeFile`, `mkdir`, `rename`, `open`, `stat`, `access`, `readdir`, `unlink`, `rm`) are also guarded. Both measured counters remain exactly zero. Tooling bootstrap may read config and migration files; this is not claimed to be a filesystem-free development toolchain. Local workerd is a short-lived emulator, not PM2, a persistent SanDeal worker, or a VPS.

| Representative operation | Verified domain result |
| --- | --- |
| Fixture import and replay | Same canonical product ID; replay reports `created=false` |
| Offer creation/update | One existing aggregate offer, updated price, no duplicate offer |
| Bounded price history | Three observations; limit 2 returns the latest two chronologically |
| Publication readiness | Existing approval operation persists `approved` while remaining hidden |
| Unauthorized public publication | Existing `SAFE_PUBLISH_JOB_REQUIRED` gate rejects; approved state remains intact |
| Non-secret settings | D1 round trip preserves requested operational value and free-only/paid-AI-disabled invariants |
| Stale writer | First expected version applies; stale retry returns `CONFLICT/VERSION`; newer value remains intact |
| Missing D1 binding | Typed `CLOUDFLARE_STORAGE_BINDING_UNAVAILABLE`, no legacy fallback |
| Unknown runtime | Typed `SANDEAL_RUNTIME_UNSUPPORTED`, no implicit default |
| SQL failure | Bounded `D1_OPERATION_FAILED`, no SQL/driver detail leak or fallback; existing data unchanged |
| Shopee unavailable | `DISABLED_NO_CREDENTIALS`, `ready=false`, unsuccessful Shopee-labelled result, network calls 0 |

The separate 25-case actual D1 suite additionally proves clean schema initialization, read-only migration planning, application/reapplication, required indexes and constraints, source collision rollback of parent and projections, offer idempotency, concurrent conditional writes, exactly 100 of 105 recent snapshots, secret rejection before persistence, guarded test reset, and legacy/D1 normalized domain parity. Mongo compatibility is verified with the existing deterministic driver tests, not a live production Mongo connection.

## Free-tier query-shape audit

FULL_SCAN_HOT_PATHS=0_FOR_SUPPORTED_CLOUDFLARE_DOMAIN_PATHS
RUNTIME_FULL_SCAN_OPERATIONS=NONE_IN_IMPLEMENTED_D1_API

The telemetry-label check in the smoke suite is corroborated by direct inspection of every query and projection trigger in `src/lib/storage/d1/`. A label alone is not proof of an indexed query. No billing or actual production usage estimate is inferred from these shapes.

| Operation | Shape | Predicate, index and bound |
| --- | --- | --- |
| Product ID / slug | POINT_LOOKUP | Unique ID/slug; `LIMIT 1` |
| Source/create/canonical identity | BOUNDED_RANGE | Namespace/key index; at most 8 keys, `LIMIT 2` per key, then at most 2 product point reads |
| Product page | BOUNDED_RANGE | ID keyset, optional status/ID index; validated limit 1-365 |
| Product create | BOUNDED_WRITE | One parent; indexed identity existence check; at most 8 candidate keys |
| Product/publication replacement | CONDITIONAL_WRITE | Unique ID plus expected revision/content digest; one parent or conflict |
| Identity/offer projections | BOUNDED_WRITE | Atomic parent triggers; indexed owner deletion; at most 256 identities and 50 offers for that parent |
| Recent price history | BOUNDED_RANGE | Product/time/ID cursor and index; validated limit 1-730; actual EXPLAIN index check in D1 suite |
| Price append-if-changed | BATCH | Two atomic statements; latest product observation `LIMIT 1`, point snapshot replay check, at most one insert |
| Product audit append/replay | BOUNDED_WRITE / POINT_LOOKUP | One event; unique kind/effect identity and `LIMIT 1` replay lookup |
| Settings read/write | POINT_LOOKUP / BOUNDED_WRITE | Allowlisted singleton ID, `LIMIT 1`, at most one changed row |
| D1 health | POINT_LOOKUP | Unique migration name, `LIMIT 1`; no heartbeat write |

`json_each` expands bounded incoming identity/offer arrays, not an unbounded persisted collection. No supported hot API issues a full product/history table read, uses large-offset pagination, scans global history per page, or writes on every read. Generic collection/file/streaming transaction APIs explicitly throw `D1_COLLECTION_OPERATION_UNSUPPORTED` rather than emulating an unbounded read or falling back to FileStorage.

The existing legacy catalog/search/related-product reads, job/lifecycle authorization stores, source-health aggregates and worker/scheduler workflows are outside initial D1 capabilities. Their remaining legacy scans are documented in [the hot-path inventory](phase-01-hot-path-inventory.md); they are not silently relabelled maintenance or claimed to be Cloudflare-ready. Full public publishing, real migration, retention maintenance and Queue/Cron implementation remain deferred. Storage publication readiness is not proof of the full authorized publish-job workflow.

## Final validation and gates

INDEXED_OPERATIONS=PASS
CONDITIONAL_WRITES=PASS
BOUNDED_HISTORY=PASS
SETTINGS_SEAM=PASS
D1_LOCAL=PASS
D1_MIGRATIONS=PASS
D1_ADAPTER=PASS
LEGACY_STORAGE=PASS_FILE_AND_MONGO_CONTRACT_TESTS
CLOUDFLARE_FILE_FALLBACK=NO
AFFILIATE_STATUS=ACCESSTRADE_AND_TIKTOK_PRESERVED
SHOPEE_STATUS=DISABLED_NO_CREDENTIALS

Migration `src/lib/storage/d1/migrations/0001_product_storage.sql` is unchanged, SHA-256 `1fad5e55594346eebca93362755a94d235a37f9814099422618622a70d858c84`. No operator data was imported, no applied migration was rewritten, and no local development database needed rebuilding.

TOTAL_TEST_SUITES=42
REUSED_PASSED_CASES=571
RESUMED_PASSED_CASES=137
TOTAL_TEST_CASES_PASSED=708
TOTAL_TEST_CASES_FAILED=0
TEST_CASES_SKIPPED=0
TEST_CASES_REMOVED=0
ASSERTIONS_WEAKENED=NO
SAFETY_GATES_RELAXED=NO
TYPESCRIPT=PASS
ESLINT=PASS_0_ERRORS_14_PREEXISTING_WARNINGS
SECRET_SCAN=PASS
SECRET_EXPOSURE_FOUND=NO
BUILD=PASS_LOCAL_VALIDATION_ONLY

Counts are unique cases in the final matrix, not the sum of repeated executions or build log lines. The original Phase 1.6/architecture cases remain represented. The completed 32-suite results include both fixed scheduler regressions, rollout stabilization, runtime fences, File/Mongo, product-first, source reliability and AffiliateProvider/AccessTrade/TikTok coverage, plus all new D1 and zero-VPS tests.

The ten resumed exact commands and results are:

| Command | Passed | Failed |
| --- | ---: | ---: |
| `node scripts/active-job-history-archive-tests.cjs` | 9 | 0 |
| `node scripts/master-m1-runtime-recovery-tests.cjs` | 22 | 0 |
| `node scripts/master-m4-intelligence-tests.cjs` | 17 | 0 |
| `node scripts/master-m5-platform-seo-tests.cjs` | 14 | 0 |
| `node scripts/m3-1-3-gate-b-worker-scheduling-tests.cjs` | 7 | 0 |
| `node scripts/prompt10-autopublish-tests.cjs` | 25 | 0 |
| `node scripts/prompt10-slo-error-budget-tests.cjs` | 20 | 0 |
| `node scripts/gemini-provider-diagnostics-tests.cjs` | 7 | 0 |
| `node scripts/master-m2-slo-runnable-tests.cjs` | 12 | 0 |
| `node scripts/master-m2-operational-health-tests.cjs` | 4 | 0 |

TypeScript and ESLint used the installed binaries with exactly the package-script arguments (`tsc --noEmit`, `eslint`); the secret check used `node scripts/release-validation.cjs secret-scan`. The build used the existing `node scripts/validate-dirty-build.cjs`, isolated temporary data, explicit legacy/file runtime, disabled Shopee/paid AI and validation-only non-release identity. It exits 0. The existing Turbopack whole-project tracing warning through `next.config.ts` / `backupManager` / control route remains a known limitation, not deployment proof. Final validation represents 42 regression commands plus these four checks; the full reproducible matrix remains `node scripts/v6-validation-runner.cjs`.

The focused/skip search across 18 changed test/fixture files found zero matches. No tests changed during resume. The two earlier legacy factory-source assertion updates and their supporting import-isolation contract remain documented in the Phase 1.7R checkpoint; no new exception was introduced here.

PRODUCTION_RESOURCE_CREATED=NO
REAL_DATA_MIGRATED=NO
CLOUDFLARE_LOGIN_USED=NO
SHOPEE_CREDENTIALS_USED=NO
DEPLOYED=NO
COMMITTED=NO
PUSHED=NO
BLOCKERS=NONE_FOR_PHASE_2_AND_2_5_SCOPE
NEXT_RECOMMENDED_PHASE=PHASE_3_PLANNING_AND_EXPLICIT_RUNTIME_CAPABILITY_DESIGN_ONLY

The resource statement concerns actions in this run, not a remote account inventory; no Cloudflare account was queried. `.data` remains empty, and all pre-existing operator work is preserved. Stop here: no Phase 3 implementation, real migration, production resource, DNS change, deployment, commit or push is authorized by this checkpoint.
