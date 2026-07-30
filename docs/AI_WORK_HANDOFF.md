# AI Work Handoff

## Task

SANDEAL M3.1 — Post-M3 Runtime Reconciliation and Product Flow Activation

## Repository state

- Branch: `master`
- Required baseline: `c3672f88c78f0d95ae0c7a5dfb5f136aa181e991`
- Initial local HEAD: `c3672f88c78f0d95ae0c7a5dfb5f136aa181e991`
- Initial `origin/master`: `c3672f88c78f0d95ae0c7a5dfb5f136aa181e991`
- Preflight: passed; branch and revisions matched, the worktree was clean, and `git diff --check` passed.
- The completed M3 baseline was confirmed by source inspection and the final M3 regression gate.
- No commit, push, deployment, VPS access, PM2 action, production configuration change, or production data access was performed.

## Initial production symptoms supplied for source verification

The live observations below came from the task input. This task did not query production.

- App Health loaded and release identity matched across Web, Worker, Scheduler, and public build.
- Worker and Scheduler heartbeats and leases appeared fresh, while historical heartbeat-stale codes were still shown as active.
- Job Health reported current-state incompleteness and a summary/manifest mismatch.
- Runtime publishing was blocked; policy publishing was not blocked.
- Runtime Guardian recovery remained at 0/3 without a qualifying healthy evaluation.
- Pickup latency showed legacy `createdAt` semantics and a long historical P95.
- Worker Pool displayed OFF while also showing bounded capacity.
- AccessTrade was configured but not ready; Gemini was unavailable under the Free-only policy.
- No product was publicly projected and the operator could not see one bounded, authoritative explanation.

## Evidence classification

| Observation | Classification | Source finding |
| --- | --- | --- |
| Fresh heartbeat shown with heartbeat-stale active reason | `CONFIRMED_CODE_DEFECT` | Operational Health unioned persisted runtime reasons into current reasons without reconciling current role evidence. |
| Historical heartbeat incident | `HISTORICAL_ONLY` | Durable audit data is valid history but must not automatically remain active. |
| Job Health manifest mismatch | `CONFIRMED_CODE_DEFECT` / `STALE_PROJECTION` | Manifest v1 did not validate all semantic revision, range, count, completeness, and combined-fingerprint relationships and had no safe deduplicated repair workflow. |
| Job Health current state incomplete | `EXPECTED_FAIL_CLOSED_BEHAVIOR` | Incomplete or invalid compact evidence must remain non-healthy while an explicit rebuild is pending. |
| Legacy pickup P95 blocks current rollout | `CONFIRMED_CODE_DEFECT` / `HISTORICAL_ONLY` | Current recovery accepted legacy or release-unattributed samples and could treat an idle/no-sample path as recovery evidence. |
| Runtime Guardian at 0/3 | `INSUFFICIENT_EVIDENCE` plus confirmed recovery gaps | Three-pass state existed, but evidence identity and per-metric sufficiency needed tightening. |
| Runtime publishing blocked, policy publishing not blocked | `EXPECTED_FAIL_CLOSED_BEHAVIOR` | Runtime and policy controls are independent and remain so. |
| Worker Pool OFF with capacity visible | `CONFIGURATION_DISABLED` | Capacity can be calculated while the continuous implementation remains disabled. |
| AccessTrade configured but not ready | `EXPECTED_FAIL_CLOSED_BEHAVIOR` / `INSUFFICIENT_EVIDENCE` | Configuration is not live readiness; no live provider probe was run. |
| Gemini unavailable under Free-only policy | `CONFIGURATION_DISABLED` | AI remains optional and separate from deterministic validation. |
| Empty public homepage | `INSUFFICIENT_EVIDENCE` | The pipeline bridge was present, but the dashboard lacked a bounded authoritative classification. |
| Direct source-to-candidate pipeline disconnect | `NOT_REPRODUCED` | Existing source job, candidate, canonical product, eligibility, and publication-job wiring was connected in source and tests. |
| First transient health timeout hides an existing safe product | `CONFIRMED_CODE_DEFECT` | Retryable first failures escalated directly to a public hide instead of one bounded grace/recheck path. |

## Completed work

### Current authoritative reasons

- Added one deterministic current-reason reconciler.
- Worker and Scheduler heartbeat reasons now require a unique active lease, fresh heartbeat and lease timestamps, current role identity, matching instance and PID ownership, valid fencing token, matching release, and no duplicate-role conflict.
- Fresh evidence clears only the matching obsolete heartbeat reason.
- Current runtime blockers, current policy blockers, projection-quality warnings, and historical audit reasons are separate.
- Historical records are retained and never deleted.
- The response exposes reason transitions with code, prior/result state, transition type, evaluation time, release, evidence timestamps, safe references, and rejection reasons.

### Job Health Summary and manifest

- Upgraded the compact projection contract to `automation-job-projection-v3`.
- Added strict schema/projection version, release, source revision, summary revision, generated time, observed range, record/active-record counts, completeness, source fingerprint, and combined projection fingerprint validation.
- Invalid projections stay fail-closed; the last valid projection remains available while status is invalid or rebuilding.
- App Health creates at most one deduplicated maintenance request and never rebuilds by reading durable job history.
- The maintenance worker rebuilds explicitly, verifies the durable source revision before and after staging, validates the staged summary and manifest, and uses the manifest as the atomic replacement boundary.
- A failed rebuild restores the prior projection and records an auditable failure.

### Pickup latency and SLO sufficiency

- Preserved historical legacy pickup metrics for audit.
- Current pickup recovery requires explicit runnable/eligibility time plus claimed time and matching current release and rollout cohort.
- Missing timestamps are `INSUFFICIENT_DATA`; they are never zero or PASS.
- Current and historical P50/P95/counts, legacy exclusions, insufficient timestamps, semantics, release boundary, and rollout boundary are exposed separately.
- The pickup target remains 30 seconds.
- Every SLO metric now reports its own status, raw/qualifying/excluded counts, threshold, observed value, window, semantics, reason, and evidence sufficiency.
- Zero-touch reports raw numerator and denominator and excludes manual/operator/user-triggered, failed, blocked, cancelled, and partial work from success.

### Runtime Guardian recovery

- Recovery remains reason-specific and requires three consecutive unique, fresh, release-compatible qualifying evidence revisions.
- Duplicate evidence cannot increment a streak.
- Breach, stale evidence, release change, and insufficient evidence reset or invalidate progress according to the existing policy.
- Recovery exposes streak, required streak, last qualifying/failed evaluation, reset reason, evidence revision, release, evaluation time, and permit state.
- Runtime recovery does not clear manual pause, emergency stop, policy, quarantine, merchant, source, URL, image, price, affiliate, product-evidence, or compliance blockers.
- Recovery has no publication side effect.

### Worker Pool truth

- App Health now reports configured mode, effective mode, configuration source, validity, implementation-active state, maximum/used/available slots, critical reservation, critical/normal active counts, normal availability, cohort, fairness policy, disabled reason, and activation control.
- OFF, SHADOW, ACTIVE, invalid configuration, and environment override are distinct.
- Existing hard concurrency, ordinary-job fairness, shutdown draining, fencing, and Runtime Guardian reservation remain unchanged.
- No Worker was added and no mode was enabled.

### Product-flow diagnostics

- Added a bounded read-only service using current product/candidate snapshots and compact job projections.
- Counts use `number | null`, so authoritative zero is distinct from unknown.
- The service reports current product/candidate/public counts, eligibility groups, evidence/policy/quarantine/recheck/manual/permanent blockers, bounded job milestones, source readiness, safe AccessTrade reason, separate AI readiness, runtime publishing state, top blocker codes, top missing fields, and recheck suppression/queue counts.
- The authenticated App Health API and dashboard expose these stable classifications with separate Vietnamese labels:
  - `NO_SOURCE_INGESTION`
  - `SOURCE_NOT_READY`
  - `NO_CANDIDATES`
  - `CANDIDATES_WAITING`
  - `CANDIDATE_PROCESSING_FAILED`
  - `PRODUCTS_MISSING_EVIDENCE`
  - `PRODUCTS_QUARANTINED`
  - `PRODUCTS_REQUIRE_RECHECK`
  - `PRODUCTS_ELIGIBLE_RUNTIME_BLOCKED`
  - `PRODUCTS_ELIGIBLE_POLICY_BLOCKED`
  - `NO_PRODUCT_MEETS_PUBLIC_ELIGIBILITY`
  - `PUBLIC_PROJECTION_MISMATCH`
  - `UNKNOWN_INCOMPLETE_DATA`
- No complete durable job collection is returned or parsed on an interactive path.

### Pipeline and safe rechecks

- No direct source/candidate/canonical-product wiring defect was confirmed, so no source provider was broadened or fabricated.
- Added bounded product-evidence recheck scheduling with stable evidence-revision idempotency, active-job suppression, retry limits, bounded backoff, circuit/manual/permanent termination, and a maximum of 50 enqueue attempts per maintenance pass.
- Existing stale-claim recovery and Guardian capacity are preserved.
- A first retryable health timeout can retain a previously public-safe product for one bounded retry; repeated or permanent failures still escalate fail-closed.
- A changed product URL is explicitly `unverified`, remains hidden, preserves all owner-edit block reasons, and schedules one durable verification job.

### App Health presentation

- Separates authoritative runtime blockers, policy blockers, projection warnings, historical audit reasons, product-flow blockers, provider readiness, and missing evidence.
- A retained reason whose evidence is still being reconciled is labelled pending rather than asserted against a fresh card.
- Shows per-reason recovery streak and last qualifying evaluation.
- Shows historical and current pickup latency separately.
- Shows configured and effective Worker Pool mode separately.
- Adds compact projection-maintenance and product-flow diagnostic panels.
- Existing refresh ordering and last-valid-snapshot preservation remain intact.
- No raw errors, paths, credentials, tokens, provider payloads, or stack traces are exposed.

## Files changed by subsystem

### Runtime evidence and recovery

- `src/lib/automation/currentReasonReconciler.ts` (new)
- `src/lib/automation/operationalHealth.ts`
- `src/lib/automation/runtimeGuardian.ts`
- `src/lib/automation/runtimeRecoveryState.ts`
- `src/lib/automation/runtimeRoles.ts`
- `src/lib/automation/sloErrorBudget.ts`
- `src/lib/automation/types.ts`

### Projection validation and maintenance

- `src/lib/automation/jobHealthSummary.ts`
- `src/lib/automation/projectionMaintenance.ts` (new)
- `src/lib/automation/store.ts`
- `src/lib/automation/healthService.ts`
- `src/lib/automation/worker.ts`

### Worker Pool

- `src/lib/automation/featureRollout.ts`
- `src/lib/automation/operationalHealth.ts`
- `src/lib/automation/worker.ts`

### Product flow and rechecks

- `src/lib/automation/productFlowDiagnostics.ts` (new)
- `src/lib/automation/safeProductRechecks.ts` (new)
- `src/lib/automation/productActions.ts`
- `src/lib/automation/reconciler.ts`
- `src/lib/product-intelligence/jobs.ts`
- `src/lib/storage/products.ts`

### Dashboard

- `src/app/dashboard/app-health/page.tsx`

### Tests and commands

- `scripts/post-m3-reconciliation-product-flow-tests.cjs` (new)
- `scripts/automation-health-reliability-tests.cjs`
- `scripts/bounded-projection-storage-tests.cjs`
- `scripts/master-m2-operational-health-tests.cjs`
- `scripts/prompt10-slo-error-budget-tests.cjs`
- `scripts/prompt12-operational-truth-tests.cjs`
- `package.json` (adds `test:post-m3` only)
- `package-lock.json` is unchanged; no dependency was added.

## Validation results

Final non-overlapping test inventory: **508 assertions passed, 0 failed**. One production-connected suite was intentionally not run.

| Command | Result |
| --- | --- |
| `git diff --check` | PASS |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS with 0 errors and 10 pre-existing warnings |
| `npm run test:post-m3` | 38 PASS, 0 FAIL |
| `node scripts/automation-health-reliability-tests.cjs` | 12 PASS, 0 FAIL |
| `node scripts/bounded-projection-storage-tests.cjs` | 13 PASS, 0 FAIL |
| `npm run test:master:m1` | 99 PASS, 0 FAIL |
| `npm run test:master:m2` | 31 PASS, 0 FAIL |
| `npm run test:master:m3` | 39 PASS, 0 FAIL |
| `npm run test:storage` | 15 PASS, 0 FAIL |
| `npm run test:storage:mongo` | 28 PASS, 0 FAIL; fake/local adapter only |
| `node scripts/prompt08-product-intelligence-tests.cjs` | 32 PASS, 0 FAIL |
| `npm run test:prompt10:lifecycle` | 50 PASS, 0 FAIL |
| `npm run test:accesstrade` | 34 PASS, 0 FAIL |
| `npm run test:prompt12` | 117 PASS, 0 FAIL |
| `npm run test:storage:acceptance` | SKIP: explicit production Mongo opt-in is prohibited for this task |
| `npm run build` | PASS |

Intermediate validation exposed and then verified fixes for an outdated M2 expectation, a Mongo collection-name sentinel, two owner-edit storage-guard inconsistencies, and two stale Prompt12 implementation-shape assertions. Every affected final suite was rerun successfully.

## Performance

- App Health fixture: 13,000 durable jobs and 500 runtime snapshots.
  - Cold: **32.4 ms**
  - Warm: **26.7 ms**
  - Durable job-history reads on interactive path: **0**
  - Durable permit-history reads on interactive path: **0**
- Product-flow fixture: 1,000 products and 2,000 candidates.
  - Duration: **15.9 ms**
  - Serialized diagnostic size: **2,436 bytes**
- Both paths are well below the requested 5-second cold, 3-second warm/diagnostic targets.
- Memory was not separately profiled; bounded input limits, bounded output size, and no-full-history static/runtime assertions passed.

## Build

- `npm run build`: PASS on Next.js 16.2.11.
- Optimized compilation: 4.3 seconds.
- TypeScript build phase: 9.8 seconds.
- Static generation: 43/43 pages.
- Existing warning remains: Turbopack NFT detects a broad filesystem trace through `next.config.ts` and `src/lib/autonomous/backupManager.ts`.

## Safety invariants preserved

- No publication mode was enabled and no product was forced public.
- No quarantine, product eligibility, source, merchant, URL, image, price, affiliate, evidence, policy, or compliance control was bypassed.
- Pickup and zero-touch SLO targets were not lowered.
- Missing evidence never becomes PASS or recovery progress.
- Claim tokens, role leases, PID ownership, fencing tokens, release identity, operation journals, idempotency, atomic writes, rollback snapshots, bounded concurrency, fairness, and Guardian reserved capacity remain enforced.
- No data, history, projection, lease, journal, evidence, snapshot, or backup was deleted.

## Remaining rollout controls

- Worker Pool remains OFF unless the existing `WORKER_CONTINUOUS_POOL_V2` control is changed in a separately authorized rollout.
- Recommended future progression is OFF → SHADOW observation → ACTIVE only after an explicit release review; do not enable ACTIVE as part of this handoff.
- Projection repair requires the existing Worker to execute the one deduplicated maintenance job.
- Runtime recovery requires three unique qualifying current-release evidence revisions; repeated reads of one revision do not count.
- These local changes do not alter current production state until a separately authorized commit/release/deployment.

## Remaining external limitations and risks

- Production was not accessed, so current live reason transitions, rebuild execution, recovery streaks, and homepage classification were not verified after these changes.
- No live AccessTrade probe was run. `configured` remains distinct from `ready`, with a safe reason code.
- Gemini availability was not probed and AI remains optional.
- No production Mongo acceptance test was run.
- No real publication attempt or post-publication monitor outcome was fabricated.
- Product diagnostics can return `UNKNOWN_INCOMPLETE_DATA` when bounded snapshots are absent, stale, truncated, or otherwise incomplete.
- The existing Turbopack NFT warning should be handled separately; it is not introduced by M3.1.

## Recommended next task

Perform a separately authorized **M3.1 controlled rollout verification**: review and commit this diff, deploy it through the normal release process with Worker Pool still OFF, verify that exactly one projection rebuild is queued/executed if needed, observe heartbeat reason transitions and three unique Runtime Guardian evaluations, and record the live product-flow classification. Do not enable publication or Worker Pool ACTIVE during that verification.

## Recommended commit message

`fix: reconcile runtime health and product flow diagnostics`

