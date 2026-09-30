# Phase 10 - local current-candidate reference

This procedure builds and inventories the current checkout. It never deploys,
uploads a Worker version, contacts production, installs approval, enables
execution, stages files, commits, or overwrites durable historical evidence.
The September 26 release reference and its ignored finalizer remain historical.

## Build identity and origin

`SANDEAL_RELEASE_ID` takes precedence over `GIT_COMMIT_SHA`; supplying different
nonempty values is an error, not an override. Production requires an explicit
full Git SHA matching HEAD. `NEXT_PUBLIC_SANDEAL_RELEASE_ID` is derived from that
commit, not a third fallback; if supplied, it must match. The build helper passes
only these three identity variables plus its existing system/profile allowlist.
For LOCAL and PRODUCTION_REHEARSAL only, absence of both authoritative variables
causes the helper to supply Git HEAD. Missing production identity still fails.
The static config uses the same resolved commit for `deploymentId` and public
release identity; no timestamp is a release identifier. Installed Next.js 16.2.11
uses a constant internal BUILD_ID when `deploymentId` is present and bypasses
`generateBuildId` (`node_modules/next/dist/build/index.js`, `getBuildId`). Do not
replace deployment skew protection or mistake that opaque internal ID for the
application release SHA. The build report reads the embedded public identity and
deployment ID from `.next/required-server-files.json` and records the internal
`nextBuildId` separately, consistent with existing release-identity tests.

The operator-selected application origin `https://app.sandeal.tech` satisfies
the explicit real-HTTPS-origin contract in `phase-10-preauth-contracts.md`.
This is an input decision, not DNS, Custom Domain, or live route verification.
The nullable historical domain/route contract is not silently rewritten.
Noindex/nofollow and all-request Worker-first routing remain mandatory.

## Inputs and invocation

Create a sanitized JSON input under ignored `.test-tmp` with exactly:

- `schema`: `sandeal-phase10-release-reference-input-v1`.
- `expectedHead`, `expectedBranch`: reviewed current Git identity, checked before
  work. `allowDirtySource`: explicit boolean; use `true` only for local patch review.
- `origin`: selected production HTTPS origin; `originSource`:
  `USER_SELECTED_APPLICATION_ORIGIN` or `REVIEWED_REPOSITORY_CONTRACT`.
- `configPath`: repository-relative Wrangler configuration path. The installed
  Wrangler configuration reader parses it locally; no Wrangler deploy is invoked.
- `target`: explicit `accountId`, `workerName`, `databaseId`, `databaseName`,
  `queueName`, `queueId` from reviewed non-secret references. These remain
  reference-only; the procedure cannot authenticate their current remote state.
- `routing`: `domain`, `domainState` (`USER_SELECTED_NOT_LIVE_VERIFIED` or
  `REFERENCE_ONLY`), `route` (null or the exact selected domain plus `/*`),
  `routeState`, `assetsRemoteState` (`UNKNOWN`, `NOT_CONFIGURED`, `REFERENCE_ONLY`).
- `operations`: all exported `operationalNames`, each explicitly `UNKNOWN`,
  `BLOCKED`, or `REFERENCE_ONLY`. Runtime production requirements plus kill
  switch, emergency stop, approval trust, abort ownership, execution enablement,
  Queue consumer and Cron state are included. `VERIFIED` is deliberately rejected:
  this reference procedure does not verify fresh production operational proofs.
- `evidencePaths`: nonempty array of repository-relative, non-secret evidence
  files to hash and preserve. Never provide credentials, approval or private keys.

```text
node scripts/phase-10-release-reference.mjs generate .test-tmp/current-inputs.json .test-tmp/current-reference
node scripts/phase-10-release-reference.mjs verify .test-tmp/current-reference
node scripts/v6-cloudflare-build-tests.cjs
node scripts/phase-10-release-reference-tests.mjs
```

Choose a **new** direct child of ignored `.test-tmp` for each generation. Existing
output directories and durable evidence destinations are refused. The build
clears only `cloudflare/site/.next` and `cloudflare/site/out`, after checking their
resolved locations and rejecting symlinks; it rejects static-site dotenv files
without reading their values. Both passes rebuild the Worker and static export
from the same source inventory and allowlisted environment. Do not edit source
while generation runs. Node/dependency versions must remain unchanged.

Outputs include the input snapshot, full checkout inventory (tracked and
nonignored untracked files, including docs and deletion markers), two build logs
and inventories, the reference bundle and verification JSON. Source, Worker,
static, configuration and referenced evidence hashes bind the candidate. Artifact
hashing reuses the existing release manifest algorithm; bundle/source inventory
hashing reuses `canonicalJson` with sorted keys, ordered arrays and one UTF-8 LF.
Two unequal artifact inventories abort before a bundle is written. Verification
rehashes current files and refuses stale source, artifacts, config or evidence.

## What the result means

`PRODUCTION_SHAPED` means production build profile, selected HTTPS origin,
HEAD-based release identity and deterministic local bytes. Local provenance binds
the **actual checkout**, not just HEAD: uncommitted remediation is explicitly
recorded and cannot masquerade as the clean committed tree. `gitTree` is the HEAD
tree, while the source fingerprint covers actual checkout bytes.

`PRODUCTION_PROVENANCE_VERIFIED` and `PRODUCTION_CERTIFIED` remain false. Production
version IDs, static release fingerprint and approval remain null. ASSETS is
verified only in local candidate configuration, not on any historical or current
remote version. The v2 reference schema is deliberately not a runtime
`ProductionBundle`. It always has `executable=false`, `approval=null`,
`productionMutationMode=BLOCKED` and no final deployment preauthorization readiness.

Review the patch and temporary evidence first. A later authorized commit changes
HEAD and requires a new clean build/reference, current target-bound operational
proofs, rollback/route/asset-version validation and fresh human preauthorization.
Local success never authorizes production actions. STOP before commit or mutation.
