# SanDeal controlled autonomous runtime

## Safety boundary

This runbook documents a future human-approved deployment. It does not authorize deployment. Never use production data, credentials, PM2, or publishing while following it in a local verification session.

`ecosystem.config.cjs` starts only the web process by default. Worker and scheduler are included only when the deployment environment explicitly sets:

```text
SANDEAL_ENABLE_PROMPT10_RUNTIME=true
```

Do not edit the ecosystem file to make this the default and do not run `pm2 save` until a controlled production rollout is approved and verified.

## Required control state

The first runtime rollout must use SHADOW with `publishPaused=true`, `launchEnabled=false`, `killSwitch=false`, and paid/external publishing disabled. Ingestion, candidate creation, worker classification/normalization/validation, duplicate detection, and publish evaluation may run; no public side effect may occur.

Publishing is allowed only when all independent gates agree: effective mode is CANARY or AUTONOMOUS, `publishPaused=false`, `launchEnabled=true`, `killSwitch=false`, policy/evidence is eligible, and the action is claimed by the durable worker under the current job contract. Client-supplied eligibility is never authority.

## Controlled sequence

1. Record branch, commit SHA, working-tree state, Node/npm versions, artifact checksum, and manifest checksum.
2. Run the complete quality matrix and strict preflight from `PRODUCTION_RELEASE_RUNBOOK.md`.
3. Pause scheduling/claims, create a backup, verify its size is greater than zero, and restore it into an empty test directory.
4. Deploy one web process only. Verify public routes, admin denial/authorization, health endpoints, empty/degraded states, desktop/mobile layout, console, and network.
5. With separate approval, enable exactly one worker and one scheduler against the shared durable data directory. Keep SHADOW and publishing paused.
6. Confirm the dashboard distinguishes process online from active lease role. Verify leader owner, heartbeat, lease expiry, last successful tick, next run, rejected contenders, queue depth, terminal failures, and schema/policy/handler versions.
7. Run a bounded mock/source dry run. Confirm candidates and drafts update but public product count does not change.
8. Consider CANARY only after stable SHADOW evidence and a verified pre-CANARY snapshot. Consider AUTONOMOUS only in a later approval window.

## Stop and rollback triggers

Enable Emergency Stop or pause the relevant subsystem when a lease is stale, duplicate side effect appears, job contracts are blocked unexpectedly, queue/failure rate grows, source/provider state is falsely reported, storage is degraded, public data is incorrect, or any secret is exposed. `publishPaused`, `launchEnabled=false`, and `killSwitch=true` are independent fail-closed controls.

Stop scheduler before worker during rollback, allow in-flight work to reach a safe boundary, retain the durable data directory, and follow `ROLLBACK_RUNBOOK.md`. Never use `git reset` or delete job/storage files as a rollback mechanism.

## M3.1.5 file-runtime stability addendum

This addendum documents the lock, lease, and rollout rules for the file-backed Worker/Scheduler runtime. It does not authorize deployment or process control.

### Lock ownership and ordering

- Role acquisition/takeover first uses the short `runtime-role-fencing` record and then the short `runtime-role-leases` mutation.
- A long handler never owns the role-lease collection lock. The process-level role heartbeat is independent of the Worker cycle and Scheduler tick; it is bounded, single-flight, and stopped after fencing loss.
- The primary `automation-jobs` lock covers only bounded selection/planning, streaming mutation, and the atomic file revision. Provider/network calls, handler execution, projection calculation/sync, audit, and sleeps happen outside it.
- Final job state transitions revalidate role owner, job lease/claim token, Worker fencing token, and release identity immediately before atomic promotion. A separate renewable role fence prevents a role takeover from racing that final promotion.
- Projection/audit/control follow-up writes occur after the job-source lock. The consistent order is role fence → short role lease or job-source mutation → follow-up projections/audit; no reverse nested lock is permitted.

### File lock recovery

The lock metadata records host, PID, process start, creation, heartbeat, expiry, and token. A live same-host PID is never stolen. A conclusively gone same-host PID may be recovered before lease expiry. An unverifiable or different-host owner requires lease expiry. Recovery and all lock release paths are audited and run in cleanup/finally paths. A timeout is `STORAGE_LOCK_TIMEOUT`, not a provider failure.

### Retry and degraded behavior

Storage lock contention and role-fence acquisition timeout use finite exponential backoff with jitter and a separate infrastructure deferral counter; they do not consume another business attempt. Five exhausted infrastructure deferrals pause the job with `STORAGE_ERROR:INFRASTRUCTURE_RETRY_BUDGET_EXHAUSTED`. Fencing loss is explicit and cancels stale completion. Manual, unknown, permanent, policy, operator-review, evidence, and publication blockers remain fail-closed. Automation must not force publication or automatically stop PM2.

### Documented rollout sequence

1. Keep Scheduler stopped and deploy the exact full release SHA through the guarded deployment script.
2. Verify immutable build/release identity, then start Worker only.
3. Observe Worker for at least 15 minutes. Require stable PID, fresh ACTIVE role lease, no repeated lock timeout, no `WORKER_FENCING_REJECTED`, no role-loss restart, no internally caused `LEASE_EXPIRED_MAX_ATTEMPTS`, safe RSS/swap, and bounded cycle/lock metrics.
4. Start Scheduler only after Worker passes those gates. Observe one tick at a time and require no duplicate scheduling, repair, recheck, scoring, price-history, or publication effect.
5. Save PM2 state only after every acceptance gate passes.

Immediate stop conditions: PID churn; stale or mismatched release identity; repeated lock timeout; recovery of a live lock; fencing rejection; duplicate durable effect; sustained memory/swap pressure; App Health timeout; or publication without complete current evidence. Roll back through the previously verified full SHA, stopping Scheduler before Worker and preserving all durable history, leases, snapshots, projections, backups, and audit evidence.

### Local acceptance evidence

The sequential 13,000-job fixture measured 55.7 MB (`58,453,671` bytes) durable job storage, Worker 20.842 s / 82 complete durable reads / 6.009 s maximum lock hold, Scheduler 5.800 s cold and 3.344 s warm with zero complete `automation-jobs` reads, repair 22.681 s cold, 25.473 s warm, 29.198 s incremental, and 1.692 s maximum catch-up lock hold, and peak RSS 497.9 MB. Critical pickup latency was 38.048 s in this run. The production observation supplied for comparison was 136 complete reads, 30.697 s maximum lock hold, and 397 MB RSS. Local figures are not a production claim; VPS observation remains a mandatory rollout gate, including the existing critical-pickup SLO.

The completed local validation included M3.1.5 stability (11/11), the sequential performance fixture, M3.1.4 (12/12), M3.1.3 recovery/live-health gates, M3.1.2 and M3.1.1 projection tests, file/fake-Mongo/migration/storage acceptance tests, Worker/Scheduler/automation-health/product/publication safety suites, resilience (11/11), backup/recovery (7/7), `npm test`, typecheck, lint, secret scan, diff check, and build. Real provider calls, production/VPS/PM2 verification, and real isolated Mongo acceptance were not run because they are prohibited or no isolated non-production configuration exists. These omissions remain external rollout gates, not successful production observations.

## Product-First AccessTrade rollout addendum

This addendum is an operator checklist, not authorization to access production.

### Retrieval contract

- Keyword matching is local because AccessTrade datafeeds do not provide a reliable keyword query.
- The default and hard scan bounds are sequential pages `5`, page size `200`, raw items `1,000`; default wall budget is 35 seconds and hard wall ceiling is 40 seconds.
- A provider `total` is advisory unless it is greater than one full page, stable across observations, all pages contribute unique items, and cumulative unique identities equal it. `total=200` on a full 200-record page must not stop page 2.
- Safe terminal reasons are `TARGET_MATCH_COUNT_REACHED`, `EMPTY_PAGE`, `SHORT_PAGE`, `TRUSTED_PROVIDER_TOTAL_EXHAUSTED`, `REPEATED_PAGE`, `NO_NEW_UNIQUE_RECORDS`, `MAX_PAGES_REACHED`, `RAW_ITEM_BUDGET_REACHED`, `TIME_BUDGET_EXCEEDED`, `REQUEST_ABORTED`, and `PROVIDER_ERROR`.
- `EMPTY_PAGE`, `SHORT_PAGE`, and trusted-total exhaustion are end-of-data evidence. Maximum pages/raw/time are safety boundaries, not proof that the provider has no match. Repeated/no-new pages indicate ignored or broken pagination.

### Preparation versus publication

Runtime Guardian may block final publication without blocking safe ingestion, exact-identity deduplication, URL/affiliate/image health checks, price truth, evidence capture, scoring, review preparation, or publication-readiness evaluation. A source reappearance is never permission to unarchive, clear quarantine, approve review, or publish. Verified recovery is revision-fenced and audit-preserving; stale repairs fail closed.

The continuous Worker pool uses the existing configured maximum and the launcher hard ceiling of four. When concurrency permits, one lane remains reserved for Guardian and non-Guardian capacity can advance product preparation. Duplicate active Guardian jobs coalesce. `WORKER_CONTINUOUS_POOL_V2=OFF` is the non-destructive runtime rollback control for the pool path; it does not roll back data or delete jobs.

### Later production verification

1. Deploy only through the normal guarded release workflow and record exact release/build identity. Do not modify `.data` manually.
2. Confirm one current Worker and Scheduler lease owner, fencing token, heartbeat, configured concurrency, and no stale job claims before enabling scheduling.
3. Keep publication paused. Run one operator-approved bounded keyword search and verify sequential page requests, application result cap, unique/duplicate counts, per-page advisory totals, stop reason, elapsed time, and no credential material in diagnostics.
4. Confirm a full unrelated page 1 no longer proves an empty result. If later pages contain relevant products, verify they enter candidate processing exactly once and remain hidden.
5. Observe RSS, swap, request latency, timeouts, queue depth, Guardian coalescing, product-critical pickup, retry counts, and fencing events on the 1-vCPU/2-GB file-backed host.
6. For an exact existing provider identity, verify stronger evidence creates a repair audit and recalculates health/readiness while archive, merchant quarantine, and unapproved review state remain unchanged.
7. Confirm Runtime Guardian still blocks final publication and no public count changes. Publication requires a separate authorized rollout with every existing gate green.

Rollback or stop immediately for repeated-page loops not reflected in diagnostics, more than five pages/1,000 raw items, uncontrolled concurrency, sustained swap pressure, duplicate jobs/products, stale-revision overwrite, missing repair audit, cleared quarantine/review state, secret exposure, fencing rejection, or any unexpected public mutation. Preserve all products, jobs, snapshots, projections, audits, backups, leases, and runtime history during rollback.
