# SanDeal master guarded deployment and rollback

## Authorization boundary

These procedures are prepared artifacts only. Creating or reviewing them does
not authorize a deployment, PM2 restart, production migration, configuration
change, or data mutation. A human operator must separately approve the exact
release and run the command on the VPS.

The deployment script:

- runs only from `/var/www/sandeal-git`;
- requires branch `master` and a clean working tree;
- displays and requires confirmation of the full current Git HEAD;
- derives every release identity from that single HEAD;
- preserves the active durable data directory;
- runs one production build;
- restarts `sandeal`, `sandeal-worker`, and `sandeal-scheduler` with
  `--update-env`;
- verifies process status and selected process environment values without
  printing the rest of the PM2 environment;
- verifies fresh worker and scheduler leases, fencing tokens, and release
  identities;
- verifies local and public liveness with HTTP 200 and
  `releaseMismatch=false`;
- redacts bounded recent log output;
- runs `pm2 save` only after every verification passes.

After explicit approval:

```bash
cd /var/www/sandeal-git
bash scripts/guarded-production-deploy.sh
```

Optional non-secret controls are:

```bash
export SANDEAL_LOCAL_HEALTH_URL='http://127.0.0.1:3000/api/health/live'
export SANDEAL_PUBLIC_HEALTH_URL='https://sandeal.tech/api/health/live'
export SANDEAL_DEPLOY_LOG_LINES='50'
```

The script must stop on any failed check. A failed run does not call
`pm2 save`, so the last verified PM2 saved state remains unchanged. It does not
delete or replace leases, jobs, journals, audits, snapshots, products, `.data`,
or database records.

## Non-destructive rollback

Rollback uses an already built, previously verified immutable release
directory. It does not rebuild source, change Git history, or restore data.
Keep the current durable data directory and confirm that the previous code is
backward compatible with the current additive schemas before authorization.

After explicit rollback approval:

```bash
cd /var/www/sandeal-git
export SANDEAL_ROLLBACK_RELEASE_DIR='/var/www/releases/<verified-release-directory>'
bash scripts/guarded-production-rollback.sh
```

The rollback directory must contain its immutable
`.sandeal-build-manifest.json`, `ecosystem.config.cjs`, dependencies, compiled
artifact, and the same guarded verification scripts. The operator must type
the manifest commit SHA before PM2 changes.

The rollback script preserves the active durable data directory, reloads the
three named PM2 applications from the verified release, verifies process
identities, leases, local health, public health, and redacted bounded logs,
then calls `pm2 save`. It stops before `pm2 save` if any verification fails.

Data restore is not part of either procedure. A data restore remains a
separate last-resort action requiring explicit approval and an isolated
checksum-verified restore rehearsal.
