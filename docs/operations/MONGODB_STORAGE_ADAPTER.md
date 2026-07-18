# MongoDB Storage Adapter

## Current scope and status

The SanDeal storage compatibility API supports two drivers, selected only on the server:

- `file` is the default when `SANDEAL_STORAGE_DRIVER` is absent.
- `file` is selected explicitly with `SANDEAL_STORAGE_DRIVER=file`.
- `mongo` is selected only with `SANDEAL_STORAGE_DRIVER=mongo` and a valid server-side `MONGODB_URI`.

MongoDB is not enabled for production by this work. No production migration, deployment, SSH operation, PM2 restart, or production cutover is part of M3–M5. Prompt 12 is outside this scope.

## Compatibility and selection

`src/lib/storage/adapter.ts` remains the compatibility facade and keeps these APIs:

- `getDataDir`
- `ensureDataDir`
- `readCollection`
- `writeCollection`
- `runTransaction`
- `findById`
- `insertOne`
- `updateOne`
- `deleteOne`
- `generateId`

The factory loads the Mongo adapter lazily. Importing storage modules, running with the file driver, and building with the default driver do not create a `MongoClient` or require a Mongo URI. Invalid Mongo configuration fails with a stable storage error and never falls back to files.

## Mongo logical model

Each logical collection item is stored in an internal wrapper containing revision, order, optional domain identity, and the domain item. Reads return only normalized domain items in their original order. Internal `_id`, revision, ordering, and migration metadata are excluded from domain checksums, shadow reports, and logical backups.

Collection replacement uses a revision document and a transaction. Revision conflicts are explicit. The business transaction callback is executed once; bounded database retries operate on an already prepared payload and do not replay business logic.

Schema planning, inspection, and apply are separate operations. Schema apply is never triggered by module import, startup, build, health checks, migration dry-run, or shadow validation.

## Environment safety

Use environment names only in committed files. Never paste a connection string into Git, chat, command arguments, screenshots, or reports.

```text
SANDEAL_STORAGE_DRIVER=file
MONGODB_URI=
MONGODB_DATABASE=sandeal
SANDEAL_MONGO_INTEGRATION_TEST=
SANDEAL_ALLOW_ISOLATED_MONGO_WRITE=
```

`MONGODB_URI` must never use a `NEXT_PUBLIC_` prefix. Health and tooling output may show a sanitized database name, but never the URI, credentials, or record values.

## Local tooling

All examples require fixture or isolated data. Do not point these commands at production in M3–M5.

```powershell
npm.cmd run storage:migration:inventory -- --data-dir <TEMP_DATA_DIR>
npm.cmd run storage:migration:plan -- --source-only --data-dir <TEMP_DATA_DIR>
npm.cmd run storage:migration:dry-run -- --source-only --data-dir <TEMP_DATA_DIR>
npm.cmd run storage:shadow:validate -- --source-dir <TEMP_SOURCE> --target-dir <TEMP_TARGET> --collections products
npm.cmd run storage:rollback:check -- --data-dir <TEMP_SOURCE> --collection products --snapshot-checksum <SHA256> --driver file
```

Backup and restore CLI verification in this phase uses only `--fake-target`. Backup writes require `--allow-backup-write`; restore writes require `--allow-isolated-write`. Both have a zero-write `--dry-run` mode.

## Resource bounds

- Migration batch size is bounded to 1–1,000 records.
- Batch retries are explicit and bounded; validation/authentication failures are not retried by default.
- A checkpoint lease and atomic compare-and-set revision fence concurrent executors using the same migration ID.
- Shadow validation has a bounded timeout and `maxDifferences` limit.
- Logical backup has collection-count and byte-size limits and refuses overwrite.
- No TTL index is created. Only the reviewed revision/order and identity lookup indexes are planned.

Shared/free MongoDB clusters have constrained storage, throughput, connections, and operational headroom. Use small fixtures, bounded concurrency, and the limits above. Check the provider's current limits before any separately approved staging or production activity.
