# SanDeal production release runbook

## Scope

This runbook prepares a human-approved release. It does not authorize production access or deployment. The current storage adapter is JSON-file based and safe for one application instance only.

## 1. Quality gate

Use Node.js supported by `package.json` and the committed lock file.

```powershell
npm ci
npm run release:quality
```

Stop if typecheck, lint, tests, build, secret scan, storage validation, backup verification, artifact creation, or manifest validation fails.

## 2. Strict preflight

Set production variables in the approved secret manager. Do not place values in source control or terminal transcripts.

```powershell
npm run release:preflight:strict -- --health-url=https://<approved-host>/api/automation/health
```

`READY` is required. `CONFIGURATION_REQUIRED` or `BLOCKED` stops the release. Gemini and AccessTrade may remain unconfigured only when their dependent actions remain disabled and clearly labelled.

## 3. Backup

Pause scheduler and worker claim through the admin controls, then create an operational-data backup. The default backup excludes `token-vault.json`; protect connection secrets through the approved secret-management backup process.

```powershell
node scripts/release-storage.cjs backup --source="D:\sandeal-data" --output="E:\sandeal-backups"
node scripts/release-storage.cjs verify --backup="E:\sandeal-backups\<backup-name>"
```

Record `BACKUP_PATH`, metadata checksum, artifact checksum, and release manifest checksum in the change ticket.

## 4. Artifact

Use `.release/release-manifest.json` and the exact `.tar.gz` named there. Never rebuild during an emergency rollback. Verify:

```powershell
npm run release:manifest:validate
Get-FileHash .release\*.tar.gz -Algorithm SHA256
```

The checksum must match the manifest. No migration is required for storage schema v1 in this release.
If `sourceState.workingTreeDirty` is `true`, treat the artifact as a local candidate only. Review and commit the intended files, run the complete quality gate on that clean commit, and use the newly generated artifact for deployment.

## 5. Human-approved deployment

Deployment requires a separate approval and platform-specific procedure. Start one web instance, one worker, and one scheduler against the same durable data directory:

```powershell
npm run start
npm run worker
npm run scheduler
```

Do not enable paid AI, external publishing, or production scheduling unless separately approved. Confirm worker and scheduler receive graceful stop signals during replacement.

## 6. Post-deploy checks

Follow `PRODUCTION_RELEASE_CHECKLIST.md`. Roll back when readiness fails, 5xx errors rise, worker heartbeat becomes stale, queue depth grows without recovery, a duplicate side effect appears, data is incorrect, a secret is exposed, or migration/storage validation fails.
