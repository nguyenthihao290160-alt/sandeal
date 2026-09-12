# SanDeal V6 Phase 01.5 verification lock

Audit date: 2026-09-07 (Asia/Saigon). Repository: `C:\duan\sandeal`.

RESULT=FAIL

SAFE_TO_BEGIN_PHASE_2=NO

The original 286-case selection independently passed, but that result did not establish test integrity. Phase 1 weakened two assertion sites and introduced a normalization omission in the new affiliate boundary. Those defects were reproduced and corrected here. The expanded verification still has three scheduler regression failures, two invalid-rollout consumer failures, and a pre-existing synthetic Shopee seed. A clean verification lock cannot be issued.

No Phase 2 implementation, deployment, data migration, commit, push, or real provider probe was performed. Production edits in this verification are limited to the proven normalization defect in the new V6 wrapper. Existing runtime/storage changes were preserved.

## Required status

```text
BRANCH=master
HEAD=3f2ee7d8bd1ef57fa9207f021cc03519b7eecde7
WORKTREE_DIRTY=YES
CHANGED_FILES=18 tracked paths at entry; 19 at completion
UNVERSIONED_FILES=22 individual files at entry; 23 at completion including this report
PHASE1_FILES=18 paths: 4 existing modifications and 14 creations
PREEXISTING_FILES=22 dirty paths: 14 tracked and 8 untracked
UNKNOWN_ATTRIBUTION_FILES=NONE unclassified at path level; unrecorded hunk authorship is UNKNOWN_PREEXISTING
EXISTING_TEST_FILES_MODIFIED=2 by Phase 1; 2 additional test files were already dirty
TEST_CASES_REMOVED=0
TEST_CASES_SKIPPED=0
ASSERTIONS_WEAKENED=8 assertions across 2 sites at entry; 0 remaining at those sites after correction
SAFETY_THRESHOLDS_RELAXED=1 test workload contract at entry (50 -> any 1..50); restored to 50
PRODUCTION_BEHAVIOR_CHANGED=YES in new adapter normalization; corrected. No existing live caller rewired by Phase 1
SHOPEE_FAKE_DATA=YES in pre-existing development seed; NO introduced by Phase 1
SHOPEE_LIVE_CALL_WITHOUT_CREDENTIALS=NO
SECRET_EXPOSURE_FOUND=NO
TEST_COMMANDS=Recorded below
TEST_RESULTS=Original selection 286/286; final selected regressions 339 passed, 3 failed
RISKS=Pre-existing scheduler failures, invalid-rollout consumers, default-contract conflicts, synthetic Shopee seed, unverified live deployment
SAFE_TO_BEGIN_PHASE_2=NO
RESULT=FAIL
```

The 339/3 total uses the latest result for each of the 22 regression scripts, including the one added normalization case. It does not double-count reruns or count intentional mutation probes as ordinary regressions. The two invalid-rollout consumer failures are additional focused diagnostic findings.

## 1. Worktree reconstruction and attribution

### Commands recorded

Executed `git branch --show-current`, `git rev-parse HEAD`, `git status --short`, `git diff --stat`, `git diff`, and `git diff --cached`. Also expanded untracked directories with `git ls-files --others --exclude-standard`.

Full unstaged diff was captured in memory, hashed, and inspected by file/hunk; sensitive values were not dumped into this report.

| Record | Entry | After verification corrections |
| --- | --- | --- |
| Branch | master | master |
| HEAD | 3f2ee7d8bd1ef57fa9207f021cc03519b7eecde7 | 3f2ee7d8bd1ef57fa9207f021cc03519b7eecde7 |
| Unstaged diff UTF-8 bytes | 229134 | 230276 |
| Unstaged diff SHA-256 | 5fb2a859b6ae4d62f300d058312c6de57f5d6c116bdebcbabbcb30125151d829 | 3db3e9dec0335413c1767e93f868d2413602593519e5e52403ff52527a2c95dd |
| Cached diff | Empty, 0 bytes | Empty, 0 bytes |
| Cached diff SHA-256 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |

Entry `git status --short`:

```text
 M .env.example
 M docs/operations/AUTOMATION_JOB_HISTORY_ARCHIVE.md
 M ecosystem.config.cjs
 M package.json
 M scripts/automation-scheduler.cjs
 M scripts/automation-worker.cjs
 M scripts/product-first-pipeline-worker-tests.cjs
 M scripts/prompt10-business-source-tests.cjs
 M scripts/prompt10-self-healing-tests.cjs
 M scripts/runtime-fence-commit-window-tests.cjs
 M src/lib/automation/featureRollout.ts
 M src/lib/automation/jobHistoryArchive.ts
 M src/lib/automation/postPublishMonitor.ts
 M src/lib/automation/providerRegistry.ts
 M src/lib/automation/runtimeRoles.ts
 M src/lib/storage/adapter.ts
 M src/lib/storage/fileStorageAdapter.ts
 M src/lib/storage/types.ts
?? docs/v6/
?? scripts/fixtures/v5-history-production-skew.json
?? scripts/repair-automation-job-history.cjs
?? scripts/scheduler-incumbent-regression-tests.cjs
?? scripts/scheduler-role-heartbeat-regression-tests.cjs
?? scripts/v5-history-cross-process-worker.cjs
?? scripts/v5-history-durability-tests.cjs
?? scripts/v6-phase1-foundation-tests.cjs
?? scripts/verify-v5-invariants.cjs
?? src/lib/affiliate/
?? src/lib/automation/jobHistoryMaintenance.ts
?? src/lib/platform/
?? src/lib/runtime/
```

Entry `git diff --stat`:

```text
 .env.example                                      |    8 +
 docs/operations/AUTOMATION_JOB_HISTORY_ARCHIVE.md |  123 ++
 package.json                                      |    4 +
 scripts/automation-scheduler.cjs                  |  988 ++++++++++++++--
 scripts/automation-worker.cjs                     | 1259 +++++++++++++++------
 scripts/product-first-pipeline-worker-tests.cjs   |    7 +-
 scripts/prompt10-business-source-tests.cjs        |   26 +-
 scripts/prompt10-self-healing-tests.cjs           |  195 +++-
 scripts/runtime-fence-commit-window-tests.cjs     |  202 ++++
 src/lib/automation/featureRollout.ts              |  410 +++++--
 src/lib/automation/jobHistoryArchive.ts           | 1151 +++++++++++++++----
 src/lib/automation/postPublishMonitor.ts          |  115 +-
 src/lib/automation/providerRegistry.ts            |   39 +
 src/lib/automation/runtimeRoles.ts                |  492 +++++---
 src/lib/storage/adapter.ts                        |   19 +
 src/lib/storage/fileStorageAdapter.ts             |   46 +-
 src/lib/storage/types.ts                          |   37 +-
 17 files changed, 4158 insertions(+), 963 deletions(-)
```

`ecosystem.config.cjs` is reported modified by status but has no textual diff. It was already listed this way in the Phase 1 opening status. It is retained as pre-existing metadata/working-copy dirt; it is not silently dropped from the count. Git emitted existing LF/CRLF warnings. No line-ending conversion was performed by this verification.

### Attribution evidence

The original local Phase 1 transcript is:

`C:/Users/huydj/.codex/sessions/2026/09/06/rollout-2026-09-06T19-32-15-01a076b4-7fa0-7ee1-9bbb-03097ea39e95.jsonl`.

Evidence is stronger than the previous report alone:

- Row 18, timestamp `2026-09-06T12:32:33.219Z`, records the opening branch, HEAD, and the exact 22 pre-existing dirty paths.
- Rows 206, 230, 237 and 281 record new file patches; rows 244, 267 and 302 record configuration/interface and new-file adjustments.
- Rows 390 and 411 record the two product-first test patches.
- Rows 493 and 514 record the source-test assertion and fixture patches.
- Row 578 creates the Phase 1 report.
- The opening status contains neither of the two Phase 1 modified test files. It does contain the self-healing and runtime-fence tests.
- No Phase 1 patch in that captured mutation history targets the pre-existing runtime/storage files.

The transcript and `docs/v6/CURRENT_STATE.md` agree at file level. A complete cryptographic snapshot of every dirty file immediately before Phase 1 is unavailable. Therefore this report does **not** infer authorship or timing of every pre-existing hunk, nor prove that an unlogged manual edit could not have occurred. Such hunk-level attribution is `UNKNOWN_PREEXISTING`.

A. Tracked files already dirty before Phase 1:

- `docs/operations/AUTOMATION_JOB_HISTORY_ARCHIVE.md`
- `ecosystem.config.cjs`
- `package.json`
- `scripts/automation-scheduler.cjs`
- `scripts/automation-worker.cjs`
- `scripts/prompt10-self-healing-tests.cjs`
- `scripts/runtime-fence-commit-window-tests.cjs`
- `src/lib/automation/featureRollout.ts`
- `src/lib/automation/jobHistoryArchive.ts`
- `src/lib/automation/postPublishMonitor.ts`
- `src/lib/automation/runtimeRoles.ts`
- `src/lib/storage/adapter.ts`
- `src/lib/storage/fileStorageAdapter.ts`
- `src/lib/storage/types.ts`

B. Existing files modified by Phase 1:

- `.env.example`
- `scripts/product-first-pipeline-worker-tests.cjs`
- `scripts/prompt10-business-source-tests.cjs`
- `src/lib/automation/providerRegistry.ts`

C. Unversioned files created by Phase 1:

- `docs/v6/CURRENT_STATE.md`
- `docs/v6/phase-01-foundation.md`
- `scripts/v6-phase1-foundation-tests.cjs`
- `src/lib/affiliate/accessTradeProviders.ts`
- `src/lib/affiliate/index.ts`
- `src/lib/affiliate/registry.ts`
- `src/lib/affiliate/service.ts`
- `src/lib/affiliate/shopeeAffiliateProvider.ts`
- `src/lib/affiliate/types.ts`
- `src/lib/platform/factory.ts`
- `src/lib/platform/index.ts`
- `src/lib/platform/legacyAdapters.ts`
- `src/lib/platform/types.ts`
- `src/lib/runtime/config.ts`

D. Unversioned files already present before Phase 1, not attributable to it:

- `scripts/fixtures/v5-history-production-skew.json`
- `scripts/repair-automation-job-history.cjs`
- `scripts/scheduler-incumbent-regression-tests.cjs`
- `scripts/scheduler-role-heartbeat-regression-tests.cjs`
- `scripts/v5-history-cross-process-worker.cjs`
- `scripts/v5-history-durability-tests.cjs`
- `scripts/verify-v5-invariants.cjs`
- `src/lib/automation/jobHistoryMaintenance.ts`

No additional unclassified source path was found at verification entry. Ignored test artifacts and TypeScript caches are not counted as source creations.

### Changes made during this verification

Only after reproducing defects:

| File | Correction | Evidence before edit |
| --- | --- | --- |
| `scripts/product-first-pipeline-worker-tests.cjs` | Restore the complete `settings.maxConcurrency` argument boundary; allow whitespace and an optional trailing comma | Phase 1 regex accepted a different property and arithmetic inside the argument |
| `scripts/prompt10-business-source-tests.cjs` | Configure ten eligible keywords in isolated test settings and a fixed 50-item fixture across bounded requests; restore all seven exact 50-item assertions, require the 24-item request limit and ten requests, restore settings in finally | All 13 tests passed with an in-memory production mutation forcing per-keyword limit to 1 |
| `src/lib/affiliate/accessTradeProviders.ts` | Call the existing source adapter's `normalize` before constructing each V6 product | Existing adapter normalization removed `rawData`; new wrapper retained it |
| `scripts/v6-phase1-foundation-tests.cjs` | Add a real-adapter normalization regression for AccessTrade/TikTok; use an already-recognized synthetic test marker | New regression failed before the one-line wrapper correction; old fixture omitted the field it purported to check |
| `scripts/release-validation.cjs` | Allow exactly the two public safe defaults `SANDEAL_RUNTIME=legacy` and `SHOPEE_AFFILIATE_ENABLED=false` | Existing secret gate failed on those two public defaults plus the synthetic test marker |

No general secret rule or ignore pattern was relaxed. Negative probes still reject enabled Shopee in the example, the Cloudflare default, and populated Shopee key configuration.

## 2. Every existing test change

Counts below are static `test(...)` declarations and assertion calls, not a claim that each assertion executes exactly once. Test names numbered through “39” in the product-first script do not mean that script contains 39 cases.

| File | HEAD cases -> Phase 1 entry cases | HEAD assertions -> entry assertions | Attribution |
| --- | --- | --- | --- |
| `product-first-pipeline-worker-tests.cjs` | 16 -> 16 | 45 -> 46 | Phase 1; one case renamed |
| `prompt10-business-source-tests.cjs` | 13 -> 13 | 80 -> 81 | Phase 1 |
| `prompt10-self-healing-tests.cjs` | 8 -> 10 | 74 -> 94 | Already dirty before Phase 1 |
| `runtime-fence-commit-window-tests.cjs` | 8 -> 12 | 54 -> 90 | Already dirty before Phase 1 |

### T1. Pool default assertion and case name

FILE=`scripts/product-first-pipeline-worker-tests.cjs:294`

CLASSIFICATION=`STALE_EXPECTATION_UPDATE` for the default assertion; `FORMAT_ONLY` for the explanatory case-name change.

OLD CONTRACT=`isContinuousWorkerPoolEnabled({}) === true`.

NEW CONTRACT=Absent configuration leaves the continuous pool disabled; explicit `WORKER_CONTINUOUS_POOL_V2=ACTIVE` enables it.

PRODUCTION CODE SUPPORTING NEW CONTRACT=`featureRollout.ts` default is OFF; `isContinuousWorkerPoolEnabled` requires valid ACTIVE effective mode. This change existed before Phase 1.

INDEPENDENT INTENT EVIDENCE=The HEAD versions of `.env.example`, `scripts/master-m1-runtime-recovery-tests.cjs:107`, `scripts/master-m2-worker-pool-tests.cjs:737`, and `docs/implementation/SANDEAL_MASTER_UPGRADE_STATUS.md:264` establish OFF/explicit activation. This is not justified solely by current implementation output.

WHY CHANGE WAS NECESSARY=The old assertion conflicted with those existing opt-in safety rules and the pre-Phase-1 baseline. The actual workload remains 8 claims, 4 slots, one reserved critical slot, exact claim count 8, and both measured peaks exactly 4.

QUALIFICATION=`docs/AI_WORK_HANDOFF.md:681` describes ACTIVE as default and HEAD implementation was ACTIVE. The repository contains contradictory rollout history. The more restrictive test is defensible, but the overall rollout contract is not fully reconciled.

### T2. Launcher concurrency regex

FILE=`scripts/product-first-pipeline-worker-tests.cjs:315`

CLASSIFICATION=`TEST_WEAKENING` at Phase 1 entry; corrected here to formatting tolerance without dropping the argument boundary.

OLD CONTRACT=Require the clamp to use the exact `Number(settings.maxConcurrency)` argument.

NEW CONTRACT AT ENTRY=Match only the prefix `Number( ... settings.maxConcurrency`, with no property or argument terminator.

PRODUCTION CODE SUPPORTING NEW CONTRACT=The pre-existing launcher reformatted `Number` across lines and included a legal trailing comma. It did not change the selected field.

WHY CHANGE WAS NECESSARY=Whitespace/trailing-comma tolerance was necessary. Removing the terminator was not necessary and had no product/configuration justification.

PROOF=The Phase 1 regex accepted both `settings.maxConcurrencyOverride` and `settings.maxConcurrency + 3`; HEAD regex rejected them. The repaired regex accepts the actual formatted code and rejects both mutations. Four-slot and eight-claim runtime assertions remain exact.

### T3. Source fixture identity and diversity

FILE=`scripts/prompt10-business-source-tests.cjs:187`

CLASSIFICATION=`STALE_EXPECTATION_UPDATE`.

OLD CONTRACT=All generated products used one merchant and lacked an explicit campaign identity, yet all were expected to enter the queue.

NEW CONTRACT=Each valid normalization/queueing fixture has a complete campaign, merchant, merchant domain, canonical product URL and affiliate URL, with distinct merchants/campaigns.

PRODUCTION CODE SUPPORTING NEW CONTRACT=`src/lib/bots/productPipeline.ts:574` checks complete source identity and later calls `selectDiversifiedSources`; `src/lib/storage/automationSettings.ts:92` defines per-merchant/per-campaign caps. These files are unchanged from HEAD.

INDEPENDENT INTENT EVIDENCE=Unmodified `scripts/source-reliability-tests.cjs` tests 15–20 exercise diversification/deduplication and test 20a explicitly makes incomplete identities non-selectable. `scripts/source-discovery-identity-tests.cjs` preserves multi-campaign identity and merchant-circuit exclusions. Both suites passed.

WHY CHANGE WAS NECESSARY=A valid “normalize then queue every supplied eligible item” fixture must not violate those independently tested eligibility/cap contracts. Raising the caps or bypassing source identity was not necessary. The final test still exercises 50 accepted items; diversity caps themselves remain covered independently.

### T4. Source cardinality assertions

FILE=`scripts/prompt10-business-source-tests.cjs`, runtime source scan case.

CLASSIFICATION=`TEST_WEAKENING` and `TEST_SCOPE_REDUCTION` at Phase 1 entry.

OLD CONTRACT=Exactly 50 found, 50 normalized, 50 queued, queue length 50, and three exact 50-valued source-quality counters.

NEW CONTRACT AT ENTRY=All seven expected values became the observed first request limit; only `0 < limit <= 50` constrained that limit.

PRODUCTION CODE SUPPORTING NEW CONTRACT=`productPipeline.ts:540` computes a bounded pool and divides it among selected keywords; defaults are an 80-candidate pool target, multiplier 3, and 10 selected keywords, yielding a 24-item request. A configuration-aware test is reasonable.

INDEPENDENT INTENT EVIDENCE=The existing settings contract and bounded adapter request tests support controlled variable limits and a 50-item ceiling. They do not authorize accepting every positive workload as proof of the original 50-item regression.

WHY CHANGE WAS NECESSARY=The old fixture did not deterministically request 50 under the current established settings. Deriving the expected result from the system under test was unnecessary and erased a useful workload guarantee.

PROOF=An isolated, memory-only replacement of the production per-keyword calculation with `1` left all 13 Phase 1 source tests green. The corrected test supplies a fixed 50-item fixture across bounded requests, retains ten eligible keywords and the existing 240-item discovery pool, preserves all seven exact 50-item checks, asserts `firstRequestLimit === 24` and exactly ten requests, and restores prior test settings. The same mutation now fails with `1 !== 24`; it also supplies only ten of the required 50 items. Neither production bounds nor the test's keyword scan/load were reduced.

### T5. Pre-existing self-healing fixture changes and added cases

FILE=`scripts/prompt10-self-healing-tests.cjs`.

Attribution: already dirty in the original opening status; not a Phase 1 patch. All hunks were inspected because they affect the combined worktree.

| Change | Classification | OLD CONTRACT | NEW CONTRACT | Production/independent support and necessity |
| --- | --- | --- | --- | --- |
| Reset `domain-circuit-breakers` | BUG_FIX | Circuit observations could leak between cases | Each case starts with clean isolated circuits | Domain circuits are durable; independent source-reliability tests prove they alter selection. Required fixture isolation, not removal of in-case circuit behavior |
| Set `enabled` together with `launchEnabled` | STALE_EXPECTATION_UPDATE | A case requesting CANARY/AUTONOMOUS launch could retain the default disabled automation state | Both controls match the explicitly requested test mode | Existing settings default disabled; safe-publication/zero-touch tests require explicit enabled operation. No production gate was removed |
| Put a rejected, higher-ranked alternate before the valid offer; record probe order/counts | BUG_FIX (coverage strengthening) | One valid alternate only | Reject first candidate, probe second exactly once, then retain existing exact URL/evidence assertions | Existing fallback contract in the same HEAD test expects validated canonical/offer/image recovery; URL health tests distinguish failed from healthy evidence |
| Add failed/timeout/ambiguous/throwing alternates case | BUG_FIX (coverage addition) | No combined negative matrix | URLs, best offer and primary selection unchanged after failed probes; exact confirmed-broken status and one probe per unique URL | Fail-closed publication/source reliability contract; directly checks the new fallback implementation's negative outcomes |
| Add 12-alternate bounded probing case | BUG_FIX (coverage addition) | No explicit fallback fan-out ceiling case | Exactly 8 distinct probes; later healthy alternate outside bound not visited or selected | Existing bounded-network policy plus newly explicit `MAX_COMMERCE_LINK_CANDIDATES=8`; this adds a bound and does not raise an old threshold |

The eight old cases remain. Two added cases passed, and existing two-observation hiding/recovery/idempotency assertions remain intact.

### T6. Pre-existing runtime-fence changes and added cases

FILE=`scripts/runtime-fence-commit-window-tests.cjs`.

Attribution: already dirty before Phase 1.

| Change | Classification | OLD CONTRACT | NEW CONTRACT | Supporting contract and necessity |
| --- | --- | --- | --- | --- |
| Test process sets fence lease to 15,000 ms | BUG_FIX (fixture determinism) | Default fence lease applied to all cases | Explicit supported minimum for observing a hung heartbeat within the new case's deadline | Production supports a 15,000-ms minimum; role leases and old load/concurrency assertions are unchanged. A shorter fence does not grant more authority |
| Collection-lock helper and two clock-wait cases | BUG_FIX (coverage addition) | No direct test of a lease being born expired after lock waits | Acquired/expiry times equal the post-lock clock and exact 5,000-ms lease; owner/release checks remain exact | Existing finite-role-lease contract; `runtimeRoles.acquireRuntimeRole` captures time inside the transaction |
| Same-instance expiry/release epoch case | BUG_FIX (coverage addition) | No combined epoch progression test | Live renewal preserves epoch; expired/released reacquisition increments it; old heartbeats/releases/authority rejected | Existing fencing ownership invariant and stale-completion test |
| Hung internal heartbeat/finally case | BUG_FIX (coverage addition) | No explicit hung-cleanup case | Operation finishes within 9 seconds; abandoned fence stays ACTIVE only until finite durable expiry, bounded to start + 16 seconds | `runtimeRoles.acquireRuntimeFence` sets closing/lost and avoids queuing release behind a hung write |
| Two `holder.operation.catch(() => undefined)` calls in finally | BUG_FIX (cleanup) | No helper cleanup | Release a held test lock even after a failed test | The holder callback only waits/releases; main assertions and awaited acquisition errors still propagate to the failing test harness. These are not caught assertion failures |

All eight original cases remain. Four added cases passed. No old load, concurrency, timing assertion, or safety threshold was increased.

## 3. Test-strength guarantee and limitations

Diff/AST searches covered every modified tracked test and all newly untracked code/test files. Searched for `.skip`, `.only`, `fit`, `fdescribe`, `xit`, `xdescribe`, exit-success assignments, assertion deletion, ignored catches, TypeScript suppression, and build-error bypass.

- No deleted test file, removed test case, focused test, skipped test, or new failure-success exit was found.
- One product-first test was renamed; it was not removed/replaced with reduced workload.
- The test harnesses still count caught failures and return nonzero exit status.
- The two cleanup catches above are explained. Other runtime catches retain explicit lease loss/expiry and are not test suppression.
- Phase 1 added two assertions overall, but raw assertion counts did not prevent eight existing assertions from becoming weaker.
- The exact 50-item workload and exact concurrency-source expression are now restored; mutation probes demonstrate that the repairs detect their respective regressions.
- Source diversity, merchant/campaign limits, the four-slot pool ceiling, and eight-claim workload were not lowered in production.
- The new V6 tests originally checked a missing `rawData` property on a fixture that never contained it. A new case now injects raw metadata through the actual legacy source adapters and requires normalization for both provider wrappers.
- Unchanged safety suites passing does not resolve contradictory rollout defaults or the separate pre-existing failures below.

## 4. Production behavior audit

### Phase 1 changes and boundary behavior

| FILE | FUNCTION | BEFORE | AFTER | REASON | RISK |
| --- | --- | --- | --- | --- | --- |
| `.env.example` | Configuration only | No SANDEAL_RUNTIME/new Shopee names | Legacy runtime, disabled Shopee, blank new credential fields; legacy blank names retained | Explicit boundary configuration | No credential/default activation introduced |
| `src/lib/runtime/config.ts` | `getSandealRuntime` | No V6 selector | Missing/blank selects legacy; explicit cloudflare recognized; unknown values throw a sanitized typed error | Runtime seam | Selector is additive; it does not replace existing launchers |
| `src/lib/platform/factory.ts` | `getJobQueueAdapter`, `getSchedulerAdapter`, `getAnalyticsAdapter` | No V6 factories | Legacy objects by default; cloudflare throws RUNTIME_ADAPTER_UNAVAILABLE | Fail closed until another implementation exists | No silent runtime fallback |
| `src/lib/platform/legacyAdapters.ts` | `enqueueJob`, `enqueueJobs` | Direct durable-store functions | Same function references behind an adapter | Adapter boundary | Idempotency/storage/commit behavior unchanged; identity checks passed |
| Same | `legacySchedulerAdapter.tick` | Separate exported automation/intelligence tick functions | Explicit caller gets both through Promise.all | Scheduler seam | It does not reproduce the full owned scheduler cycle's Guardian, reconciliation and ownership orchestration. No production caller uses it; future replacement must preserve that orchestration |
| Same | `recordEvent`, `aggregate`, `readDaily`, `getSummary` | Existing growth collections/functions | Delegation to the same functions/collection | Analytics seam | Revenue remains unavailable; no new revenue fabrication |
| `src/lib/affiliate/accessTradeProviders.ts` | `discoverProducts` | Legacy callers explicitly normalize discovered items | Phase 1 wrapper mapped items directly and exposed raw metadata; corrected here to call adapter.normalize | Preserve established normalized boundary | Proven Phase 1 defect, now covered for AccessTrade/TikTok |
| Same | `healthCheck`, mapping helpers | Legacy SourceHealth/product fields | Explicit typed health/product envelope, bounded request limit, sanitized error code | Provider-neutral interface | No live readiness probe is added; legacy configured is not made READY |
| Same | TikTok `createTrackingLink` | Existing AccessTrade TikTok link API | Delegate with matching tracking fields and signal; return provider envelope | Link seam | Client credentials, request bounds, URL safety and existing source adapter remain unchanged |
| Same | AccessTrade link/product/offer/promotion/transaction/commission methods without an implementation | No equivalent unified operations | Typed NOT_SUPPORTED; no fabricated records | Explicit capability boundary | Consumers must handle unsupported operations; this is not full transaction/revenue support |
| `src/lib/affiliate/registry.ts`, `service.ts` | selection/discovery delegation | No unified registry/use case | Explicit aliases/registration, unknown fails closed, selected provider is used directly | Provider seam | Shopee cannot use AccessTrade while retaining Shopee identity |
| `src/lib/affiliate/shopeeAffiliateProvider.ts` | all seven API-dependent operations and health | No live Shopee provider | Typed unavailable results in all configurations, always ready=false | Safe unavailable provider | No HTTP client, scrape, generated offer or live response exists |
| `src/lib/automation/providerRegistry.ts` | AiProvider interfaces/types | Metadata declarations only | Add executable interface types | AI contract seam | Comment-free TypeScript runtime emit matches HEAD exactly; no AI routing/cost policy change |
| Affiliate/platform types and barrel exports | Types/exports | No V6 names | Versioned contracts and exports | Architecture | No import-time scheduling/provider operation was found |

Repository searches found no existing application, worker or scheduler caller importing the new V6 factories/service. The legacy product pipeline, source adapter platform, AccessTrade clients, scheduler core, publication gates, public filtering, product storage and growth implementation are unchanged from HEAD. Legacy remains the functional runtime, subject to the pre-existing failures recorded below.

### Pre-existing production changes relative to HEAD

These differences were already in the Phase 1 starting worktree. Reasons below describe the code/recorded invariants; unknown original author intent remains UNKNOWN_PREEXISTING. They were not rewritten during verification.

| FILE | FUNCTION | BEFORE | AFTER | REASON / evidence | RISK |
| --- | --- | --- | --- | --- | --- |
| `featureRollout.ts` | DEFAULT_MODES / pool helpers | Pool default ACTIVE | OFF with explicit activation | Existing OFF configuration and guarded-rollout tests support opt-in; later handoff conflicts | Runtime throughput/rollout expectations differ between documents |
| Same | DEFAULT_MODES for local AI, operator alerts, categorization, multi-offer, programmatic SEO | OFF, OFF, SHADOW, SHADOW, SHADOW | All ACTIVE when absent | Recorded pre-existing change; no supporting authorization found in scoped evidence | Contradicts existing master upgrade rollout table; affects optional inference, notification, category, link selection, SEO behavior |
| Same | `isFeatureActive` and pool/critical summaries | Some helpers read mode | Read effectiveMode; invalid helper configuration returns OFF | Explicit fail-closed comment and invalid-mode tests | Two consumers still read mode directly, creating B3 |
| `postPublishMonitor.ts` | `probe`, `resolveCommerceUrlCandidate`, `alternateOffers` | Probe current merchant/affiliate only in commerce path | Rank alternate offers, dedupe/cap 8 URLs, choose only HEALTHY alternate, record every probe | Existing HEAD fallback test plus added negative/bounded cases | Additional bounded requests and URL/primary-offer changes are material, but predate Phase 1; self-healing suite passed |
| `runtimeRoles.ts` | `acquireRuntimeRole` | Time captured before waits; same instance reused token even after expiry | Time inside transaction; only live renewal reuses token | Prevent born-expired leases and stale epoch reuse | Coordination semantics changed; fence regression passes |
| Same | `heartbeatRuntimeRole`, `releaseRuntimeRole`, `isRuntimeRoleOwner` | Default time captured before storage wait/read | Time evaluated after obtaining storage state | Prevent expiry resurrection/stale ownership results | Explicit caller-provided clocks remain deterministic; scheduler caller still renews during ownership cycle |
| Same | `acquireRuntimeFence`, renewal/assertion/release | Less bounded cleanup / pre-wait time | Post-lock lease time, confirmed-expiry checks, bounded release wait, finite abandonment if renewal hangs | Fail-closed durable fence semantics | Temporary retained fence can delay takeover; original authority must not be released by a stale process |
| `scripts/automation-worker.cjs` | heartbeat, watchdog, role loss, startup/loop/finally | Previous bounded heartbeat/role loop | Confirmed lease-expiry watchdog, late-completion checks, guarded release and detailed drain state | Fail closed if storage heartbeat never settles | Timers/shutdown changed; 4-slot clamp, job bounds, role identity and paid-AI policy preserved |
| `scripts/automation-scheduler.cjs` | heartbeat, watchdog, shutdown/loop/finally | Previous scheduler timers/cleanup | Similar expiry watchdog and guarded bounded drain/release | Fail-closed lease-loss behavior | Healthy-incumbent waiting and single-heartbeat expectations fail (B1/B2); 30-second scheduling interval unchanged |
| `storage/types.ts`, `storage/adapter.ts` | transaction policy, `runExclusive` | Existing storage transactions | Optional adapter-owned exclusive scope and PRIMARY_ONLY policy; unsupported scope throws | History coordination without claiming multi-collection atomicity | New capability is FileStorage-specific; unsupported drivers fail explicitly |
| `storage/fileStorageAdapter.ts` | `readCollectionUnlocked`, transactions, streaming transactions, `runExclusive` | Backup recovery default | Default recovery retained; opted-in PRIMARY_ONLY omits backup resurrection; renewable exclusive lock handle | Coordinated primary-state history writes | Malformed primary fails closed; selected callers intentionally stop backup fallback |
| `jobHistoryArchive.ts` | record/index/manifest validators and exact lookups | Earlier history validations/index resolution | Stronger typed/shard/fingerprint checks, exact indexed version resolution, coherent reads | Existing documented immutable-history/idempotency invariants | Corruption can now reject previously accepted reads; fail-closed by design |
| Same | batch archive, manifest/index publication and recovery | Separate append/index/manifest updates | Coordinator, durable publication intents, guarded child commits, verified recovery; bounded batches retained | Crash consistency and V5 history contract | Material cross-collection writes; active/archive suite passed; exhaustive V5 fault matrix not rerun |
| `jobHistoryMaintenance.ts` plus repair/verify CLIs | plan, verify, fingerprint-guarded apply | Absent at HEAD | Explicit FileStorage-only audit/repair API; dry-run default, guarded apply | Pre-existing V5 durability work and operations document | No repair/verification command targeting real data was executed here |
| `package.json`, history operations documentation | CLI wiring/docs | No V5 history script aliases | Four explicit V5 commands and extended runbook | Support pre-existing history tools | Does not alter default npm test list or automatically run repair |
| `ecosystem.config.cjs` | None observable | HEAD text | Same textual content | Working-copy dirt only | Byte-preserved |

## 5. Shopee safety

V6 provider checks:

- All seven API-dependent methods return typed PROVIDER_UNAVAILABLE.
- Nine configurations were independently exercised: absent/disabled, enabled without credentials, invalid flag, partial credentials, configured disabled/enabled, legacy-name-only and invalid credential characters.
- 63 operation checks passed. Health was never ready. Missing credentials produced DISABLED_NO_CREDENTIALS or PENDING_EXTERNAL_ACCESS; malformed/partial configuration produced INVALID_CONFIGURATION.
- Explicit Shopee selection never invoked a sentinel AccessTrade provider. Captured network calls: 0. Other-provider calls: 0.
- Credentials in examples are blank; test-only synthetic values do not enable calls or produce READY. No hardcoded live credential, authenticated-page scraping path, Shopee HTTP implementation, fake transaction or provider response was added.
- Even configured Shopee remains CONFIGURED_NOT_VERIFIED and all methods unavailable. Future live implementation will need its own credential validation and access verification; this audit does not certify external access.

Repository-wide exception: `src/lib/storage/products.ts:1448` exports `seedSampleProducts`, which includes a synthetic Shopee product with an example URL, fabricated prices and approved status. This function is identical to HEAD and has no caller found in the repository. Local `.data` is empty. Nevertheless, the literal condition “no fake Shopee data exists” is false. It was not removed because it is not a proven Phase 1 defect and pre-existing code must be preserved.

## 6. Secret audit

SECRET_EXPOSURE_FOUND=NO

Inspected `.env.example`, `.gitignore`, new configuration/provider files and tests, tracked diff, and the existing repository secret gate. Only `.env.example` is tracked among environment files. Real environment files, token storage, private-key files, generated test data and release artifacts retain their existing ignore rules.

The first existing secret-gate run returned exit 1 for the two new public defaults and a synthetic test marker. The correction admits only those exact safe public defaults and uses the scanner's existing test-marker convention. The final gate passed. No broad fixture, credential, authorization, or cookie exclusion was added. No secret values are reproduced in this report.

## 7. Commands and independently observed results

Each row was run as `node scripts/<file>`, except the bounded product-first suite used `node --expose-gc scripts/product-first-bounded-accesstrade-tests.cjs`. These are the actual script bodies behind the previously reported npm aliases. A serial child-process runner recorded each exit status separately and continued to collect independent failures. TypeScript and ESLint ran through their npm commands.

Test scripts use their established isolated test directories/fixtures. No real provider request, production worker/scheduler, repair apply, migration or deployment was started.

| Script | Baseline passed | Baseline failed | Final/coverage note |
| --- | ---: | ---: | --- |
| `v6-phase1-foundation-tests.cjs` | 12 | 0 | 13/0 after boundary regression added |
| `accesstrade-link-safety-tests.cjs` | 34 | 0 | Unchanged legacy client |
| `accesstrade-tiktok-integration-tests.cjs` | 43 | 0 | Unchanged legacy client |
| `product-first-bounded-accesstrade-tests.cjs` | 21 | 0 | Run with --expose-gc |
| `product-first-pipeline-worker-tests.cjs` | 16 | 0 | 16/0 again after restoring regex |
| `storage-adapter-phase1a-tests.cjs` | 19 | 0 | Isolated storage |
| `storage-acceptance-tests.cjs` | 28 | 0 | Repository acceptance fixtures, not live Mongo |
| `source-reliability-tests.cjs` | 32 | 0 | Includes source identity/diversity/circuits |
| `prompt10-zero-touch-tests.cjs` | 5 | 0 | Product publication safety |
| `prompt10-foundation-tests.cjs` | 28 | 0 | Legacy automation |
| `prompt10-runtime-tests.cjs` | 18 | 0 | Runtime coordination |
| `prompt10-business-source-tests.cjs` | 13 | 0 | 13/0 again with fixed 50-item expectations |
| `prompt09-seo-analytics-tests.cjs` | 7 | 0 | Analytics/SEO |
| `prompt10-revenue-integrity-tests.cjs` | 5 | 0 | No invented revenue |
| `prompt13-production-readiness-tests.cjs` | 5 | 0 | Local readiness fixtures |
| `prompt10-self-healing-tests.cjs` | 10 | 0 | Pre-existing changed test |
| `runtime-fence-commit-window-tests.cjs` | 12 | 0 | Pre-existing changed test |
| `source-discovery-identity-tests.cjs` | 2 | 0 | Unchanged independent identity contract |
| `scheduler-incumbent-regression-tests.cjs` | 0 | 1 | BLOCKER B1 |
| `scheduler-role-heartbeat-regression-tests.cjs` | 1 | 2 | BLOCKER B2 |
| `master-m2-worker-pool-tests.cjs` | 18 | 0 | Feature rollout, pool bounds and fencing |
| `active-job-history-archive-tests.cjs` | 9 | 0 | Archive durability / safety |

Original reported selection: first 15 script rows, **286 passed / 0 failed**. Its 15 reported commands also included TypeScript/ESLint because two npm aliases run two scripts each.

Expanded baseline: **338 passed / 3 failed**, 20 successful script commands and 2 failed script commands.

After corrections: affected foundation/product-first/business-source suites all passed; one new foundation case makes the final unique selection **339 passed / 3 failed**. Unchanged failures were investigated, not edited or silently relabelled.

| Additional command/check | Result |
| --- | --- |
| `npm.cmd run typecheck` | PASS before and after changes; tsc --noEmit |
| `npm.cmd run lint` | PASS before and after; 0 errors, 14 warnings, all in unchanged/pre-existing files |
| `npm.cmd run release:secret-scan` | Entry FAIL on public defaults/synthetic marker; final PASS |
| `git diff --check` | PASS |
| In-memory per-keyword-limit=1 mutation | Entry 13/13 PASS despite defect; repaired test 12 passed / 1 failed as required |
| Concurrency-expression mutation probes | Final rejects alternate field/arithmetic; accepts exact formatted argument |
| New normalization regression before fix | 12 passed / 1 failed; proves adapter omission |
| New normalization regression after fix | 13 passed / 0 failed, both actual source adapters checked |
| Shopee/registry/runtime/delegate matrix | PASS: 9 configurations, 63 unavailable operation checks, 0 network calls, 0 fallback calls, 5 delegate identity checks, all 15 feature helper invalid modes OFF |
| Secret-gate negative controls | PASS: unsafe example activation/runtime selection and populated credential field still rejected |
| Invalid-rollout real-consumer diagnostic | FAIL: local AI and operator-alert consumer behavior disagree with effective OFF; no external network/messages |

The one-line V6 normalization fix does not change the legacy integration modules. The existing AccessTrade/TikTok suites passed on those unchanged modules; the added actual-source-adapter regression exercised the repaired wrapper. No unrelated broad suite was repeatedly rerun after it had passed.

Not performed: full `npm test`, Next production build, real Mongo acceptance, full V5 history durability fault matrix, live external providers, deployed runtime/PM2 observation. The selected checks do not imply those outcomes.

## 8. Blocking findings and risks

### B1. Healthy scheduler incumbent causes challenger exit

FILE=`scripts/automation-scheduler.cjs:414`; regression `scripts/scheduler-incumbent-regression-tests.cjs:244`.

Expected: a long-running challenger stays alive, does not tick/steal the healthy incumbent's authority, and can shut down gracefully.

Observed: exit code 1 after SCHEDULER_ROLE_ALREADY_ACTIVE. The entrypoint logs rejection and returns instead of waiting. No timeout threshold was increased and the test was not changed.

Attribution: the entrypoint and untracked test were already dirty/present before Phase 1; Phase 1 does not import its new adapters into this path. Original intent behind that pre-existing mismatch is UNKNOWN_PREEXISTING. Existing ownership rejection remains protective, but the stated scheduling regression fails.

### B2. Scheduler heartbeat has two owners

FILES=`src/lib/automation/scheduler.ts:203` and `scripts/automation-scheduler.cjs:220`.

The entrypoint heartbeat and `runOwnedSchedulerCycle` both call `heartbeatRuntimeRole`. The entrypoint's local in-flight guard does not cover the owned cycle.

Observed in the unchanged pre-existing regression:

- Peak heartbeat calls = 2 instead of 1; overlap observed = true.
- The owned cycle extended heartbeat/expiry/update fields and incremented roleHeartbeatRenewalCount to 1; the test requires a read-only authority check and zero renewals.

One persisted fail-closed authority case passed; these two cases failed. Scheduler core is unchanged from HEAD; the entrypoint and tests predate Phase 1. No attribution to the V6 wrappers is justified.

### B3. Invalid rollout is effectively OFF but two consumers activate

FILES=`src/lib/automation/featureRollout.ts:133`, `src/lib/ai/localAiAdapter.ts:193`, `src/lib/automation/operatorAlerting.ts:228`.

Pre-existing default changes make AI_LOCAL_FALLBACK and OPERATOR_ALERTING ACTIVE. Invalid flag input returns `mode=ACTIVE`, `valid=false`, `effectiveMode=OFF`. The helper `isFeatureActive` honors effectiveMode, but these two consumers read mode without checking valid.

Focused proof: invalid local-AI configuration reached an injected request implementation once and reported consumer mode ACTIVE; invalid operator-alert configuration proceeded to NO_ADAPTERS instead of FEATURE_DISABLED. No real request, adapter delivery or message was performed.

Categorization, compliance-offer and SEO consumers also read mode but separately require `rollout.valid` before applying/emitting; the same invalid-value bypass was not found in those three paths.

This is a material pre-existing fail-closed gap, not merely a documentation disagreement. It is outside the permission to fix only proven Phase 1 defects.

### B4. Rollout default contract remains inconsistent

Five pre-existing ACTIVE defaults conflict with the existing master upgrade table's OFF/SHADOW rollout rules (`docs/implementation/SANDEAL_MASTER_UPGRADE_STATUS.md:267`). The pool's OFF default has independent supporting tests/configuration but conflicts with the later ACTIVE-default handoff statement. No undocumented operator authorization is assumed.

Resolve this combined-worktree contract before asserting a general safety lock. Passing the selected legacy suites is not proof that these configuration changes were intended.

### B5. Synthetic Shopee seed remains in repository

The pre-existing sample described in section 5 prevents SHOPEE_FAKE_DATA=NO. It is not a live V6 provider result, and no active local data was found. This distinction does not change the literal verification condition.

Other limits: new V6 factories are opt-in seams with no production consumer; the scheduler seam is not a full replacement for owned runtime orchestration; transaction/commission sync remains unsupported; live credentials, deployment and production data remain unverified. None of these justify beginning Phase 2 while the blocking checks fail.

## 9. Preservation evidence and stopping point

At verification entry, SHA-256 digests were captured for all 572 tracked/untracked source files. Final verification found only the five correction files listed above changed, plus this new report. All 22 pre-existing dirty paths matched their entry bytes. Branch/HEAD and empty index were unchanged; local `.data` remained empty.

For these pre-existing paths, entry and final SHA-256 are identical:

| File | SHA-256 |
| --- | --- |
| `docs/operations/AUTOMATION_JOB_HISTORY_ARCHIVE.md` | `7eb87099584975af2673cb2062cf2c8502a7ac49f0596d279ba7cda350519fbe` |
| `ecosystem.config.cjs` | `e68788a139ad03de4c5cfa54e1caf89fb4f36f963f281f6a4d5ff9e0c52f61f5` |
| `package.json` | `fe0d3800c5609c171b8f295924b6685a38e395271892a68cf85c39767cd828d6` |
| `scripts/automation-scheduler.cjs` | `16406db2946b45f6cdb0cd310e6d5264b7b550169a16b7b6b907fc8812535b64` |
| `scripts/automation-worker.cjs` | `0e21692604468450e2f6d29ef416e08c494a06498a884b8a40f469f1190f0e09` |
| `scripts/prompt10-self-healing-tests.cjs` | `5daf4b34b8589c78e748aa3c16c631a49e04a282c854bcc7f8253a7a850d100a` |
| `scripts/runtime-fence-commit-window-tests.cjs` | `b3e76d534f5a62b8ceabcae8085f940f6e5fb26ea078735627ba8c2546cc07de` |
| `src/lib/automation/featureRollout.ts` | `766a067bc5290605de06121eefa1a6b3cbc4e9dabb43d481089e8d013e006ed9` |
| `src/lib/automation/jobHistoryArchive.ts` | `450cb44cd4c31d41d545c6966776493fbc4e6b1185b043ffb19e1adefa25faf0` |
| `src/lib/automation/postPublishMonitor.ts` | `104a54279af656aeab4d8350653bdfd88bd87d69b49e0893f2495280cbbc6da3` |
| `src/lib/automation/runtimeRoles.ts` | `aece690b610044c73bf7ce72acfc2c20c83fe76774b57aec14f3386e1678e5ec` |
| `src/lib/storage/adapter.ts` | `6fbb94949ac1c3200a654c7f7658693bacad7ac2b07aace258d3a22a6773e8c4` |
| `src/lib/storage/fileStorageAdapter.ts` | `35f29a75a1753dce23f8c0c23797f5aca2299d1be6d07b0bf35a2543e4607786` |
| `src/lib/storage/types.ts` | `00cbe1aef0ae28d3de3c6624ed4541049b8d80ef6b79a476533c7b6c5d2651d7` |
| `scripts/fixtures/v5-history-production-skew.json` | `2c6ba1434b47ca1ad25d8f40be2bc3ed2f0e75fbca1c2cd9cce6672b27afa584` |
| `scripts/repair-automation-job-history.cjs` | `eab8af3e6940170777ce9a98b479bb79c6ba2378cfc7fb4a01620f02449a54b7` |
| `scripts/scheduler-incumbent-regression-tests.cjs` | `feb7ec528d2d94d47e1b73b291fb826885603c41dd30be9e82c912dabb5907be` |
| `scripts/scheduler-role-heartbeat-regression-tests.cjs` | `c0acef796c0a3834b582ae5491e825705fd2a708609d772616f8ee13051bb19a` |
| `scripts/v5-history-cross-process-worker.cjs` | `045d86b5841f6f1b64f860a6a075a7fc268448ca876e80d9472bace1e22e49ca` |
| `scripts/v5-history-durability-tests.cjs` | `932b2304df5d6a44279f86c3d882386b3f160b00ad7e972faf833f3589742ba3` |
| `scripts/verify-v5-invariants.cjs` | `debe3bcdd96768c40908f3c27807bcc5a531fc58dbea1dff03fdb9bfdf1a4904` |
| `src/lib/automation/jobHistoryMaintenance.ts` | `3150662fb2b55bb17fc83ac322bde7e3858f4c9cd7dfe8f6a8de16bab80c18d7` |

This report is the sole additional source file from verification. Ignored test artifacts/TypeScript caches may be generated by the repository's existing checks. Pre-existing changes were not reverted, staged, committed or pushed.

PHASE1_VERIFICATION=FAIL

TEST_INTEGRITY=WEAKENING_FOUND_AND_CORRECTED; CASES_PRESERVED

PRODUCTION_BEHAVIOR=NEW_BOUNDARY_DEFECT_CORRECTED; PREEXISTING_RUNTIME_BLOCKERS_REMAIN

SHOPEE_SAFETY=V6_PROVIDER_FAIL_CLOSED; REPOSITORY_FAKE_DATA_CONDITION_FAILED

SECRET_SAFETY=PASS

REGRESSION_RESULT=339_PASSED_3_FAILED; ADDITIONAL_INVALID_ROLLOUT_DIAGNOSTIC_FAILED

SAFE_TO_BEGIN_PHASE_2=NO

BLOCKERS=B1,B2,B3,B4,B5

RESULT=FAIL
