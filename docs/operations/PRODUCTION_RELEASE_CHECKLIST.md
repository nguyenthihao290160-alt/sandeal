# SanDeal production release checklist

## Before approval

- [ ] Branch, commit SHA, artifact SHA-256, and manifest SHA-256 match the change ticket.
- [ ] `sourceState.workingTreeDirty` is `false` for the production artifact.
- [ ] `npm run release:quality` passed on the exact commit.
- [ ] Strict preflight is `READY`; public HTTPS URL, admin auth, vault encryption key, data directory, and timezone are configured.
- [ ] Paid AI and external publishing remain disabled unless separately approved.
- [ ] Backup completed and `release-storage.cjs verify` passed.
- [ ] Restore was verified in a separate local/test directory.
- [ ] Storage schema is v1; migration list is empty for this release.
- [ ] Single-instance limitation is accepted; only one web writer is planned.
- [ ] Rollback artifact and its checksum are available before deployment.
- [ ] `SANDEAL_RELEASE_ID` identifies the reviewed immutable release and `/api/health/live` reports it.
- [ ] New build lives in a separate release directory; the running release's `.next` directory was not overwritten or removed.
- [ ] A verified backup copy exists outside the VPS/primary failure domain.
- [ ] Every real `test:prompt10:*` script passed on the exact commit; runtime and job-schema contracts have no blocked regression.
- [ ] Isolated autonomous/runtime smoke passed with a test port, temporary data, mock/local-only providers, and zero external requests.
- [ ] Worker/scheduler PM2 entries remain opt-in; initial automation state is SHADOW, publishing paused, and launch disabled.

## Immediately after deployment

- [ ] Public website responds without exposing dashboard data.
- [ ] Login and administrator authorization work.
- [ ] Liveness and readiness endpoints return the expected structured response.
- [ ] `/api/health/live` is public and minimal; `/api/health/ready` is authenticated and distinguishes warning/critical dependencies.
- [ ] Dashboard, Kết quả bot, Tác vụ, Tự động hóa, Nguồn, Kết nối bảo mật, Sức khỏe, and Cài đặt render.
- [ ] Worker heartbeat is fresh and no second worker claims the same task.
- [ ] Scheduler last/next run is plausible and does not enqueue duplicates.
- [ ] Dashboard distinguishes scheduler process online from active/standby/rejected lease role and shows owner, heartbeat, lease expiry, last tick, and next run truthfully.
- [ ] Provider `configured` and `ready` states are displayed separately; degraded and insufficient-data states are not shown as success.
- [ ] Job diagnostics show terminal state, reason/error, retry, and schema/policy/handler versions without secret/internal payload leakage.
- [ ] Queue depth and failure rate are stable.
- [ ] A dry-run task completes without business-data or external side effects.
- [ ] AI usage, circuit breaker, and missing-provider states are accurate.
- [ ] Kill switch state matches the approved state.
- [ ] Source connections show configured/unconfigured accurately.
- [ ] Browser console has no new error, hydration mismatch, or request loop.
- [ ] Desktop and mobile views have no horizontal overflow; loading, empty, populated, error, and degraded states are usable with keyboard and visible focus.
- [ ] Public cards with missing facts remain truthful; prices show observation/freshness, Trust Panel claims have evidence, and affiliate disclosure is visible.
- [ ] 5xx rate and response latency remain within the approved baseline.

## Rollback triggers

- [ ] Readiness fails or repeated 5xx errors appear.
- [ ] Worker heartbeat is stale or queue depth grows without recovery.
- [ ] Duplicate side effect, incorrect data, secret exposure, or checksum mismatch is detected.
- [ ] Storage compatibility check fails.
