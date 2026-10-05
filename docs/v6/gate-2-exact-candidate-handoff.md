# Gate 2: exact reviewed candidate, local only

This adds an offline Option A handoff, not a deployment command. Only VERIFY and
PREPARE are implemented. There is no Cloudflare client, credential lookup, login,
build, signing, migration, Queue/Cron execution, upload, promotion or CI dispatch.
No existing application, runtime authority gate or production config is changed.

## Review pins and provenance

`config/cloudflare/gate2-exact-candidate.contract.json` is the independently
reviewable trust root. It pins source commit
`4c1e501ad7ca07741f07d89dd30fadc1957c8711`, branch `master`, the local tracking ref
`refs/remotes/origin/master`, candidate
`1687ef0f1a333abab319317c44f4d9c74fb75899e51addda0836419c4dd93146`, exact reference
and final-integrity bytes, 1 Worker plus 109 static files, account
`88d3839bee4ac092d39fbb293e3eb426`, and Worker `sandeal-production`.
These identifiers are non-secret metadata, not production credentials.

The CLI does not accept alternate pins or read approval from environment variables.
Changing this contract requires a separate human review; a new self-consistent
candidate cannot approve itself. Programmatic directory/policy/checkout/clock
injection exists only for isolated synthetic unit fixtures, not as CLI overrides.
Protect the reviewed driver and this trust root from unreviewed modification.

The driver reuses the existing canonical SHA-256, artifact fingerprint/inventory,
and two-build validation implementations. It rehashes the original reference body,
all referenced evidence and build logs, source inventory, exact Worker bytes, and
the entire static directory, with no extension filters. It compares both clean
builds, the reference and final review inventory. Missing, additional or modified
deployable files fail. Paths, symlinks/junctions, unknown handoff fields and extra
package files fail closed. The source SHA, branch, Git tree and local remote-tracking
SHA must match the pinned source and the index must be clean. No fetch/remote query
is made: the tracking ref is not a fresh attestation of the remote server.

Unlike the existing current-checkout reference verifier, this verifier does not
rebuild or relabel the current worktree. Gate 2 tooling can be unstaged while it
verifies the retained, clean-source candidate. The copied source inventory and
pinned review prove that candidate's source, not that a dirty worktree was built.
An eventual tooling commit or source change requires explicit review of how the
pinned-source checkout and driver are supplied; there is no HEAD fallback.

## Local commands

Run from the repository root, with the already-installed dependencies. The first
command defaults to VERIFY and performs no writes. The second copies only already
verified bytes, exclusively into a new direct child of ignored `.test-tmp`.

```text
node scripts/phase-10-exact-candidate.mjs .test-tmp/phase10-local-clean-4c1e501-20261003/phase10-production-release-bundle.json
node scripts/phase-10-exact-candidate.mjs prepare .test-tmp/phase10-local-clean-4c1e501-20261003/phase10-production-release-bundle.json .test-tmp/gate2-reviewed-handoff
node scripts/phase-10-exact-candidate.mjs verify .test-tmp/gate2-reviewed-handoff/handoff.json
node scripts/phase-10-exact-candidate-tests.mjs
```

An existing destination is never overwritten. Copying rechecks hashes, then the
entire package is reverified; a failed/interrupted copy is not a prepared release.
The exact reviewed candidate is never changed. A package contains `handoff.json`,
`artifacts/worker.mjs`, `artifacts/assets/` and referenced evidence under `evidence/`.
Metadata is not part of the 110 deployable artifacts. Verification of a package
does not depend on the original build output still being available.

The conservative **local review** age limit is seven days from the pinned
October 4, 2026 04:50:25.284 UTC review, expiring October 11, 2026 04:50:25.284 UTC.
This is not production certification freshness. Copying or preparing a package
cannot refresh it; a stale review needs separate review and new pins. Future-dated
and invalid clock values also fail. Local success never refreshes operational or
human authority evidence.

## Handoff, assets and phase boundaries

The handoff binds source/tree, candidate ID, Worker path/hash, all static paths,
sizes/hashes/count, target account/Worker/environment, configuration fingerprint,
release fingerprint and evidence. `noBundle=true` forbids future rebuilding or
transforming the reviewed Worker. `UPLOAD_INACTIVE` is the only intended future
deployment mode; it is metadata, not an available command.

`ASSETS` must associate this exact static inventory with the same inactive Worker
version, with all-request Worker-first gating. A declaration or local match does
not prove the remote binding exists. The future remote verifier must compare the
actual uploaded Worker, asset identity and configuration before any promotion.
No package generated here is a Wrangler deployment config or a runtime approval.

| Phase | Gate 2 behavior | Independent future requirement |
| --- | --- | --- |
| VERIFY | Local read-only hash/inventory/target checks | No authority granted |
| PREPARE | Local exclusive copy and reverification | No authority granted |
| UPLOAD_INACTIVE | Blocked; no executor | Fresh target/handoff-bound production certification and explicit human upload authorization |
| VERIFY_REMOTE_VERSION | Blocked; no remote access | Verify inactive remote Worker, assets and configuration without shifting traffic |
| PROMOTE | Blocked; no executor | Verified remote version, compatible rollback pair and separate explicit human promotion authorization |

Verification can pass with certification and authorization absent because its
result is explicitly `PASS_LOCAL_ONLY_NOT_DEPLOYMENT_AUTHORIZATION`. Every future
phase reports `allowed=false` and `mutationAllowed=false`, with missing certification
and deployment authorization as separate blockers. Supplied booleans or local PASS
claims are not authenticated authority. Even supplied claims cannot unblock an
unimplemented phase. Implementing a future remote executor and external authority
verification requires a separate authorized change; never add a fallback deploy,
automatic login, force option or environment-only approval.

Before any future mutation boundary, that separately reviewed executor must rerun
the package/target checks against independently approved pins and authenticate
fresh, operation-specific authority bound to the exact handoff fingerprint. Never
consume a saved local PASS as permission, infer an account from credentials, choose
a Worker from the current branch, rebuild on upload, or promote as an upload side
effect. A hash demonstrates identity and integrity, not human authorization.

## Rollback and runtime control

Rollback metadata pairs source, candidate, Worker hash, static fingerprint,
configuration and release identities. Remote Worker version, deployment, asset
version and previous compatible release are all null/UNVERIFIED. No historical
production rollback target is invented; promotion stays blocked until a separately
verified compatible pair exists.

D1 schema certification is not deployment certification or runtime activation.
Required future records are `release_bundles` and `execution_controls`. Gate 2
neither reads nor creates them. Their local readiness is UNVERIFIED and their
absence must fail closed. Execution, Queue and Cron remain disabled. Runtime
activation requires separate authority, never upload/promotion authorization.
The focused suite calls existing production read-only handlers with in-memory
SELECT-only stubs to prove absent records still yield 503 without writes, asset
serving, Queue/Cron execution or signature creation.

The focused fixtures never use production credentials or the retained candidate.
Existing release-identity, build-handoff and release-reference tests are safe to
run separately. The full preauth suite is outside this gate: it signs synthetic
approvals, rebuilds the shared Worker output, creates/writes local D1 records and
exercises Queue/Cron handlers. Do not run it as part of this local-only handoff.

Keep all four Gate 2 files unstaged for human review. Local validation does not
authorize staging, a commit, a push, a deployment or any production mutation.
