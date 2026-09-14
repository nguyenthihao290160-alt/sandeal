# SANDEAL V6 - Phase 8.5 Content Lifecycle

Date: September 14, 2026. Result: **PASS_LOCAL_SHADOW_FOUNDATION**.
This is a resumed, local-only validation checkpoint, not production authorization.
Phase 9 has not started. No commit, push, deployment, Cloudflare login, DNS change,
publication, deletion, redirect creation, metadata change, or production experiment occurred.

## Reconstruction Of The Interrupted Worktree

- Branch: `master`; HEAD: `39357f28f890d01b9c9ad983f1ee4ccf18b25d11`.
- Initial inventory: 15 modified tracked files and 18 untracked files; none staged.
- Initial `git diff --check`: exit 0. Git reported existing LF/CRLF conversion notices.
- Initial source fingerprint: `b4f5f329fae76e5fd9636113b55215eca8b0359126f7480adcc32d95ebf043c2`.
- Implementation, tests, migration/storage, and Cron/Queue integration were already present.
- The Phase 8.5 document/checkpoint was absent. The top-level state still said Phase 8,
  `RUNNING`, even though historical Phase 8 gates were populated.
- The last saved focused report actually contained **108 passed, 0 failed, 0 skipped**,
  completed at `2026-09-14T00:16:23.206Z`. The prior regression reports contained
  **601 passed**, and all four prior quality commands had exited 0.
- Those results were not treated as validation of later edits. Source manifests showed
  subsequent lifecycle config, evaluator, store, value-store and test changes.
- The first unfinished step was focused validation of that final worktree, not engine
  implementation. The first resumed run passed **112 cases**. Ten additional
  ledger-safety/concurrency/recovery cases then brought the focused suite to **122**.
- The earlier fixture was already corrected: an independent `APPROVED -> REJECTED`
  commission retracts approved evidence while the original `PAID` commission stays final.
  A new negative test verifies that `PAID -> REJECTED` remains quarantined.
- All initial `src/` file contents were preserved exactly during this resume. Only the
  lifecycle tests, validation runner, generated evidence and checkpoint were completed.

No reset, checkout, rollback, removal of pre-existing untracked files, or replacement
of the implemented engine was performed. Previous phase checkpoint history is retained.

## Existing Implementation And Authority

- `src/lib/content/lifecycle/`: deterministic material-change evaluation, lifecycle
  transitions, refresh priority/eligibility, evidence projection and conservative value snapshots.
- `src/lib/storage/d1/d1ContentLifecycleStore.ts`: explicit shadow content registration,
  compare-and-swap plan/relationship observations, bounded work discovery, orchestration,
  atomic evaluations and immutable audits, and indexed portfolio reads.
- `src/lib/storage/d1/d1ContentValueStore.ts`: bounded attribution inbox processing,
  ledger-referenced projections, snapshots and indexed value ranking.
- `src/lib/storage/d1/migrations/0009_content_lifecycle.sql`: extends the existing jobs
  table without replacing the job system, and adds shadow lifecycle/attribution tables,
  trigger-driven invalidation, uniqueness constraints, indexes and retention caps.
- `src/lib/runtime/cloudflare/contentLifecycle.ts`, the existing scheduler adapter and
  Queue consumer wire the single `CONTENT_LIFECYCLE_EVALUATE` job type into D1 claims,
  durable outbox dispatch, capped retries, leases and redelivery handling.

Money Engine, Deal Intelligence, Decision OS policy, Opportunity Engine and the existing
Phase 8 content plan remain upstream authorities. Lifecycle decisions cannot edit their
scores, evidence, ledger rules, affiliate destinations or publication permissions.

### Material Change And Refresh

Material price change uses a 3% threshold; DealScore and confidence thresholds are 10
points and 0.15 respectively. Changed product facts, selected offer/route, policy,
opportunity priority, coverage and canonical relationships are evaluated deterministically.
Tiny price movements and metadata-only changes do not authorize content refresh.

The evidence fingerprint includes canonical/content identity, baseline/current evidence,
content-plan and value fingerprints, and configuration. Evaluation time and page age do
not by themselves authorize refresh. A real evidence-freshness failure, expired offer,
invalidated fact or unsafe route still requires corrective evidence/review or a block.

`BLOCK`/`QUARANTINE`, unsafe destinations, invalid prices and blocked content plans cannot
be bypassed by revenue or experiment evidence. Missing/low-confidence evidence, review
policy and canonical conflicts fail closed into review or block. Value can only provide
a bounded priority bonus after safety gates. Requests to refresh price/offers, content
refresh plans, merge/supersede recommendations and archive reviews are inert shadow records.

### Concurrency And Stale Jobs

Concurrent registration and refresh producers converge on one identity/job. Concurrent
consumers, later redelivery and a lost acknowledgement produce one committed plan/audit.
Queued evidence/configuration is recomputed before execution; stale fingerprints or
algorithm/config versions complete as `STALE_JOB_NOOP` without a lifecycle plan, and
leave current work pending. A transactional source/revision fence rejects evidence that
changes between preparation and commit. Lease takeover prevents the old consumer writing.

Equivalent duplicate invalidation with unchanged authoritative evidence is not falsely
classified as stale. Noncritical events coalesce for 30 seconds; equivalent material
state observes a one-hour cooldown. Critical evidence bypasses coalescing/cooldown.
These limits do not create a new service or continuous polling loop.

### Attribution And Content Value

Attribution requires an explicitly registered content identity and a matching immutable
money click. It follows the existing content-to-click-to-conversion-to-commission chain,
checking canonical product, provider, platform, currency, origin and timestamps. Every
projection references an existing deduplicated `affiliate_money_events` identity.
Content and shadow-experiment projections can reference the same click/business event
without creating additional money or counting a business event twice in either projection.

The public redirect endpoint is unchanged and has no content-source override. Unlinked
historical clicks are not reverse-attributed. Ambiguous, mismatched, future or missing
chains remain unknown/unattributed or are quarantined. Fixture-origin evidence cannot
enter authenticated-origin content value.

Approved commission is not paid revenue. Revision processing reclassifies or retracts
approved evidence transactionally; final paid money remains final. Duplicate clicks,
conversions, commission revisions and revenue reconciliation have zero additional effect.

Snapshots retain currency-specific minor-unit evidence, counts, source fingerprints,
window, confidence and completeness. No data gives `UNKNOWN`, zero confidence and
`revenueEvidence: null`, not fabricated zero revenue or low business value. Partial
observed zero payment does not establish complete zero content value. Low sample sizes
remain insufficient evidence. Confidence is capped at 0.9; attribution does not establish
causal impact. External SEO evidence remains `NOT_AVAILABLE`.

### AI, Merge And Archive Safety

AI is disabled/advisory: zero AI attempts and no live probe. Old AI prose cannot supply
facts, override policy or influence the authoritative fingerprint. Refresh briefs separate
changed, invalidated and still-valid facts; invalidated references cannot be preserved or
reused as current evidence. New claims require validated evidence.

Merge/supersede relationships require a registered matching canonical target and an
explicit compare-and-swap observation. They are recommendations, not URL operations.
Obsolescence can recommend archive review; age, low sample size or no revenue cannot
auto-archive anything. There is no production content or redirect executor.

## Resource Budget And Runtime Boundary

| Resource | Hard bound / behavior |
| --- | --- |
| Due lifecycle candidates | 20 per invocation, indexed urgency/due queries |
| New lifecycle jobs | 5 per invocation |
| Config invalidation | Keyset pages of 5; no unbounded scan |
| Attribution inbox work | 5 per invocation by default; indexed pending sequence |
| Portfolio/value queries | Explicit limit, maximum 20 |
| Registered content | 16 records per canonical product |
| Fact evidence | 32 facts per evaluation |
| Value window | Up to 31 days, 3 currencies, at most 93 daily buckets |
| Refresh/audit history | Up to 256 per content; immutable audits are not silently pruned |
| Attribution history | Up to 20,000 event keys per content; additional attribution is not inferred |
| Merge/supersede reviews | At most 2 per invocation |
| AI reviews | Disabled; no provider calls |

Caps are conservative retention limits, not an automated production retention policy.
Reaching them requires a separately reviewed retention design; it does not justify
deleting money history, lowering constraints or claiming complete attribution coverage.
Query-plan tests verify indexed searches without table scans or temporary sort trees
for due work, attribution, value and portfolio paths.

The optional `SANDEAL_CONTENT_LIFECYCLE_ENABLED=true` flag requires local-only Cloudflare
mode, production false, AutoPilot/Deal/Decision/Opportunity prerequisites, D1 and Queue.
It is not enabled in shipped configuration. Missing prerequisites fail closed without
FileStorage, filesystem settings, PM2, VPS or long-running process fallbacks.

Native `workerd` proof exercises Cron, Queue and replay with authenticated-origin safety:
fixture-derived evidence is blocked, no public product payload changes, and no money or
experiment-assignment event is created. The positive AccessTrade/Shopee lifecycle proof
uses explicit local fixture injection and real normalization, preserves the registered
content/canonical identity through offer replacement, and makes zero direct Shopee calls.

## Validation Results

| Suite / gate | Passed | Disposition |
| --- | ---: | --- |
| Phase 8.5 focused lifecycle | 122 | Fresh final run; 0 failed/skipped |
| Phase 8 content | 9 | Rerun |
| D1 | 25 | Rerun |
| Queue | 17 | Rerun |
| Cron | 10 | Rerun |
| AutoPilot | 4 | Rerun |
| Cloudflare runtime | 14 | Rerun |
| Cloudflare routing | 11 | Rerun |
| Zero-VPS storage | 9 | Rerun |
| Revenue integrity | 5 | Rerun |
| Opportunity/experiments | 127 | Reused verified unchanged regression |
| Decision OS | 132 | Reused verified unchanged regression |
| Deal Intelligence | 79 | Reused verified unchanged regression |
| Money Engine | 57 | Reused verified unchanged regression |
| AccessTrade safety | 34 | Reused verified unchanged regression |
| AccessTrade/TikTok | 43 | Reused verified unchanged regression |
| Publication safety | 25 | Reused verified unchanged regression |
| TypeScript | PASS | `tsc --noEmit --incremental false` |
| ESLint | PASS | 0 errors; 35 pre-existing warnings, identical to the prior log |
| Secret scan | PASS | Repository scanner |
| Cloudflare static and Worker builds | PASS | Local only; zero forbidden storage modules |

Critical regressions total **601**: 104 rerun, 497 reused. Combined unique phase and
regression cases: **723 passed, 0 failed, 0 skipped**. The initial resumed 112-case run
is not counted again. Two validation-runner invalid-selection guard checks also pass
and are not included in the 723-case total.

Reused results have checked successful logs and unchanged authoritative implementations
and test sources. Later edits were confined to opt-in lifecycle code, covered by the
fresh focused and affected integration runs. Expensive unrelated suites were not restarted.
The runner now accepts exact suite names and creates a unique results directory so that
selective resumption does not replace the prior regression/quality logs.

```text
node scripts/v6-content-lifecycle-tests.mjs
node scripts/v6-phase8-5-validation.mjs tests content-phase8 d1 queue cron autopilot runtime routing zero-vps revenue
node scripts/v6-phase8-5-validation.mjs quality
```

## Full Phase 8.5 Gates

```text
PHASE8_5=PASS
CONTENT_LIFECYCLE_ENGINE=PASS
MATERIAL_CHANGE_ENGINE=PASS
TIME_ONLY_REFRESH_EFFECT=0
REFRESH_ELIGIBILITY=PASS
REFRESH_PRIORITY=PASS
REFRESH_ORCHESTRATOR=PASS
REFRESH_JOB_STORM_GUARD=PASS
REFRESH_COOLDOWN=PASS
STALE_REFRESH_JOB_EFFECT=0
LIFECYCLE_EVIDENCE_FINGERPRINT=PASS
CONTENT_VALUE_ATTRIBUTION=PASS
CONTENT_VALUE_SNAPSHOT=PASS
CONTENT_VALUE_CONFIDENCE=PASS
UNKNOWN_VALUE_ZERO_COERCION_EFFECT=0
NO_REVENUE_AUTO_ARCHIVE_EFFECT=0
CONTENT_DECAY=PASS
CONTENT_ATTRIBUTION_CHAIN=PASS
RESOURCE_BUDGET=PASS
AI_IS_ADVISORY=YES
LIVE_AI_PROBE=NOT_RUN
INVALIDATED_FACT_REUSE_EFFECT=0
AI_PROSE_AS_AUTHORITY=NO
MERGE_FOUNDATION=PASS
ARCHIVE_SAFETY=PASS
ACCESS_TRADE_SHOPEE_LIFECYCLE=PASS
DIRECT_SHOPEE_STATUS=DISABLED_NO_CREDENTIALS
DIRECT_SHOPEE_API_CALLS=0
DUPLICATE_REFRESH_EVALUATION_EFFECT=0
DUPLICATE_REFRESH_JOB_EFFECT=0
DUPLICATE_LIFECYCLE_PLAN_EFFECT=0
DUPLICATE_CONTENT_CLICK_EFFECT=0
DUPLICATE_CONTENT_CONVERSION_EFFECT=0
DUPLICATE_CONTENT_REVENUE_EFFECT=0
CONTENT_LIFECYCLE_POLICY_OVERRIDE_EFFECT=0
CONTENT_LIFECYCLE_FULL_SCAN=NO
REFRESH_QUEUE_FULL_SCAN=NO
CONTENT_VALUE_FULL_SCAN=NO
CONTENT_ATTRIBUTION_FULL_SCAN=NO
DUE_REFRESH_WORK_FULL_SCAN=NO
CONTENT_PORTFOLIO_FULL_SCAN=NO
PRODUCTION_CONTENT_MUTATIONS=0
PRODUCTION_CONTENT_PUBLISHED=0
PRODUCTION_CONTENT_DELETED=0
PRODUCTION_REDIRECTS_CREATED=0
PRODUCTION_METADATA_MUTATIONS=0
PRODUCTION_EXPERIMENT_TRAFFIC=0
ACTIVE_PRODUCTION_EXPERIMENTS=0
FILE_STORAGE_CALLS=0
FILESYSTEM_SETTINGS_CALLS=0
PM2_REQUIRED=NO
VPS_REQUIRED=NO
LONG_RUNNING_PROCESS_REQUIRED=NO
CONTINUOUS_POLLING=NO
ASSERTIONS_WEAKENED=NO
SAFETY_GATES_RELAXED=NO
TYPESCRIPT=PASS
ESLINT=PASS_0_ERRORS_35_EXISTING_WARNINGS
SECRET_SCAN=PASS
BUILD_CLOUDFLARE=PASS_STATIC_AND_WORKER
BUILD_LEGACY=NOT_RUN_UNAFFECTED
COMMITTED=NO
PUSHED=NO
DEPLOYED=NO
CLOUDFLARE_LOGIN_USED=NO
DNS_CHANGED=NO
PHASE9_STARTED=NO
RESULT=PASS_LOCAL_SHADOW_FOUNDATION
```

## Evidence And Stop Boundary

- `docs/v6/evidence/phase8-5-resume-audit.json`: authoritative reconstruction, prior
  validation results, source fingerprints and preserved phase history.
- `docs/v6/evidence/phase8-5-completion.json`: final focused cases/proofs, rerun/reused
  regressions, quality results, preservation checks and the full gate map.
- `.test-tmp/phase8-5/tests-resume-0KTQfr/results.json`: fresh affected regressions.
- `.test-tmp/phase8-5/quality-resume-JPF5Av/results.json`: fresh quality/build gates.
- `docs/v6/LONG_RUN_STATE.json`: completed Phase 8.5 checkpoint with previous phases retained.

The inherited Phase 8 scaffold has nine tests; some earlier documentation reports broader
SEO capabilities than those tests establish. Phase 8.5 does not treat configuration PASS
constants as independent proof, rewrite that scaffold, or claim production SEO readiness.
External SEO performance, live AI, production publishing, production attribution coverage,
retention beyond the hard caps and production deployment remain unverified/out of scope.

**STOP after Phase 8.5. Phase 9 requires a separate explicit instruction.**
