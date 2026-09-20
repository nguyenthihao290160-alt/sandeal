# Phase 10 — Local production contracts, not authorization

## Scope and immutable safety boundary

Prepared September 19, 2026. `LOCAL_CONTRACT_READY` means that names, schemas,
validators and local negative tests exist. It never means `PRODUCTION_VERIFIED`.
No account login, account API, remote resource discovery, deployment, migration,
DNS action, traffic shift, content publication or money operation is authorized.

The original Phase 10 BLOCKED_PREAUTH checkpoint remains historical evidence.
The Phase 9.5 audit is an honestly dated reconstruction of the committed 19-file
changeset, not proof of the date or occurrence of the missing historical audit.
Its `SAFE_TO_COMMIT_ALL` applies only to that reconstructed changeset. No commit
is performed. Expired LOCAL certificates cannot authorize PRODUCTION.

## Configuration and static artifacts

`config/cloudflare/production.contract.json` is a non-deployable contract, NOT a
Wrangler file. Null references are deliberately unresolved, not fake resource
IDs. The actual architecture is one Worker with ASSETS, DB and JOB_QUEUE; there
is no separate Pages project, KV or R2 dependency. Existing local Wrangler files
are unchanged. Production must use `run_worker_first: true` for **all** requests;
otherwise the static asset router could bypass authorization and emergency stop.
The production static-artifact proof must verify that exact routing setting.

Static builds explicitly distinguish LOCAL, PRODUCTION_REHEARSAL and PRODUCTION.
Only LOCAL defaults to localhost. A rehearsal uses a reserved `.invalid` HTTPS
origin, not an invented production domain; a production build requires a supplied
real HTTPS origin. Public config is frozen at build time and must be rebuilt and
rehash-bound whenever the origin/environment changes. There is no runtime secret
injection into browser assets. Output remains `cloudflare/site/out`, `output:
export`, trailing slashes, same-origin assets and API calls; `/deals/*` remains a
Worker-resolved shell rather than server-side Next.js. Reserved API/admin/redirect
paths must not fall back to HTML. Noindex/nofollow remains an intentional safe
policy until separate content/SEO authorization; production equivalence does not
require enabling indexing. An unknown origin or unsupported environment blocks.

The local build artifacts are not production-certified: targets, a clean future
HEAD, origin, migration baseline and all production proofs are still missing.

## Read-only production runtime and approval

The production path is deliberately limited to `READ_PRODUCTION_HEALTH` on GET
and HEAD `/api/health/live` and `/api/health/ready`. All other capabilities remain
default-denied, including static serving/publication, catalogue, admin settings,
redirects, provider calls, money, Queue and Cron. This is an architecture boundary,
not completion of a production storefront or mutating executor. The existing
Phase 9 registry, local-only D1 execution store and execution job schema are not
relaxed. No new approval issuer, remote executor or HTTP control endpoint exists.

Production activation requires every flag explicitly safe, an exact pinned
`ProductionIdentity`, bundle fingerprint and pinned **public** Ed25519 key plus
human approver identity. The private signing key stays with the external human
signer and is never a Worker binding, configuration value or repository file.
There are no installed production trust keys. Local tests create throwaway keys
in memory, only sign synthetic fixtures and never persist or print private keys.

The validator authenticates the signature, not a caller-supplied `APPROVED`
boolean. It binds Git HEAD, candidate fingerprint, Worker/static artifact
fingerprints, environment, exact account/Worker/static/D1/Queue/domain/route,
ordered migration names and hashes, capability set, config fingerprint,
secret-reference names, bundle fingerprint, approver/key identity and expiry.
Proof freshness and approval lifetime are capped at five minutes. This is a
validator safety bound, **not** an invented production change-window policy.
Rebuilds, new HEADs, changed targets, evidence or releases invalidate approvals.

The Worker reads a `release_bundles` row by `prod-<bundleFingerprint>` with
environment PRODUCTION. Its payload contains the bundle and signed approval.
`execution_controls` carries the environment/target/bundle-bound production
control snapshot. These are **future record contracts using existing tables**;
the current local store cannot issue these records and no production rows are
created. An authenticated operator procedure for installing/revoking these records
and pinning keys must be reviewed and verified after discovery. Its absence blocks.

Every operational proof names its target fingerprint, candidate fingerprint,
report fingerprint, reference and validity interval. Authentication, resources,
bindings, secret presence, baseline, recovery, observability, canary, change
window, rollback and static artifact proofs are independently required. Flags
alone never grant authority. Repeated indexed control reads detect changes before
the read-only response. There is no mutating executor to exploit a commit race.
Future writes require a separately reviewed transactional commit fence, not this
read-only guard. Production HTTP errors are sanitized and noncacheable.

## Secret reference contract

Only names are stored. `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` are mandatory
reserved admin references for the initial binding review, even though admin
routes remain disabled. Presence does not authorize admin access. The conditional
`ACCESS_TRADE_API_KEY` reference applies only to a future, separately implemented
and reviewed AccessTrade capability. Endpoint provenance, campaign, merchant,
platform, affiliate-field provenance and destination allowlist must be discovered
and approved together. No direct Shopee credential is requested. No credential
value is requested, emitted, stored or added to a `NEXT_PUBLIC_*` variable.

## Emergency stop and kill switch

`ACTIVE`, `UNKNOWN`, absent, malformed, stale, future-dated or unavailable controls
block. Domain flags, positive revision, environment, exact targets and bundle are
validated along with the existing Phase 9 kill-switch semantics. Emergency stop
must have AVAILABLE state, matching revision, fresh timestamps, an operator
procedure reference and verified drill fingerprint; an arbitrary availability
boolean is insufficient. Any mismatch denies authorization.

Before activation, an authenticated human must verify a target-scoped operator
procedure that atomically sets ACTIVE, increments the revision, invalidates the
approval record, and proves all Worker entrypoints stop. Confirm the operator can
also disable external Queue/Cron triggers and withdraw routing through separately
authorized controls. An unavailable control store blocks without relying on that
fallback. This document does not implement or claim a connected production stop
button. Local tests prove rejection and a mid-request revision change only.

## Observability and abort evidence

Required signals are Worker errors, HTTP failures, D1 failures, Queue failures,
Cron failures, provider failures, unexpected writes, money invariant failures,
kill-switch events, deployment health, latency and rate limiting. For each signal,
discovery must record target/version labels, supported collection mechanism,
freshness, retention, human-approved threshold/window, operator destination and
a safely generated verification event. Unsupported latency/rate-limit mechanisms
require an explicit supported alternative or keep the capability blocked. There
are no invented numerical SLOs or fabricated telemetry connections.

Any unexpected write, money invariant failure, security failure, stale authority,
kill-switch uncertainty or artifact/target mismatch aborts. Thresholds for error
rates/latency require operator review; unknown thresholds do not mean success.
Queue/Cron/provider telemetry must either be verified for an authorized capability
or explicitly show those mechanisms remain disabled. No alert transport is added.

## Canary contract

Only a future bounded health-route trial matches the currently implemented
production capability. A separate hostname/route requires actual discovered
ownership and configuration; the contract does not assume one exists. Workers
version percentages, if verified supported for the exact Worker and deployment,
apply to compatible request traffic, not arbitrary business experiment cohorts,
D1 migration steps or an assumed independent static site. Compatibility of static
assets with concurrently served versions must be checked. Do not assume Queue
messages or Cron events follow HTTP percentages: these remain disabled and require
separate validated control. Existing configuration proves no canary routing.

Require baseline Worker/asset versions, route-to-version mapping, bounded scope,
approved exposure/hold duration, healthy observations, abort operator and rollback
targets. Actual percentages and thresholds stay unset pending review. Migration
backward/forward compatibility must cover both versions. No traffic is shifted;
`PRODUCTION_TRAFFIC_SHIFT=0`.

## Change window

The repo has a generic `validChangeWindow` validator and synthetic tests, but no
configured production policy in config, Worker or release workflow. Therefore
`CHANGE_WINDOW_STATUS=REVIEW_REQUIRED_NOT_CONFIGURED`. A production proof is
required before runtime approval. An operator must supply/review a real policy or
an explicit scoped exception; no fake recurring schedule or open window is made.

## Read-only migration discovery plan

Do not execute this plan in the pre-auth session. After separate read-only
discovery authorization, use the installed Wrangler version/help and exact
authenticated account/database selection to inspect identity and bindings. Never
guess IDs, silently create resources, login automatically or select the local D1.
The bounded SQL plan is generated by `productionMigrationDiscoveryPlan`; it is
data only and has no network or query executor. Read schema metadata and the
actual migration ledger. Missing ledger, extra rows, unknown names, mismatched
checksums, inconsistent schema or truncation are blockers, not an empty baseline.
Wrangler ledgers may not contain hashes; migration names alone cannot prove bytes.
Compare signed prior release inventory/schema/export evidence to checked-in SQL,
then compute the exact pending set. Production baseline remains
`UNKNOWN_UNTIL_AUTHENTICATED_DISCOVERY`.

The ten checked-in migrations are not blanket classified safe: earlier migrations
contain table-copy/destructive transformations. Local Phase 9.5 clean-install and
0009-to-0010 fixture proofs do not identify production's baseline or pending set.

## Recovery and rollback requirements

Before any real migration, verify export/backup support for the actual D1 plan,
identity, schema and data; create and validate an authorized backup separately;
record timestamp, checksum, retention and secure location. Inspect Time Travel
availability/bookmarks/retention rather than assuming account support. A database
export is not a tested restore. Verify the documented procedure in an isolated,
explicitly authorized destination and measure data/schema integrity, operator
permissions and recovery objectives. This session creates neither backup nor
restore resources and contains no restore executor.

Current documentation does not provide Time Travel cloning/forking into another
database; do not invent that restore path. Inspect virtual-table export limitations,
export request blocking and large-integer precision risks before selecting a backup
procedure, especially for money invariants. Never delete production virtual tables
as an automatic export workaround. A separately authorized disposable database
may test an export/import procedure, not prove a nonexistent Time Travel clone.

Code/Worker rollback does not reverse schema/data/Queue or binding changes. Record
the exact previous Worker and compatible asset version; neither is known. Classify
irreversible transformations, forward-fix paths, possible data loss and concurrent
write/Queue replay hazards. The operator procedure must quiesce applicable writes,
verify the selected recovery point and rehearse evidence checks; do not automatically
undo SQL, replay paid events or label an unverified plan FULL recovery.
`PRODUCTION_RECOVERY_STATUS=UNVERIFIED_UNTIL_PRODUCTION_DISCOVERY`.

## Release bundle and handoff

`production-release-bundle.contract.json` is a draft with null references and
`executable: false`, deliberately not a valid `ProductionBundle`. It cannot pass
the runtime validator. It includes the identity, required proofs, approval,
stop/kill evidence and rollback references. A real bundle must be assembled from
discovered facts, a clean later HEAD and final artifacts; its canonical fingerprint
is signed by the human approval. Editing any material invalidates that signature.

Next authorization may cover **read-only discovery only**, with mutation/login/
deployment/resource creation/migrations/DNS/traffic still disallowed unless
separately authorized. This local remediation does not authorize its own next step.

## Documentation basis

Installed Next.js 16.2.11 `node_modules/next/dist/docs/01-app/02-guides/static-exports.md`
and `environment-variables.md` were read before edits. Public Cloudflare documentation
is retained with hashes in local validation evidence (not authenticated account
access). Platform mechanisms are possibilities, not verified account capabilities.
Consult current official Workers gradual-deployments/rollbacks, static-assets
worker-script routing, and D1 migration/export/Time-Travel documentation again
before the separately authorized discovery and release review.
