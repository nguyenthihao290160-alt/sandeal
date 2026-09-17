# Phase 9: Safe Execution Control Plane

## Status And Resume Boundary

Phase 9 targeted rollback remediation passes for the **local shadow/dry-run
foundation only**. The original pre-commit audit and later rollback re-audit
identified defects; this checkpoint records remediation validation, not an
independent final re-audit pass or authorization for Phase 9.5 or Phase 10.

- Repository: `master`, HEAD `29b113ad386a51a085123361417d85ca4328e96e`.
- Reconstruction was read-only. Existing modified and untracked work was retained.
- All 681 non-document source/configuration/test file hashes exactly match the
  interrupted targeted-remediation run, before and after the refreshed final gates.
- Source SHA-256: `cff68903a05f6eae3f43217f5aefc6365532e029c6dda2ddb50de0faed1b193e`.
- The saved reports confirm 26 targeted checks, then 124 full Phase 9 checks with
  41/41 required cases on September 16, 2026, 10:10:59 UTC. Final gates also completed
  at 10:12:53 UTC. Their checkpoint was not finalized before interruption.
- The first unverified step was final rollback evidence/checkpoint consistency.
  Existing suites were not restarted. The 124 Phase 9 checks and 727 unaffected
  regressions were reused after comparing source hashes and raw logs.
- The five changes since general remediation are confined to the Phase 9 test,
  rollback/types/bundle modules and isolated D1 execution store. Shared runtime,
  D1 adapter, migrations, prior-phase code and regression tests are unchanged.
- One supplemental ephemeral-D1 probe verifies cross-proposal rollback replay;
  the requested final quality/build gates were refreshed. No existing source,
  tests, migration, dependency or build configuration was edited during this resume.
- Earlier general-remediation evidence is retained as history, not current-source
  proof. Its 104-focused/831-total counts are superseded by the results here.

Durable summary: `docs/v6/evidence/phase9-targeted-rollback-remediation.json`.
Full Phase 9 report: `.test-tmp/phase9/focused-1smivd/results.json`.
Unchanged regressions: `.test-tmp/phase9/all-dQL90j/results.json`.
Refreshed final gates: `.test-tmp/phase9/final-resume/results.json`.
Required-case/targeted evidence: `.test-tmp/phase9/focused-results.json` and
`.test-tmp/phase9/rollback-results.json`.
Supplemental replay proof: `.test-tmp/phase9/rollback-cross-proposal-resume-results.json`.

## Verified Implementation And Limits

- `capabilityRegistry.ts`: immutable null-prototype registry, own-property lookup,
  frozen nested permissions, exact action binding, risk compatibility, and default
  denial. Publication, deployment, DNS, production-schema and real-money actions
  have no enabled execution mode.
- `preflightValidator.ts`: current deterministic Decision OS policy, target identity,
  proposal/evidence fingerprints, expiration, binding availability, approvals,
  change windows and recoverable prior-state evidence are required as applicable.
  Missing or malformed authority fails closed. Decision OS defaults to `SHADOW`;
  proposals require an explicit permitted mode and never default to live execution.
- `approval.ts`: approval binds the full material proposal fingerprint, evidence,
  environment, capability, risk and authorized approver. Revoked, expired, stale,
  cross-proposal and cross-environment approvals confer no execution authority.
- `killSwitch.ts`: absent, malformed, stale or unknown controls block execution.
  Global and domain stops cannot be overridden by approval, reason text or AI.
  Authorized emergency stop is durable, audited and fences prior D1 claim revisions.
- `dryRunExecutor.ts`: produces only simulated `WOULD_EXECUTE_*` receipts/effects.
  Blocked and review-required cases have no would-effects. No external transport,
  production content mutation, money movement or live AI execution is implemented.
- `d1ExecutionStore.ts` and migration `0010_execution_control_plane.sql`: real local
  D1 tests establish semantic proposal deduplication, indexed bounded lookups,
  conditional claims, lease/generation/revision fencing, and atomic receipt,
  side-effect, rollback-plan and audit persistence. Actual SQL constraint failure
  rolls back the whole result batch. The store accepts only `LOCAL`/`TEST`.
- `executionQueue.ts`: strict identifier-only messages, durable job lookup, ack only
  after completion or a terminal no-op, bounded retry/outbox dispatch, redelivery,
  lost-acknowledgement and concurrency proofs. This is a locally exercised consumer,
  **not a newly enabled production Worker route or Queue handler**.
- `rollback.ts`: content refresh requires actual inline title, canonical and content
  values; experiment proposals require a complete validated `ExperimentSpec` for
  the target product. Capability, evidence ID, target, environment, version,
  fingerprint and capture/expiry bindings must match. Hash-only objects, unresolved
  references, self-asserted validity and incomplete/unrelated state fail closed.
  Valid inline values survive D1 persistence and are copied into the bound plan.
  Read-only and non-reversible capabilities never fabricate recovery evidence.
- Rollback coverage is **capability-scoped inline prior-state plan coverage**, not
  general recovery. Bundle `FULL` means every member has such a valid plan;
  incomplete bundles report `PARTIAL` or `NONE`, and failed preflight prevents
  persistence. There is no reference resolver, restore executor, external-effect
  recovery or production rollback proof. Production/non-reversible actions remain
  disabled and review-required; these limitations are not resolved by approval.
- D1 replay checks establish zero duplicate, stale or cross-proposal rollback
  effects. Claim/revision fencing, expected-result recomputation, unique plan
  receipts and atomic commits remain intact. The supplemental probe rejects three
  foreign/rebound plan or receipt submissions with no persisted records, then
  persists both legitimate proposal-specific plans with their original content.
- `releaseBundle.ts` and `changeWindow.ts`: bounded, environment-consistent,
  deterministic dependency ordering; cycles/missing dependencies fail; each member
  reuses preflight. D1 bundle persistence is idempotent. No deploy operation exists.
- `targetSafety.ts`: exact target identity, constrained relative paths or validated
  allowlisted HTTPS URLs, no credentials/private addresses/redirect parameters.
  AccessTrade may represent Shopee/TikTok; Direct Shopee is rejected. Untrusted
  natural-language instructions stay inert and cannot bypass deterministic policy.

## Required Safety Matrix

These are the exact required test names from
`scripts/phase-09-execution-control-plane-tests.cjs`; each has a passing recorded case.
The remaining 83 focused cases extend this matrix with adversarial and D1 proofs.

| # | Required case | Result |
| --- | --- | --- |
| 1 | safe dry run | PASS |
| 2 | unregistered action | PASS |
| 3 | policy block | PASS |
| 4 | kill switch ACTIVE | PASS |
| 5 | kill switch UNKNOWN | PASS |
| 6 | revoked approval | PASS |
| 7 | stale approval | PASS |
| 8 | expired approval | PASS |
| 9 | cross-proposal approval reuse | PASS |
| 10 | cross-environment authorization | PASS |
| 11 | stale proposal | PASS |
| 12 | proposal expiration | PASS |
| 13 | duplicate proposal | PASS |
| 14 | duplicate dry run | PASS |
| 15 | duplicate receipt | PASS |
| 16 | queue redelivery | PASS |
| 17 | lost acknowledgement | PASS |
| 18 | concurrent execution | PASS |
| 19 | superseded proposal | PASS |
| 20 | production publish blocked | PASS |
| 21 | deployment blocked | PASS |
| 22 | DNS change blocked | PASS |
| 23 | destructive migration blocked | PASS |
| 24 | unknown migration blocked | PASS |
| 25 | money ledger immutable | PASS |
| 26 | prompt injection | PASS |
| 27 | malicious deploy now | PASS |
| 28 | malicious disable safety | PASS |
| 29 | malicious change DNS | PASS |
| 30 | malicious publish 500 pages | PASS |
| 31 | malicious ignore policy | PASS |
| 32 | malicious turn kill switch off | PASS |
| 33 | AccessTrade/Shopee boundary | PASS |
| 34 | Direct Shopee disabled | PASS |
| 35 | unsafe URL | PASS |
| 36 | missing binding | PASS |
| 37 | D1 unavailable | PASS |
| 38 | Queue unavailable | PASS |
| 39 | rollback missing | PASS |
| 40 | rollback invalid | PASS |
| 41 | unknown environment | PASS |

## Reused Tests And Supplemental Proof

| Suite | Passed |
| --- | --- |
| Phase 9 focused, reused | 124 |
| D1 | 25 |
| Queue / Cron | 17 / 10 |
| Phase 8.5 lifecycle / Phase 8 content | 122 / 9 |
| Phase 7.5 opportunity / Phase 7 decision | 127 / 132 |
| Phase 6 deal / Phase 5 money | 79 / 57 |
| AutoPilot / runtime / routing / site | 4 / 14 / 11 / 4 |
| AccessTrade / TikTok | 34 / 43 |
| Publication / zero-VPS / revenue | 25 / 9 / 5 |
| Supplemental cross-proposal D1 rollback replay, new | 1 |
| **Total: 124 focused + 727 regressions + 1 supplemental** | **852** |

All 19 saved suites and the supplemental probe exited zero, with zero failed or
skipped cases. The earlier 26 targeted checks are also present in the 124 focused
checks and are not counted twice. Thus 27 distinct rollback-targeted checks pass
(26 reused, one new); 851 suite checks are reused and one new check is added.
Builds, checkpoint checks and repeated executions of the new probe are not added
to the unique test count.

## Current-Source Quality And Builds

Final gates were verified on September 16, 2026, 23:50:32 UTC (September 17 local
time), with an unchanged source fingerprint. TypeScript completed in
`final-B8HI1x`; after correcting only the new probe's import style, ESLint and the
remaining gates completed in `final-resume`. No lint rule or assertion was weakened.

| Gate | Result |
| --- | --- |
| TypeScript (`tsc --noEmit --incremental false`) | PASS |
| ESLint (`eslint .`) | PASS: 0 errors, 68 warnings, identical to the prior run |
| Repository secret scan | PASS |
| `git diff --check` | PASS |
| Cloudflare Worker bundle | PASS: 379,507 bytes; no forbidden storage/runtime dependencies |
| Cloudflare static site export | PASS: 10 static pages generated |

The current Worker metafile still reaches the shared adapter through
`cloudflare/worker.ts` -> `runtime/cloudflare/http.ts` ->
`runtime/cloudflare/context.ts` -> `storage/d1/d1StorageAdapter.ts`.
Both Cloudflare builds were run; neither was classified as unaffected. The shipped
Worker does not import the Phase 9 executor. Builds used the existing exported
`buildWorker()`/`buildSite()` helpers locally, without login, deployment or migrations.

`src/lib/storage/d1/d1StorageAdapter.ts` is byte-identical to HEAD and to the tested
source (Git blob `86524c9b6ce16dc77e7b3ddd50c91ef4c64fd843`). It has no BOM, CRLF,
EOF, formatting-only or functional churn in the current patch.

`LONG_RUN_STATE.json` uses UTF-8 without BOM and repository-style JSON formatting.
The existing `scripts/v6-run-state.cjs` reader parses it directly. Phase 5, 6, 7,
7.5, 8 and 8.5 objects and all ten pre-Phase-9 checkpoints are preserved. All 49
pre-Phase-9 evidence entries plus the earlier general-remediation evidence entry
remain unchanged. One targeted evidence entry is appended; the single Phase 9
checkpoint is updated in place. No JSON key, checkpoint or evidence name is duplicated.

## Verified Outcome

```text
PHASE9_REMEDIATION=PASS
PHASE9_TARGETED_ROLLBACK_REMEDIATION=PASS
PHASE9=PASS
EXECUTION_CONTROL_PLANE=PASS_LOCAL_SHADOW_DRY_RUN_ONLY
TARGETED_ROLLBACK_TESTS=27_PASS_26_REUSED_1_NEW
PHASE9_TEST_MATRIX_REQUIRED_COUNT=41
PHASE9_TEST_MATRIX_COVERED_COUNT=41
PHASE9_TEST_COVERAGE_COMPLETE=YES
FOCUSED_PHASE9_TESTS=124
TOTAL_VERIFIED_TESTS=852
CAPABILITY_REGISTRY=PASS
DEFAULT_DENY=PASS
UNKNOWN_CAPABILITY_EFFECT=0
UNREGISTERED_ACTION_EFFECT=0
EXECUTION_MODE_AUDIT=PASS
DEFAULT_EXECUTION_MODE=SHADOW
LIVE_EXECUTION_ENABLED=NO
PRODUCTION_EXECUTION_ENABLED=NO
APPROVAL_MODEL=PASS
STALE_APPROVAL_EFFECT=0
EXPIRED_APPROVAL_EFFECT=0
REVOKED_APPROVAL_EFFECT=0
CROSS_PROPOSAL_APPROVAL_REUSE_EFFECT=0
CROSS_ENVIRONMENT_AUTHORIZATION_EFFECT=0
GLOBAL_KILL_SWITCH=PASS
KILL_SWITCH_UNKNOWN_FAIL_CLOSED=YES
KILL_SWITCH_OVERRIDE_EFFECT=0
PREFLIGHT_VALIDATOR=PASS
STALE_EXECUTION_PROPOSAL_EFFECT=0
DRY_RUN_EXECUTOR=PASS
DRY_RUN_PRODUCTION_SIDE_EFFECTS=0
DRY_RUN_EXTERNAL_WRITE_CALLS=0
DRY_RUN_REAL_MONEY_EFFECT=0
D1_EXECUTION_STORE=PASS
QUEUE_REDELIVERY=PASS
CONCURRENCY=PASS
ROLLBACK_FOUNDATION=PASS
ROLLBACK_COVERAGE_AUDIT=PASS
DUPLICATE_ROLLBACK_EFFECT=0
STALE_ROLLBACK_EFFECT=0
CROSS_PROPOSAL_ROLLBACK_EFFECT=0
RELEASE_BUNDLE_FOUNDATION=PASS
CHANGE_WINDOW_FOUNDATION=PASS
EMERGENCY_STOP=PASS
EXECUTION_URL_SAFETY=PASS
EXECUTION_PROMPT_INJECTION_DEFENSE=PASS
EXECUTION_MONEY_LEDGER_MUTATION_EFFECT=0
ACCESS_TRADE_SHOPEE_EXECUTION_BOUNDARY=PASS
DIRECT_SHOPEE_STATUS=DISABLED_NO_CREDENTIALS
DIRECT_SHOPEE_API_CALLS=0
LIVE_AI_PROBE=NOT_RUN
AI_EXECUTION_AUTHORITY=NO
TYPESCRIPT=PASS
ESLINT=PASS_0_NEW_ERRORS
SECRET_SCAN=PASS
GIT_DIFF_CHECK=PASS
BUILD_CLOUDFLARE=PASS
LONG_RUN_STATE_PARSE=PASS
LONG_RUN_STATE_PRIOR_HISTORY_PRESERVED=YES
PRODUCTION_SIDE_EFFECTS=0
PRODUCTION_CONTENT_MUTATIONS=0
PRODUCTION_D1_MIGRATIONS=0
CLOUDFLARE_DEPLOYMENTS=0
DNS_CHANGES=0
REAL_MONEY_TRANSACTION_CREATED=NO
PHASE9_CHECKPOINT_CONSISTENT=YES
SAFE_FOR_PHASE9_REAUDIT=YES
SAFE_FOR_PHASE9_FINAL_REAUDIT=YES
BLOCKERS=NONE_WITHIN_PHASE9_TARGETED_ROLLBACK_REMEDIATION
NEXT_STEP=STOP_FOR_PHASE9_FINAL_REAUDIT
```

No commit, push, Cloudflare login, deployment, DNS change, production migration,
production action, Phase 9.5 or Phase 10 work is authorized by this checkpoint.
