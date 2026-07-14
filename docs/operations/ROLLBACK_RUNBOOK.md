# SanDeal rollback runbook

Rollback requires human approval. Do not use `git reset`, rebuild source, or automatically overwrite production data.

## A. Application rollback

1. Enable the admin kill switch if side effects may be unsafe.
2. Stop the new scheduler, then stop new worker claims. Allow in-flight work to reach a safe boundary.
3. Select the previously approved artifact, commit SHA, and SHA-256 from the release record.
4. Verify the artifact checksum before replacing the application artifact.
5. Start one web instance and verify liveness/readiness before restarting worker or scheduler.

## B. Worker and scheduler rollback

1. Stop the new worker and scheduler gracefully.
2. Keep `SANDEAL_DATA_DIR` unchanged; do not delete or recreate task files.
3. Confirm the previous runtime supports storage schema v1 and the current job states.
4. Start one previous-version worker and verify heartbeat, leases, idempotency keys, and queue depth.
5. Start the previous scheduler only after confirming it cannot duplicate the current time bucket.

## C. Data restore

Data restore is last resort and needs explicit human confirmation. First restore into an empty verification directory:

```powershell
node scripts/release-storage.cjs verify --backup="E:\sandeal-backups\<backup-name>"
node scripts/release-storage.cjs restore --backup="E:\sandeal-backups\<backup-name>" --target="D:\sandeal-restore-check"
```

Compare queue/task/source/product counts and operation IDs. Only then schedule a controlled replacement of the production data directory while all writers are stopped. The default operational backup excludes the encrypted connection vault; restore that only through its separately approved secure process.

## Verification after rollback

- [ ] Commit and artifact checksum match the previous release record.
- [ ] Liveness/readiness pass.
- [ ] Worker heartbeat is fresh; only one worker claims tasks.
- [ ] Scheduler does not create a duplicate task.
- [ ] Queue depth, idempotency, and approval states are intact.
- [ ] Dry-run completes without side effects.
- [ ] Public website and admin login work.
- [ ] No new 5xx, secret exposure, or storage corruption appears.
- [ ] Kill switch is changed only by an authorized administrator with a recorded reason.

