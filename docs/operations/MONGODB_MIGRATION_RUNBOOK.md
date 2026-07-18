# MongoDB Migration Runbook — Local and Isolated Only

## Scope

This runbook covers M3 planning and M4 local/fake validation. It is not a production cutover procedure. The file driver remains the default, MongoDB is not enabled in production, `.data` must not be deleted or renamed, and Prompt 12 is not included.

Never use production data, a production backup, token-vault contents, or a production Mongo credential in these commands.

## 1. Preflight

Run the M1–M4 gates before creating a new plan:

```powershell
git diff --check
npm.cmd run typecheck
npm.cmd run test:storage
npm.cmd run test:storage:mongo
npm.cmd run test:storage:migration
npm.cmd run test:storage:shadow
```

Confirm that `SANDEAL_STORAGE_DRIVER` is absent or `file`. Do not place a Mongo URI on the command line. Generated manifests and snapshots must remain under `.test-tmp`, `.backups`, `.release`, or an OS temporary directory.

## 2. Inventory

Use an explicit temporary or approved source directory:

```powershell
npm.cmd run storage:migration:inventory -- --data-dir <TEMP_DATA_DIR>
```

Inventory scans only the top level of the supplied directory. It classifies logical JSON collections as migratable, empty, sensitive excluded, unsupported, invalid JSON, invalid root, or ignored artifact. `token-vault.json` is classified from its filename and is not opened or parsed. Locks, temporary files, technical `.bak` files, generated reports, symlinks, and non-logical files are never migration inputs.

Review these comparison sets:

- `fileWithoutSchema`: blocker; the file collection has no reviewed Mongo schema plan.
- `sourceWithoutSchema`: blocker; source code references a collection absent from the schema plan.
- `schemaWithoutFile`: warning; the fixture has no file for a planned collection.
- `schemaWithoutSource`: warning for review.

## 3. Plan and source-only dry-run

```powershell
npm.cmd run storage:migration:plan -- --source-only --data-dir <TEMP_DATA_DIR>
npm.cmd run storage:migration:dry-run -- --source-only --data-dir <TEMP_DATA_DIR>
```

The manifest is versioned, sorted, and contains counts and SHA-256 checksums only—never record payloads, URI, or password. Its logical checksum excludes `createdAt`, so timestamps do not change the content identity. A blocker makes the command exit nonzero.

The source-only path does not import or instantiate `MongoClient`, does not connect to a target, does not write MongoDB, does not write the source, and does not change source mtime.

## 4. Isolated apply foundation

There is no `apply-production` mode. The executor API supports `plan`, `dry-run`, and injected `apply-isolated` only. An isolated write requires all of the following:

- explicit `allowIsolatedWrite` authorization;
- a database ending in `_test`, `_staging`, `_sandbox`, `_migration_test`, `_restore_test`, or `_acceptance`;
- a database other than `sandeal`, `admin`, `local`, or `config`;
- an empty target collection or a checkpoint owned by the same migration;
- matching manifest checksum, source checksum, and source count.

The executor never clears a target. It has no drop mode and does not overwrite unowned records.

## 5. Checkpoint and resume

Each checkpoint stores migration ID, manifest checksum, collection, source checksum/count, processed count, batch cursor, state, timestamp, CAS revision, executor lease, and a safe error code. It contains no URI, credentials, or payload.

Resume is allowed only when manifest and source proofs still match. Batches use deterministic idempotency keys. A crash after a batch write but before checkpoint advancement can replay that key without duplicating records. Atomic compare-and-set and the executor lease fence concurrent execution. A failed batch records `FAILED`, never `COMPLETED`.

## 6. Shadow validation

For local/fake validation:

```powershell
npm.cmd run storage:shadow:validate -- --source-dir <TEMP_SOURCE> --target-dir <TEMP_TARGET> --collections products --max-differences 50 --timeout-ms 10000
```

Shadow validation is read-only. `MATCH` requires existence, count, checksum, order, and schema readiness—not count alone. Reports contain paths and redaction flags but no before/after values. Sensitive collections are excluded by default.

## 7. Logical backup and isolated restore verification

```powershell
npm.cmd run storage:mongo:backup -- --fake-target --dry-run --data-dir <TEMP_TARGET> --collections products --database sandeal_migration_test --output-dir <IGNORED_DIR>
npm.cmd run storage:mongo:backup -- --fake-target --allow-backup-write --data-dir <TEMP_TARGET> --collections products --database sandeal_migration_test --output-dir <IGNORED_DIR>
npm.cmd run storage:mongo:restore:verify -- --fake-target --dry-run --snapshot <SNAPSHOT> --database sandeal_restore_test --restore-id <RUN_ID>
npm.cmd run storage:mongo:restore:verify -- --fake-target --allow-isolated-write --snapshot <SNAPSHOT> --database sandeal_restore_test --restore-id <RUN_ID>
```

Logical backup is an application-level verification aid, not a replacement for Atlas infrastructure backup. It strips internal metadata, preserves order, excludes sensitive collections, writes atomically, verifies itself, and refuses overwrite. Restore preflights every target collection, refuses nonempty targets, never drops data, and verifies count/checksum afterward.

## 8. Stop conditions

Stop on any blocker, checksum/count mismatch, source mtime change, schema mismatch, target write during shadow validation, secret in output, nonempty restore target, unsafe database name, network activity in default tests, or regression in file storage. Do not repair a mismatch automatically.

Production cutover requires a separate approved phase and a separately reviewed production runbook.

