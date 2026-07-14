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

## Immediately after deployment

- [ ] Public website responds without exposing dashboard data.
- [ ] Login and administrator authorization work.
- [ ] Liveness and readiness endpoints return the expected structured response.
- [ ] Dashboard, Kết quả bot, Tác vụ, Tự động hóa, Nguồn, Kết nối bảo mật, Sức khỏe, and Cài đặt render.
- [ ] Worker heartbeat is fresh and no second worker claims the same task.
- [ ] Scheduler last/next run is plausible and does not enqueue duplicates.
- [ ] Queue depth and failure rate are stable.
- [ ] A dry-run task completes without business-data or external side effects.
- [ ] AI usage, circuit breaker, and missing-provider states are accurate.
- [ ] Kill switch state matches the approved state.
- [ ] Source connections show configured/unconfigured accurately.
- [ ] Browser console has no new error, hydration mismatch, or request loop.
- [ ] 5xx rate and response latency remain within the approved baseline.

## Rollback triggers

- [ ] Readiness fails or repeated 5xx errors appear.
- [ ] Worker heartbeat is stale or queue depth grows without recovery.
- [ ] Duplicate side effect, incorrect data, secret exposure, or checksum mismatch is detected.
- [ ] Storage compatibility check fails.
