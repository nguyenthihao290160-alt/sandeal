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
