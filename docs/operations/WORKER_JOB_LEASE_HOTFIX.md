# Worker job lease hotfix

## Authority model

The `WORKER` runtime role lease and an automation-job claim lease are separate
authorities. The role lease elects one Worker process and carries its fencing
token. A job claim authorizes that process instance to execute one specific
`RUNNING` job using the job ID, claim token, owner ID, instance ID, fencing
token, attempt number, and release identity.

A process must hold both authorities. A role heartbeat never renews a job
claim, and a current job claim never substitutes for a lost Worker role.

## Renewal and recovery behavior

- Every claim starts an independent renewal lifecycle as soon as the batch is
  claimed, including work waiting behind a sequential handler.
- The renewal interval is derived from the effective claim lease (about one
  third, bounded below the lease). Renewal attempts never overlap.
- One transient storage failure receives a delayed retry. A second failure, an
  unsafe remaining lease window, role loss, claim mismatch, or fencing mismatch
  aborts local authority.
- Expired-job recovery revalidates and invalidates the heartbeat claim at the
  durable job commit boundary. A renewal that won the race cancels recovery;
  an expired heartbeat is removed before the old worker can renew again.
- Completion and failure retain the existing atomic claim guard and runtime
  role fence. Renewal is stopped and joined before intentional claim removal.
- Shutdown stops claims, propagates `WORKER_SHUTDOWN_REQUESTED` to handlers,
  stops renewal timers, drains for the configured bound, and leaves unfinished
  claims for normal lease-expiry recovery.

## Structured events

The Worker emits bounded, sanitized lifecycle events including:

- `job_lease_renewal_started`
- `job_lease_renewed` (rate limited)
- `job_lease_renewal_failed`
- `job_ownership_lost`
- `job_handler_aborted`
- `stale_completion_rejected`
- `expired_job_safely_recovered`
- `worker_retry_backoff_applied`
- `worker_shutdown_drain_started`
- `worker_shutdown_drain_completed`

No event includes claim tokens, credentials, provider payloads, or product
records.

## Safe later rollout order

Do not deploy from this coding task. After review and approval, the safe order
is: commit and push; pull and build the web release; start the Worker only;
monitor role and job lease renewals, CPU, memory, lock timeouts, and job
completion; start the Scheduler only after Worker stability is proven; then run
the repository's release, process, runtime, and health verification.

Runtime Guardian, quarantine, evidence, review, URL, image, price, affiliate,
and Safe Publish gates remain unchanged and fail closed.
