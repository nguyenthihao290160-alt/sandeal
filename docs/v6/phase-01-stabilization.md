# V6 Phase 1.6 stabilization

Date: 2026-09-07. Local work only; no commit, push, deployment, provider probe, real-data migration, or production resource operation.

```text
BRANCH=master
HEAD=3f2ee7d8bd1ef57fa9207f021cc03519b7eecde7
WORKTREE_DIRTY=YES
ORIGINAL_BLOCKERS=scheduler incumbent exit; competing heartbeat renewal; invalid rollout consumers; conflicting defaults; synthetic Shopee seed
SCHEDULER_FAILURES_BEFORE=3
SCHEDULER_FAILURES_AFTER=0
ROLLOUT_AUTHORITY=src/lib/automation/featureRollout.ts:getFeatureRolloutState
INVALID_CONFIG_BEHAVIOR=OFF; mode equals effectiveMode; configuredValue redacted as INVALID
CONFLICTING_DEFAULTS_RESOLUTION=existing rollout ledger and .env.example; optional activation requires explicit ACTIVE
SHOPEE_SYNTHETIC_FIXTURE_LOCATION=scripts/fixtures/development-products.cjs
SHOPEE_PRODUCTION_FAKE_DATA=NO
AFFILIATE_NORMALIZATION=existing source adapter normalize retained before V6 domain mapping
TEST_CASES_SKIPPED=0
UNJUSTIFIED_TEST_CASES_REMOVED=0
ASSERTIONS_WEAKENED=NO
SAFETY_GATES_RELAXED=NO
SECRET_EXPOSURE_FOUND=NO
SAFE_TO_ENTER_PHASE_1_7=YES
RESULT=PASS
```

## Baseline and reproduction

Before any edits, ran `git branch --show-current`, `git rev-parse HEAD`, `git status --short`, and `git diff --stat`. Branch/HEAD are above. Status contained 19 modified tracked paths and untracked V6/runtime/history files. Diff stat: 18 textual paths, 4,175 insertions, 961 deletions. `ecosystem.config.cjs` has status dirt without textual diff. Read the three previous checkpoint reports, then inspected actual code and test diffs. Before production edits captured SHA-256 fingerprints for 573 tracked/untracked files.

The exact previously failing commands were run before production changes:

| TEST | EXPECTED | ACTUAL / FAILURE | FILE / RELEVANT_FUNCTION | Cause |
| --- | --- | --- | --- | --- |
| `node scripts/scheduler-incumbent-regression-tests.cjs` — healthy incumbent | Challenger alive; no tick or stolen lease; graceful shutdown | Exit 1, `SCHEDULER_ROLE_ALREADY_ACTIVE` | `scripts/automation-scheduler.cjs`, startup acquisition in `main` | PRODUCTION_DEFECT |
| `node scripts/scheduler-role-heartbeat-regression-tests.cjs` — overlap | Peak heartbeat 1; overlap false | Peak 2; overlap true | `src/lib/automation/scheduler.ts:runOwnedSchedulerCycle`, entrypoint `boundedRoleHeartbeat` | PRODUCTION_DEFECT |
| Same command — read-only authority | All four timestamps unchanged; renewal count 0 | All four changed; renewal count 1 | `runOwnedSchedulerCycle` | PRODUCTION_DEFECT |

Heartbeat suite baseline: 1 passed, 2 failed. Incumbent suite: 0 passed, 1 failed. No existing test in either suite was edited.

Added `node scripts/v6-stabilization-tests.cjs` BEFORE changing production rollout behavior. Initial 17-case version: 5 passed, 12 failed. Ten feature states returned their default mode instead of effective OFF for invalid input. Local AI observed ACTIVE and reached injected request handling; alerts returned NO_ADAPTERS instead of FEATURE_DISABLED. No external network or messages were used. Final tests also cover unknown feature rejection, exact selected defaults, and fixture isolation.

## Authority and consumers

`getFeatureRolloutState` is the only environment-to-feature-mode interpreter. Its `mode` is now a compatibility alias for `effectiveMode` in all branches. `configuredValue` and `defaultMode` provide diagnostics. This fixes old consumers together without introducing competing helpers. Unknown feature identifiers throw a value-free error. Invalid values return OFF and never echo the supplied value. Explicit valid ACTIVE/OFF remains ACTIVE/OFF; observation modes remain non-active. Absent/blank config uses only the existing documented safe OFF/SHADOW defaults.

| Consumer | Authority path and interpretation |
| --- | --- |
| Worker entrypoint and scheduling | `isContinuousWorkerPoolEnabled`, `isCriticalWorkerSchedulingEnabled`; both derive valid/effective mode from the authority |
| Operational health/dashboard | `listFeatureRolloutStates`, worker summaries; configured/effective/source/cohort/implementation fields all derive from the same state |
| Scheduler | Durable role ownership plus automation settings/control; it does not invent a feature-mode parser. `control.effectiveMode` is the separate OBSERVE/ASSISTED/AUTONOMOUS execution policy, not an ACTIVE feature flag |
| Local AI | `LocalAiAdapter.featureMode` consumes the authoritative compatibility alias; readiness and generation reject OFF |
| Operator alerts | `dispatchOperatorAlert` reads that alias before selecting adapters or writing delivery state |
| AI fallback routing | `providerFallback.enabled` reads the same alias through registry feature declarations |
| Runtime Guardian / self-healing | `sloErrorBudget` resolves recovery feature once, supplies it to `advanceRuntimeReasonRecoveryState`; its two production call sites share that resolved state |
| Recovery canary / publisher | `runtimeRecoveryCanary` checks RECOVERY_CANARY through the authority; `autoPublish` retains runtime/policy/permit gates |
| Post-publication monitoring | PUBLICATION_EVIDENCE_V2 comes from the same state; invalid no longer observes SHADOW |
| SLO/job cohorts | `store` and `sloErrorBudget` derive SLO_RUNNABLE_AT_V2 mode/cohort from the same authority; persisted historical cohorts remain historical observations |
| Source discovery | AccessTrade readiness probe uses the authority; source settings, identity, circuits, and credential readiness remain additional restrictions |
| Categorization, offer selection, SEO | All resolve the authority, retain valid + ACTIVE checks, and report its mode |
| Mongo bulk | Storage facade uses authoritative MONGO_BULK_WRITE state; invalid never opts into optimization |

No independent environment parser for these feature names was found outside `featureRollout.ts`. Pure recovery transition input is a caller-supplied domain argument, not another configuration source; its production callers were traced. Runtime platform selection remains `getSandealRuntime` with legacy default and unknown rejection, covered by foundation tests. No runtime platform or automation policy value is translated into feature ACTIVE.

## Conflicting defaults inventory

For every row, SOURCE_A is `featureRollout.ts:DEFAULT_MODES` at entry. SOURCE_B is `.env.example` plus `docs/implementation/SANDEAL_MASTER_UPGRADE_STATUS.md` feature rollout ledger (lines 261 onward). CURRENT_RUNTIME_RESULT describes absent feature configuration at entry. SELECTED_AUTHORITY is the existing ledger/config contract enforced by `getFeatureRolloutState`.

| FEATURE | VALUE_A | VALUE_B | CURRENT_RUNTIME_RESULT | Selected default | WHY / EVIDENCE |
| --- | --- | --- | --- | --- | --- |
| AI_LOCAL_FALLBACK | ACTIVE | OFF | ACTIVE | OFF | Optional inference requires explicit activation; HEAD default and ledger agree |
| OPERATOR_ALERTING | ACTIVE | OFF | ACTIVE | OFF | Optional delivery requires explicit activation; HEAD default and ledger agree |
| SMART_CATEGORIZATION_V2 | ACTIVE | SHADOW | ACTIVE | SHADOW | Ledger preserves existing canonical categories until V2 activation; HEAD matches |
| MULTI_AFFILIATE_OFFER | ACTIVE | SHADOW | ACTIVE | SHADOW | Ledger retains legacy affiliate projection until opt-in; HEAD matches |
| PROGRAMMATIC_SEO_V2 | ACTIVE | SHADOW | ACTIVE | SHADOW | Ledger suppresses V2 emission until activation; HEAD matches |
| WORKER_CONTINUOUS_POOL_V2 | OFF | OFF; later `docs/AI_WORK_HANDOFF.md:681` says ACTIVE | OFF | OFF | Independent M1/M2 tests, example, and rollout ledger require opt-in. Later handoff is historical, not a runtime authority |

HISTORICAL_INTENT=UNRESOLVED for the conflicting ACTIVE edits/handoff. Effective automatic activation resolves OFF in all six conflicts (three use proven SHADOW observation defaults). No other feature default was changed. Explicit server environment configuration remains the single runtime override; documentation is not read as another active configuration source.

## Scheduler correction

The long-running entrypoint retries durable acquisition every 30 seconds while a healthy incumbent owns the role. The existing wakeable wait handles shutdown. `--once` still reports contention as exit 1. No tick or heartbeat starts before acquisition. All original incumbent ownership assertions pass unchanged.

The owned cycle now uses read-only persisted ownership at its start and between enqueue stages; the entrypoint alone renews the role. Checks use current post-read clock rather than the cycle's old scheduling timestamp. Existing expiry watchdog, drain bounds, fencing, workloads, and heartbeat intervals are preserved. Both heartbeat tests now pass unchanged with renewal count 0 in the cycle.

## Synthetic seed and affiliate boundary

Moved the three historical sample records, including the Shopee example, to the pure `scripts/fixtures/development-products.cjs` factory. It imports no application code, returns marked `isSample/publicHidden/needsVerification` data, and never writes storage. `seedSampleProducts` retains an explicit rejecting compatibility entrypoint in every environment. It cannot be invoked to persist synthetic records. No production module imports the fixture.

Public DTOs, SEO, and `/go/[productId]` use `isPublicSafeProduct`, which rejects the fixture flags even if status is changed to published. Fixtures cannot enter runtime discovery/provider health through a seed; no Shopee HEALTHY result exists. Transaction/commission synchronization remains unsupported. Existing AccessTrade/TikTok wrappers retain source adapter normalization; real-adapter fixture regressions exercise raw metadata removal. Shopee methods remain unavailable, ready=false, no network and no provider substitution. `.data` was not seeded or migrated.

## Test integrity and secret review

Reviewed all four previously modified tests against HEAD and the new Phase 1/1.5 tests. No skip/focus declarations, removed cases, assertion suppression, reduced concurrency, relaxed ceilings, or removed negative cases were found. The Phase 1.5 restoration of exact 50-item source workload and exact concurrency argument remains intact. Existing self-healing additions strengthen alternate-probe negatives/bounds. The two runtime-fence cleanup catches only release held locks; assertions propagate to the failure-counting harness. None of these original Phase 1/1.5 tests or scheduler regressions was edited in this run. The earlier modifications and evidence remain detailed in `phase-01-verification.md`.

One additional old test fixture required correction after the broader regression matrix: `scripts/master-m5-platform-seo-tests.cjs`. TEST_FILE=that file; OLD_EXPECTATION=fresh verified product is indexable and explicit ACTIVE emits V2; NEW_EXPECTATION=unchanged; SUPPORTING_CONTRACT=`productSeo.getProductIndexingDecision` derives current price truth and rejects stale verification; REASON=the positive fixture was hardcoded to July 26 while the test uses the September runtime clock. Initial result 11 passed / 2 failed, both with stale verification. Classification=STALE_TEST. Changed only the positive draft timestamp to the current clock; fixed-clock offer cases retain their explicit dates. Added a separate 60-day-stale product negative case asserting no indexing, no JSON-LD, and no V2 emission. Final 14 passed / 0 failed. No freshness threshold or prior assertion changed.

The new regression runner executes every listed suite independently, records nonzero exits, and retains full outputs under `.test-tmp/v6-validation-6HgnAr`; it does not replace the repository's test command. Reviewed `.env.example`, `.gitignore`, provider/configuration code and new files. Secret scan emits file/line/rule only on findings, never values. No credential configuration or scanner exclusion was changed here.

## Final validation

TEST_COMMANDS=33 regression scripts listed below; npm.cmd run typecheck; npm.cmd run lint; npm.cmd run release:secret-scan; targeted ESLint after fixture/import cleanup; git diff --check

PASSED_CASES=529 (latest result per suite, reruns not double counted)

FAILED_CASES=0 in final matrix; entry scheduler failures and intermediate M5 stale-fixture failures retained above

REMAINING_BLOCKERS=NONE for Phase 1.6

After Phase 1.7's storage runtime guard, all 33 suites were rerun: 529 passed / 0 failed, logs `.test-tmp/v6-validation-n6lnOw`. Four additional architecture cases pass. Phase 1.6 remains PASS; Phase 1.7 fails on the unresolved indexed storage/transaction/binding architecture described in `phase-01-architecture-gate.md`. Phase 2 was not started.

TypeScript passed. Full ESLint passed with 14 pre-existing warnings plus one new unused import subsequently removed; targeted ESLint passed for every new/changed file with no warning. Secret scan passed before and after documentation/test additions. `git diff --check` passed. No build or live Mongo/provider test is claimed at this stabilization gate.

| Regression command | Passed | Failed |
| --- | ---: | ---: |
| `node scripts/v6-phase1-foundation-tests.cjs` | 13 | 0 |
| `node scripts/v6-stabilization-tests.cjs` | 20 | 0 |
| `node scripts/scheduler-incumbent-regression-tests.cjs` | 1 | 0 |
| `node scripts/scheduler-role-heartbeat-regression-tests.cjs` | 3 | 0 |
| `node scripts/accesstrade-link-safety-tests.cjs` | 34 | 0 |
| `node scripts/accesstrade-tiktok-integration-tests.cjs` | 43 | 0 |
| `node --expose-gc scripts/product-first-bounded-accesstrade-tests.cjs` | 21 | 0 |
| `node scripts/product-first-pipeline-worker-tests.cjs` | 16 | 0 |
| `node scripts/storage-adapter-phase1a-tests.cjs` | 19 | 0 |
| `node scripts/storage-adapter-mongo-tests.cjs` | 39 | 0 |
| `node scripts/storage-acceptance-tests.cjs` | 28 | 0 |
| `node scripts/source-reliability-tests.cjs` | 32 | 0 |
| `node scripts/source-discovery-identity-tests.cjs` | 2 | 0 |
| `node scripts/prompt10-zero-touch-tests.cjs` | 5 | 0 |
| `node scripts/prompt10-foundation-tests.cjs` | 28 | 0 |
| `node scripts/prompt10-runtime-tests.cjs` | 18 | 0 |
| `node scripts/prompt10-business-source-tests.cjs` | 13 | 0 |
| `node scripts/prompt09-seo-analytics-tests.cjs` | 7 | 0 |
| `node scripts/prompt10-revenue-integrity-tests.cjs` | 5 | 0 |
| `node scripts/prompt13-production-readiness-tests.cjs` | 5 | 0 |
| `node scripts/prompt10-self-healing-tests.cjs` | 10 | 0 |
| `node scripts/runtime-fence-commit-window-tests.cjs` | 12 | 0 |
| `node scripts/master-m2-worker-pool-tests.cjs` | 18 | 0 |
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
