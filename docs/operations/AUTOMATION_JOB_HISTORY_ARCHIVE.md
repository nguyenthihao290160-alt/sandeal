# Automation job active/history storage

## Purpose and authority boundary

FileStorage previously kept active and terminal automation jobs in one
`automation-jobs.json` array. A real claim or expired-lease recovery therefore
parsed and rewrote retained terminal history even when only one runnable job
changed. The Worker now treats that file as the active/recoverable source and
stores terminal history in bounded, immutable archive segments.

This document is a guarded runbook, not deployment authorization. Do not run a
production migration, restart a process, or change `.data` without separate
operator approval. FileStorage remains the production driver.

## Storage layout

- `automation-jobs` contains runnable, running, waiting, paused, retryable, and
  workflow-protected records. Claim, renewal, recovery, completion, and failure
  never scan history segments.
- `automation-job-history-v1-00` through
  `automation-job-history-v1-7f` are stable SHA-256-sharded history segments.
  Each segment is capped at 1,024 immutable versions and 16 MiB.
- `automation-job-history-manifest-v1` contains bounded segment counts, status
  counts, and content fingerprints. It never contains full jobs.
- `automation-job-history-idempotency-v1-*` is a bounded lookup index for
  successful-job idempotency reuse. Enqueue reads one deterministic index
  shard; it does not scan all history.
- Existing status and compact-list projections remain the bounded dashboard
  read model. Terminal projections are not deleted when a source record moves.

The archive record includes the complete durable terminal job, its stable
fingerprint, archive timestamp, operation and job identifiers, results,
sanitized errors, attempts, release/worker evidence still present in the
terminal source, checkpoints, and audit references.

## Terminal transition invariant

The transition order is deliberately asymmetric and crash recoverable:

1. Commit the terminal job to `automation-jobs` with the existing claim,
   fencing, attempt, release, and runtime-role commit guard.
2. Synchronize the existing projection and audit evidence.
3. Append the exact committed representation to its archive segment, append
   the successful-idempotency entry when applicable, and update the manifest.
4. Re-read and verify the archive fingerprint.
5. Remove the matching active record only if its status and full fingerprint
   are unchanged. Worker-originated archive commits and removal retain the
   current Worker runtime-role authority through each atomic commit.

A failure before archive durability leaves the terminal source intact. A
failure after archive durability leaves both copies; retry detects the same
immutable record and resumes removal without duplicating it. Active records
win on reads while both copies exist. A changed claim, role, release, fencing
token, terminal fingerprint, or workflow dependency fails closed.

Terminal parents and children connected to a non-terminal workflow stay in the
active file until the graph becomes terminal. This keeps parent reconciliation
bounded without making Worker paths scan history.

## Guarded compaction command

The command defaults to dry-run:

```powershell
npm run automation:compact:preview -- --batch-size=100 --maximum-batches=100
```

Review at least the status counts, active/eligible/archive counts, source and
selection fingerprints, `remainingEligibleJobs`, and the absence of invariant
errors. Dry-run creates no backup, archive segment, projection mutation, temp
file, or source write.

Apply requires the explicit script and flag embodied by the npm command:

```powershell
npm run automation:compact:apply -- --batch-size=100 --maximum-batches=100
```

Apply is FileStorage-only and refuses a fresh Worker or Scheduler role lease.
It verifies the active source, creates and verifies a source backup, archives
bounded batches, verifies every selected fingerprint, and only then performs
one atomic removal from the active source. It does not write runtime leases,
runtime fencing, job heartbeats, automation audit, projections, secrets, or
unrelated collections. Repeat preview/apply only when
`remainingEligibleJobs` is nonzero; an already completed run is a no-op.

Never source `.env.production` into a shell. Supply only the already-approved
runtime configuration through the established process manager procedure, and
never print credential values.

## Verification and rollback

Retain the complete JSON report and its `backupRef`, source fingerprint,
backup fingerprint, selection fingerprint, archive fingerprints, counts, and
batch totals in the operator record. Verify that:

- the backup fingerprint equals the pre-migration source fingerprint;
- archived counts increase by the selected count;
- active/recoverable and workflow-protected records remain in
  `automation-jobs`;
- every selected job resolves through the history-aware detail path;
- a second dry-run reports no remaining eligible records when the whole source
  fit within the configured batch bound.

Rollback is an exceptional, separately approved storage recovery. Keep Worker
and Scheduler stopped, preserve the archive because it is append-only, verify
the recorded active-source backup in an isolated restore directory, and use the
repository's guarded storage recovery procedure to restore that verified
active source. Do not overwrite production data directly. Active-copy
precedence makes duplicated archived IDs harmless while rollback is assessed.
An application rollback must be archive-aware; older code that only reads
`automation-jobs` cannot provide complete history views.

## Guarded release and Worker canary

After the source change is reviewed and classified safe, the later operator
sequence is:

1. Commit and push the reviewed diff. On the VPS verify `master`, a clean tree,
   fetch, and fast-forward only.
2. Build with one exact new commit assigned to all five variables:
   `SANDEAL_BUILD_MANIFEST_COMMIT`, `SANDEAL_BUILD_COMMIT`,
   `SANDEAL_RELEASE_ID`, `GIT_COMMIT_SHA`, and
   `NEXT_PUBLIC_SANDEAL_RELEASE_ID`.
3. Restart Web first. Verify local and public health, and verify the exact
   release identity. Keep Worker and Scheduler stopped.
4. Run the compaction preview, review its fingerprints/counts and disk
   headroom, then run the explicitly approved apply. Re-run preview and detail
   verification. Do not manually edit, delete, or rename `.data` files.
5. Start Worker alone for at least 120 seconds. Record CPU and memory every 15
   seconds, capture only log output created during the canary, and arrange a
   bounded automatic Worker stop at the end. Keep Scheduler stopped.
6. Pass only if the Worker lease has the new release, role and job heartbeats
   stay fresh, renewal succeeds, real claims touch only the small active file,
   CPU is not repeatedly near 100%, memory is bounded, completions archive
   exactly once, and no new fence timeout, renewal storage failure, false
   ownership loss, archive validation error, or lock spin appears.
7. Only after a passing canary start Worker persistently, then Scheduler. Run
   release, process, runtime, local/public health, queue, projection, and Safe
   Publish verification before saving the approved process state.

Runtime Guardian, quarantine, evidence, review approval, canonical and
affiliate URL, image, price, and Safe Publish gates are not changed by this
storage layout.
