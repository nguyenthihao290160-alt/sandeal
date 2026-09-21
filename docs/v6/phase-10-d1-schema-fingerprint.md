# Phase 10 D1 local rehearsal evidence contract

## Scope

This is a local evidence repair, not permission to authenticate, migrate, deploy,
create resources, send Queue messages, write secrets, or change traffic. The
runner uses installed Miniflare/workerd directly, with an inline inert Worker,
loopback listener, one ephemeral D1 binding, persistence disabled, no Wrangler
configuration, no account identifiers, no Queue binding, and no dotenv loading.
It never imports the application or runs a production command. The production
zero-effect counters describe this invocation only, not historical provisioning.

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
along with the initial clean Git gate and hashes of the harness, this document,
package manifest, lockfile, and existing local migration helper. New harness files
are working-tree artifacts, not falsely claimed to be present at the source HEAD.

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
steps are recorded independently. Prefix resumes after 0003/0006/0009 inspect the
ledger and schema before resuming; existing migration entries must be skipped,
and final canonical schema and control/business counts must equal clean install A.
These are empty-business-prefix proofs, not populated-production upgrade proofs.

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

The installed D1 authorizer denies `integrity_check` and access to internal
`_cf_METADATA` columns. `table_xinfo` and `index_xinfo` work for application
objects. The method excludes that exact internal table and uses the supported
`quick_check`, explicit index metadata/query plans and negative uniqueness probes;
it does not misreport a full SQLite `integrity_check` as having run.

## Reproduce and review

Requires the repository's installed lockfile dependencies and Node 22+ (within
the package's supported range). No dependency install, authentication or network
credential is needed. From a clean checkpoint, capture the gate before repair:

```text
node scripts/phase-10-d1-evidence-repair.mjs capture-gate
node scripts/phase-10-d1-evidence-repair.mjs repair
node scripts/phase-10-d1-evidence-repair.mjs verify
node scripts/phase-10-d1-evidence-repair.mjs replay
```

The initial implementation's clean gate was captured before creating these
harness files. `repair` accepts only the explicitly classified repair files as
new dirty changes; it requires an unchanged HEAD, empty index, unchanged SQL and
unchanged Phase 5 bytes. It generates structured evidence and runs TypeScript,
ESLint, secret scan, diff checks and focused tests. `verify` checks the durable
mapping, current hashes, implementation hashes, embedded canonical schema and
cross-report bindings without creating a database. `replay` independently reruns
the local installations/resumes/failure/safety checks and compares fingerprints
without rewriting durable evidence. Reports/logs in `.test-tmp` are disposable
and are not the sole source of any required conclusion.

## Previous hash and authorization limits

The previous fingerprint was
`765242eb594e24acd01c1e35ee5a9c13c9a31754b18d6a828f1a7729da2d3859`.
Its historical report contains neither a source mapping nor a fingerprint method.
Do not infer an old algorithm or claim a schema change solely from a hash mismatch.
The new method becomes authoritative for this local evidence only after A/B and
replay validation. Preserve the actual comparison and explain any change as a
newly specified representation, with the old method explicitly unknown.

Re-audit readiness is NOT migration authorization. The replacement preauth report
withdraws the unsupported old blanket PASS/YES and records local evidence checks
and an exact rehearsal-file SHA-256 reference. No current production identity,
empty baseline, backup/export, Time Travel, permissions, change window or approval
is certified by local execution. None is silently inherited from old booleans.

Recovery limitations: committed migrations are not automatically reversible;
0004/0005/0006/0009 include table-copy/drop transformations. Code rollback does not
undo schema/data. No production backup or restore has been tested here. Before a
separately authorized production attempt, a human must approve the final clean
checkpoint and byte inventory, revalidate the exact production identity/ledger/
empty baseline, review current remote transaction semantics, authorize and verify
the actual backup/recovery procedure, establish a change window and abort owner,
quiesce writers and Queue consumers, and issue explicit migration permission.
Unknown, nonempty, drifted or partially applied targets must stop for review; no
automatic reset, reverse SQL, force-apply or production retry is provided.
