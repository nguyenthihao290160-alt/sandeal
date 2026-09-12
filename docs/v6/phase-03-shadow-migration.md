# Phase 3.5 — local shadow migration

SOURCE_TYPE=PRODUCTION_SHAPED_FIXTURE
SOURCE_IS_AUTHORITATIVE=NO
DESTINATION=LOCAL_D1_SHADOW
REMOTE_RESOURCE_USED=NO
REMOTE=false
PRODUCTION=false
SOURCE_HASH_BEFORE=.test-tmp/v6-shadow-proof-00Z0rW/source-hashes-before.json
SOURCE_HASH_AFTER=.test-tmp/v6-shadow-proof-00Z0rW/source-hashes-after.json
SOURCE_CHANGED=NO
INVENTORY=PASS_99_OBSERVATIONS_98_UNIQUE_RECORDS
PLAN=PASS_BATCH_SIZE_10
DRY_RUN=PASS_ZERO_D1_WRITES
FIRST_APPLY=PASS_98_INSERTS_10_BATCHES
VERIFY=PASS
SECOND_APPLY=NO_OP_ZERO_INSERTS_99_SKIPS
SOURCE_VALID=98
DESTINATION_VALID=98
MATCHED=98
MISSING=0
EXTRA=0
CONFLICTS=0
RESULT=PASS
SAFE_FOR_PHASE_4=YES

Completed 2026-09-09. Phase 3 passed before this run: 159 focused migration/D1/File/Mongo cases passed; the earlier 773-case matrix was retained without blindly rerunning it. Phase 3.5 added 14 passing cases, zero failures and zero skips.

The fixture is explicitly synthetic: 32 canonical products, source mappings and offers, four publication states, 64 price observations (including equal-price observations with distinct history IDs), two non-secret mutable settings, and one byte-equivalent duplicate product. Its merchant names and `.invalid` URLs identify test data. No jobs, schedules or unsupported collections are claimed as migrated. Authoritative `.data` remained empty.

Original fixture: `.test-tmp/v6-shadow-proof-00Z0rW/fixture-original/`. Byte-equivalent migration input: its separate `shadow-input/` directory. Destination: ignored `.wrangler/sandeal-shadow/proof-1788948628485-8432dd19/`. The previous interrupted shadow run was retained.

| Input file | SHA-256 before and after (identical) |
| --- | --- |
| automation-settings.json | a0ae7e03577d4cf17d351cbbd58ee0df83deb31d33f84eddcfa48c00ce1b95e0 |
| price-history.json | a17dec08493bb2dc18f28e1a10cdffb2a2d1ffad7daee04d58c14899af8587c6 |
| products.json | c94f5ffeba23d68d973cb1cb5501a48053ed62e8f511f3690086d3aaf225502d |
| scheduler-config.json | bf182caef8e086c195e3240d8226bce5b3607b7f20d31047e879e270d382cf92 |

Both copies' bytes and mtimes were compared after all operations. Before-hashes were persisted before the first CLI invocation. Canonical source fingerprint: `266672612a884c08ec61671b88dc27ba113101ae9c9bf814cf08e24bb0d38f66`. Plan fingerprint: `3d0a5f9be564d6e8bcd700e019d40008f46dd7732dbdd53e98ab541d2fd5eb0e`.

The test calls the actual `scripts/v6-migrate-storage.cjs` in separate processes for inventory, explicit local schema initialization, plan, dry-run, apply, verify, apply and verify. It verifies each product's source identity owners, projected source mappings, exact offer payloads, publication flags, latest history and both settings values against the original fixture.

Failure proof passes: actual CLI rejects remote flags and authoritative `.data` apply (including a false shadow assertion); stale/tampered plans and changed source fingerprints reject before writes; malformed and identity-conflicting records quarantine and block apply; an interruption immediately after a committed product resumes to full parity and a second zero-change apply. Negative source variants are separate directories; the parity source was never changed. Failure injection uses the existing engine hook against a second official local D1 instance.

Repeat with `npm.cmd run test:v6:shadow-migration`. Evidence: `.test-tmp/v6-shadow-proof-00Z0rW/evidence.json`, its eight command logs and both source hash manifests. Test log: `.test-tmp/v6-resume-3-iY9h4P/v6-shadow-migration.log`. Code-hash manifest: `docs/v6/evidence/v6-shadow-migration.json`.

CLOUDFLARE_LOGIN_USED=NO
PRODUCTION_RESOURCE_CREATED=NO
REMOTE_DATA_MIGRATED=NO
DEPLOYED=NO
