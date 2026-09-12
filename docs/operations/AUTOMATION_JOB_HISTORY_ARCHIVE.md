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

## V5.2 Phase 1 durable publication protocol

This protocol deliberately does not claim one atomic transaction across a
segment, its idempotency index, and the manifest. It makes the independent
FileStorage commits recoverable and orders them under one adapter-owned,
renewable cross-process lock named `automation-job-history-publication-v1`.
Every child commit reasserts that this coordinator is still held and composes
the existing Worker commit guard when one was supplied.

`AUTHORITATIVE_SOURCE`: Current valid records in the append-only history
segments are authoritative history. The manifest, idempotency indexes, and
publication intents are derived metadata. A stale manifest never authorizes
restoring `.bak`, deleting a newer valid record, or rolling a segment back. If
a requested record has not crossed the segment commit boundary, its unchanged
terminal record in `automation-jobs` remains the retry source.

`WRITE_SERIALIZATION`: An archive holds the dedicated coordinator across
intent creation, sorted segment appends, index convergence, manifest
publication, strict verification, and intent completion. FileStorage backs
the coordinator with its existing renewable collection lock, so the exclusion
applies across Node processes as well as within one process. Per-collection
transactions retain their normal atomic rename and commit-guard behavior.

`GENERATION_RULE`: A segment's append-only `itemCount` is its monotonic
generation. `manifestGeneration` is a separate global publication generation;
it increments only when manifest metadata changes, and the first coordinated
write upgrades a legacy manifest that has no generation. An expected
generation, when supplied by guarded maintenance, must still equal the
observed generation before commit.

`STALE_WRITER_RULE`: While holding the coordinator, publication re-reads each
affected current segment immediately before deriving its manifest entry and
checks that the manifest transaction still sees the same observed source.
Metadata with a lower item count is rejected as stale. Equal counts must have
the exact content fingerprint and status counts or publication fails closed;
only a strictly higher authoritative count may advance that shard.

`CRASH_RECOVERY_RULE`: Before any segment append, the archive stores a bounded,
deterministic publication intent containing only stable record, shard, index,
and fingerprint references. On retry, an explicit post-restart maintenance
run, or the next archive, recovery resolves those references against current
segments. References that
never reached a segment leave the active terminal source available for retry.
References that did reach a segment deterministically rebuild missing indexes,
publish current segment truth, pass strict verification, and only then remove
the intent. Repeating any completed step is a no-op.

`MANIFEST_PUBLICATION_RULE`: Segment persistence precedes index persistence,
which precedes manifest publication. The manifest entry is computed from a
fresh authoritative segment snapshot under the coordinator; global archived
and status totals are recomputed from the resulting entries. The manifest is
then replaced by one atomic collection commit. Publication never copies
records from a manifest or backup into a segment. If the manifest primary is
absent, one exceptional bounded scan of all 128 current primary shards rebuilds
the complete manifest so unrelated shards cannot be omitted. History segment,
index, intent, and manifest transactions use primary-only sources and never
seed a new primary from `.bak` or `.bak.2`.

`INDEX_CONVERGENCE_RULE`: Each terminal segment record deterministically
derives its idempotency entry. A missing entry is appended, an exact entry is a
no-op, and any conflicting entry fails closed. Recovery and the supported
repair command therefore converge indexes toward segment truth without
overwriting an ambiguous mapping.

`READER_COHERENCE_RULE`: Reads that compare a manifest, segments, and indexes
hold the same coordinator, assert it before and after the read, and retry once
only if lock ownership was lost. Direct job lookup may read its immutable
shard, and idempotency lookup remains a bounded single-index read but validates
the selected job and fingerprint against its segment; an orphan index is an
error. While active and archived copies coexist, the active copy retains read
precedence. A coordinated strict reader waits behind publication instead of
classifying its temporary multi-collection window as permanent corruption.

The protocol converges under each required failure mode:

- Same-shard writers serialize, then append or observe the same immutable
  record; the later manifest is derived from the latest complete shard.
- Different-shard writers also serialize at publication scope, preserving both
  entries and recomputing global totals rather than overwriting one another.
- A process crash leaves either no durable intent, a replayable intent, or a
  fully verified publication; the unchanged active terminal source and intent
  journal determine the next idempotent action.
- A stale writer cannot publish an older snapshot because it must acquire the
  coordinator, re-read the shard, and pass the count, fingerprint, source, and
  optional generation checks.
- A partial durable sequence is completed from committed segment records after
  a crash following the segment, index, or manifest boundary. No recovery step
  reverses current valid history.

Recovery findings use three classes. `GREEN` means segment authority is known,
there is no conflict or data loss, and deterministic idempotent convergence is
safe (for example a stale manifest or missing exact index). `AMBER` means the
evidence is transient or degraded and should be retried with backoff, deferred,
or isolated until fresher evidence is available. `RED` means durable data is
malformed, idempotency evidence conflicts, authority is ambiguous, or an
invariant cannot be repaired deterministically; fail closed and alert an
operator without guessing.

The supported maintenance entry points are
`npm run automation:history:repair:dry-run`,
`npm run automation:history:repair:apply -- --source-fingerprint <sha256> --plan-fingerprint <sha256>`,
and `npm run verify:v5:history`. Dry-run is the
default and performs no writes. It reports the recovery class, exact grouped
collection/reason mismatch summary, source and plan fingerprints, and whether
a guarded attempt is safe. `AUTO_MAINTENANCE_ELIGIBLE=YES` is stricter than
`SAFE_TO_APPLY=YES`: it requires `GREEN`; an `AMBER` plan is never eligible for
automatic maintenance. Apply re-reads the complete source and plan under the
coordinator before its first write, aborts on either fingerprint changing, and
prints `NO_OP` when a freshly planned second application has nothing to change.

Runtime idempotency readers validate the exact indexed history fingerprint,
derive and compare the complete index record, reject duplicate or wrong-shard
index evidence, and fail closed on orphan/conflicting mappings. They do not
silently substitute the newest version of the same job ID for the version named
by an index entry.

The normal archive path is bounded by the requested batch (at most 250
records), its affected segment shards, and its affected index shards. Claims,
completions, and scheduler ticks do not perform a 128-shard scan. Scanning all
128 history shards is reserved for the explicit verifier, repair dry-run/apply,
separately bounded startup maintenance, or the one-time missing-manifest
initialization/recovery path.

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
