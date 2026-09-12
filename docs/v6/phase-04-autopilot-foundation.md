# Phase 4.5 — local event-driven autopilot foundation

Closed locally on 2026-09-11, branch `master`, HEAD `3f2ee7d8bd1ef57fa9207f021cc03519b7eecde7`.
Phase 4 remains formally PASS. The existing dirty worktree is preserved. This closure changes documentation and generated evidence only; it does not change runtime source, tests, migration code, or deployment configuration.

```text
RESUME_PHASE4_5=COMPLETE
PHASE4=PASS_REUSED
PHASE4_5=PASS
FIRST_UNVERIFIED_STEP=RERUN_INVALIDATED_CRON_QUEUE_EVIDENCE_THEN_AFFECTED_D1_AND_QUALITY_GATES
SCHEDULER_ADAPTER=cloudflare-indexed-cron
QUEUE_ADAPTER=cloudflare-d1-outbox-queue
CRON_MODEL=BOUNDED_EVENT_HANDLER_EVERY_5_MINUTES_LOCAL_CONFIG
DUE_TASK_QUERY=scheduled_tasks_due_INDEX_ENABLED_NEXT_RUN_AT_ID_LIMIT_10
JOB_MESSAGE_SCHEMA=jobId,jobType,idempotencyKey,attempt,createdAt,payloadVersion
JOB_STATE_MODEL=PENDING,RUNNING,RETRY_SCHEDULED,SUCCEEDED,FAILED,BLOCKED
IDEMPOTENCY=DETERMINISTIC_JOB_ID_TASK_CAS_CLAIM_TOKEN_ATOMIC_D1_DOMAIN_AND_TERMINAL_COMMIT
RETRY_MODEL=RETRYABLE_FINAL_QUARANTINE
MAX_RETRY_BEHAVIOR=3_BUSINESS_ATTEMPTS_5_OUTBOX_DISPATCHES_3_TRANSPORT_RETRIES_PER_ENQUEUE_24H_JOB_LIFETIME
POISON_MESSAGE_BEHAVIOR=DURABLE_SANITIZED_QUARANTINE_THEN_ACK_NO_DOMAIN_EFFECT
UNKNOWN_JOB_BEHAVIOR=QUARANTINE_THEN_ACK_NO_EXECUTION
CRON=PASS
QUEUE=PASS
D1=PASS
LOCAL_CRON_TEST=PASS
LOCAL_QUEUE_TEST=PASS
LOCAL_AUTOPILOT=PASS
JOB_STATE=SUCCEEDED
DUPLICATE_CRON=SAFE_ONE_JOB_ONE_SCHEDULED_EFFECT
DUPLICATE_DELIVERY=SAFE
DUPLICATE_DOMAIN_EFFECT=0
DUE_TASK_FULL_SCAN=NO
JOB_FULL_SCAN=NO
HEARTBEAT_WRITES=0
CONTINUOUS_POLLING=NO
BOUNDED_CRON_BATCH=YES
BOUNDED_QUEUE_BATCH=YES
FILE_STORAGE_CALLS=0
FILESYSTEM_SETTINGS_CALLS=0
PM2_REQUIRED=NO
VPS_REQUIRED=NO
LONG_RUNNING_PROCESS_REQUIRED=NO
LEGACY_WORKER_PRESERVED=YES
LEGACY_SCHEDULER_PRESERVED=YES
LEGACY_QUEUE_SCHEDULER_IMPLEMENTATION_PRESERVED=YES
LEGACY_PM2_CONFIGURATION_PRESERVED=YES
PRODUCTION_QUEUE_CREATED=NO
PRODUCTION_CRON_CREATED=NO
PRODUCTION_WORKER_CREATED=NO
PRODUCTION_RESOURCE_CREATED=NO
CLOUDFLARE_LOGIN_USED=NO
DEPLOYED=NO
TEST_CASES_SKIPPED=0
ASSERTIONS_WEAKENED=NO
SAFETY_GATES_RELAXED=NO
NEW_TEST_CASES_PASSED=32
NEW_TEST_CASES_FAILED=0
TESTS_PASSED=108
TESTS_FAILED=0
TYPESCRIPT=PASS
ESLINT=PASS_0_ERRORS_34_EXISTING_WARNINGS
SECRET_SCAN=PASS
BUILD_LEGACY=PASS_VALIDATION_ONLY
BUILD_CLOUDFLARE=PASS_STATIC_AND_WORKER
RESULT=PASS
SAFE_FOR_NEXT_PHASE=YES
BLOCKERS=NONE
NEXT_RECOMMENDED_PHASE=PHASE_5_ONLY_AFTER_SEPARATE_AUTHORIZATION
```

## Reconstruction and evidence reuse

The requested branch, HEAD, status and diff-stat inspection confirmed the same branch and HEAD, with the prior worktree retained. This checkpoint did not exist. LONG_RUN_STATE still reported an in-progress validation even though the four-case native autopilot suite and its smoke proof had completed successfully.

The entire source/test/config fingerprint matched the native autopilot evidence: `3c0d42a49c2cc8c03be160dff3a6ae75286019e5b1d884fd605e8912cee20bc3`. There were no new source files absent from that manifest. Its saved log was read and its four PASS results reused. The older Cron/Queue evidence had different hashes for `src/lib/platform/cloudflareAdapters.ts`, the Cron test and package scripts. Those two suites were rerun. The affected D1 suite was also rerun because its test file and additive event schema postdated Phase 4 evidence.

The first unverified step was immediately recorded in LONG_RUN_STATE. Phase 3 and 3.5 migration suites and Phase 4 routing suites were not restarted. The critical legacy scheduler, worker/scheduler contract, rollout and zero-filesystem checks retain valid evidence: their implementations and test files are unchanged. The historical manifest differences are two other test scripts, Cloudflare-only context, and compile-time adapter generic types. The current TypeScript check validates those types. The reuse decisions and file hashes are persisted in `docs/v6/evidence/phase45-resume-audit.json`.

## Event contract and bounded queries

`cloudflare/worker.ts` exposes `scheduled` and `queue` handlers alongside the existing fetch handler. The scheduled handler constructs `createCloudflareSchedulerAdapter(env)` and returns after its tick. The consumer constructs its D1 context from explicit bindings. The shared legacy factory remains fail-closed for unsupported binding-free Cloudflare selection; event handlers use the binding-aware Cloudflare constructors.

The complete flow is Cron tick → due-task range → deterministic persisted job and task advancement → outbox reservation → Queue send → conditional claim → price-history domain operation → atomic domain/job completion → acknowledgement and return.

The due-task SQL is `SELECT * FROM scheduled_tasks WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at,id LIMIT ?`, with limit 10 and index `scheduled_tasks_due(enabled,next_run_at,id)`. The outbox uses `dispatch_pending=1 AND dispatch_at<=? ORDER BY dispatch_at,id LIMIT ?`, also limit 10, with `automation_jobs_dispatch_due(dispatch_pending,dispatch_at,id)`. EXPLAIN tests require indexed SEARCH and reject table SCAN for both queries. Job reads and transitions use the primary key; price-history access uses a product/time indexed range limited to one adjacent observation. Test-only COUNT queries measure effects and are not runtime scheduling queries.

An idle tick executes exactly two SELECTs and no writes. There is no heartbeat table or heartbeat update, per-second scheduling write, `while(true)`, interval timer, continuous polling, process lease daemon, PM2 or VPS requirement in the event implementation. Missed intervals advance directly to the next future time without a catch-up loop. The local config is a five-minute Cron and Queue batches of at most 10; handlers additionally enforce their bounds. These are architecture properties, not a forecast of Cloudflare charges.

## Idempotency and durable state

The Cron key is `cron:<task-id>:<scheduled-due-time>`. Its SHA-256 produces the stable `cf-...` job ID. The unique idempotency key, task revision/next-run conditional update and atomic D1 materialization prevent sequential or concurrent duplicate ticks from creating additional jobs. A dispatch reservation also prevents concurrent enqueue amplification. Queue outage recovery deliberately permits bounded redelivery of the same durable job.

The message contains only the six listed reference fields; no arbitrary business payload, URL, credentials or settings travel in it. Payload version is 1, supported job type is only `CAPTURE_PRICE_HISTORY`, and the serialized message is capped at 1,024 bytes. The stored payload accepts only a validated product ID. Message references must agree with the durable job before execution.

States reuse `AutomationJobStatus`: PENDING → RUNNING → SUCCEEDED, or RETRY_SCHEDULED before another RUNNING attempt. FAILED and BLOCKED are also terminal. They are checked in D1 before acknowledging a replay. A random claim token and 60-second expiry fence commits; takeover changes the token. The price-history insert and SUCCEEDED update occur in the same D1 batch under that token and expiry condition. A rollback cannot leave the effect without its completion record. An unchanged adjacent observation is an explicit successful no-op with `snapshotCreated:false`, not a claimed new observation.

The exact-message Queue test calls `f.message(job)` repeatedly using the same original job object: the job ID, idempotency key, attempt, creation time, version and type remain identical, including simultaneous delivery. It asserts exactly one observation and one attempt. The native workerd smoke separately proves native Cron → emulated Queue → D1 SUCCEEDED and completed-job replay acknowledgement. No different job ID substitutes for the duplicate-delivery check.

One additional complete local proof captures the actual body emitted by `cloudflareScheduled` into the fixture Queue binding, invokes the same Cron tick twice, and passes the very same delivery object through `cloudflareQueue` twice against real local D1. It verifies one enqueue, one deterministic job, initial PENDING, first delivery SUCCEEDED with exactly one observation, two acknowledgements in total, zero retries, byte-identical and object-identical message bodies, and a final attempt count of one. The reproducible `node -e` command source and successful exit are saved in `docs/v6/evidence/phase45-exact-message-smoke.json`; its log is `.test-tmp/phase45-exact-message-smoke.log`.

## Crash windows and retry disposition

| Window or input | Verified result |
| --- | --- |
| Failure before domain commit | Zero observations, RETRY_SCHEDULED, later success with exactly one observation |
| Failure between history insert and completion | D1 abort trigger rolls back the whole batch; retry creates one observation |
| Crash after commit before acknowledgement | SUCCEEDED remains durable; replay acknowledges with no second observation, even after product changes |
| Consumer loss with active claim | Delivery defers; expired claim can be taken over without heartbeat |
| Stale claim after takeover | Old token cannot commit; current token commits exactly one observation |
| D1 unavailable | No acknowledgement or filesystem fallback; bounded transport retry, no private error logging |
| Unknown job type / forged reference | Sanitized quarantine, acknowledgement, no domain mutation |
| Malformed / oversized / secret-bearing payload | Quarantine stores only delivery hash, reason code and time; no raw body |
| Retryable provider failure | Three durable business attempts maximum; then FAILED with no effect |
| Missing product / final validation failure | FAILED and acknowledged without business retry |
| Expired job | BLOCKED; no stale business effect |
| Queue send failure / materialization-send crash | Indexed durable outbox recovers without creating another job |
| Repeated Queue send failure | Five dispatch reservations maximum; then durable FAILED |

RETRYABLE business failures use 30- then 60-second backoff under the three-attempt cap. FINAL errors become FAILED. QUARANTINE input errors are recorded before acknowledgement; a quarantined in-execution job becomes BLOCKED. A forged/unsupported envelope does not rewrite a legitimate referenced job. Unknown persisted job types are also excluded by the D1 schema.

Transport retries are separately capped at three per enqueue by both local Wrangler configuration and the emulator. A dependency outage can exhaust transport retries while D1 is unavailable; this is not reported as job success. The existing outbox permits later bounded recovery after D1 returns. Five dispatch reservations and a 24-hour job lifetime prevent perpetual job retry. No production Queue or dead-letter resource is provisioned or claimed by this local proof.

## Local proof and legacy preservation

The saved native smoke uses real local workerd/Miniflare and ephemeral D1. It creates a due task, invokes Cron, allows the emulated Queue to deliver, observes one successful claimed job and one price observation, invokes the same Cron tick again, then delivers the completed job reference again and checks explicit acknowledgement with no retry or additional domain effect. Its bounded eight-second test observation loop is confined to test code.

The bundled runtime dependency proof excludes FileStorage, Mongo, filesystem settings, and both legacy entrypoints. Its only external imports are `node:async_hooks` and `node:crypto`. The reused nine-case zero-VPS suite additionally measures zero FileStorage and filesystem calls with throwing spies around representative D1 domain/settings operations. Build tools and local emulators use the filesystem; the event runtime has no persistent-filesystem or long-running SanDeal process requirement.

`scripts/automation-worker.cjs`, `scripts/automation-scheduler.cjs`, `ecosystem.config.cjs`, `src/lib/platform/legacyAdapters.ts`, `src/lib/automation/store.ts` and `src/lib/automation/scheduler.ts` remain present as rollback/reference paths. The legacy build ran with the established validation-only dirty-worktree mode and isolated fixture data.

## Validation ledger

| Validation | Passed | Failed | Disposition |
| --- | ---: | ---: | --- |
| Phase 4.5 Cron | 10 | 0 | Rerun, current adapter/test hashes |
| Phase 4.5 Queue | 17 | 0 | Rerun, current adapter hashes |
| Native local autopilot smoke | 4 | 0 | Reused, complete source/test/config hash match |
| Exact captured-message complete local flow | 1 | 0 | Executed; same captured delivery object twice |
| Affected D1 | 25 | 0 | Rerun, includes additive event-schema expectations |
| Critical scheduler incumbent | 1 | 0 | Reused, implementation/test unchanged |
| Critical scheduler role/heartbeat | 3 | 0 | Reused, implementation/test unchanged |
| Worker/scheduler runtime contracts | 18 | 0 | Reused, implementation/test unchanged |
| Critical rollout / stabilization | 20 | 0 | Reused, implementation/test unchanged |
| D1 zero-filesystem regression | 9 | 0 | Reused, implementation/test unchanged |
| Total | 108 | 0 | 53 executed, 55 reused |

The 32 Phase 4.5 cases are 10 Cron + 17 Queue + 4 native autopilot + 1 exact captured-message complete-flow proof; the other 76 are affected/critical regressions. Counts describe verified cases. The supplemental proof uses the existing fixture and handlers without editing source or test files.

Current Cron/Queue/D1 logs and command exits: `.test-tmp/v6-resume-3-YlQfgA/results.json`. Native smoke: `.test-tmp/v6-resume-3-1m9xr8/v6-cloudflare-autopilot.log`. Reused critical regression logs: `.test-tmp/v6-resume-3-SnTU7e/`. Per-suite manifests are in `docs/v6/evidence/`.

Current TypeScript, ESLint, secret scan, legacy build and Worker build all exit 0; logs are in `.test-tmp/v6-runtime-quality-y4p87q/`. Static export also exits 0 and generates 10 static pages; its log is `.test-tmp/phase45-static-build.log`. ESLint retains 34 pre-existing warnings (14 source/test and 20 generated Worker), zero errors. The legacy build retains its pre-existing Turbopack tracing warning. Neither warning class was suppressed to pass this phase.

The secret scan is repeated after writing the checkpoint and supplementary proof; its final log is `.test-tmp/phase45-final-secret-scan.log` and its exit record is included in the final validation evidence.

The three Phase 4.5 suites and their fixture helper contain no `.skip`, `.only`, `fit` or `fdescribe`. Assertion failures increment failure counts and cause nonzero exit. Exact duplicate counts, attempt/dispatch limits, workload bounds and crash assertions remain intact; no tests or safety gates were edited during closure.

Phase 4.5 is PASS for the local foundation. Stop here. Phase 5, Affiliate Money Engine and AI Bot work were not started. No commit, push, Cloudflare login, production resource, deployment or DNS change occurred. A future phase requires a separate user instruction; this PASS is not production rollout approval.
