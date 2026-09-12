# Resume long run 3

BRANCH=master
HEAD=3f2ee7d8bd1ef57fa9207f021cc03519b7eecde7
PHASE3_EVIDENCE_REUSABLE=NO_FOR_COMPLETE_HASH_ATTESTATION
PREVIOUS_MATRIX_RETAINED=773_PASSED_0_FAILED_44_SUITES
FULL_MATRIX_RERUN=NO

Reconstructed on 2026-09-09. The Phase 2.6 snapshot, Phase 3 report, all 44 matrix logs and `.test-tmp/v6-validation-AvQEr4/results.json` exist. The recovery snapshot matches 78 of 84 current files. Differences are `package.json`, the Mongo adapter test, File adapter, local D1 helper, validation runner and D1 adapter. These are consistent with the documented Phase 3 implementation. HEAD and branch match the saved reports. The dirty worktree was preserved.

Phase 3 did not persist a complete code-hash manifest. Its CLI, source guard and focused test file also have modification times after the matrix's migration test log. The report says a focused recheck passed, but a separately hash-attested recheck was not found. Therefore the old ledger remains historical evidence, and the affected migration, D1, File and Mongo suites are revalidated. Unrelated scheduler, provider and business suites are not automatically rerun as part of reconstruction.

Phase 3.5 had only completed fixture inventory and isolated local schema initialization in `.test-tmp/v6-shadow-proof-7FHIfn`; there was no completed parity evidence or Phase 3.5 checkpoint. Its existing source and database are retained. A repeatable fresh isolated fixture run will supply the missing proof after Phase 3 passes.

`LONG_RUN_STATE.json` is updated after each suite and major gate. `scripts/v6-run-state.cjs` records SHA-256 manifests in `docs/v6/evidence/`; the state excludes itself and generated evidence from its fingerprint to avoid self-reference. Secret environment files, ignored runtime data, dependencies and build output are not recorded. `scripts/v6-resume-validation.cjs` runs explicitly named suites, stores logs, and stops on failure or skipped cases.

No login, remote resource, remote migration, deployment, commit or push is authorized for this run.
