# Phase 1.7R — storage architecture remediation

BRANCH=master
HEAD=3f2ee7d8bd1ef57fa9207f021cc03519b7eecde7
WORKTREE_DIRTY=YES_PREEXISTING_AND_CURRENT_WORK

Baseline was captured before this run's edits with `git branch --show-current`, `git rev-parse HEAD`, `git status --short`, and `git diff --stat`. Entry diff: 22 textual files, 4,214 insertions / 1,057 deletions; the status also included the existing ecosystem configuration change and untracked foundation/history work. The reports were read first, then source inspected. The existing architecture test was 4 passed / 0 failed: it proved fail-closed selection, not an implemented indexed domain seam.

ORIGINAL_BLOCKERS=INDEXED_DOMAIN_OPERATIONS; CONDITIONAL_COMMIT_CONTRACT; D1_BINDING_AND_SETTINGS_SEAM

## Operation inventory and implementation scope

The full production-path classification is in [phase-01-hot-path-inventory.md](phase-01-hot-path-inventory.md). That inventory includes ordinary legacy workers, catalog queries, source health, both job domains, and lifecycle journals; none are relabelled maintenance to hide scans.

| OPERATION | CURRENT_IMPLEMENTATION at entry | CLASS | D1_REQUIRED_OPERATION | REMEDIATION |
| --- | --- | --- | --- | --- |
| Product ID/slug | Normalize/find entire products array | HOT_PATH | Point lookup | Repository calls DomainStorage.getProduct/getProductBySlug |
| Source candidate dedupe | Scan all source IDs, mappings and URLs | HOT_PATH | Bounded union of indexed aliases | findProductIdentity returns at most two products; ambiguity still rejects |
| Operator create / canonical upsert | Two distinct array-based duplicate predicates | HOT_PATH | Namespaced identity queries | CREATE/CANONICAL namespaces retain their exact original predicates |
| Product/embedded offer update | Products transaction callback | HOT_PATH | ID read and conditional entity replace | Bounded entity preparation plus revision/content-token CAS |
| Evidence repair | Full products callback | HOT_PATH | ID read/CAS | Same verified-evidence and expectedUpdatedAt rules over one entity |
| Publication / rollback | Catalog read, replacement and readback | HOT_PATH | Entity CAS / exact-version rollback | Existing authorization, lifecycle, public safety and operation guard retained |
| Publication/duplicate/repair audit | Collection append callbacks in repository | HOT_PATH | Bounded append; effect replay identity | Typed product-audit operation; legacy retention bounded to 1,000 per audit kind |
| Price capture / recent history | Global history transaction/read | HOT_PATH | Atomic append-if-changed; product/time/ID/limit | DomainStorage operations; legacy global retention stays inside legacy infrastructure |
| Automation / scheduler settings | Business modules know JSON paths | HOT_PATH | Non-secret typed settings singleton | SettingsStore; file paths only in legacySettingsStore |
| Public catalog/related cards/search | Whole published catalog and derived histories | HOT_PATH | Future bounded catalog/read model | Preserved legacy implementation; no generic D1 collection emulation permitted |
| Legacy scheduler/worker/jobs/source health | Mixed bounded projections and whole-collection callbacks | HOT_PATH | Future typed job/source capabilities | Preserve legacy; explicitly unsupported in initial D1 scope, not a queue implementation |
| Product deletion and aggregate dashboards | Whole collection / derived aggregates | ADMIN_PATH | Future entity delete/read model | Preserved legacy; unsupported D1 capabilities must fail explicitly |
| Migration, archive repair, full history tools | Deliberate collection inventory/rewrite | MIGRATION_ONLY / MAINTENANCE_ONLY | Explicit later offline tools | Retained; no real data migration performed |

WHOLE_COLLECTION_HOT_PATHS_BEFORE=PRODUCT_LOOKUP_DEDUPE_MUTATION_PUBLICATION_PRICE_SETTINGS_PLUS_LEGACY_WORKFLOWS
WHOLE_COLLECTION_HOT_PATHS_AFTER=NO_SHARED_COLLECTION_DEPENDENCY_FOR_REMEDIATED_ENTITY_OPERATIONS; LEGACY_CATALOG_JOBS_SOURCE_WORKFLOWS_REMAIN_EXPLICITLY_OUTSIDE_INITIAL_D1_CAPABILITIES

This is a storage-foundation seam, not a claim that the full Next application or legacy worker is Cloudflare-ready. File and Mongo may retain collection-revision internals. Their `nativeIndexedQueries=false` capability is truthful; D1 must implement the same bounded domain API with native indexes. No second repository, application, Mongo product format, or runtime was introduced.

## Contracts

INDEXED_DOMAIN_OPERATIONS=getProduct; getProductBySlug; findProductIdentity; listProducts; createProduct; replaceProduct; getPriceHistory; appendPriceSnapshot; appendProductAudit

PRODUCT_DEDUPE_CONTRACT=EXISTING_THREE_NAMESPACES_PRESERVED

Source candidates use exact source/source ID and conservative canonical URL aliases, never fuzzy titles or affiliate URLs. Two different matches still throw SOURCE_CANDIDATE_MAPPING_CONFLICT. Operator create retains its lowercased source identity, broader URL rules and exact merchant/title fallback only when stable identities are absent. Canonical upsert retains raw source/original/affiliate matching and source-hash suppression. Shared helpers live in productIdentity.ts. Indexed candidate preparation is bounded, retains evidence merge rules, and retries at most three conditional conflicts.

PUBLICATION_UPDATE_CONTRACT=ENTITY_READ_CAS_READBACK; ROLLBACK_ONLY_THE_VERSION_THIS_OPERATION_COMMITTED

The durable safe-publish job, actor, runtime control, free-only settings, lifecycle and public/review checks remain authoritative. A caller cannot publish merely by supplying a boolean. Product storage no longer rewrites a catalog from business code. Future D1 publication-state persistence does not imply D1 support for legacy job authorization or lifecycle journals.

CONDITIONAL_COMMIT_CONTRACT=APPLIED_WITH_INCREMENTED_REVISION | CONFLICT_WITHOUT_WRITE | NOT_FOUND

`ProductVersion` contains revision plus a canonical content token. Legacy rows begin at revision 1. The token detects old lifecycle/migration writers that changed an aggregate without incrementing storageRevision. File uses its existing locked transaction; Mongo uses its existing atomic collection revision transaction. No last-write-wins compatibility path is substituted. Optional domain fields serialize as absent JSON properties; non-finite numbers, cycles, executable values, sparse arrays and unsupported objects still reject. Mongo's generic strict serialization tests were not weakened.

PRICE_HISTORY_QUERY_CONTRACT=PRODUCT_ID_PLUS_OPTIONAL_TIME_ID_CURSOR_PLUS_VALIDATED_LIMIT; RECENT_ROWS_RETURN_CHRONOLOGICALLY

Default 365; hard existing maximum 730 per product. Adjacent identical source hashes are suppressed except an explicit checkpoint after 24 hours. Returning to an older price is a new observation. Existing legacy 730-day/per-product/global retention is preserved in infrastructure; D1 must not run global destructive compaction on hot writes.

SETTINGS_ABSTRACTION=SettingsStore_AUTOMATION_SCHEDULER_ALLOWLIST

Immutable runtime/provider configuration stays in environment/bindings. Secrets and unowned settings keys reject. File settings keep their historical filenames and atomic replacement. Mongo settings use bounded system-settings rows, never its intentionally unsupported filesystem methods. Cloudflare will require its explicit non-secret settings implementation.

D1_BINDING_SEAM=createStorage({runtime,bindings,createD1})_WITH_EXPLICIT_REQUEST_SCOPE
CLOUDFLARE_TO_FILE_FALLBACK=NO

The Phase 1.7R constructor validates structural DB prepare/batch binding and the injected driver/capabilities/settings store. No implementation means D1_STORAGE_IMPLEMENTATION_UNAVAILABLE; missing/invalid binding means CLOUDFLARE_STORAGE_BINDING_UNAVAILABLE. Unknown runtime rejects before selection. File/Mongo load only on legacy construction. Request scopes are isolated, not a process-global mutable DB. A Cloudflare scope cannot accept FileStorage.

## Test integrity and observed corrections

TEST_CASES_SKIPPED=0
TEST_CASES_REMOVED=0
ASSERTIONS_WEAKENED=NO
SAFETY_GATES_RELAXED=NO

Two old static assertions needed a source-shape update after their failures were reproduced:

TEST_FILE=scripts/storage-adapter-mongo-tests.cjs; scripts/storage-acceptance-tests.cjs
OLD_EXPECTATION=FILE_BRANCH_DIRECTLY_RETURNS_EAGERLY_IMPORTED_fileStorageAdapter
NEW_EXPECTATION=FILE_BRANCH_LAZILY_REQUIRES_AND_RETURNS_EXACT_fileStorageAdapter
SUPPORTING_CONTRACT=LEGACY_ONLY_INFRASTRUCTURE_MUST_NOT_LOAD_WHILE_CONSTRUCTING_CLOUDFLARE_STORAGE
REASON=AUTHORIZED_IMPORT_ISOLATION_REFACTOR; EXISTING_RUNTIME_IDENTITY_AND_NO_FALLBACK_ASSERTIONS_RETAINED

The new Mongo domain fixtures initially exposed undefined optional fields from canonical normalization. Production domain serialization was corrected; assertions and strict generic Mongo validation remained unchanged. Added cross-driver scenarios test create/read, source convergence, stale revisions, retry, missing entities, distinct identities, pagination, history and audit replay. No workloads, concurrency, ceilings or failure thresholds were reduced or relaxed.

## Validation and gate

TEST_COMMANDS=EXISTING_33_SUITE_MATRIX_PLUS_ARCHITECTURE_REMEDIATION_SETTINGS_AND_TOUCHED_DOMAIN_SUITES
LEGACY_STORAGE_PARITY=PASS_FILE_AND_DETERMINISTIC_MONGO_DRIVER_TESTS; LIVE_MONGO_NOT_RUN
PASSED_CASES=672
FAILED_CASES=0_FINAL
SECRET_EXPOSURE_FOUND=NO

The first matrix run is recorded in `.test-tmp/v6-validation-oy9D5D/results.json`. It contains two superseded factory-shape failures and the unchanged archive suite's orchestration timeout. Factory suites subsequently passed (Mongo 49/0, acceptance 28/0). The first direct archive rerun passed eight cases but lost a lock during an observed roughly 13-hour host-time/execution gap (47,752,655ms preparation); refusing the expired lease was correct. The next unchanged direct run passed **9/0**, including its original 2,000-job workload and 3-second hot-path ceilings. Isolated artifacts: `.test-tmp/active-job-history-archive-45340-1788874372305`. No archive source, test, lease duration, performance limit or orchestration timeout was changed.

Final counting uses the latest result per suite: the original 533 cases plus ten additive Mongo cases, 17 architecture-remediation cases, 12 settings cases, 34 production-health/readiness cases, 27 operator-intelligence cases, seven lifecycle-storage cases and 32 product-intelligence cases = **672 passed / 0 failed across 40 regression commands**. All 533 previous cases remain represented. Reproduction failures are recorded above, not hidden or counted as final failures. TypeScript, full ESLint (zero errors, 14 existing warnings), secret scan and diff whitespace check pass. The 40 regression commands plus TypeScript, ESLint and secret scan make 43 authoritative validation commands; repeated executions are not extra unique cases.

Additional commands beyond the existing 33-suite runner: `node scripts/v6-storage-architecture-tests.cjs`, `node scripts/v6-architecture-remediation-tests.cjs`, `node scripts/v6-settings-seam-tests.cjs`, `node scripts/production-health-readiness-regression-tests.cjs`, `node scripts/operator-intelligence-regression-tests.cjs`, `node scripts/prompt10-lifecycle-storage-tests.cjs`, `node scripts/prompt08-product-intelligence-tests.cjs`. Rechecks used the exact original archive, Mongo, acceptance, product-first, foundation and stabilization commands. Static skip/only/focused-case search returned no matches in changed tests. Two old static assertions changed as documented; no old case or negative assertion was removed.

SAFE_TO_BEGIN_PHASE_2=YES
BLOCKERS=NONE_FOR_SCOPED_LOCAL_D1_FOUNDATION
RESULT=PASS

At this gate (2026-09-08), no D1 schema/tooling/database, production resource, login, deploy, commit, push, DNS change, or real-data migration has been performed. `.data` is still empty. Prior reports remain historical evidence and were not rewritten. The fourteen design constraints in the prior architecture checkpoint remain locked: versioned migration ledger, deterministic source identities/preserved canonical IDs, indexed bounded access, conditional atomic projection writes, bounded event/history retention design, no write-on-read, no ordinary-row secrets, private/public separation, fixture dry-run before future migration, and legacy authority until a separate cutover.
