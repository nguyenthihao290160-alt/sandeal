# Phase 10 - 0010 operational package and recovery preauthorization

## Disposition and scope

`READY_FOR_0010_PRODUCTION_EXECUTION_AUTHORIZATION=NO`.
The operational policy is finalized for review; end-to-end recovery within the
approved 30-minute RTO is **UNKNOWN**, not a verified capability or guarantee.
`RECOVERY_RESTORE_TESTED=NO`. No restore or migration, including a local 0010
rehearsal, is performed by this task. A separate execution authorization is still
required even if a subsequent review resolves every blocker.

The evidence snapshot is `docs/v6/evidence/phase10-0010-operational-package.json`.
Its observations are newly collected, not inherited from historical PASS flags.
The production schema was checked at `2026-09-24T00:13:53.304Z`, runtime at
`2026-09-24T00:14:13.274Z`, and a fresh bookmark at
`2026-09-24T00:14:24.541Z` (07:14:24.541 Asia/Saigon). These are recorded audit
timestamps, not a scheduled or open production change window.

The start gate was clean on `master` at
`9dcd43ac95648fb91435dea7a50b7bc1d0d7c7a7`: clean worktree, clean index, and both
diff checks passed. This task adds documentation/evidence only to tracked files.
It does not amend previous incident evidence, source, SQL, runtime config, or
historical approvals. Review/commit is a human next step; no commit or push occurs.

## Exact identity and immutable migration binding

| Item | Required value |
| --- | --- |
| Account | `88d3839bee4ac092d39fbb293e3eb426` |
| D1 name | `sandeal-production` |
| D1 ID | `bdf42c22-190d-4cdf-a166-a9e07ade57f2` |
| Ledger | `d1_migrations` |
| Candidate | `src/lib/storage/d1/migrations/0010_execution_control_plane.sql` |
| Raw-byte SHA-256 | `7402fcea62eb779d24f2ee99aec011f54924006d3963d265cc6ca5b45a8380a2` |
| Pre-0010 fingerprint | `16af48356ed1ae61da3008107b8dc25190f2b444ec704298aa0952f1364f52aa` |
| Expected post-0010 fingerprint | `2d857eed231f8eef4f846dbd9f1134787f3b8becb557521cb54f0512a444cfd4` |
| Fingerprint algorithm | `d1-schema-canonical-v1` |
| Pre/post migration counts | Exactly 9 / exactly 10 |
| Installed Wrangler | `4.129.1` |
| Installed Wrangler source SHA-256 | `c1601ea9684445806550e51a81369cf007d2b5e5ec12506377f4733522200cc7` |

Authenticated read-only API requests verify the exact account and D1. The ordered
ledger is exactly 0001 through 0009; 0010 and all its 12 new tables are absent.
The canonical pre-fingerprint matches. All business, commission, and revenue row
counts are zero. The sole non-business cursor seed remains exactly
`{id: 'revenue-v1', last_sequence: 0, claim_key: null}`. `quick_check` is `ok` and
`foreign_key_check` returns no rows. Every SQL response reports zero rows written,
zero changes, and `changed_db=false`.

The actual deployed Worker remains version
`eee7c19e-0b14-4efc-9ec1-336be52bafcf`; its only bindings are the exact D1 and
`JOB_QUEUE` / `sandeal-production-jobs`. The deployed source's guards and both
health endpoints prove fail-closed operation: HTTP 503 with
`PRODUCTION_EXECUTION_BLOCKED`. No execution-enable binding, Queue consumer, Cron,
Worker route, or custom domain is present. Source and metadata were inspected
without saving or exposing secret binding values. DNS records outside the
Worker's routes/domains were not inventoried; no DNS write was made or authorized.

## Human-approved planning policy

These assignments come directly from the human's supplied policy, not an
inference from account membership or an invented personal name.

- Maximum change window: **30 minutes**.
- Operator: **authenticated SanDeal account owner currently present at the terminal**.
- Abort owner: **the same human operator**.
- Recovery owner: **the same human operator**.
- The operator must remain present, authenticated, and exclusively responsible
  for the entire window and any separately authorized recovery.
- Business, Queue, provider, money, and other mutating automation remain OFF.
- No overlapping deployment, DNS change, traffic shift, or consumer enablement.
- Automatic retry is prohibited. Ambiguous results mean **STOP_AND_REAUDIT**.

`CHANGE_WINDOW_CONFIGURED=YES` means this bounded policy is recorded. It does not
mean the window has started. A future separately authorized change record must
log actual UTC start/end times, with end no later than start plus 30 minutes,
and the operator's acknowledgement before making any mutation. Do not invent
timestamps now or reuse a prior authorization. At deadline or loss of access,
stop all further mutations; any recovery requires its own explicit authorization.

The supplied RTO and RPO policies are approved for planning, not production
execution. RTO is 30 minutes from the recovery decision to completion of all
acceptance checks, including human authorization/access overhead. RPO is the
fresh pre-0010 Time Travel bookmark, captured after quiescence immediately before
the future authorized attempt. Preserve the associated pre-state, source/config
hashes, exact database ID, request/server times, and request ID together.

Allow at least **60 minutes** of bookmark availability for the maximum change
window followed by the RTO target. Neither the RPO nor RTO approves business
writes; concurrent writes invalidate the zero-business-data recovery assumption.

## Read-only recovery capability assessment

### Retention: YES for the required window; exact paid/free tier UNKNOWN

The actual database reports `version=production` and successfully returns both
current and historical Time Travel bookmarks. At `2026-09-24T00:10:39.349Z`, the
exact D1 returned a bookmark for `2026-09-23T23:10:36.594Z`, a 60-minute lookback.
The official limits specify seven days for Free and 30 days for Workers Paid;
both exceed this package's 60-minute requirement. This supports
`ACCOUNT_RECOVERY_RETENTION_VERIFIED=YES` for the required window only, not a
claim that this account has paid/30-day retention or that a restore was tested.

The account subscriptions GET returned HTTP 403, error 10000. The exact plan
therefore remains UNKNOWN; it was not guessed, upgraded, or retried. Subsequent
membership and production reads succeeded, so this endpoint-specific denial
does not mean the authenticated session was lost.

### Recovery permission: YES, read-only entitlement verification only

Authenticated membership detail for the exact account reports `status=accepted`,
`Super Administrator - All Privileges`, and `permissions.d1.edit=true`.
The existing OAuth credential includes `d1:write`, and authenticated reads of the
exact D1 succeed. The membership response reports `d1.read=false`; it is retained
as returned, not rewritten. The positive edit permission, all-privileges account
role, granted write scope, and live authenticated reads establish the permission
model without issuing a restore or an invalid/empty mutation probe.

This is not proof of a successful restore, future token validity, or uninterrupted
operator access. The inspected access token expires at
`2026-09-24T00:19:35.040Z` (07:19:35.040 Asia/Saigon), so this session must not be
used as evidence of authentication continuity for a later 30-minute window.
The human must establish and reverify adequate authentication/recovery access
before future authorization. No credential refresh, login, or secret write is
performed here. Tokens, refresh tokens, and personal account email are not output.

The raw `capabilities.json` discovery artifact deliberately leaves assessment
fields UNKNOWN; this section and the final evidence apply the documented
read-only interpretation to its successful, narrowly projected API observations.

### Restore model and target behavior: YES; restore tested: NO

Installed Wrangler source and current official documentation agree: Time Travel
restores **the same database in place**. It overwrites schema/data at that D1 ID,
cancels in-flight queries/transactions, and may discard changes after the chosen
bookmark. Replacement D1 creation, rebinding, deployment, and DNS changes are
neither required nor authorized. Do not substitute an assumed cloning/forking
feature or a Worker rollback for D1 recovery.

The reviewed command model below is **not executed** and contains an intentionally
unresolved bookmark placeholder. It requires separate incident-specific human
authorization and fresh identity/config/hash verification:

```text
cwd: C:\duan\sandeal
environment: CLOUDFLARE_ACCOUNT_ID=88d3839bee4ac092d39fbb293e3eb426
environment: WRANGLER_SEND_METRICS=false
node node_modules/wrangler/bin/wrangler.js d1 time-travel restore DB --bookmark <VERIFIED_PRE_0010_BOOKMARK> --config .test-tmp/phase10-0010-preauth-resume/wrangler.0010-only.json
```

Use an interactive human-controlled terminal and review the default-No prompt.
Do **not** use `--json`: this installed version bypasses the confirmation prompt
in JSON mode and sends the restore request directly. Do not use `--yes`, automated
stdin, a noninteractive confirmation fallback, conflicting environment/account
overrides, or an alternate config. Restore is remote by definition in the pinned
command; do not append migration-only/local/preview flags. Its handler performs
POST only to the exact account/D1 `time_travel/restore` endpoint after confirmation.
No retry loop exists in the inspected handler or its direct fetch-result chain.
Do not wrap it in a retry mechanism. The service documents a maximum of ten
restores per ten minutes per database; this package authorizes zero restores and
never uses that allowance as permission to retry.

After a future failed/ambiguous 0010 attempt:

1. Send no further mutation. Keep execution, writers, providers, money and Queue
   consumers OFF. Preserve the initial response, request IDs, and current state.
2. Re-audit identity, ledger, schema, counts, deployed version/routes and auth with
   read-only requests. Do not infer rollback from a client error or cancellation.
3. The same human recovery owner reviews the retained **pre-attempt** bookmark,
   its retention, identity, and accepted data-loss boundary. Capture the current
   bookmark too; it must not replace the required pre-attempt recovery point.
4. Only after separate explicit recovery authorization, use the reviewed model
   once. Retain the result, returned `previous_bookmark`, and start/end timing.
   The returned bookmark is not required to equal the input bookmark text; verify
   recovered content and the acceptance checks instead.
5. On error, timeout, access loss, or ambiguity, stop and re-audit without retrying
   either migration or restore. Escalate to the human; a second restore or undo
   requires another decision. Never reset D1 or insert/delete ledger rows manually.
6. Keep runtime blocked even after successful recovery. No automatic resumption,
   deployment, traffic shift, Queue message, or business action follows.

### RTO/RPO feasibility

`RECOVERY_RTO_APPROVED=YES` and `RECOVERY_RPO_APPROVED=YES` reflect the supplied
human planning decisions. `RECOVERY_RPO_TECHNICALLY_FEASIBLE=YES` reflects the
actual bookmark API, supported production backend, sufficient required retention,
and quiescent zero-business-data baseline, not a completed restore test.

`RECOVERY_RTO_TECHNICALLY_FEASIBLE=UNKNOWN`. The inspected Cloudflare references
and pinned client source provide no guaranteed end-to-end completion bound, and
no restore has been measured. The small database and fast read-only requests are
not a recovery benchmark. Do not promote an approved target into a verified RTO.
A separately authorized representative nonproduction D1 Time Travel recovery
drill can measure the process without restoring production; it is not a clone
of production and cannot alone guarantee production service latency. The human
must review its applicability and full access/acceptance timing before re-audit.

## Recovery acceptance: all conditions mandatory

- Exact original account, D1 ID and name; original nine ledger rows, including
  names/IDs/applied timestamps, and no 0010 record.
- Canonical schema fingerprint exactly
  `16af48356ed1ae61da3008107b8dc25190f2b444ec704298aa0952f1364f52aa`;
  no partial/unexpected 0010 table, index, trigger, column or other schema effect.
- Every business, commission, and revenue count remains zero; the sole cursor
  control seed remains exactly unchanged.
- Execution stays disabled and mutation mode BLOCKED; business/provider/money
  automation, Queue consumers, and Cron stay OFF.
- No unexpected route, binding, Worker/asset version, deployment, DNS, or traffic
  change. Compare against the future window's captured metadata and operator
  change record; this audit does not claim an account-wide DNS inventory.
- `PRAGMA foreign_key_check` returns no rows and `PRAGMA quick_check` returns `ok`.
- The human recovery/abort owner reviews all evidence and timing against the
  approved RTO/RPO. Failure or UNKNOWN in any check means remain blocked.

## 0010-only envelope: static and read-only verification

The existing reviewed config is
`.test-tmp/phase10-0010-preauth-resume/wrangler.0010-only.json`, SHA-256
`9ce0b306fffc4e1f73cb7137a22e8269d9726e337c8173a59e86cac3b5f73f43`.
It pins the exact account and D1, `d1_migrations`, directory
`../../src/lib/storage/d1/migrations`, and literal pattern
`../../src/lib/storage/d1/migrations/0010_execution_control_plane.sql`.
It has no Worker entrypoint, route, assets, Queue, Cron, or environment overlay.

The pinned installed Wrangler selector and bundled matcher were re-evaluated in
a read-only VM: selected/pending is exactly 0010; empty or missing-0009 ledgers
still cannot select 0009; already-recorded 0010 is skipped. All those abnormal
ledger states nevertheless block execution. `0009_REPLAY_POSSIBLE=NO` applies
only to this exact envelope/tool version, not arbitrary commands or changed config.

Wrangler uses unique migration names, not content hashes, in its ledger. Its
query builder appends the 0010 ledger insert to the exact SQL and submits the
combined query; ledger initialization is separate DDL. Do not run `migrations
list` or `migrations apply` for discovery. No remote transaction/restore behavior
was tested here. Historical rehearsal fingerprints and source/harness hashes were
validated against their actual historical HEAD and ancestry without replaying SQL.

The envelope binds the source hash, ledger, and pre/post fingerprints above.
A future execution must independently recheck every binding, including clean
Git/HEAD, exact config/source/tool bytes, and fresh production evidence. This
package introduces no executor and issues no authorization. Expected future
success is exactly ten ledger entries, the pinned post-fingerprint, all 12 new
control-plane tables empty, and zero business or runtime-enabling changes.

## Abort conditions

Abort immediately for wrong/ambiguous account or D1; 0010 already present;
history not exactly 0001..0009; source hash mismatch; pre-fingerprint mismatch;
fresh bookmark unavailable; unexpected business data; any enabled Queue consumer
or execution; migration error; ambiguous Wrangler response; ledger mismatch;
unexpected schema object; wrong post-fingerprint; or loss of authenticated access.

Also abort for dirty Git/index, changed HEAD/config/tool/source/evidence, stale or
truncated observation, failed integrity check, changed control seed, missing
recovery retention/permissions, unresolved RTO, absent owner/operator, concurrent
writer/deployer, automation enablement, quality failure, missing separate
authorization, insufficient access continuity, or the window deadline.

Abort means stop further mutations and preserve/re-audit evidence, not automatic
rollback or retry. `ABORT_CONDITIONS_COMPLETE=YES` does not assert an automated
production abort monitor exists.

## Evidence and references

The JSON snapshot records quality commands/results and local evidence hashes.
Ignored raw logs, query journals, schema metadata, and the bookmark remain under
`.test-tmp/phase10-0010-preauth-resume/` and
`.test-tmp/phase10-0010-finalization/`; no credentials are included in the tracked
package. Do not commit raw auth files, caches, generated bundles, or session logs.
Existing historical incident files and baseline evidence remain unchanged.

Official references were retrieved over HTTPS during this audit:

- `https://developers.cloudflare.com/d1/reference/time-travel/`
- `https://developers.cloudflare.com/d1/platform/limits/`
- `https://developers.cloudflare.com/api/resources/d1/subresources/database/subresources/time_travel/methods/restore/`
- `https://developers.cloudflare.com/fundamentals/manage-members/roles/`

The limits page distinguishes seven-day Free retention from 30-day Paid retention;
the overview's general 30-day wording must not be applied to an unknown plan.
Installed restore implementation: `node_modules/wrangler/wrangler-dist/cli.js`,
`src/d1/timeTravel/restore.ts` block, lines 226310-226440 in the pinned bytes.

**STOP. No 0010, production restore, deployment, DNS change, consumer enablement,
traffic shift, production secret write, commit, or push is authorized or performed.**
