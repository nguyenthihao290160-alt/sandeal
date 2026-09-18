# Phase 9.5 — Local pre-production readiness rehearsal

## Status and resume boundary

**PASS — local rehearsal only; stop for the Phase 9.5 precommit audit.** This records a historical certificate, not production authorization or an ongoing execution permission.

- Branch: `master`; baseline HEAD: `1fda09b7d0e9fdaac6a315b4aa50d3da326adeab`. The existing worktree was retained; no reset, rollback, commit or push occurred.
- Read-only reconstruction verified all 696 source-file hashes against the interrupted 59-pass report and verified its raw log hash. Source had not changed after those checks. The first unverified step was regressions, not implementation.
- The 59 checks were initially reused. All 20 required/affected regression suites then ran: **873 passed, zero failures/skips**. Historical evidence writes were isolated from the prior checkpoint.
- Real artifact certification correctly blocked Next.js export filenames containing `$d$slug` and `[slug]`. The only source remediation adds those filename characters to the artifact allowlist; traversal, absolute-path, encoding, fingerprint and source-binding checks remain enforced.
- Two additive tests cover the actual filename shapes and seven unsafe path shapes. Every pre-existing assertion is unchanged. The affected Phase 9.5 suite was rerun: **61 passed, zero failures/skips**. The original 59 are superseded, not counted twice.
- The 873 regressions were not repeated after this isolated fix: all 694 other source files, all regression tests, the shipped Worker dependencies and raw regression log hashes are unchanged. Exact before/after hashes and the reuse rationale are recorded in the structured evidence.
- **934 unique verified checks = 61 final focused + 873 regressions.** Final-source TypeScript, ESLint, secret scan, diff checks, two Worker/static builds and source-bound certification passed.

## Source-bound release

- Candidate: `rc-8ae580e1c0fb177c728efdccb683d2af56922aa7c81724430ebf3c94b9a56aef`.
- Final source fingerprint: `be2c47bbe9522a583b4812c6d6bbf509deecf18a8968f6dd5d476c8ee361e11d`.
- Algorithm: `release-rehearsal-v1`; local source inventory includes tracked and nonignored untracked source/configuration/test files, excludes documentation and secret environment files. Documentation is covered separately by the long-run working-tree fingerprint.
- Worker artifact: `aa756a30780c26c52c1506a0535dddbfece866cf325cf47e4835560fc21acddc`; one file, 379507 bytes.
- Static artifact: `dc8eaa9b3dd6b2f4f607cb49295a6d661f9033d330310c6d7a81b56b21a412b3`; 109 files, 1437090 bytes.
- The actual artifact bytes were rehashed before certification. Worker builds are byte-identical. Static builds have recorded Next.js build-ID/output variance; **byte-for-byte static reproducibility is not claimed**.
- D1 `DB`, Queue `JOB_QUEUE`, assets `ASSETS`, local-only runtime flags and configuration fingerprint are bound to the manifest. Secret references are empty; no raw credentials are present.
- No production dependencies or package/lock changes were introduced. The Worker still excludes file-storage, Mongo and filesystem-settings modules.

## Migration and rollback scope

All ten existing migrations were applied to clean ephemeral local D1. A separate representative 0009 baseline was upgraded with additive 0010. Fourteen keyed synthetic product/offer, click/conversion/commission/ledger/revenue, deal, decision, opportunity and content fixtures retain identical before/after hashes. The migration ledger preserves persisted execution receipts and inline rollback evidence on repeat application. Historical destructive/review-required migrations retain those classifications; only 0010 is pending against the representative baseline. No production schema or data was inspected.

Rollback coverage **FULL** means capability-scoped inline plans for every critical reversible member of the **local fixture bundle**. It is not an artifact restore, database downgrade, external rollback or production recovery implementation. The drill reports `restored=false`. Duplicate, stale, cross-proposal, wrong-environment, wrong-target, wrong-fingerprint and missing-prior-state cases are covered by passing assertions.

Fresh candidate-bound local D1 drills verify active/unknown kill switches and emergency stop block execution. Emergency-stop and certification databases are separate, ephemeral instances. No production control is reset.

## Canary, observability and certificate safety

The canary plan is deterministic local planning only: every stage has `executable=false` and production traffic remains zero. Unknown blast radius, unknown thresholds, missing abort conditions and attempted nonzero traffic block readiness. Observability is configured local safety thresholds, not production measurements or approved business SLOs. Queue/D1/retry/resource bounds reuse the existing contracts; no scheduler or continuous polling is added.

Certificate state: `CERTIFIED_LOCAL_PREPROD`; issued 2026-09-18T00:12:24.619Z, expires 2026-09-18T00:15:30.157Z. This historical checkpoint does not extend that expiry. Retrieval revalidates source, artifacts, candidate identity, approvals, controls, environment and time; stale, duplicate, superseded, cross-environment and stale-artifact attempts confer no new authority. A commit changes HEAD and invalidates source identity.

Approvals and provider availability are explicit local fixtures, not authenticated production-human approvals or live provider observations. AI has no execution authority. Direct Shopee remains disabled without credentials; no direct calls or live AI probe ran. All zero-production-effect counters describe actions performed by this rehearsal, not an inspection of an external production system.

## Evidence and history

- Compact durable evidence: `docs/v6/evidence/phase9-5-preproduction-readiness.json`.
- Full exact manifest, artifact inventory, A–Z matrix, case results and log fingerprints remain in ignored `.test-tmp/phase9-5/` reports, individually SHA-256-bound by the durable summary.
- Pre-fix reports are retained under `.test-tmp/phase9-5/pre-artifact-path-fix/`; nothing is deleted or relabeled as freshly executed.
- ESLint: zero errors, 68 existing warnings, output identical to the earlier successful lint run.
- `LONG_RUN_STATE.json` preserves all prior Phase 5–9 objects, all 11 prior checkpoints and all 51 prior evidence entries; adds one Phase 9.5 checkpoint/evidence entry; UTF-8 without BOM and no duplicates.
- No Phase 10 work, production mutation, money transaction, Cloudflare login/deployment/resource creation, production migration, DNS change or production traffic shift occurred.

## Operator handoff

The completed modes are `regressions`, `focused` after the narrow path fix, `build`, `quality`, and `certify` in `scripts/v6-phase9-5-validation.mjs`. Do not restart the rehearsal merely to repeat verified work. Audit the exact source and report hashes, scoped reuse evidence, artifact byte hashes, migration inventory, rollback limitations and historical certificate boundary. Any later source/artifact change requires affected revalidation and a newly bound certificate before local reuse.

`SAFE_FOR_PHASE9_5_PRECOMMIT_AUDIT=YES``NEXT_STEP=STOP_FOR_PHASE9_5_PRECOMMIT_AUDIT`

**STOP. No commit, push, deployment, Cloudflare login, production migration, DNS change, traffic shift or Phase 10 is authorized.**
