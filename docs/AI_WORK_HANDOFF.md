# AI Work Handoff

## Current handoff: SanDeal M3.1.5

### Task and reconstructed starting state

- Task: file-storage lock convergence, independent role heartbeats, and Worker/Scheduler stability.
- Repository: `C:\duan\sandeal`; branch `master`; initial HEAD `ce9296ffff763f336305721e62a240fd58f6a01c`.
- Initial `git status --short`, `git diff --stat`, `git diff`, `git diff --cached`, and untracked-file inspection were clean. The current working tree contains only the uncommitted M3.1.5 work recorded below.
- The current M3.1.3 production runbook and M3.1.4 implementation/tests were read before editing. No VPS, PM2, production storage, provider credential, deployment, commit, push, or production-data operation was performed.

### Confirmed production root cause

| Component | Confirmed behavior | Risk | Smallest safe correction |
| --- | --- | --- | --- |
| Role authority | The prior authority wrapper held the role-lease collection lock across job mutations. | Role heartbeat waited behind file work and the role expired/fenced. | Add a separate short-lived role fence with its own heartbeat; keep the role lease heartbeat independent. |
| File `automation-jobs` | Each enqueue could scan and rewrite the complete JSON collection while holding the lock. | Scheduler contention, long lock ownership, and memory/CPU pressure. | Use bounded planning plus an atomic append-only file path; batch scheduler intelligence enqueues. |
| Control reads | Control updates performed an explicit read and then a transactional read/write. | Repeated durable reads and lock acquisition in one cycle. | Use the transaction snapshot as the authoritative update input and a bounded cycle-scoped control read model. |
| Stale lock recovery | A dead same-host PID waited for lease expiry even when it could not release the lock. | Recovery latency extended contention. | Recover only a conclusively dead same-host PID immediately; never steal a live PID; unknown hosts still require expiry. |
| Handler failures | Lock/fence timeout codes could be routed through provider/terminal failure handling. | Infrastructure contention could consume business attempts or be mislabeled. | Classify lock contention separately, defer with bounded jitter, preserve attempts, and pause fail-closed after the finite deferral budget. |

### M3.1.5 implementation

- `src/lib/automation/runtimeRoles.ts`: independent `runtime-role-fencing` records serialize role takeover and final fenced mutations without holding the role-lease lock during business work. Fence heartbeats stop after role ownership is no longer valid; release and takeover paths are finally-cleaned and release-aware.
- `src/lib/automation/store.ts`, `src/lib/automation/types.ts`: batch enqueue, cycle-scoped control reads, final `beforeCommit` authority checks, bounded infrastructure-contention deferral, separate infrastructure retry accounting, and explicit storage/fencing diagnostics. A contention deferral does not increment `attemptCount`; five bounded deferrals pause the job for operator recovery rather than looping.
- `src/lib/storage/fileStorageAdapter.ts`, `src/lib/storage/mongoStorageAdapter.ts`, `src/lib/storage/types.ts`: atomic before-commit hooks, append-only file promotion without full JSON reserialization, byte-correct UTF-8 closing-bracket offsets, lock-wait/heartbeat/recovery diagnostics, and semantic Mongo compatibility.
- `src/lib/storage/diagnostics.ts`: bounded counters for reads by collection, lock wait/hold, stale recovery, file/job/role heartbeat latency, and fencing rejection.
- `src/lib/automation/cycleReadModel.ts`, `src/lib/automation/worker.ts`, `src/lib/automation/scheduler.ts`: bounded cycle-local control reuse, scheduler batch enqueue, single-flight scheduler cycle, and structured bounded cycle diagnostics. No process-wide durable job snapshot is retained.
- `scripts/automation-worker.cjs`, `scripts/automation-scheduler.cjs`, `src/lib/automation/executionBudget.ts`: bounded independent role-heartbeat calls, cleanup, role-loss shutdown behavior, and explicit infrastructure cancellation.
- `src/lib/storage/mongoSchema.ts`: additive logical collection registration for the role-fence record.
- `scripts/m3-1-5-file-runtime-stability-tests.cjs` and `scripts/m3-1-5-file-runtime-performance-tests.cjs`: deterministic safety tests and the sequential 13,000-job fixture.

### Lock and authority model

1. Role acquisition/takeover uses the small `runtime-role-fencing` record, then the short `runtime-role-leases` transaction.
2. During work, the role lease is renewed independently by the process entrypoint; a final mutation also owns a renewable role fence and revalidates role owner, job claim, fencing token, and release identity immediately before promotion.
3. The `automation-jobs` lock covers only bounded planning/streaming mutation and the atomic file/Mongo commit. Provider/network work, handler execution, projection sync, audit, logging, and sleeping occur after it is released.
4. Projection, audit, and control follow-up writes occur after the job-source lock. No remote call is initiated under the primary jobs lock.

File lock recovery requires the recorded host/PID and lease metadata. A live same-host PID is never stolen. A conclusively gone same-host PID may be recovered before expiry; an unverifiable/different-host owner requires lease expiry. All owned locks and timers are released in `finally` paths.

### Retry, degraded operation, and safety rules

- `STORAGE_LOCK_TIMEOUT`, `ROLE_FENCE_LOCK_TIMEOUT`, and `STORAGE_LOCK_CONTENTION` are infrastructure contention, not provider timeout or product failure. They use finite exponential backoff with jitter, retain audit evidence, and do not consume another business attempt.
- Role fencing loss is explicit `WORKER_FENCING_REJECTED`; stale workers cannot complete, fail, reschedule, publish, or overwrite a job. A timed-out/fenced handler is aborted and late durable success is blocked.
- Exhausted infrastructure deferrals become `PAUSED` with `STORAGE_ERROR:INFRASTRUCTURE_RETRY_BUDGET_EXHAUSTED`; they do not auto-loop. Existing terminal history, product blockers, Runtime Guardian, publication evidence, and fail-closed policy gates are unchanged.
- Worker/Scheduler remain safe-default/off for experimental rollout flags. No publication was forced and no production product state was changed.

### Local performance measurements

The fixture was run sequentially in a temporary file store with 13,000 jobs and a 55.7 MB (`58,453,671` bytes) `automation-jobs` file. The supplied production observation is the only before measurement for the VPS baseline; it reported 136 complete durable reads, 30,697 ms maximum lock hold, and 397,348,864-byte RSS.

| Operation | Measured result |
| --- | ---: |
| Job Health repair, cold / warm / incremental catch-up | 22,681 / 25,473 / 29,198 ms |
| Scheduler cycle, cold / warm | 5,800 / 3,344 ms |
| Worker cycle, cold | 20,842 ms |
| Worker complete durable reads | 82; `automation-jobs` complete reads: 0 |
| Scheduler `automation-jobs` complete reads | 0 |
| Maximum Worker lock hold | 6,009 ms; Scheduler 1,692 ms; repair catch-up 1,692 ms |
| Critical pickup latency in fixture | 38,048 ms |
| Peak RSS / peak heap | 497.9 / 263.3 MB |
| Four repeated-cycle heap delta after GC | -112,696 bytes |

The local Worker read count is 39.7% below the supplied 136-read baseline, and the measured maximum Worker lock hold is 80.4% below the supplied 30,697 ms baseline. The fixture reported zero complete durable `automation-jobs` reads for repair, Scheduler, and Worker operations. Critical pickup was measured at 38.048 seconds in this local run; the fixture does not treat that as a pass/fail threshold, so the VPS rollout must explicitly verify the existing pickup SLO and stop if critical maintenance is delayed. These are deterministic local measurements, not a production performance claim.

### Tests and validation status

- `npm run test:m3.1.5`: 11 passed, 0 failed; `npm run test:m3.1.5:performance`: PASS, all acceptance assertions passed.
- `npm run test:m3.1.4`: 12 passed, 0 failed; `npm run test:m3.1.3`: Gate A 7, Gate B 7, publication recovery 11, live health 3 passed.
- `npm run test:m3.1.2:projection-repair`: 15 passed; `npm run test:m3.1.2:projection-performance`: PASS; M3.1.1 projection repair: 11 passed.
- Storage: file 15, fake-Mongo 30, migration 39, acceptance 20 passed. The acceptance command explicitly reported `REAL_ISOLATED_MONGO_ACCEPTANCE: NOT_RUN`.
- Runtime/product suites: Prompt 10 runtime 18, orchestration 12, job schema 10, self-healing 8, lifecycle 50, resilience 11, backup/recovery 7; automation 29; health/readiness 33; hardening 12; durable health 26 passed. `npm test` passed.
- `npm run typecheck`: PASS; `npm run lint`: PASS with 0 errors and 12 pre-existing warnings; `npm run release:secret-scan`: PASS; `git diff --check`: PASS with only existing CRLF normalization warnings; `npm run build`: PASS with the existing broad Turbopack NFT filesystem-trace warning.
- Intentionally skipped: real provider/AccessTrade/Gemini calls (user prohibition); real isolated Mongo acceptance (no explicit isolated non-production configuration, and production Mongo access is prohibited); VPS/PM2/deployment/production website verification (user prohibition).

### Production rollout plan — document only, do not execute locally

Worker first: keep Scheduler stopped; deploy the exact full release SHA through the guarded deployment script; verify immutable build/release identity; start Worker only; observe at least 15 minutes. Require unchanged PID, ACTIVE/fresh role lease, no storage-lock timeout, no `WORKER_FENCING_REJECTED`, no role-loss restart, no internal-contention `LEASE_EXPIRED_MAX_ATTEMPTS`, safe RSS/swap, and bounded cycle/lock metrics. Stop immediately on any failed gate.

Scheduler second: only after Worker stability, start Scheduler; observe one tick at a time; require single-flight scheduling, no duplicate critical jobs/repairs/rechecks/publications, no lock contention, fresh Scheduler lease, and safe memory/swap. Save PM2 state only after all gates pass.

Rollback/stop: stop Scheduler before Worker, allow only safe in-flight cleanup, preserve the durable data directory and evidence, and use the previously verified full release SHA through the guarded rollback procedure. Never delete jobs, leases, projections, backups, or audit history. Immediate stop conditions are PID churn, stale/mismatched identity, repeated lock timeout, incorrect live-lock recovery, fencing rejection, duplicate effect, sustained memory/swap pressure, App Health timeout, or publication without complete current evidence.

### Recommended commit and classification

- Recommended commit: `fix: bound automation memory leases and repair convergence`
- Classification: `SAFE_TO_COMMIT_M3_1_5` based on the completed local gates and final diff review. This is not production deployment authorization; the documented Worker-first rollout and VPS acceptance gates remain mandatory.

## Current handoff: SanDeal M3.1.2

### Task

SanDeal M3.1.2 - Convergent, Fenced Projection Repair

### Repository and recovery state

- Branch: `master`
- Baseline and current HEAD: `3a0bf95e83c88e52531ff8a0a5a0a686b93c38f4`
- The intentionally interrupted working tree was preserved in place. No tracked or untracked change was reset, discarded, rolled back, cleaned, or replaced.
- The recovered work already contained most of the M3.1.2 protocol plus two untracked test programs. Work resumed by inspecting the complete diff and every untracked file before editing.
- The remaining integration work found one obsolete M3.1.1-era assertion and one real status-projection version propagation defect. Both were corrected without restarting the implementation.
- No commit, push, deployment, VPS/PM2 access, production storage access, production configuration change, or production data mutation was performed.

### Completed implementation

#### Convergent source boundary

- Durable job mutations reserve a monotonic projection mutation sequence before the authoritative `automation-jobs` transaction.
- The manifest records the next mutation sequence, committed semantic high-watermark, in-flight operations, and a bounded semantic source fingerprint.
- `projectionSourceVersion` fences older compact writes per job. Both list and status projections now carry that version.
- Heartbeat and lease volatility, including the fencing-only version field, is excluded from semantic source fingerprints. Status, payload/result disclosure, lifecycle, and other compact semantic changes remain fingerprint-significant.
- A repair performs a base build and then up to five bounded catch-up passes. It re-reads the authoritative durable source, reuses unchanged bounded candidate rows, and publishes only after the source boundary is stable.
- A stale caller-supplied snapshot is no longer treated as authoritative or rejected immediately; catch-up converges it to the latest durable state.
- Catch-up exhaustion is explicit as `JOB_PROJECTION_CATCH_UP_RETRY_EXHAUSTED` and leaves the previous active generation visible.

#### Fenced single-flight repair

- A repair claim contains repair id, rebuild token, monotonically increasing repair fence, Worker owner/instance/fencing identity, hashed claim token, attempt number, target generation, and target slot.
- Duplicate executor calls for the same claim join one local promise. A distinct active repair is rejected unless an authorized newer attempt explicitly supersedes it.
- Every phase transition is validated: `CLAIMED`, `REBUILDING`, `CATCHING_UP`, `VALIDATING`, `PUBLISHING`, then `COMPLETED`; retry, failed, and superseded terminal paths are explicit.
- Worker ownership and the durable job claim are re-authorized immediately before publication. A superseded Worker cannot move the manifest pointer.
- Repair scheduling remains two-stage. App Health writes only one compact `SCHEDULED` request; the Worker materializes the durable maintenance job outside the interactive request.
- Concurrent refreshes and Worker loops suppress duplicate requests and reuse one repair/job identity.

#### Candidate generation and atomic publication

- Each repair writes list, status, and summary candidates to unique `A`/`B` collections suffixed by the repair fence.
- Candidate metadata includes generation, slot, repair identity, start/current source boundaries, catch-up counts, schema/version, record counts, full-content fingerprints, combined fingerprint, and summary revision.
- Candidate collections and the compact staging record are re-read and verified before publication. A second verification runs after the final authorization hook.
- One manifest transaction is the reader-visible promotion boundary. A crash before it preserves the prior active generation; a crash after it treats the promoted generation as authoritative and completes safely.
- The promoted generation is mirrored to legacy collection names only while the boundary is unchanged. If mirroring cannot settle, readers remain on the promoted generation and `legacyMirrorPending` stays explicit.
- Old fenced candidates are recorded for bounded best-effort cleanup. File storage does not create redundant backups for reproducible transient candidate collections.

#### Incremental writes, polling, and maintenance

- Create, claim, retry, completion, failure, cancellation, approval, recovery, parent/manual transitions, compaction, and persisted-entity migration participate in projection mutation fencing.
- Batched claim changes update both compact projections under one mutation handle. Partial read-model failure invalidates the manifest fail-closed instead of presenting a mixed projection as current.
- Lightweight job polling follows the active generation and can repair a stale compact row from the durable job. Status projections retain `projectionSourceVersion`, preventing both stale overwrite and the recovered polling regression.
- Heartbeats update the active compact generation without advancing the semantic source boundary. Current heartbeat evidence refreshes Job Health freshness without producing rebuild churn.
- The broad autonomous reconciler no longer starts a competing full projection rebuild; the dedicated fenced maintenance workflow owns repair.

#### Health evidence and operator visibility

- Valid projection evidence can move obsolete projection-specific current reasons to historical audit state. It cannot clear SLO, Runtime Guardian, AI policy, publication policy, or unrelated reasons.
- App Health exposes active generation/slot, source high-watermark/fingerprint, active repair id/phase/attempt, last repair failure, retry time, catch-up state, previous-valid serving state, last successful repair, and legacy mirror state.
- Legacy M3.1/M3.1.1 manifests remain valid and are upgraded additively in memory. Missing or invalid projections rebuild without deleting durable job history.
- File and Mongo serialization preserve the same manifest and repair protocol semantics.

### Tests added or updated

- Added `scripts/m3-1-2-convergent-projection-repair-tests.cjs` with 15 scenarios covering semantic/volatile identity, continuous heartbeats, relevant write waves, bounded exhaustion, request and executor single-flight behavior, Worker supersession, crash recovery, retry metadata atomicity, corrupt candidates, current-reason cleanup, legacy bootstrap, missing projection recovery, Mongo parity, and invalid phase transitions.
- Added `scripts/m3-1-2-projection-repair-performance-tests.cjs` with a 13,000-job / 500-runtime-snapshot / 55.5 MB fixture and explicit latency, durable-read, response-size, retained-candidate, and memory guards.
- Updated the prior bounded storage test so a stale caller snapshot must converge to current durable truth.
- Updated M3.1.1, post-M3, App Health reliability, and Mongo adapter tests for two-stage materialization and fenced candidate storage.
- Added package scripts `test:m3.1.2:projection-repair` and `test:m3.1.2:projection-performance`.

### Validation results

| Command | Result |
| --- | --- |
| `git diff --check` | PASS |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS with 0 errors; 10 existing warnings remain |
| `npm run release:secret-scan` | PASS; 485 files scanned |
| `npm run test:m3.1.2:projection-repair` | 15 PASS, 0 FAIL |
| `npm run test:m3.1.2:projection-performance` | PASS |
| `node scripts/bounded-projection-storage-tests.cjs` | 13 PASS, 0 FAIL |
| `node scripts/m3-1-1-projection-repair-tests.cjs` | 11 PASS, 0 FAIL |
| `node scripts/post-m3-reconciliation-product-flow-tests.cjs` | 38 PASS, 0 FAIL |
| `node scripts/automation-health-reliability-tests.cjs` | 12 PASS, 0 FAIL |
| `node scripts/sandeal-durable-health-regression-tests.cjs` | 26 PASS, 0 FAIL |
| `npm test` | PASS |
| `npm run test:master:m1` | PASS |
| `npm run test:master:m2` | 31 PASS, 0 FAIL |
| `npm run test:master:m3` | PASS |
| `npm run test:storage` | 15 PASS, 0 FAIL |
| `npm run test:storage:mongo` | 29 PASS, 0 FAIL; fake/local adapter only |
| `npm run test:storage:migration` | 39 PASS, 0 FAIL |
| `npm run test:prompt10:job-schema` | 10 PASS, 0 FAIL |
| `npm run test:prompt10:orchestration` | 12 PASS, 0 FAIL |
| `npm run test:prompt10:lifecycle` | PASS |
| `npm run test:prompt10:resilience` | 11 PASS, 0 FAIL |
| `npm run test:prompt10:backup` | 7 PASS, 0 FAIL |
| `npm run build` | PASS on Next.js 16.2.11; 43/43 static pages |
| `npm run test:storage:acceptance` | NOT RUN: explicit real-Mongo/production opt-in is prohibited for this task |

Two additional non-gating Prompt 10 commands were inspected and remain red in product-readiness fixtures outside the M3.1.2 diff:

- `npm run test:prompt10:foundation`: 27 PASS, 1 FAIL (`valid server-derived readiness snapshot passes foundation invariant`).
- `npm run test:prompt10:shadow`: 2 PASS, 3 FAIL (fixtures reach `SAFE_PUBLISH_NOT_READY` before the intended shadow-mode assertions).

The failing reasons concern affiliate/canonical verification, image/content evidence, price freshness, review quality, and autonomous assessment. M3.1.2 does not change those readiness modules or policies; no unrelated policy weakening was made to force these optional suites green.

### Performance measurements

- Fixture: 13,000 durable jobs, 500 runtime snapshots, 55.5 MB `automation-jobs` file.
- App Health: 118.9 ms cold and 101.6 ms warm; five repeated calls performed 0 complete durable-job reads; heap delta was 0.5 MB.
- Interactive repair scheduling: 8.8 ms, 0 durable-job reads, and no inline durable maintenance-job enqueue.
- Base repair: 4,076.5 ms total, 2 full durable reads, 1 catch-up pass, 8.0 ms manifest promotion, and 141.6 ms legacy mirror.
- Relevant-write repair: 4,885.1 ms total, 3 full durable reads, one changed job caught up, and 7.9 ms manifest promotion.
- Continuous-heartbeat repair: 4,549.6 ms total, 7 heartbeat writes, 2 full durable reads, 6.5 ms promotion, and no semantic source-boundary movement.
- Peak memory: 429.6 MB heap and 642.3 MB RSS, below the 1.5 GB test guard. The retained candidate remains bounded to 2,000 list plus 2,000 status records; the test models at most two candidate copies / 8,000 projection records.

### Build result

- Optimized Next.js 16.2.11 build: PASS.
- Compilation: 4.9 seconds; TypeScript: 14.1 seconds; static generation: 43/43 pages in 643 ms.
- Existing warnings remain: npm's `min-release-age` deprecation notice and Turbopack's broad NFT trace through `next.config.ts` / `src/lib/autonomous/backupManager.ts`.

### Safety invariants and remaining risks

- Durable source writes, compact projection writes, repair claims, Worker ownership, manifest promotion, and retries are fenced independently and fail closed on ambiguity.
- A candidate is never reader-visible before manifest promotion. A failed or superseded candidate cannot replace the prior valid generation.
- Continuous heartbeats do not starve semantic convergence or fabricate source revisions.
- App Health remains bounded and performs no complete durable job-history read or inline maintenance-job creation.
- Existing Runtime Guardian capacity reservation, job claim tokens, role leases, Worker fencing, retry limits, idempotency, publication policy, and product eligibility controls remain enforced.
- Worker Pool rollout state and publication modes were not enabled. No product was forced public.
- A stale in-flight mutation is conservatively absorbed by a later full repair after its bounded age. Until the Worker retries, projection evidence remains fail-closed.
- File storage necessarily parses the large durable job collection during explicit repair. The measured peak RSS is within the test guard but remains material; live latency and memory on production hardware are unverified.
- Production/VPS and a real Mongo acceptance environment were not accessed, so post-deployment recovery and live Mongo transaction latency remain unverified.
- The two unrelated product-readiness fixture failures above remain visible and were not masked by this change.

### Recommended commit and classification

- Recommended commit: `fix: make projection repair convergent and fenced`
- Classification: `SAFE_TO_COMMIT_M3_1_2`

---

## Current handoff: SanDeal M3.1.1

### Task

SanDeal M3.1.1 - Asynchronous Projection Repair and Product Flow Recovery

### Repository and recovery state

- Branch: `master`
- Baseline and current HEAD: `5386e7818869a9dcf21b3e1330af71a2a19a5219`
- The interrupted worktree was preserved. The only pre-existing partial edit was `src/lib/automation/jobHealthSummary.ts` (35 insertions and 2 deletions); the backup patch was not applied.
- The recovered partial edit had started canonical serialization, a deterministic revision hash, a stable projection name, and previous-valid timestamp retention. It had not yet connected asynchronous scheduling, Worker execution, staged validation/activation, product-flow recovery, UI states, or M3.1.1 tests.
- No unrelated change, baseline drift, secret, or production dependency was found.
- No commit, push, deployment, VPS/PM2 access, production data/configuration change, mode activation, destructive Git action, or backup operation was performed.

### Confirmed root causes

1. `projection_maintenance` was a mutating component behind a one-second `Promise.race`. When it timed out, `ensureJobHealthProjectionMaintenanceRequest()` could continue enqueuing after the HTTP component had returned. The reported 1.1-1.6 second production duration is consistent with that boundary plus storage work.
2. Maintenance enqueue used the generic durable automation-job transaction, which can scan/write job state. It was therefore unsafe to abandon through an interactive timeout even though the actual projection rebuild already belonged in the Worker.
3. App Health and product-flow diagnostics independently loaded compact job projections instead of sharing one request-scoped projection-status result.
4. Manifest revision/source hashing used non-canonical JSON serialization and identity-only projection fingerprints. Object-key order could produce unstable hashes, while semantically changed compact records could retain the same identity fingerprint. The old schema also lacked full-content parity checks.
5. Worker repair bookkeeping could report success before the fenced durable completion committed, and maintenance shared the broad storage-exclusive class with Runtime Guardian.

### Completed implementation

#### Interactive App Health

- Projection inspection is bounded to summary, manifest, and compact projection metadata/content. It never reads complete durable job history and never rebuilds a projection in the request.
- Public projection states are `VALID`, `STALE`, `INVALID`, `REBUILD_SCHEDULED`, `REBUILD_RUNNING`, `REBUILD_FAILED`, and `UNKNOWN`.
- Invalid or rebuilding state remains fail-closed while retaining the previous valid bounded summary for context; it cannot be reported as PASS.
- The mutating enqueue check is awaited and is no longer wrapped in an abandoning timeout. Request abort is honored before supported work begins; no non-abortable rebuild is started by HTTP.
- One request-scoped projection status is passed to product-flow diagnostics. Web, Worker, Scheduler, lease, release, and control components remain independent.

#### Deduplicated maintenance lifecycle

- One `RECONCILE_AUTOMATION` maintenance workflow uses projection name `automation-job-health` and one stable incident idempotency key.
- Existing `REQUESTED`, `CLAIMED`, `RUNNING`, or retry-scheduled work is reused; repeated App Health refreshes do not enqueue another repair.
- Repair state is recorded as scheduled, running, retry-scheduled, succeeded, failed, or exhausted with bounded safe reason codes, duration, source revision, and result revision/fingerprint.
- The Worker performs the rebuild outside HTTP. Success is recorded only after fenced job completion commits. Failure follows the durable retry state and bookkeeping errors do not crash the Worker.
- Projection maintenance has its own concurrency resource. Two repairs conflict with each other, while Runtime Guardian keeps its reserved capacity and is not starved by a repair.

#### Candidate validation and activation

- A replacement is built and written as a separate staged candidate.
- Before activation, validation checks schema/projection version, projection name, source snapshot fingerprint/revision, record and active counts, completeness, capacity, observed range, timestamps, item schemas, unique IDs, identity fingerprints, full-content fingerprints, combined fingerprint, and candidate fingerprint.
- The durable source is checked before live writes and again before manifest activation.
- The manifest is the atomic reader-visible activation boundary: readers reject the rebuild token/partial state, and the new manifest is published only after both compact projections verify.
- Validation or write failure restores the previous projections and previous valid manifest. A failed candidate cannot replace a valid projection.

#### Deterministic manifest semantics

- Manifest schema is now version 2.
- Canonical serialization recursively sorts keys and normalizes `undefined`, non-finite numbers, and `Date` values.
- Full-content fingerprints complement identity fingerprints. Volatile top-level heartbeat/lease timestamps are normalized out so routine heartbeats do not trigger repairs.
- File and Mongo adapters use the same serialized manifest contract and fingerprint semantics. Genuine content mismatch remains invalid.

#### Product flow and dashboard

- Authoritative product/candidate counts remain available without a valid job projection.
- Projection-dependent job fields are `null`/unknown when evidence is incomplete; known zero is preserved, stale bounded data is labelled stale, and current valid data remains authoritative.
- Product flow does not schedule or rebuild independently and recovers automatically on the next request after a valid manifest becomes active.
- The App Health dashboard labels scheduled, running, retry-scheduled, failed, and succeeded repair states in valid UTF-8 Vietnamese, preserves the last valid snapshot, and suppresses duplicate refreshes while one request is active.
- No raw errors, stack traces, filesystem paths, credentials, blocking modal, forced publication, or false completion state was added.

### Files changed by subsystem

#### Projection contract, validation, and storage

- `src/lib/automation/jobHealthSummary.ts`
- `src/lib/automation/projectionMaintenance.ts`
- `src/lib/automation/store.ts`

#### Interactive diagnostics and UI

- `src/lib/automation/healthService.ts`
- `src/lib/automation/productFlowDiagnostics.ts`
- `src/app/api/automation/health/route.ts`
- `src/app/dashboard/app-health/page.tsx`

#### Worker and capacity safety

- `src/lib/automation/worker.ts`
- `src/lib/automation/executionPolicy.ts`

#### Tests and handoff

- `scripts/m3-1-1-projection-repair-tests.cjs` (new)
- `docs/AI_WORK_HANDOFF.md`
- `package.json`: unchanged
- `package-lock.json`: unchanged

### Validation results

Final non-overlapping inventory: **347 assertions passed, 0 failed**. One production-connected suite was intentionally skipped.

| Command | Result |
| --- | --- |
| `git diff --check` | PASS |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS; 0 errors and 10 pre-existing warnings |
| `node scripts/m3-1-1-projection-repair-tests.cjs` | 11 PASS, 0 FAIL |
| `node scripts/bounded-projection-storage-tests.cjs` | 13 PASS, 0 FAIL |
| `node scripts/post-m3-reconciliation-product-flow-tests.cjs` | 38 PASS, 0 FAIL |
| `node scripts/automation-health-reliability-tests.cjs` | 12 PASS, 0 FAIL |
| `npm run test:master:m1` | 99 PASS, 0 FAIL |
| `node scripts/master-m2-worker-pool-tests.cjs` | 16 PASS, 0 FAIL |
| `npm run test:master:m2:slo` | 12 PASS, 0 FAIL |
| `node scripts/master-m2-operational-health-tests.cjs` | 3 PASS, 0 FAIL |
| `npm run test:master:m3` | 39 PASS, 0 FAIL |
| `npm run test:storage` | 15 PASS, 0 FAIL |
| `npm run test:storage:mongo` | 28 PASS, 0 FAIL; fake/local adapter only |
| `npm run test:storage:migration` | 39 PASS, 0 FAIL |
| `npm run test:prompt10:job-schema` | 10 PASS, 0 FAIL |
| `npm run test:prompt10:orchestration` | 12 PASS, 0 FAIL |
| `npm run test:storage:acceptance` | SKIP: it requires explicit production Mongo opt-in/access, prohibited by this task |
| `npm run build` | PASS on Next.js 16.2.11 |

### Performance measurements

- Invalid projection status: **3.3 ms**, with **0** complete durable job-history reads (target below 500 ms).
- App Health production-sized fixture: 13,000 jobs and 500 runtime snapshots; **177.5 ms cold**, **174.1 ms warm**, **0** durable job-history reads and **0** permit-history reads (targets below 5 s cold and 3 s warm).
- Product-flow fixture: 1,000 products and 2,000 candidates; **25.4 ms** (target below 3 s).
- Worker fixture: 13,000 pending jobs, bounded ordinary capacity 3 plus one Guardian reservation; fixture setup **1495 ms**, pickup **400 ms**.
- Memory was not separately profiled. Bounded input/output assertions and the no-full-history checks passed.

### Build result

- Optimized build: PASS; compilation 4.6 seconds, TypeScript 11.4 seconds, static generation 43/43 pages.
- Existing warnings remain: npm's `min-release-age` config deprecation notice and Turbopack's broad NFT trace through `next.config.ts` / `src/lib/autonomous/backupManager.ts`.

### Safety invariants and remaining risks

- Claim tokens, leases, fencing, heartbeat, retry scheduling, stable idempotency, role ownership, bounded capacity, Runtime Guardian reservation, and fail-closed projection validation remain enforced.
- Worker Pool remains OFF. CANARY/ACTIVE and publication state were not enabled, and no product was forced public.
- Manifest v2 deliberately causes an old v1 manifest to schedule one repair; the existing Worker must run for recovery to complete.
- Storage transactions are not cancellable once committed work begins, so the request prevents abandonment instead of pretending cancellation. The projection rebuild itself never runs in HTTP.
- Activation is atomic at the manifest boundary. During a staged swap readers fail closed; an ordinary failure restores prior data. A catastrophic storage outage during rollback can leave the projection invalid, but cannot make a partial projection valid.
- Production/VPS and a real Mongo acceptance environment were not accessed, so live repair latency and post-deployment recovery remain unverified.
- No full repository test suite was run; validation was intentionally limited to the required M3/M3.1/M3.1.1, Runtime Guardian, Worker, storage, and production-sized focused gates.

### Recommended commit and classification

- Recommended commit: `fix: make projection repair asynchronous and bounded`
- Classification: `SAFE_TO_COMMIT`

---

## Previous handoff: SanDeal M3.1 (retained for context)

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
