# MongoDB Storage M3–M5 Acceptance Report

Report date: 2026-07-18

Scope: local and injected/fake isolated validation only

## Status

| Gate | Status | Evidence |
| --- | --- | --- |
| Gate 0 / M2 | PASS | Typecheck, M1 file/factory tests, M2 fake Mongo tests, and lint completed before M3. |
| M3 | PASS | Inventory, deterministic manifest/checksum, source-only dry-run, isolated safety/checkpoint/resume tests, and fixture CLI gate passed. |
| M4 | PASS | Read-only shadow, redaction, rollback evaluator, logical backup, fake isolated restore, regression tests, and CLI gate passed. |
| M5 | PASS | Acceptance matrix, storage/background/full tests, lint, file-default build, generated check, and migration check passed. Secret scan has the two pre-existing non-secret default findings documented below. |
| REAL_ISOLATED_MONGO_ACCEPTANCE | NOT_RUN | No real MongoDB or Atlas connection is authorized or executed in this phase. |

## Acceptance matrix

| Mode | Expected behavior | Current evidence |
| --- | --- | --- |
| A — default file | No driver and no URI select file; build must not initialize Mongo. | PASS, including final Next.js build with storage/Mongo environment removed. |
| B — explicit file | `SANDEAL_STORAGE_DRIVER=file` works without URI and build remains offline. | PASS in unit acceptance; default-file build also passed. |
| C — invalid Mongo config | Explicit Mongo without URI fails `MONGO_URI_REQUIRED`, with no file fallback. | PASS. |
| D — fake/injected Mongo | CRUD, transaction/conflict, schema inspect, migration, shadow, backup/restore, and rollback checks. | PASS. |
| E — optional real isolated Mongo | Requires all opt-ins, safe suffix, empty-target check, local ignored URI, limited credential, and user confirmation. | NOT_RUN. |

## Data and external systems

- `.data` deleted or modified: NO. Existence, directory mtime, and file count were unchanged across both final builds.
- Real MongoDB read/write: NO.
- Atlas connection: NO.
- Mongo collection/index created: NO; fake/in-memory structures only.
- Provider or paid API call: NO.
- Backup/restore: application snapshot and restore verification used fake/injected targets in ignored/temporary directories.

## Deployment state

- File driver remains the default: YES.
- Production Mongo enabled: NO.
- Production migration executed: NO.
- Commit/push/deploy/SSH/PM2: NO.
- Prompt 12 included: NO.

## Verification executed

Final command evidence:

- `npm.cmd run typecheck`: PASS, 0 errors (about 2.9 seconds in the final run).
- Storage suites: 137 passed, 0 failed — M1 11, M2 27, M3 39, M4 40, and M5 acceptance 20.
- Prioritized adapter-dependent suites: 142 passed, 0 failed — automation 20, runtime 18, job/schema 10, lifecycle/domain/API 50, backup/recovery 7, product intelligence 29, and alerts 8.
- `npm.cmd run lint`: PASS with 0 errors and 27 pre-existing warnings; no M3–M5 file produced a warning.
- `npm.cmd run build`: PASS with no storage/Mongo environment configured; 41 static pages were generated and `.data` was unchanged. Turbopack emitted one existing NFT trace warning through `backupManager.ts`, outside the M3–M5 change set.
- `npm.cmd test`: final rerun PASS, 226 passed and 0 failed. The first run stopped at Prompt 07 because the new opt-in placeholders used `false`; they were corrected to empty placeholders without changing the test, after which Prompt 07 passed 17/17 and the complete suite passed.
- `npm.cmd run release:generated-check`: PASS after supplying process-local Git `safe.directory` because the sandbox user does not own the worktree.
- `npm.cmd run release:migration-check`: PASS (`schema=1`, no migration finding). `.data` contained zero files, so no credential record was opened.
- `npm.cmd run release:secret-scan`: nonzero with only `.env.example` lines for `SANDEAL_STORAGE_DRIVER=file` and `MONGODB_DATABASE=sandeal`. Both exact values already exist in `HEAD`, Prompt 07 identifies them as allowed non-sensitive storage defaults, and all findings introduced by M3–M5 were removed. The scanner was not weakened.

Warnings observed on npm commands:

- npm repeatedly reports the existing `Unknown env config "min-release-age"` warning.
- `npm audit` and both audit-fix commands were not run. Dependencies and `package-lock.json` were not changed.

## Optional isolated acceptance guard

The following command validates configuration only and never connects:

```powershell
npm.cmd run storage:mongo:acceptance:check
```

Readiness requires local environment values for `SANDEAL_MONGO_INTEGRATION_TEST=true`, `SANDEAL_STORAGE_DRIVER=mongo`, a nonempty valid `MONGODB_URI`, a safely suffixed `MONGODB_DATABASE`, `SANDEAL_ALLOW_ISOLATED_MONGO_WRITE=true`, and explicit user confirmation. It reports only whether a URI is configured, never the URI itself. Even a `READY_FOR_ISOLATED_CHECK` result is not an executed acceptance test and must not be reported as Atlas runtime evidence.

## Remaining limitations before a production cutover

- A separately approved real isolated staging acceptance has not run.
- Atlas infrastructure backup/restore has not been tested and is not replaced by the application snapshot.
- Production data inventory, migration window, ownership, monitoring, credential scope, capacity, and rollback coordination remain unapproved.
- Shared/free cluster capacity is limited; current provider limits must be reviewed before any later staging or production decision.
- Production cutover and Prompt 12 require separate scopes and approval.
