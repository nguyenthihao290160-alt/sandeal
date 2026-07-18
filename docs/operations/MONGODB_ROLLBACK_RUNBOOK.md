# MongoDB Storage Rollback Readiness Runbook

## Meaning of rollback

Rollback means selecting `FileStorageAdapter` through controlled configuration. It does not delete MongoDB, drop collections or indexes, merge Mongo data back into files, overwrite `.data`, or silently fall back from Mongo to files.

M4 validates this procedure only with fixtures and injected/fake targets. It is not evidence of a production rollback.

## Required evidence

Rollback is considered safe only when all conditions are true:

1. `SANDEAL_STORAGE_DRIVER` is absent or exactly `file`.
2. The file directory is readable and writable, and file health passes.
3. The current file collection checksum matches the pre-migration snapshot/checkpoint.
4. No Mongo-only write occurred after that snapshot.

The evaluator returns:

```json
{
  "fileConfigured": true,
  "fileReachable": true,
  "sourceChecksumMatches": true,
  "mongoWriteDetectedAfterSnapshot": false,
  "rollbackSafe": true,
  "blockers": []
}
```

It never returns record values, URI, or credentials.

## Local verification

Use a fixture checksum, not production data:

```powershell
npm.cmd run storage:rollback:check -- --data-dir <TEMP_SOURCE> --collection products --snapshot-checksum <SHA256> --driver file
```

The command is file-only. It does not require `MONGODB_URI`, read MongoDB, write MongoDB, or modify the source file.

## Blockers

- `FILE_DRIVER_NOT_CONFIGURED`
- `FILE_STORAGE_UNREACHABLE`
- `FILE_SOURCE_CHECKSUM_CHANGED`
- `MONGO_WRITES_AFTER_FILE_SNAPSHOT`

Do not declare rollback safe if any blocker exists. In particular, a Mongo write after the file snapshot means the file source is stale, even when file health is green.

## Controlled configuration sequence for a separately approved cutover phase

1. Stop new writes through the separately approved operational mechanism.
2. Capture and compare the reviewed checkpoint/checksum evidence.
3. Confirm there were no Mongo-only writes after the snapshot.
4. Set `SANDEAL_STORAGE_DRIVER=file` through the approved secret/configuration system.
5. Verify file health without a Mongo URI and without writing MongoDB.
6. Resume traffic only after the owning operator approves the evidence.

Do not delete the Mongo target after rollback. Preserve it for investigation and audit. Do not delete or rename `.data`.

