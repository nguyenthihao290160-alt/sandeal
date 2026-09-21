# Phase 10 D1 repaired-0009 and partial-production evidence contract

## Scope

This is a local evidence repair, not permission to authenticate, migrate, deploy,
create resources, send Queue messages, write secrets, or change traffic. The
runner uses installed Miniflare/workerd directly, with an inline inert Worker,
loopback listener, one ephemeral D1 binding, persistence disabled, no Wrangler
configuration, no account identifiers, no Queue binding, and no dotenv loading.
It never imports the application or runs a production command. The production
zero-effect counters describe this invocation only, not historical provisioning.

Production is **not empty**: the verified incident baseline has exactly 0001..0008
applied; 0009 failed and 0010 remains pending. This task does not reinspect or write
production. The immutable incident is
`docs/v6/evidence/phase10-d1-production-migration.json`, still `FAIL`, with the first
attempt stopped at 0009. Its original byte hash is checked before and after every
regeneration. The staged incident entry is preserved; this runner never stages,
commits, pushes, invokes Wrangler, or retries a production migration.

## Exact source binding

The ordered allowlist is exactly the ten SQL files 0001 through 0010 under
`src/lib/storage/d1/migrations`. An extra, missing, or renamed SQL file fails.
SHA-256 and byte length cover the original on-disk bytes, including comments,
statement markers, BOM if any, and line endings; no source normalization occurs.
UTF-8 round-trip validation rejects invalid input. Each migration is decoded from
the same captured bytes, split only at the existing `-- statement-breakpoint`
markers, trimmed, and submitted in a single D1 `batch` followed by its migration
ledger insert. Standalone comment-only segments are omitted. Trigger bodies are
never split on semicolons. This matches the local migration helper's batching
contract; it is not a rehearsal of the remote Wrangler migration command.

Every applied step records its source hash, byte length, statement count, ordered
submitted-statement digest, ledger, resulting schema digest, inventory counts,
foreign-key check and row counts. Current source bytes are rechecked after every
run and at final verification. The ordered source mapping is itself hashed using
the canonical JSON encoding below. The source Git HEAD and branch are recorded,
along with the classified dirty repair gate and hashes of the harness, this document,
package manifest, lockfile, and existing local migration helper. New harness files
are working-tree artifacts, not falsely claimed to be present at the source HEAD.

The repair audit compares raw SQL bytes to incident Git HEAD
`833ba419280edbe6d0e2e10abe07a50160762771`. Migrations 0001..0008 and 0010 must be
byte-identical. Migration 0009 must be exactly the original bytes after replacing
only the two enumerated `SELECT CASE WHEN ... THEN RAISE(...) END;` expressions in
`content_source_cap` and `content_audit_cap` with `SELECT RAISE(...) WHERE ...;`.
Predicates, limits (16 sources and 256 audits), ABORT messages, trigger WHEN clauses,
table definitions, columns and constraints remain unchanged. A token-level guard
rejects CASE reintroduction, missing bodies and cap-policy changes. This is a local
regression guard against the known failed shape, not proof that a remote retry
will succeed. No remote parser request is made.

## d1-schema-canonical-v1

Implementation: `scripts/lib/d1-schema-canonical.mjs`.

1. Read `type,name,tbl_name,sql` from `sqlite_schema`. Include every user table,
   view, trigger and explicit index. Exclude names beginning `sqlite_`, the exact
   infrastructure tables `_cf_KV`, `_cf_METADATA` and `d1_migrations`, and their owned objects.
   SQLite implicit indexes are nevertheless included through each included
   table's `index_list`. No business-table name is excluded from the schema.
2. Sort table, trigger, view and per-table index arrays by name with JavaScript
   ordinal string comparison (UTF-16 code units), never locale-sensitive sorting.
   Object key ordering uses the same comparator recursively.
3. Columns come from `table_xinfo`, sorted numerically by `cid`. Include `cid`,
   name, normalized declared type, declared `notnull`, normalized default (SQL
   NULL stays JSON null), primary-key ordinal and hidden/generated-column flag.
   A separate primary-key list is sorted by key ordinal. `notnull` describes the
   pragma value, not an inference about INTEGER PRIMARY KEY rowid semantics.
4. Foreign keys come from `foreign_key_list`. Group by its transient FK id, then
   discard that id. Include parent table, ON UPDATE, ON DELETE, MATCH and ordered
   `(ordinal, from, to)` column mappings. Sort groups by canonical JSON. Preserve
   full table SQL as well, including deferrability and other unexposed details.
5. Indexes include name, unique flag, origin (`c`, `u`, `pk`), partial flag and
   normalized SQL (null for implicit indexes). `index_xinfo` entries include
   ordinal, cid, name, descending, collation and key flag, sorted by ordinal.
   Include rowid/expression markers and auxiliary columns, not just key columns.
   Implicit names are schema-derived names, not `sqlite_sequence` data values.
   A WITHOUT ROWID primary-key index can lack a `sqlite_schema` row: its SQL is
   null and its complete index metadata still comes from the pragmas. A missing
   explicit index definition fails closed.
   Partial predicates and expression definitions remain in index SQL.
6. Include each trigger's name, owning table and complete normalized SQL, and
   each view's name and normalized SQL. Include full normalized table CREATE SQL
   so CHECK, UNIQUE, COLLATE, generated columns, STRICT/WITHOUT ROWID and all
   other DDL details cannot silently disappear. CHECK expressions are additionally
   extracted in source occurrence order using balanced parentheses and SQL tokens.
7. SQL normalization tokenizes SQL, discarding only ASCII whitespace and comments
   outside quotes, then joins tokens with one ASCII space. Recognize single-quoted
   strings, double-quoted/backtick/bracket identifiers, doubled closing quotes
   (except bracket identifiers), numeric/hex/blob literals, identifiers, operators
   and punctuation. Preserve token spelling, case, quote style, semicolons and all
   bytes inside literals/quoted identifiers, including whitespace/newlines. No
   Unicode normalization, case folding, expression rewriting or semantic SQL
   equivalence is claimed. Unterminated quotes/comments and unsupported tokens
   fail closed. Comments or whitespace inside literal values are NOT stripped.
8. Serialize `{methodVersion,tables,triggers,views}` by recursively sorting object
   keys, preserving the explicitly ordered arrays, and applying `JSON.stringify`
   without indentation. Append exactly one LF (`\n`), encode as UTF-8 without BOM,
   and compute lowercase hexadecimal SHA-256. Embedded string newlines are JSON
   escapes; the file's pretty-print indentation is not part of the fingerprint.

The complete canonical object is embedded in the rehearsal JSON, not just a hash
or an ignored log reference. Rehash `canonicalJson(evidence.canonicalSchema)` to
independently verify the recorded representation. Paths, timestamps, root pages,
rowids, pragma enumeration sequence numbers, ledger timestamps, SQLite internal
sequence values, file locations and engine versions are not schema-hash inputs.
Engine versions remain explicit provenance outside the canonical object. New
engine versions require revalidation; cross-version SQL spelling is not assumed.

## Counts, seeds and local checks

`tables` counts all included application tables. `indexes` counts explicit indexes;
`implicitIndexes` and `allIndexes` report the additional UNIQUE/PK indexes. Historical
54/87/50 values are observations to compare, not hard-coded success criteria.
`migrationLedgerTables` reports the separately observed ledger table, and
`tablesIncludingMigrationLedger` adds it to the application-table count. Neither
count includes SQLite or Cloudflare internal tables. This makes a 53-application-
table inventory distinguishable from a 54-table inventory including the ledger.

All application tables are counted individually. Only `affiliate_revenue_cursor`
is classified as migration-owned control data: exactly the `revenue-v1` row with
`last_sequence=0` and `claim_key=null`. It is reported, never silently treated as
business data or erased. Migration ledger rows and SQLite/Miniflare infrastructure
are separately excluded from business rows. Every other application table must
have zero rows after a clean install and after each empty-prefix resume.

Install A and B use separate, freshly constructed and disposed Miniflare instances.
Before ledger creation their application schema and ledger are absent. All ten
steps are recorded independently. Prefix resumes after 0003/0006/0008/0009 inspect the
ledger and schema before resuming; existing migration entries must be skipped,
and final canonical schema and control/business counts must equal clean install A.
These are empty-business-prefix proofs, not populated-production upgrade proofs.

The 0008 prefix is an independent fresh database and is the required rehearsal of
the current production history. Its complete canonical schema, ordered eight-row
migration ledger, per-table row counts, control row, FK/quick checks and inventory
counts are durable in `partialResumes` under `0008_opportunity_experiments.sql`.
The pre-0009 fingerprint must also equal step 0008 of clean installs A and B.
0009 and 0010 ledger entries and partial 0009 objects must be absent. Then the
runner applies only 0009, captures its success, and separately applies 0010. The
eight existing ledger entries are skipped, not reapplied. Final canonical schema
must match both repaired clean installations.

Failure injection uses a third disposable database at 0003 and the exact captured
0004 statement batch, with a deliberate final CHECK failure before the migration
ledger append. The proof compares pre/post schema, ledger and data, verifies
table-copy/drop work rolled back, and then retries unmodified 0004..0010. A
separate successful-batch positive control confirms the DDL/data probes can take
effect; the failing batch also exercises a ledger insert before the failure.
This proves local D1 batch atomicity, not whole ten-file atomicity or remote
Wrangler behavior. Earlier committed migration steps remain committed on failure.

Read-only safety checks inspect every FK target/column, run `foreign_key_check`
and `quick_check`, inspect every index component and compile INSERT/UPDATE/
DELETE EXPLAIN statements for every table (all writable columns in UPDATE) so
trigger bodies and UPDATE OF references are checked. Explicit negative constraint,
uniqueness, FK, immutable-money and execution-control probes use a separate local
fixture database. Synthetic business rows in that probe database are disclosed;
they never seed clean installations or production. These are bounded regression
probes, not an exhaustive theorem about all application behavior.

The isolated policy fixture permits source 16, rejects source 17 with
`CONTENT_PRODUCT_CAP`, and preserves the duplicate-source conflict path at the cap.
It permits audit 256, rejects audit 257 with `CONTENT_AUDIT_CAP`, and checks that the
counter and row total stay 256. Synthetic fixture rows are explicitly reported;
the two clean installations and every migration-prefix rehearsal have zero
business rows. The existing single revenue cursor control seed is not business data.

The installed D1 authorizer denies `integrity_check` and access to internal
`_cf_METADATA` columns. `table_xinfo` and `index_xinfo` work for application
objects. The method excludes that exact internal table and uses the supported
`quick_check`, explicit index metadata/query plans and negative uniqueness probes;
it does not misreport a full SQLite `integrity_check` as having run.

## Reproduce and review

Requires the repository's installed lockfile dependencies and Node 22+ (within
the package's supported range). No dependency install, authentication or network
credential is needed. After classifying the incident/repair files, capture a new
gate at the current HEAD (do not reuse the pre-repair gate):

```text
node scripts/phase-10-d1-evidence-repair.mjs capture-gate
node scripts/phase-10-d1-evidence-repair.mjs repair
node scripts/phase-10-d1-evidence-repair.mjs verify
node scripts/phase-10-d1-evidence-repair.mjs replay
```

`capture-gate` accepts only the repair allowlist and, if present, the already
staged incident file. It records the actual dirty/index state rather than claiming
clean Git. `repair` requires unchanged HEAD, exact index-diff hash, captured repaired
SQL, immutable incident, preserved forensic artifacts and unchanged Phase 5 bytes.
It generates structured evidence and runs TypeScript,
ESLint, secret scan, diff checks and focused tests. `verify` checks the durable
mapping, current hashes, implementation hashes, embedded canonical schema and
cross-report bindings without creating a database. `replay` independently reruns
the local installations/resumes/failure/safety checks and compares fingerprints
without rewriting durable evidence. Reports/logs in `.test-tmp` are disposable
and are not the sole source of any required conclusion.

The two confusing SQL files are `TEMP_FORENSIC_ARTIFACT`, not repository fixtures:
`.test-tmp/isolated/0001_test.sql` is byte-identical to pre-repair 0009, renamed for
isolated parser reproduction; `.test-tmp/bisect/0001_base.sql` is byte-identical to
0001 and served as a bisection baseline. Neither is in the migration source set.
Eight untracked one-off scripts/configurations from the investigation are retained
byte-for-byte as `.txt` files under `.test-tmp/phase10-0009-forensics/`, not executed
or committed. The evidence gate records every original path, preserved path,
classification, reason and hash. Existing `.gitignore` already excludes `.test-tmp`.

## Previous hash and authorization limits

The older undocumented fingerprint was
`765242eb594e24acd01c1e35ee5a9c13c9a31754b18d6a828f1a7729da2d3859`.
Its historical report contains neither a source mapping nor a fingerprint method.
Do not infer an old algorithm or claim a schema change solely from a hash mismatch.
The pre-repair `d1-schema-canonical-v1` fingerprint was
`e5c45918f92463f24a675bf7c62407714b3110ce1929b2108703a8fa22e190c1`.
It is **historical only and invalid for current authorization**. The authoritative
repaired post-0010 fingerprint is `schemaFingerprint` in the newly generated
rehearsal, bound to all ten current migration hashes and matching A/B results.
The canonicalization algorithm has not changed. Replacing only the two repaired
trigger bodies in the new canonical schema with their historical forms must
reproduce the old fingerprint exactly; this proves no other canonical schema
definition changed.

Re-audit readiness is NOT migration authorization. The replacement preauth report
withdraws all previous empty-production authorization assumptions and records local
evidence checks and an exact rehearsal-file SHA-256 reference. Its expected target
is account `88d3839bee4ac092d39fbb293e3eb426`, D1
`bdf42c22-190d-4cdf-a166-a9e07ade57f2` (`sandeal-production`). A future separately
authorized read-only audit must verify that identity, the exact ordered 0001..0008
history, absent 0009/0010 metadata, absence of every partial 0009 object/effect,
the expected pre-0009 canonical fingerprint, zero business rows and the exact
control seed. Missing or mismatched observations fail closed. Local mutation
tests cover each of these rejection conditions.

`readyForD1PartialBaselinePreauthAudit=YES` means only that the local prerequisites
for that audit are ready. `authorizationDecision=NO` and
`productionMigrationAuthorized=false` remain mandatory. No current production
identity, baseline, backup/export, Time Travel, permissions, change window or
approval is certified by local execution. None is inherited from historical flags.

Recovery limitations: committed migrations are not automatically reversible;
0004/0005/0006/0009 include table-copy/drop transformations. Code rollback does not
undo schema/data. No production backup or restore has been tested here. Before a
separately authorized production attempt, a human must approve the final clean
checkpoint and byte inventory, revalidate the exact production identity/ledger/
eight-migration baseline, review remote transaction semantics, authorize and verify
the actual backup/recovery procedure, establish a change window and abort owner,
quiesce writers and Queue consumers, and issue explicit migration permission.
Only 0009 then 0010 can be considered in a future authorization; never rerun
0001..0008. Unknown histories, populated business data, drift or partial 0009
effects must stop for review; no
automatic reset, reverse SQL, force-apply or production retry is provided.
