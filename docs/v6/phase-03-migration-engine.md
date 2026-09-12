# Phase 3 - safe local migration engine

MIGRATION_ENGINE=src/lib/storage/v6MigrationEngine.ts; scripts/v6-migrate-storage.cjs
SOURCE_DRIVERS=FILE_PRIMARY_READ_ONLY; MONGO_EXISTING_REVISION_CURSOR_READ_ONLY
DEFAULT_MODE=INVENTORY_NO_WRITES
SOURCE_MUTATION_ALLOWED=NO
REMOTE_APPLY_ALLOWED=NO
RESULT=PASS
SAFE_FOR_PHASE_3_5=YES

Phase 2.6 passed before implementation: 84 recovery copies, 84 verified hashes, zero mismatches. Branch is `master`, HEAD `3f2ee7d8bd1ef57fa9207f021cc03519b7eecde7`; the pre-existing dirty worktree is preserved. No commit or production resource was created.

## Existing boundaries and supported domains

The existing File-to-Mongo migration executor accepts complete collection arrays and targets revision envelopes. It remains available. The D1 domain migration extension reuses `migrationChecksum` canonical fingerprints, `productIdentity` source keys, canonical normalization, the File adapter's streaming JSON member reader, existing Mongo `scanCollection`, D1 product validation and indexed domain writes. SQL remains in `storage/d1/d1MigrationTarget.ts`, not business services. There is no new generic SQL abstraction or duplicate business repository.

| Domain | Migration ownership |
| --- | --- |
| products | Canonical aggregate; existing IDs retained, missing IDs require deterministic stable source identity |
| product source identity/mappings | Existing Product fields and the already-defined D1 projection triggers |
| offers | Existing Product.offers, validated and atomically projected; not a second independent offer authority |
| merchants/categories/affiliate metadata | Existing aggregate fields, not speculative standalone tables |
| publication | Existing aggregate state; no silent status, visibility or verification repair |
| price-history | Every validated source snapshot copied by stable ID, including legitimate equal-price observations |
| mutable settings | Automation and scheduler singleton values only, using existing allowlists and secret rejection |
| jobs/schedules/source health/audit collections/other domains | UNSUPPORTED in this engine; retained in source and explicitly reported, not silently migrated |

Unsupported files/collections are metadata-only inventory entries: `SOURCE_RECORDS=UNKNOWN_NOT_READ`, with an unsupported artifact count. This avoids opening possible credential stores or falsely reporting one file as one domain record. Supported domains report source, valid, duplicate, malformed, conflict, stale and unsupported counts. Quarantined rows retain only ordinal/classification/fingerprints in plans, not raw payloads or credential values.

The older File-to-Mongo CLI's existing test exposed a prior inventory mismatch: the implemented `system-settings` generic revision domain was absent from its migration inventory. `MONGO_MIGRATION_COLLECTIONS` now explicitly includes that bounded singleton domain. The deployed v1 index manifest, schema version and unknown-domain blocker remain unchanged. Tests prove settings ownership does not add production index requirements; no old test expectation was relaxed.

## Classification, fingerprints and apply contract

IDEMPOTENCY=DETERMINISTIC_SOURCE_KEYS_AND_IDS; INSERT_OR_COMPARE_DOMAIN_TRUTH; NO_OVERWRITE
RESUMABLE=LOCAL_CHECKPOINT_PLUS_IDEMPOTENT_REPLAY_OF_VERIFIED_SOURCE
SOURCE_FINGERPRINT=SHA256_CANONICAL_DRIVER_AND_BOUNDED_SOURCE_RECORDS
PLAN_FINGERPRINT=SHA256_CANONICAL_VERSION_POLICY_BATCH_CLASSIFICATION_MAPPING_AND_SOURCE_FINGERPRINT

Every observed candidate is MIGRATABLE, DUPLICATE_EQUIVALENT, SKIP_STALE, QUARANTINE_MALFORMED, QUARANTINE_CONFLICT, or UNSUPPORTED. Same-ID equal-domain records converge. Conflicting canonical IDs sharing source identity/slug are quarantined, even if titles look similar. All conflicting members are blocked, not merely the later arrival. Similar titles alone never merge stable distinct products. Any quarantine blocks apply. Unsupported domains remain explicitly deferred. History staleness is disabled by default; the programmatic planning option requires an explicit deterministic cutoff.

Before apply, the plan fingerprint is checked and the entire bounded source is re-read and re-fingerprinted. A changed source aborts before destination writes. Apply uses that immutable in-memory capture, not subsequent reads from a changing live directory. Existing destination records and identity owners are rechecked. Unequal existing values are never overwritten. Each product write atomically maintains its existing D1 child projections; price/settings inserts use unique IDs plus post-write domain verification.

File input is primary-only: no backup recovery, repair, lock, mkdir or source normalization in place. Syntax errors and oversized records fail closed. Mongo planning calls the existing read-only revision cursor transaction; it does not initialize schema or use source write APIs. CLI Mongo planning accepts only explicitly configured loopback Mongo, never a URI argument. No live Mongo connection was used in this run; deterministic driver tests prove the adapter boundary. CLI apply requires a file shadow copy under the repository's local test area.

Apply requires the `apply` command **and** `--apply`, an explicit run ID, a verified local D1 handle, and `--shadow-source`. Remote/config/token flags are rejected. The helper issues handles from official local Wrangler only and refuses forged foreign handles. Authoritative `.data` cannot be asserted as a shadow directory. Source/output paths are resolved; checkpoint output rejects symbolic-link directories and is confined to `.test-tmp`. No default command initializes a destination or persists a plan.

## Bounds and recovery

Default batch size 25; accepted range 1-100. The first engine deliberately caps a source snapshot at 10,000 records and 32 MiB, with a 1 MiB streaming member ceiling. Larger snapshots fail explicitly; this is not a claim of unlimited production migration throughput. Entity batches never become a whole-collection SQL transaction. D1 payload, offer, identity, settings and history limits remain enforced.

Local checkpoints outside source record migration ID, source/plan fingerprints, domain, last batch, attempted/applied/skipped rows, errors and status. Counters describe the current execution attempt. Resume revalidates the source and replays deterministic inserts/comparisons, including records committed before a checkpoint. It therefore remains safe even if the checkpoint was never persisted. Checkpoint write failure is typed and cannot report completion. No automatic retry loop, source mutation or deletion occurs.

Dry-run reads/classifies source, reads destination identities, reports mapping/conflicts and estimated logical insert bounds, with `D1_WRITES=0`. `ESTIMATED_D1_WRITES` is a conservative logical-row bound (a product can project at most 256 identities and 50 offers), not Cloudflare billing or measured usage. Verification compares canonical aggregate truth, price facts and settings, plus destination counts. Missing and extra records are counted separately, even when their counts cancel. Offline verification counts are deliberately outside runtime hot-path APIs.

## Commands

Run from the repository using `node scripts/v6-migrate-storage.cjs` or `npm.cmd run v6:migrate -- ...`:

1. No arguments: read-only inventory of local `.data`; no destination and no output files.
2. `inventory --source <input>`: supported-domain inventory, with no D1 writes.
3. `init-shadow --apply --run-id <local-id>`: explicit schema initialization of an isolated local shadow DB; not a data migration.
4. `plan --source <input> --shadow-source --run-id <local-id> --batch-size 25`: destination-aware plan, persisted exclusively to `.test-tmp/v6-migrations/<local-id>/plan.json`; existing plan files are not overwritten.
5. `dry-run --source <input> --shadow-source --run-id <local-id> --batch-size 25`: read-only destination analysis, no D1 writes or plan file writes.
6. `apply --apply --source <input> --shadow-source --run-id <local-id>`: explicit local-shadow apply/resume.
7. `verify --source <input> --shadow-source --run-id <local-id>`: domain parity; nonzero exit on mismatch.

Shadow input must be beneath `.test-tmp`; persistent shadow D1 lives only under ignored `.wrangler/sandeal-shadow/<local-id>`. Legacy `.data`, the existing local development D1 and operator sources are not reset or imported remotely.

## Tests and phase gate

FAILURE_INJECTION=PASS_AFTER_COMMIT; BEFORE_CHECKPOINT; AFTER_FIRST_BATCH; CHECKPOINT_UNAVAILABLE; D1_FAILURE
TESTS=773_PASSED_0_FAILED_ACROSS_44_SUITES
TYPESCRIPT=PASS
ESLINT=PASS_0_ERRORS_14_EXISTING_WARNINGS
SECRET_SCAN=PASS
TEST_CASES_SKIPPED=0
TEST_CASES_REMOVED=0
ASSERTIONS_WEAKENED=NO
SAFETY_GATES_RELAXED=NO

The full result ledger is `.test-tmp/v6-validation-AvQEr4/results.json`: all 44 commands exit 0. It contains all previous 708 cases plus 22 new migration cases, 42 existing/additive legacy migration cases, and one additive real-adapter/fake-connection Mongo planning case. The final focused 22-case migration recheck also passes after tightening local source/output path guards. TypeScript, full ESLint, secret scan and diff whitespace checks pass. Scheduler/rollout, archive performance ceilings, File/Mongo, D1, zero-VPS, product-first, source reliability, affiliate/AccessTrade/TikTok, self-healing, revenue and AI provider suites remain green.

Development failures were resolved, not hidden: four new test fixtures initially passed non-persisted undefined optionals to the deliberately strict canonical checksum (fixed by using the existing domain JSON serializer); one actual verifier bug undercounted EXTRA when MISSING also existed (production verifier corrected); the old CLI inventory mismatch was corrected as above. No workload, negative case, safety gate or assertion was weakened.

Read-only inventory of the actual local `.data` found zero records and performed zero D1 writes. Its source fingerprint was `4e08fce07c3a76b269f09157156096891db34d771421bde1de9e28df918fe95f`; no real source import was attempted. Phase 3.5 must therefore use explicit production-shaped schema fixtures, not claim parity against absent operator data.

SOURCE_MUTATED=NO
REMOTE_MIGRATION=NO
PRODUCTION_RESOURCE_CREATED=NO
SHOPEE_STATUS=DISABLED_NO_CREDENTIALS
BLOCKERS=NONE_FOR_LOCAL_SHADOW_PROOF

The Phase 3 gate passed before creating or executing the Phase 3.5 shadow workflow.
