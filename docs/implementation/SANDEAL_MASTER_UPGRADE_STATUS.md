# SanDeal Master Upgrade Status

This document is the durable, secret-free implementation ledger and acceptance
matrix for the SanDeal master upgrade contract. It must be updated at every safe
checkpoint. A status of `VERIFIED` requires both implementation evidence and
test evidence.

Allowed statuses:

- `NOT_STARTED`
- `DISCOVERED`
- `IN_PROGRESS`
- `IMPLEMENTED_NOT_PROVEN`
- `BLOCKED`
- `VERIFIED`
- `DEFERRED_WITH_REASON`

## Session checkpoint

| Field | Value |
| --- | --- |
| Repository | `C:\duan\sandeal` |
| Required branch | `master` |
| Baseline Git SHA | `01855b77c0d717c17287fd8182a8fbfcf2464910` |
| Current Git SHA | `01855b77c0d717c17287fd8182a8fbfcf2464910` |
| Historical production baseline | `01855b77c0d717c17287fd8182a8fbfcf2464910` |
| Current milestone | `M6` |
| Current milestone status | `VERIFIED`; `CODE COMPLETE` and `RELEASE-CANDIDATE COMPLETE` for the authorized local/isolated and Windows PWA acceptance scope |
| Last updated | `2026-07-27` |
| Deployment status | Not authorized and not attempted |
| Production mutation status | No production configuration or data accessed or mutated |
| Storage cutover status | Not authorized and not attempted |
| Latest localhost browser server | Running at `http://localhost:3100` on loopback process 38576 with the rebuilt PWA remediation, isolated FileStorage in `.test-tmp\m6-browser-live-20260726\data`, matching release identity, and disabled publication/runtime activation controls. |

## Windows PWA manual verification and remediation checkpoint

- Manual Windows Chrome verification confirmed successful standalone
  installation, the custom S icon, Windows Start registration, and launch
  without the normal Chrome tab strip or address bar.
- The installed application name was incorrectly observed as
  `Danh sách deal đã kiểm tra SanDeal SanDeal`; the required name is exactly
  `SanDeal`.
- The emitted manifest already returned `name: "SanDeal"` and
  `short_name: "SanDeal"`, and root metadata emitted
  `application-name: SanDeal`.
- The `/deals` document title was
  `Danh sách deal đã kiểm tra | SanDeal | SanDeal`. Its route-level metadata
  manually included `| SanDeal`, then the root Next.js title template appended
  the same suffix again. Compare, taxonomy fallback, and missing-product
  metadata contained the same composition pattern.
- The remediation leaves manifest identity and icon routes unchanged, delegates
  the document-title suffix to the root template exactly once, and keeps
  separately branded Open Graph/Twitter titles.
- Focused source/metadata proof, the M5 regression gate, typecheck, lint, and
  the production build pass.
- The restarted rebuilt artifact returns manifest `name` and `short_name`
  exactly `SanDeal`, `/deals` document title
  `Danh sách deal đã kiểm tra | SanDeal`, application metadata `SanDeal`,
  HTTP 200 for both custom icon routes, and a passing release-matched live
  health response.
- Final clean Windows Chrome uninstall/reinstall verification passed: Windows
  Start shows exactly `SanDeal`, the custom S icon is correct, the app opens in
  a standalone window without the normal Chrome tab strip or address bar, the
  duplicated/overlong name is gone, and the descriptive browser/window title
  remains correct.

## Existing worktree state

The worktree was already dirty before this ledger was created:

- `package-lock.json` contained an operator-owned change of 24 insertions and
  12 deletions.
- The existing diff changes npm lock metadata and optional peer package
  entries.
- This upgrade must preserve that diff and must not attribute it to this work.
- The M0 ledger does not overlap `package-lock.json`.

## Mandatory pre-edit inspection evidence

| Inspection item | Evidence and finding |
| --- | --- |
| Working directory | `C:\duan\sandeal`; Git root resolved to the same repository. |
| Branch | `master`. |
| Git HEAD | `01855b77c0d717c17287fd8182a8fbfcf2464910`. |
| Git status | `master...origin/master`; pre-existing modified `package-lock.json`. |
| Existing uncommitted work | One operator-owned lockfile diff; inspected and preserved. |
| Package scripts | `package.json` exposes targeted Prompt 10 tests, storage tests, release tests, typecheck, lint, build, and release-quality commands. |
| Node and package manager | Repository requires Node `>=20.9.0 <25` and `npm@11.6.2`; discovery ran on Node `v24.13.0` and npm `11.6.2`. npm reported that the user-level `min-release-age` setting will be unsupported in the next npm major. |
| Storage adapter | `SANDEAL_STORAGE_DRIVER` is unset in the local process. `getStorageConfig()` therefore selects the `file` driver. Mongo requires explicit `mongo` plus a valid URI. No real environment file was read. |
| Feature flags | `featureRollout.ts` now provides a server-only `OFF`/`SHADOW`/`OBSERVE`/`CANARY`/`ACTIVE` registry for every contract flag. Invalid values fall back to the conservative declared default. |
| Schema validation | The repository uses explicit validators and normalizers in automation job contracts, Mongo serialization/schema, migration manifests, product normalization, URL safety, and API parsers. Zod is not installed. |
| Journal and idempotency | `operationJournal.ts` provides durable contracts, effect leases, ownership, checksums, replay, duplicate suppression, and inconsistent-journal reconciliation. `idempotency.ts` provides stable bounded keys. |
| Worker and scheduler | One durable role lease per role, fencing tokens, claim tokens, job heartbeats, role heartbeats, stale-lease takeover, and graceful scheduler shutdown exist. The worker launcher stops new loop iterations on signals but batch execution is not a continuous pool. |
| Runtime Guardian and SLO | Guardian persists current and historical reasons. SLO is fail-closed on `INSUFFICIENT_DATA`, but requires publication and monitor samples and clears the runtime block only on `PASS`. |
| Providers and Token Vault | A Gemini-oriented router, policy registry, circuit/budget tracking, encrypted Token Vault storage, and safe projections exist. The provider registry and multi-tier fallback contract are not implemented. |
| Existing tests | Prompt 10, production health, durable health, release identity, storage, security, dashboard, and product tests are present and mapped below. |
| Reusable UI | Dashboard navigation, dashboard icons, operational panels, task states, toasts, timeout fetch helpers, product dashboard states, product detail actions, and safe product image components already exist. |

No real `.env` file, credential value, Token Vault value, production data file,
or production process environment was opened or displayed.

## M0 repository and architecture map

### Release identity and deployment

| Area | Existing implementation | Discovery result |
| --- | --- | --- |
| Build identity | `next.config.ts`, `src/lib/releaseIdentity.ts` | Embedded identity is read from `SANDEAL_BUILD_COMMIT`; runtime and public identities are separate inputs. |
| PM2 environment | `ecosystem.config.cjs` | All release variables are currently derived from one resolved release ID, but the required guarded remote verification workflow is not yet encoded as one fail-safe operator block. |
| Health reporting | `src/app/api/health/live/route.ts`, `src/app/api/health/route.ts`, `src/lib/health/readiness.ts` | Release mismatch protection exists and must remain fail-closed. |
| Release tooling | `scripts/release-preflight.cjs`, `scripts/release-manifest.cjs`, `scripts/release-validation.cjs` | Immutable artifact and validation foundations exist. Current runbooks do not yet match every required PM2 environment and lease check in the contract. |
| Rollback | `docs/operations/ROLLBACK_RUNBOOK.md` | Non-destructive artifact and isolated-restore guidance exists and must be reconciled with the final guarded PM2 procedure. |

### Storage and migrations

| Area | Existing implementation | Discovery result |
| --- | --- | --- |
| Adapter selection | `src/lib/storage/storageConfig.ts`, `storageFactory.ts`, `adapter.ts` | FileStorage is the default. Mongo is explicit and server-only. |
| FileStorage | `src/lib/storage/fileStorageAdapter.ts` | Cross-process collection locks, atomic temporary writes, validation, fsync, and rename behavior exist. |
| Mongo adapter | `src/lib/storage/mongoStorageAdapter.ts` | Revision-based collection snapshots and transaction retry behavior exist. Generic capability discovery and business bulk-write APIs do not exist. |
| Compatibility facade | `src/lib/storage/adapter.ts` | Existing imports can remain stable while adapter capabilities are added. |
| Migration safety | `migrationManifest.ts`, `migrationExecutor.ts`, `migrationChecksum.ts` | Manifests, source checksums, bounded batches, checkpoints, leases, CAS revisions, dry-run, and isolated-only apply exist. |
| Backup and restore | `mongoLogicalBackup.ts`, `mongoRestore.ts`, release storage scripts | Checksummed logical backup and isolated restore verification exist. Production cutover is intentionally absent. |

### Automation safety kernel

| Area | Existing implementation | Discovery result |
| --- | --- | --- |
| Control provenance | `src/lib/automation/types.ts`, `store.ts` | Operator, runtime, and policy publication blocks are persisted separately; the aggregate pause is derived from them. |
| Job contract | `store.ts` | Job schema, factory metadata, retries, claims, claim tokens, fencing tokens, heartbeats, completion, and failure persistence exist. |
| Fair selection | `store.ts::selectFairRunnableJobs` | Priority, FIFO, overdue fairness, and job-type diversity are implemented. |
| Operation journal | `operationJournal.ts` | Durable effect ownership, leases, checksums, replay, mismatch blocking, and reconciliation state exist. |
| Publication | `autoPublish.ts` | Normal publication uses a journal contract for product mutation, audit, event, and monitor creation. |
| Reconciliation | `reconciler.ts` | Lifecycle and some publication effects are repaired, and missing monitor jobs are created for genuinely published products. |
| Runtime roles | `runtimeRoles.ts` | Single-role ownership, fencing tokens, fresh leases, conflicts, heartbeat renewal, and release identity are persisted. |
| Scheduler | `scheduler.ts`, `scripts/automation-scheduler.cjs` | Guardian priority is 100; scheduler heartbeats and graceful shutdown exist. |

### Confirmed defects from source inspection

1. `executeAutoSafePublish()` evaluates eligibility before its normal operation
   journal contract. The ineligible path invokes `applyBlockedDecision()` and
   returns without a durable `publish_blocked` audit effect.
2. The SLO considers `publish_blocked` a publication attempt, but the blocked
   pre-transaction path never creates that evidence.
3. SLO measurement supports only `MEASURED` and `INSUFFICIENT_DATA`; it cannot
   represent `NOT_APPLICABLE`, `BOOTSTRAP`, or `RECOVERY`.
4. SLO full measurement requires both publication attempts and monitor
   outcomes. With zero public products, runtime recovery can remain
   indefinitely fail-closed.
5. Runtime control is cleared automatically only on one `PASS`; no persisted
   recovery state or consecutive-health requirement exists.
6. Worker batches use `Promise.all()` only when every claimed job is
   `PROCESS_CANDIDATE`. Any mixed batch is processed by a sequential loop.
7. The worker claims a full batch, waits for that batch, and then returns to the
   launcher. Freed capacity does not trigger immediate replacement claims.
8. Pickup latency is calculated as `claimedAt - createdAt`. Job inclusion is
   based on `completedAt || updatedAt || createdAt`, which can select unrelated
   historical queue time and ignores retry/future runnable semantics.
9. App Health separates some current and historical reasons but lacks persisted
   recovery state, recovery progress, complete embedded/runtime/role release
   identity, queue-age semantics, and rollout diagnostics.
10. A strong URL validation and bounded fetch utility exists, but remote fetch
    use is not centralized and coverage must be audited for DNS rebinding,
    redirect-host changes, MIME validation, decoded-size limits, and safe HTML
    and JSON-LD parsing.
11. Provider routing is Gemini-specific and deterministic local rules are
    represented as a provider fallback. A policy-declared provider registry,
    strict output contracts, optional local inference adapter, and transition
    alert adapter are not implemented.
12. Storage adapter interfaces do not advertise bulk-write, transaction,
    upsert, atomic revision, or server-filtering capabilities.

### Feature configuration map

| Control | Location | Current behavior |
| --- | --- | --- |
| Runtime process enablement | `SANDEAL_ENABLE_PROMPT10_RUNTIME` in `ecosystem.config.cjs` | Boolean opt-in; worker and scheduler are omitted when false. |
| Publication APIs | `ALLOW_PUBLISHING_API`, `AUTO_PUBLISH_ENABLED` | Boolean environment controls; both default disabled when unset. |
| Automation operating mode | `AutomationControlState` | Persisted `OBSERVE`, `SHADOW`, `CANARY`, or `AUTONOMOUS`; default `OBSERVE`. |
| Emergency stop | `killSwitch` and `EMERGENCY_STOP` control action | Persisted, server-enforced, and must not be cleared by recovery. |
| Operational settings | `automationSettings.ts` | Persisted bounded limits; `safePublish=true`, `freeOnly=true`, and `allowPaidAi=false` are immutable. |
| Storage adapter | `SANDEAL_STORAGE_DRIVER` | Unset means `file`; `mongo` is explicit and validated. |

### UI reuse map

| Need | Reusable implementation |
| --- | --- |
| Active navigation | `src/app/dashboard/layout.tsx::isRouteActive` and existing active sidebar class. |
| App Health panels | `src/app/dashboard/app-health/page.tsx` and `operations.module.css`. |
| Operational truth projection | `src/lib/automation/dashboard.ts`, `truth.ts`, and automation health routes. |
| Routine feedback | Existing toast patterns in product dashboard and product detail. |
| Loading/error/empty states | `task-status.tsx`, `intelligence-ui.tsx`, and current dashboard state components. |
| Bounded browser requests | Existing timeout helpers in dashboard and source pages; these should be consolidated rather than duplicated. |
| Broken image fallback | `src/components/safe-product-image.tsx`, `src/app/deals/ProductImage.tsx`, and `public/product-placeholder.svg`. |
| Product detail | Existing compact sections and blocker grouping in `src/app/dashboard/products/[id]/page.tsx`. |

Before any Next.js source change, the applicable local Next.js 16.2.11 guide
under `node_modules/next/dist/docs/` must be read in full. Likely guides include
App Router route handlers, client/server components, image handling, metadata,
and deployment identity.

## Risk map

| Risk ID | Severity | Risk | Required control |
| --- | --- | --- | --- |
| R-01 | Critical | Recovery weakens fail-closed publication safety. | Recovery may clear only the runtime block after persisted applicable evidence; operator, policy, and emergency controls remain authoritative. |
| R-02 | Critical | A blocked audit is duplicated or fabricated. | Stable operation/effect key, journal ownership, committed dependency, restart replay, and exact-count tests. |
| R-03 | Critical | Recovery invents monitor or publication evidence. | Correct `NOT_APPLICABLE` semantics and no synthetic publication/monitor records. |
| R-04 | Critical | Canary bypasses product gates. | Durable one-product/one-operation permit that bypasses only the runtime recovery block. |
| R-05 | Critical | Fencing loss permits stale completion. | Durable role-owner checks at claim, heartbeat, effect, and completion boundaries. |
| R-06 | High | Continuous worker pool creates unbounded promises. | Explicit bounded in-flight map and claim only for available slots. |
| R-07 | High | Same-product or same-operation jobs race. | Central execution metadata plus durable product/operation locking where required. |
| R-08 | High | Critical-slot reservation starves normal work. | Borrowable capacity, overdue fairness, central critical-type list, and load tests. |
| R-09 | High | SLO changes hide real congestion. | Runnable-at semantics, separate pending queue age, invalid sample rejection, and boundary tests. |
| R-10 | Critical | Stale PM2 values relabel an artifact. | Embedded identity stays immutable; all runtime variables derive from reviewed HEAD and are verified inside each process. |
| R-11 | Critical | Remote fetch reaches private infrastructure. | Protocol, host, resolved-IP, redirect, size, timeout, MIME, and injection controls with security tests. |
| R-12 | High | AI fallback bypasses free-only or safety policy. | Per-provider eligibility, normalized errors, bounded attempts, and strict canonical data contracts. |
| R-13 | Critical | Token or prompt material enters diagnostics. | Existing sanitizers plus safe projections and redaction-focused tests. |
| R-14 | High | Optional local AI harms Guardian latency. | Disabled default, separate process, bounded queue/concurrency, resource gate, and benchmark requirement. |
| R-15 | Critical | Mongo features run on FileStorage or trigger cutover. | Capability detection, active-driver check, default flag off, and isolated adapter tests only. |
| R-16 | High | Affiliate yield outranks compliance. | Deterministic eligibility-first selector and auditable fallback reason. |
| R-17 | High | Structured data exposes unverified claims. | Deterministic generation from public, indexable, verified canonical data only. |
| R-18 | High | Existing operator-owned lockfile diff is overwritten. | Do not edit or regenerate `package-lock.json` unless a separately reviewed dependency change is necessary. |

## Dependency map

| Dependency or subsystem | Current use | Upgrade decision at M0 |
| --- | --- | --- |
| Next.js `16.2.11` | App Router, route handlers, metadata, image, production build | Use installed local documentation before code changes. No upgrade planned. |
| React `19.2.4` | Client dashboard and public UI | Reuse existing state patterns. No upgrade planned. |
| MongoDB driver `7.5.0` | Optional Mongo adapter and isolated migration tooling | Preserve optional status. No cutover or performance claim. |
| TypeScript `^5` | Source and direct TypeScript loading in tests | Preserve existing compiler setup. |
| ESLint `9` and Next config | Static validation | Preserve and run targeted/full checks at gates. |
| Node built-ins | Crypto, DNS, filesystem, URL, streams, process signals | Preferred for new safety and orchestration primitives. |
| Custom schema validators | Jobs, migrations, products, APIs | Extend where a single source of truth already exists. |
| Zod | Not installed | Do not add unless existing validators cannot safely express the AI contract. |
| Cheerio | Not installed | Do not add during M0. Reassess at M4 with maintenance, license, and install-script evidence. |
| External AI/local runtimes | Not vendored | Must remain operator-installed and disabled by default. |

No dependency change is part of M0.

## Migration and compatibility map

| Planned area | Code migration | Data migration | Optional backfill | Compatibility and rollback |
| --- | --- | --- | --- | --- |
| Recovery state | Additive persisted collection/record normalization expected | None required for old records | Historical recovery evidence should not be backfilled as healthy | Missing record defaults to conservative bootstrap/open behavior; flag rollback stops new transitions while old data remains readable. |
| Canary permits | Additive collection expected | None | None | Expired or unknown permits remain unusable; disabling the flag prevents issuance and consumption. |
| Job execution metadata | Additive type metadata expected | None | None | Unknown old jobs use conservative serial/exclusive defaults where needed. |
| Runnable-at SLO context | Additive measurement fields expected | None | Optional read-only historical analysis only | Old jobs remain readable; invalid or unavailable attempt fields are excluded, not rewritten. |
| Provider provenance | Additive record fields expected | None | Optional evidence backfill only after a separate plan | Missing provenance blocks canonical AI writes that require it. |
| Categorization evidence | Additive record fields expected | None | Optional, shadow-only evaluation | Existing category remains canonical until V2 is proven and activated. |
| Multiple offers | Additive product field expected | None | Optional offer derivation after M5 proof | Legacy single affiliate fields remain readable and are used by compatibility projection. |
| Storage capabilities/bulk | Interface and adapter additions | None | None | FileStorage path remains default; disabling flag restores current per-collection behavior. |
| Structured-data version | Additive derived metadata | None | None | Flag rollback restores current public rendering without rewriting products. |

No production migration, backfill, Mongo connection, or cutover is authorized.

## Feature rollout ledger

| Feature | Status | Required default | Current effective default | Rollback |
| --- | --- | --- | --- | --- |
| `RUNTIME_RECOVERY_V2` | `VERIFIED` | `SHADOW` or `OFF` until proven | `SHADOW` | Set server-side mode to `OFF`; keep runtime block fail-closed. |
| `RECOVERY_CANARY` | `VERIFIED` | `OFF` | `OFF` | `OFF`; existing permits become unusable and are retained for audit. |
| `WORKER_CONTINUOUS_POOL_V2` | `VERIFIED` | `OFF` until an operator authorizes rollout | `OFF` | `OFF`; return to the existing bounded batch path. |
| `SLO_RUNNABLE_AT_V2` | `VERIFIED` | `SHADOW` until an operator authorizes control authority | `SHADOW` | `OFF`; retain additive attempt telemetry without control authority. |
| `AI_CLOUD_FALLBACK` | `VERIFIED` | `OFF` | `OFF` | `OFF`. |
| `AI_LOCAL_FALLBACK` | `VERIFIED` | `OFF` | `OFF` | `OFF`. |
| `OPERATOR_ALERTING` | `VERIFIED` | `OFF` | `OFF` | `OFF`; delivery state remains auditable. |
| `SMART_CATEGORIZATION_V2` | `VERIFIED` | `SHADOW` | `SHADOW` | `OFF`; retain existing canonical categories. |
| `MONGO_BULK_WRITE` | `VERIFIED` | `OFF` | `OFF` | `OFF`; use the compatibility revision path. |
| `MULTI_AFFILIATE_OFFER` | `VERIFIED` | `SHADOW` | `SHADOW` | `OFF`; use legacy affiliate projection. |
| `PROGRAMMATIC_SEO_V2` | `VERIFIED` | `SHADOW` | `SHADOW` | `OFF`; suppress V2 output. |

## Milestone test matrix

No test command in this section is considered passed until its exact result is
recorded in the session results section.

| Milestone | Existing targeted commands | Required new or extended coverage |
| --- | --- | --- |
| M0 | `git diff --check`; read-only repository/status inspection | Ledger completeness, acceptance-matrix completeness, no runtime source diff. |
| M1 | `npm run test:prompt10:autopublish`; `npm run test:prompt10:slo`; `npm run test:prompt10:self-healing`; `npm run test:durable-health`; `npm run test:health-readiness`; release identity cases in hardening/readiness tests | Blocked audit exactly once, recovery state transitions, zero-product `NOT_APPLICABLE`, optional permits, consecutive health, restart and journal reconciliation, all release mismatch variants. |
| M2 | `npm run test:prompt10:orchestration`; `npm run test:prompt10:slo`; `npm run test:automation`; `npm run test:durable-health`; `npm run test:operator-intelligence` | Continuous replacement claims, bounded slots, critical capacity, concurrency classes, fencing loss, graceful shutdown, runnable-at boundaries, queue age, App Health separation. |
| M3 | `npm run test:dashboard`; `npm run test:prompt08`; `npm run test:hardening`; `npm run test:release-ui`; `node scripts/prompt10-product-api-security-tests.cjs` | Timeout/unmount/supersession states, product list/detail failures, image fallback and recheck feedback, route errors, SSRF/redirect/MIME/size/injection security. |
| M4 | `npm run test:gemini-provider`; `node scripts/prompt09-bot-foundation-tests.cjs`; `node scripts/prompt10-business-source-tests.cjs`; `npm run test:operator-intelligence` | Deterministic extraction, provider registry, retry eligibility, strict AI contract, no-network local adapter, alert dedupe, golden categorization evaluation. |
| M5 | `npm run test:master:pwa`; `npm run test:storage`; `npm run test:storage:mongo`; `npm run test:storage:migration`; `npm run test:storage:acceptance`; `node scripts/prompt10-revenue-integrity-tests.cjs`; `node scripts/prompt10-business-search-seo-tests.cjs` | Exact manifest/PWA identity, one-pass document-title composition, unchanged icon routes, capability-aware bulk partial failures, FileStorage compatibility, offer eligibility ordering, deterministic tie, disclosure, noindex and safe JSON-LD. |
| M6 | `npm run typecheck`; `npm run lint`; `npm test`; `npm run build`; relevant security, migration, restore, and rollback rehearsals | Full acceptance matrix, performance/resource evidence, dependency review, isolated restore proof, feature rollback proof. |

## Requirement acceptance matrix

| Requirement ID | Description | Status | Source files | Test files or command | Feature flag | Default mode | Migration | Rollback | Evidence | Remaining risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M0-01 | Repository, branch, HEAD, status, runtime, package, storage, and safety discovery | `VERIFIED` | This ledger | `git status --short --branch`; runtime diff review | None | N/A | None | Revert documentation file only | Repository identity and all 16 inspection areas recorded; no runtime source diff | Existing lockfile remains operator-owned |
| M0-02 | Repository, risk, dependency, migration, and test maps | `VERIFIED` | This ledger | Manual completeness review; `git diff --check` | None | N/A | None | Revert documentation file only | Required sections present; 41 acceptance rows mapped; whitespace check passed | Maps must be updated when implementation reveals new facts |
| M0-03 | Durable status ledger and acceptance matrix | `VERIFIED` | This ledger | Tracked and untracked documentation checks | None | N/A | None | Revert documentation file only | UTF-8 file without BOM; no trailing whitespace; no runtime behavior change | Ledger accuracy depends on checkpoint updates |
| M1-01 | Pre-transaction blocked-publication audit exactly once | `VERIFIED` | `autoPublish.ts`, `products.ts`, `types.ts` | `npm run test:prompt10:autopublish` | `RUNTIME_RECOVERY_V2` | `SHADOW` | Additive audit metadata only | Flag `OFF`; retain immutable audits | Blocked state and audit are separate journal effects; crash/replay tests prove one audit and no event/monitor | File and Mongo cross-collection atomicity remains journal-based rather than a database-wide transaction |
| M1-02 | Persisted deterministic recovery state | `VERIFIED` | `runtimeRecoveryState.ts`, `sloErrorBudget.ts`, `runtimeGuardian.ts` | `node scripts/master-m1-runtime-recovery-tests.cjs`; `npm run test:prompt10:slo` | `RUNTIME_RECOVERY_V2` | `SHADOW` | Additive state record | Flag `OFF`; fail-closed state remains durable | Versioned state, optimistic updates, evidence summaries, reset reasons, release identity, and restart normalization pass | Production observation is not authorized |
| M1-03 | Measurement states including zero-product `NOT_APPLICABLE` | `VERIFIED` | `sloErrorBudget.ts` | `npm run test:prompt10:slo` | `RUNTIME_RECOVERY_V2` | `SHADOW` | Additive measurement fields | Recovery flag `OFF`; retain fail-closed measurements | Zero-product/no-target monitor is `NOT_APPLICABLE`; a real failed monitor is `MEASURED` and breached; three real healthy runtime evaluations recover without fabricated evidence | Runnable-at pickup semantics remain M2 |
| M1-04 | Optional scoped half-open canary permits | `VERIFIED` | `runtimeRecoveryCanary.ts`, `autoPublish.ts`, `products.ts`, `postPublishMonitor.ts` | Recovery primitive and autopublish suites | `RECOVERY_CANARY` | `OFF` | Additive permit collection and product observation fields | Set `OFF`; permits remain durable but no new issue/consume path is enabled | One-operation/product permits, fencing, scheduler/release checks, capacity 1/hard max 2, restart replay, real monitor, immediate unhealthy hide all pass | No production canary observation performed |
| M1-05 | Persisted consecutive healthy recovery | `VERIFIED` | `runtimeRecoveryState.ts`, `sloErrorBudget.ts` | Recovery primitive and SLO suites | `RUNTIME_RECOVERY_V2` | `SHADOW` | Additive state fields | Set `OFF`; retain runtime block | Three distinct evaluations are required; duplicates do not increment; operator block is never cleared | Production cadence not observed |
| M1-06 | Transactional effect consistency and reconciliation | `VERIFIED` | `autoPublish.ts`, `products.ts`, existing `operationJournal.ts` | `npm run test:prompt10:autopublish` | Recovery flags | Safe defaults | Additive journal effect for new publications; legacy journal contract retained | Replay legacy three-effect journal; disable canary issuance | Blocked state/audit and publication audit are stable idempotent effects; missing audit is rebuilt before `PUBLISHING` becomes public; event/monitor follow committed state | Cross-collection consistency relies on durable replay by design |
| M1-07 | Runtime recovery failure/restart test matrix | `VERIFIED` | M1 production modules | `npm run test:master:m1` | Same as M1 | Safe defaults | Isolated temporary storage only | Remove isolated test artifacts only | 84/84 aggregate M1 tests passed; focused suites include crash/replay, fencing, stale leases, release mismatch, pause, canary health, and no-fake-evidence cases | Hard OS kill is modeled through durable partial-state fixtures, not a production process kill |
| M1-08 | One-HEAD release identity and mismatch protection | `VERIFIED` | `releaseIdentity.ts`, `next.config.ts`, `ecosystem.config.cjs`, build-manifest writer | `node scripts/master-m1-release-identity-tests.cjs`; `npm run build` | None | Fail closed | None | Previously verified immutable artifact | Build-embedded, runtime, Git, and public identities remain separate; invalid, missing, stale PM2, and health mismatch tests pass; build manifest matches HEAD | Actual PM2 environments and public health require deployment authorization |
| M1-09 | Guarded deployment and non-destructive rollback blocks | `VERIFIED` | Guarded shell/verifier/redactor scripts and operations document | Static checks in release identity suite | None | Manual approval | None | Previously built immutable compatible artifact | Scripts require path/branch/clean HEAD confirmation, one build, all three app restarts, process/lease/health checks, redacted bounded logs, and `pm2 save` last | Scripts were not executed on the VPS |
| M2-01 | Continuous bounded worker pool | `VERIFIED` | `worker.ts`, `automation-worker.cjs`, `store.ts` | `npm run test:master:m2:worker`; orchestration/durable suites | `WORKER_CONTINUOUS_POOL_V2` | `OFF` | None | Set flag `OFF`; existing batch path remains intact | In-flight promise map is bounded, freed slots refill before slow siblings finish, failures are isolated, shutdown drains bounded work | Production rollout and observation remain unauthorized |
| M2-02 | Borrowable critical capacity | `VERIFIED` | `executionPolicy.ts`, `worker.ts`, `store.ts` | `npm run test:master:m2:worker` | `WORKER_CONTINUOUS_POOL_V2` | `OFF` | None | Set flag `OFF`; existing priority/fairness selector remains | Central critical types, one borrowable slot where capacity permits, Guardian under 30 seconds, and overdue normal fairness pass | Controlled isolated timing is not production latency evidence |
| M2-03 | Concurrency classes and durable resource keys | `VERIFIED` | `executionPolicy.ts`, `types.ts`, `store.ts` | Worker pool, durable health, and orchestration suites | `WORKER_CONTINUOUS_POOL_V2` | `OFF` | Additive job metadata only | Flag `OFF`; old jobs remain readable | Durable RUNNING state prevents same-product and storage-exclusive conflicts; different products run concurrently; resource IDs are hashed | Provider-specific budget concurrency remains M4 scope |
| M2-04 | Worker failure, fencing, heartbeat, retry, and shutdown evidence | `VERIFIED` | `worker.ts`, `store.ts`, `automation-worker.cjs`, runtime role code | M2 worker, automation, durable health, runtime, orchestration suites | Pool flag | `OFF` | Isolated storage only | Flag `OFF`; role/job leases expire normally | Sibling failure, stale ownership, takeover fencing, claim token heartbeat, retry after restart, journal replay, and bounded shutdown all pass; stale worker no longer updates capacity/control state | Hard process termination is represented by persisted interruption fixtures and signal subprocess tests |
| M2-05 | Runnable-at pickup latency and pending queue age | `VERIFIED` | `sloErrorBudget.ts`, `types.ts`, `store.ts` | `npm run test:master:m2:slo`; existing SLO suite | `SLO_RUNNABLE_AT_V2` | `SHADOW` | Additive attempt collection/measurement fields | Set flag `OFF`; legacy formula remains authoritative | Attempt runnable time follows retry eligibility, future schedule, then creation; exact boundaries, invalid/negative/missing samples, queue age, retry P95, and interrupted attempt reconciliation pass | Historical records without sufficient timestamps are excluded rather than rewritten |
| M2-06 | Operationally truthful App Health | `VERIFIED` | `operationalHealth.ts`, automation health route, App Health page | `npm run test:master:m2:health`; health/readiness suite; build | Recovery/SLO/pool rollout diagnostics | Observe only | Additive API fields | Set pool/SLO flags to safe defaults; existing endpoint consumers ignore additive fields | Current and historical reasons, recovery progress, canary, SLO, pending queue, pool slots, active lease releases, release match, controls, and rollout modes are separate | Browser visual verification remains M3/M6 scope |
| M3-01 | Product list, detail, route, and job reliability | `VERIFIED` | Product dashboard/detail pages, client request helper, product-health checks | `npm run test:master:m3`; Prompt 8, resilience, dashboard, and durable-health suites | None | Existing behavior with bounded failure handling | None | Revert the isolated M3 UI/request changes | Product and operational-truth requests settle independently; rechecks poll to terminal or bounded timeout; 39/39 M3 aggregate and related regressions pass | Real operator data and production routes were not exercised |
| M3-02 | Async state machine cannot remain stuck | `VERIFIED` | `clientRequest.ts`, product dashboard/detail, App Health page | `master-m3-client-request-tests.cjs`; M3 aggregate | None | Bounded by default | None | Revert helper adoption | Caller abort, supersession, timeout, non-2xx, invalid JSON, oversized response, unmount cleanup, and synchronous duplicate guards are covered; 11/11 focused cases pass | Browser transport behavior is represented by deterministic fetch fixtures |
| M3-03 | Safe broken-image fallback and visible recheck | `VERIFIED` | `safe-product-image.tsx`, product detail/dashboard, CSS, health checker | M3 UI/security suites; AccessTrade and Prompt 8 regressions | None | Fail closed to local placeholder | None | Retain local placeholder and revert optional status presentation | Unsafe sources never reach the image element; stale events are ignored; failures are categorized; recheck feedback reaches terminal or timeout; focused UI/security suites pass | Remote CDN behavior was mocked; no production image host was contacted |
| M3-04 | Compact accessible navigation and product detail | `VERIFIED` | Dashboard layout/navigation helper, product detail page and CSS, product list shrink boundary, shared loading/error controls | M3 UI suite, release UI, operator intelligence, build; `node scripts/master-m3-browser-tests.cjs --base-url=http://localhost:3100 --evidence-dir=.test-tmp/m3-browser-evidence-20260726` | None | Existing behavior | None | Revert presentation/navigation changes | Nested route activation, visible keyboard focus, desktop/mobile product list/detail and App Health, loading-to-success, forced error/retry, no stuck states, and zero page overflow pass against the rebuilt localhost artifact | Browser connector remained unavailable; proof used installed headless Chrome over the DevTools protocol with an isolated synthetic fixture |
| M3-05 | Internet content security | `VERIFIED` | `urlSafety.ts`, `productHealthCheck.ts`, `safe-product-image.tsx`, `next.config.ts` | `master-m3-remote-content-security-tests.cjs`; hardening, resilience, durable-health suites | None | Fail closed | None | Roll back the release as a unit; never bypass safe fetch validation | DNS-pinned runtime transport, all-answer public DNS validation, redirect revalidation, protocol/credential/port/private-network rejection, timeout/size/encoding/MIME controls, and security headers are implemented; 11/11 focused cases pass | Real DNS/remote-server integration was not contacted; CSP retains documented Next-compatible `unsafe-inline` directives |
| M4-01 | Deterministic extraction floor with provenance | `VERIFIED` | `deterministicExtraction.ts`, `imageResolver.ts` | `npm run test:master:m4` | Existing pipeline | Deterministic, bounded | Additive derived provenance | Retain existing canonical values | Attribute-order-independent OG/HTML and bounded JSON-LD Product graph extraction, source/value hashes, confidence and warning codes pass | Live merchant markup was not contacted |
| M4-02 | Provider registry and adapter declarations | `VERIFIED` | `providerRegistry.ts`, `providerFallback.ts` | `npm run test:master:m4` | `AI_CLOUD_FALLBACK`, `AI_LOCAL_FALLBACK` | `OFF` | None | Flags `OFF` | Three declarations encode capability, transport, free-only policy, network boundary, process boundary, concurrency, response and retry limits | Registry is intentionally limited to currently implemented tiers |
| M4-03 | Policy-safe bounded cloud fallback | `VERIFIED` | `providerFallback.ts`, existing `providerRouter.ts` | `npm run test:master:m4` | `AI_CLOUD_FALLBACK` | `OFF` | None | Flag `OFF` | Feature-off transport suppression, transient-only retry, terminal stop, provider/attempt caps, safe projections and ignored-abort deadline pass | No real cloud provider was contacted |
| M4-04 | Strict AI data contract before canonical writes | `VERIFIED` | `canonicalDataContract.ts`, `geminiEditorialProvider.ts` | `npm run test:master:m4` | Cloud/local fallback flags | `OFF` | Additive proposal provenance only | Reject V2 writes or disable adapters | Exact keys, version/hash/time/provider/evidence validation, factual-claim evidence and explicit high-confidence write scope pass | Canonical AI application remains opt-in and evidence-bound |
| M4-05 | Optional separate-process local AI tier and benchmark gate | `VERIFIED` | `localAiAdapter.ts`, `.env.example` | `npm run test:master:m4` | `AI_LOCAL_FALLBACK` | `OFF` | None | Flag `OFF`; stop separately managed service separately | Loopback-only explicit-port adapter, resource/readiness/contract/concurrency/queue/response gates and synthetic benchmark evaluator pass without starting a service | No local runtime/model was installed; actual model performance remains unclaimed |
| M4-06 | Optional provider-agnostic operator alerts | `VERIFIED` | `operatorAlerting.ts` | `npm run test:master:m4` | `OPERATOR_ALERTING` | `OFF` | Additive `operator-alert-deliveries` state | Flag `OFF` | Injected adapters only; feature-off suppression, transition dedupe, bounded delivery and hashed entity/receipt persistence pass | No real external notification was sent |
| M4-07 | Evidence-based smart categorization | `VERIFIED` | `smartCategorization.ts`, `types.ts` | `npm run test:master:m4` | `SMART_CATEGORIZATION_V2` | `SHADOW` | Additive suggestion/evidence field | Set `OFF`; existing category remains canonical | Accent-stable deterministic Vietnamese taxonomy, weighted field evidence, hashes, confidence/margin, stable ties and shadow non-mutation pass | ACTIVE mode remains unauthorized |
| M4-08 | Isolated Vietnamese golden dataset and quality gate | `VERIFIED` | `smartCategorization.ts`, `scripts/fixtures/master-m4-vietnamese-category-golden.json` | `npm run test:master:m4` | `SMART_CATEGORIZATION_V2` | `SHADOW` | None | Keep V2 below active | Fixed 30-case Vietnamese dataset achieved 100% coverage and at least 95% required accuracy | Dataset is isolated and intentionally not a production-distribution claim |
| M5-01 | Adapter-aware bounded bulk storage | `VERIFIED` | `storage/types.ts`, `bulkMutation.ts`, adapter facade, File and Mongo adapters/schema | `npm run test:master:m5` | `MONGO_BULK_WRITE` | `OFF` | Additive interfaces and Mongo collection manifest entries only | Compatibility revision path remains available | Capability declarations are truthful; 100-item/64-KiB bounds, per-item results, duplicate rejection, atomic File revision, and isolated fake-Mongo revision behavior pass | No real Mongo server or production collection was contacted |
| M5-02 | Multiple affiliate offers and compliance-first routing | `VERIFIED` | `types.ts`, `complianceOfferSelector.ts` | M5 focused and revenue-integrity suites | `MULTI_AFFILIATE_OFFER` | `SHADOW` | Additive offer and suggestion fields | Legacy affiliate projection remains canonical | Compliance precedes price; unsafe, stale, unhealthy, untracked, merchant-drifted, duplicate-ID, and over-limit inputs fail closed; ties and input hashes are deterministic | ACTIVE mode and real affiliate traffic remain unauthorized |
| M5-03 | Deterministic verified structured data and indexing | `VERIFIED` | `structuredData.ts`, `urlValidation.ts`, SEO modules, product/taxonomy routes, sitemap/robots | M5 focused, M3 remote security, business search/SEO, build | `PROGRAMMATIC_SEO_V2` | `SHADOW` | Additive derived output only | `OFF` suppresses V2; unsafe data remains noindex | Central 256-KiB script-safe serializer, browser-safe public URL syntax screening, verified images/prices, bounded text, future offer dates, safe redirects, sitemap filtering, and noindex preservation pass | Live search-engine rendering was not contacted |
| M5-04 | Professional UI metadata and polish | `VERIFIED` | App metadata, `manifest.ts`, public route metadata, product/taxonomy SEO helpers, generated icon routes, existing dashboard CSS | `npm run test:master:pwa`; M5 focused gate; typecheck; lint; `npm run build`; rebuilt localhost metadata smoke; final Windows Chrome install verification | `PROGRAMMATIC_SEO_V2` where relevant | `SHADOW` | None | Revert only the PWA title-composition remediation; existing generated assets and metadata remain compatible | Manifest `name` and `short_name` are exactly `SanDeal`; application metadata is `SanDeal`; route titles receive one template suffix; social titles remain descriptive; S icon routes are unchanged; 5/5 focused checks, 125/125 M5 aggregate checks, typecheck, lint, and 44-page production build pass; final Windows Start name/icon/standalone/title verification passed | No unverified local or Windows PWA acceptance item remains; production deployment remains separately unauthorized |
| X-01 | End-to-end correlation and redacted observability | `VERIFIED` | `correlationTrace.ts`, authenticated automation audit route | `npm run test:master:m6` | Related feature flags | Read-only observe projection | No schema change | Remove optional trace query; durable records remain | Bounded trace joins jobs, attempts, provider disclosure, automation audit, operation journal, publication audit, and monitors; incomplete stages stay explicit; stable references hash raw identifiers/reasons | Production-sized traces were not queried |
| X-02 | Bounded resource and performance budgets | `VERIFIED` | Settings, worker, fetch, providers, bulk/local AI, correlation trace | M2 load tests; M3/M4/M5 focused gates; M6 trace-bound test; full build/browser gate | Related feature flags | Safe defaults | None | Disable optional feature | Worker peak/claims, client/server fetch, provider, local adapter, storage, offer, JSON-LD, and trace layer bounds are implemented and tested | Local deterministic evidence is not a production performance claim |
| X-03 | Dependency and supply-chain review | `VERIFIED` | `package.json`, operator-owned `package-lock.json`, refreshed dependency audit | `npm audit --json`; installed-tree, license, lifecycle-script, advisory, lock-hash review | None | N/A | None | No dependency mutation performed | Audit records 12 high and 0 critical findings, all installed lock entries have licenses, two pre-existing lifecycle scripts were reviewed, and the lock SHA-256 remained unchanged | Remediation needs separately authorized compatible dependency changes |
| X-04 | Additive migration, restore, resume, and rollback rehearsal | `VERIFIED` for the authorized scope | Existing migration, backup, restore, compatibility, and guarded rollback tooling | Migration 39/39; storage acceptance 20/20; backup 7/7; isolated round-trip and migration checks; guarded script static assertions | Feature-specific | Dry-run/isolated | Additive only | Compatibility paths and guarded non-destructive rollback artifact | Crash/resume migration and isolated backup/restore pass; old records and feature-off paths remain compatible | Rollback execution was expressly prohibited and was not performed; production restore/cutover remains unauthorized |
| M6-01 | Full integration, security, performance, restore, rollback, and final acceptance | `VERIFIED` for the authorized scope | Entire milestone diff | Full test, typecheck, lint, build, security, migration, restore, dependency, diff, localhost browser gates, and final Windows PWA verification | All | Safe defaults | As documented | Guarded rollback remains unexecuted | All permitted local/isolated gates and final Windows PWA acceptance pass; complete diff review corrected encoding and stale/secret-scan fixture assumptions without weakening production controls | Production validation, dependency remediation, and rollback/deployment execution remain separately unauthorized operations |
| DEPLOY-01 | Guarded deployment deliverable without automatic deployment | `VERIFIED` | `scripts/guarded-production-deploy.sh`, `scripts/guarded-production-rollback.sh`, guarded verifier/redactor, operations document | Static safety assertions in `master-m1-release-identity-tests.cjs` | None | Manual confirmation | None | Non-destructive known-good immutable artifact | Prepared and statically verified; no deploy, restart, migration, commit, or push occurred | Execution remains explicitly unauthorized |

## Completed requirements

- M0 pre-edit inspection verified without opening real environment files or
  production data.
- M0 repository, risk, dependency, migration, feature, UI reuse, and test maps
  verified in documentation-only review.
- M0 durable ledger and initial 41-row acceptance matrix verified.
- M1 fail-closed Runtime Guardian recovery, zero-public-product recovery,
  blocked-publication auditing, scoped optional canaries, consecutive health,
  transactional audit reconciliation, and release identity are verified by
  isolated tests.
- M1 guarded deployment and rollback artifacts are prepared and statically
  verified but were not executed.
- M2 continuous slot refill, borrowable critical capacity, concurrency
  metadata/resource exclusion, fencing-aware completion, runnable-at attempt
  telemetry, and operational App Health truth are verified by isolated and
  existing regression suites.
- M2 risky behavior remains disabled by default: the pool is `OFF` and
  runnable-at control authority is `SHADOW`.
- M3 product/detail request reliability, bounded async cleanup, safe image
  fallback, remote-content transport hardening, active-route logic, and
  desktop/mobile browser behavior are verified.
- The connected Browser surface remained unavailable, so the authorized
  installed headless-Chrome fallback exercised the rebuilt localhost artifact
  with isolated synthetic data. It found and then verified the fix for a
  product-list grid intrinsic-width overflow.
- M4 deterministic extraction/provenance, provider declarations, bounded
  fallback, strict AI contracts, separate-process local adapter gates,
  provider-agnostic alert dedupe, smart categorization, and its fixed
  Vietnamese golden evaluator are verified by 74 isolated checks.
- M4 cloud/local/alert behavior remains `OFF`; categorization remains `SHADOW`.
  No external provider, notification service, local runtime, or model was used.
- M5 capability-aware bounded storage mutations, compliance-first multi-offer
  selection, verified structured data, safe centralized serialization,
  sitemap/robots filtering, and real manifest icon routes are verified by 125
  aggregate assertions and a production build.
- M5 optional behavior remains conservative: Mongo bulk is `OFF`, multi-offer
  routing and programmatic SEO V2 are `SHADOW`, FileStorage remains default,
  and legacy affiliate projection remains canonical.
- M6 authenticated correlation tracing, cross-layer redaction, resource bounds,
  dependency/supply-chain review, isolated restore/resume proof, full quality
  gates, and final localhost browser proof are verified for the authorized
  local scope.
- M6 did not execute rollback, contact production, start PM2, send external
  notifications, install/download AI software, or mutate dependencies.
- Windows Chrome manual verification proved standalone installation, custom S
  icon rendering, Windows Start registration, and app-like launch. It also
  exposed the duplicated installed name, whose title-template root cause is now
  fixed and covered by focused and aggregate automated gates.
- Final clean Windows PWA reinstall verification passed with the exact
  `SanDeal` Start name, correct custom S icon, standalone chrome, no browser
  controls, no stale duplicated name, and the intended descriptive title.

## Final completion summary

- `CODE COMPLETE`: `VERIFIED`.
- `RELEASE-CANDIDATE COMPLETE`: `VERIFIED` for the authorized local/isolated
  and Windows PWA acceptance scope.
- No unverified implementation or acceptance-matrix item remains.
- Production validation/deployment, PM2 actions, dependency remediation,
  migration/cutover, restore, and rollback execution remain outside this
  completed release-candidate scope and require separate explicit authority.

## Files changed in this upgrade session

- `.env.example`: conservative rollout and recovery policy placeholders.
- `.gitignore`: excludes the generated immutable build manifest.
- `ecosystem.config.cjs`, `next.config.ts`, `package.json`: derive embedded and
  runtime release identity from one HEAD and expose the M1 test/build commands.
- `src/lib/automation/featureRollout.ts`: server-only rollout registry.
- `src/lib/automation/runtimeRecoveryState.ts`: durable deterministic recovery
  state and consecutive-health transitions.
- `src/lib/automation/runtimeRecoveryCanary.ts`: fenced, scoped, optional
  recovery canary permits.
- `src/lib/automation/autoPublish.ts`, `src/lib/storage/products.ts`,
  `src/lib/types.ts`: replay-safe blocked/publication audits, publication
  journal reconciliation, scoped canary authorization, and additive metadata.
- `src/lib/automation/sloErrorBudget.ts`,
  `src/lib/automation/runtimeGuardian.ts`: recovery measurement semantics,
  current/historical reason separation, and release/lease truth.
- `src/lib/automation/postPublishMonitor.ts`,
  `src/lib/autonomous/lifecycle.ts`, `src/lib/publicProductFilter.ts`,
  `src/lib/seo/productSeo.ts`: real canary monitoring, immediate unhealthy
  hide, non-discoverability, and health-save correction.
- `src/lib/automation/canaryController.ts`: accepts recovery measurement states
  without weakening launch-wave safety.
- `src/lib/releaseIdentity.ts`: separates embedded artifact identity from
  runtime identities without Edge-incompatible filesystem access.
- `src/lib/automation/executionPolicy.ts`, `src/lib/automation/worker.ts`,
  `src/lib/automation/store.ts`, `src/lib/automation/types.ts`, and
  `scripts/automation-worker.cjs`: bounded continuous pool, critical capacity,
  durable conflict metadata, attempt context, fencing-aware completion, and
  graceful drain behavior.
- `src/lib/automation/sloErrorBudget.ts`: shadow-first runnable-at measurement,
  pickup P50/P95, retry pickup, never-claimed queue age, exact window
  boundaries, and interrupted-attempt fallback.
- `src/lib/automation/operationalHealth.ts`,
  `src/app/api/automation/health/route.ts`, and
  `src/app/dashboard/app-health/page.tsx`: current/history separation,
  recovery/SLO/pool/canary/operator/feature diagnostics, and separate
  embedded/runtime/lease release truth.
- `src/lib/dashboard/clientRequest.ts`,
  `src/app/dashboard/products/products-dashboard.tsx`,
  `src/app/dashboard/products/[id]/page.tsx`, and
  `src/app/dashboard/app-health/page.tsx`: bounded requests, cancellation,
  stale-response rejection, duplicate-submit prevention, terminal recheck
  feedback, and cleanup on every outcome.
- `src/components/safe-product-image.tsx`,
  `src/app/dashboard/products/[id]/product-detail.module.css`, and
  `src/app/globals.css`: local image fallback, failure categorization, stale
  event protection, and visible verification feedback.
- `src/lib/dashboard/navigation.ts` and
  `src/app/dashboard/layout.tsx`: deterministic nested-route navigation state.
- `src/app/dashboard/products/products.module.css`: allows the product grid and
  result sections to shrink to a mobile viewport while retaining the table's
  bounded horizontal scroller.
- `src/lib/product-intelligence/urlSafety.ts` and
  `src/lib/bots/productHealthCheck.ts`: DNS-pinned, redirect-revalidated,
  timeout/size/encoding/MIME-bounded remote transport and product health
  probes.
- `src/lib/product-intelligence/deterministicExtraction.ts` and
  `src/lib/bots/imageResolver.ts`: one bounded JSON-LD/OpenGraph/HTML
  extraction floor with field-level source provenance.
- `src/lib/automation/providerRegistry.ts` and
  `src/lib/automation/providerFallback.ts`: explicit provider declarations and
  feature-gated, transient-only, deadline-bounded fallback.
- `src/lib/ai/canonicalDataContract.ts`,
  `src/lib/ai/geminiEditorialProvider.ts`, and
  `src/lib/ai/localAiAdapter.ts`: exact AI proposal/editorial validation,
  evidence-gated write projection, and optional loopback-only local tier.
- `src/lib/automation/operatorAlerting.ts`: disabled-by-default injected alert
  delivery with transition dedupe and hashed durable receipts.
- `src/lib/product-intelligence/smartCategorization.ts` and
  `src/lib/types.ts`: deterministic Vietnamese category evidence and
  shadow-safe additive suggestions.
- `next.config.ts`: compatible Content Security Policy and browser security
  headers in addition to immutable release identity.
- `scripts/master-m3-client-request-tests.cjs`,
  `scripts/master-m3-remote-content-security-tests.cjs`, and
  `scripts/master-m3-ui-reliability-tests.cjs`: focused M3 regression proof.
- `scripts/master-m3-browser-tests.cjs`: dependency-free, localhost-only
  headless Chrome gate for desktop/mobile viewport, keyboard focus, active
  navigation, loading, error/retry, settled state, accessibility projection,
  and screenshot evidence.
- `scripts/prompt07-release-ui-tests.cjs` and
  `scripts/prompt10-resilience-tests.cjs`: exact safe feature-default checks
  and production-shaped fail-closed resilience fixtures.
- `scripts/master-m1-runtime-recovery-tests.cjs`,
  `scripts/master-m1-release-identity-tests.cjs`, and the three updated Prompt
  10 suites: isolated M1 proof.
- `scripts/master-m2-worker-pool-tests.cjs`,
  `scripts/master-m2-slo-runnable-tests.cjs`, and
  `scripts/master-m2-operational-health-tests.cjs`: isolated M2 proof.
- `scripts/master-m4-intelligence-tests.cjs` and
  `scripts/fixtures/master-m4-vietnamese-category-golden.json`: isolated M4
  provider/extraction/contract/alert/category proof and its fixed 30-case
  evaluator dataset.
- `src/lib/storage/bulkMutation.ts`, storage adapter types/facade/File/Mongo
  implementations, and `mongoSchema.ts`: truthful capability declarations,
  bounded partial results, atomic revision application, and additive schema
  inventory.
- `src/lib/product-intelligence/complianceOfferSelector.ts` and `src/lib/types.ts`:
  fail-closed offer eligibility, stable ranking/hashes, shadow suggestion, and
  legacy-compatible active projection.
- `src/lib/seo/structuredData.ts`,
  `src/lib/product-intelligence/urlValidation.ts`, product/taxonomy SEO,
  rendered JSON-LD entry points, sitemap, and manifest: browser-safe public URL
  screening, centralized bounded escaping, verified derived claims, and valid
  metadata/icon routes.
- Public deal/list/compare/taxonomy/product metadata now delegates the
  `| SanDeal` document-title suffix to the root Next.js template exactly once;
  manifest identity and generated S icon routes are unchanged.
- `scripts/master-m5-platform-seo-tests.cjs`, extended storage adapter tests,
  and production-shaped business search/SEO fixtures: isolated M5 proof.
- `scripts/master-pwa-metadata-tests.cjs`: focused exact-name, application
  metadata, title-template, social-title, and unchanged-icon regression proof.
- `src/lib/automation/correlationTrace.ts` and
  `src/app/api/automation/audit/route.ts`: authenticated, read-only, bounded
  cross-layer correlation with hashed identifiers and explicit missing stages.
- `scripts/master-m6-integration-tests.cjs`: complete/incomplete trace,
  redaction, bounds, identifier validation, and auth-order proof.
- `scripts/release-validation.cjs` and selected isolated test fixtures:
  exact public example defaults and clearly labeled synthetic values so the
  release secret scan remains strict without treating fixtures as credentials.
- `docs/operations/DEPENDENCY_AUDIT_2026-07-24.md`: refreshed M6 lock,
  license, lifecycle-script, reachability, advisory, and remediation evidence.
- `scripts/write-build-manifest.cjs`, guarded deploy/rollback/verifier/redactor
  scripts, and `docs/operations/SANDEAL_MASTER_GUARDED_DEPLOYMENT.md`: prepared
  release and rollback artifacts.
- `docs/implementation/SANDEAL_MASTER_UPGRADE_STATUS.md`: durable ledger and
  acceptance matrix.

The pre-existing `package-lock.json` change is not part of this upgrade session.

## Tests added

- Added `master-m1-runtime-recovery-tests.cjs` and
  `master-m1-release-identity-tests.cjs`.
- Extended autopublish, SLO, and self-healing regressions with current,
  fully eligible isolated fixtures and failure/replay assertions.
- Added 25 focused M2 cases: worker pool (10), runnable-at SLO (12), and
  operational health truth (3).
- Added 29 focused M3 cases: bounded client requests (11), remote-content
  security (11), and UI reliability contracts (7).
- Added a reproducible localhost-only M3 browser gate covering 10 rendered
  states, 10 keyboard focus steps, an accessibility tree, and 9 screenshots.
- Added 17 focused M4 cases covering extraction bounds/provenance, registry and
  fallback policy, strict AI contracts, feature-off/local resource behavior,
  adapter concurrency, benchmark gates, alert dedupe, categorization evidence,
  shadow safety, and the Vietnamese golden dataset.
- Added 13 focused M5 cases covering bounded bulk mutation, compliance-before-
  price selection, unsafe/duplicate/over-limit offer rejection, stable ties and
  hashes, shadow/active behavior, script-safe JSON-LD, evidence-qualified
  price/image output, noindex preservation, manifest, and robots.
- Added 5 focused Windows PWA metadata cases covering exact manifest `name` and
  `short_name`, application metadata, one-pass title composition, branded
  social titles, and unchanged custom S icon routes.
- Extended FileStorage and fake-Mongo adapter coverage for capability discovery,
  atomic revision application, and per-item partial failures.
- Added 5 focused M6 cases covering the complete durable publication trace,
  explicit incomplete evidence, per-layer bounds, strict correlation IDs, raw
  identifier/secret/reason redaction, and route authentication ordering.
- Updated resilience and release UI fixtures to exercise current production
  safety requirements without weakening assertions.

## Exact test commands and results

| Command | Result |
| --- | --- |
| `npm run test:master:m1` | Passed: 84 passed, 0 failed across recovery primitives (15), release identity (10), runtime roles (18), autopublish (21), SLO (12), and self-healing (8). |
| `npm run test:master:m2` | Passed: 25 passed, 0 failed across worker pool (10), runnable-at SLO (12), and operational health truth (3). |
| `npm run test:master:m2:worker` | Passed: 10 passed, 0 failed; replacement claims, bounds, sibling isolation, drain, critical borrowing/fairness, conflict keys, atomic capacity, Guardian pickup, and fencing. |
| `npm run test:master:m2:slo` | Passed: 12 passed, 0 failed; runnable priority, retry, scheduling, invalid/negative samples, congestion, exact window boundaries, pending age, and interrupted attempt reconciliation. |
| `npm run test:master:m2:health` | Passed: 3 passed, 0 failed; current/history separation and recovery/SLO/canary/pool/release truth. |
| `npm run test:master:m3` | Passed: 39 passed, 0 failed across bounded client requests (11), remote-content security (11), UI reliability (7), and dashboard regression (10). |
| `node scripts/master-m3-browser-tests.cjs --base-url=http://localhost:3100 --evidence-dir=.test-tmp/m3-browser-evidence-20260726` | Passed after the responsive-width fix: 10 rendered states, 10 keyboard focus steps, 9 screenshots, correct nested active navigation, visible loading and error/retry feedback, no stuck state, and no desktop/mobile page overflow. |
| `npm run test:master:m4` | Passed: 74 passed, 0 failed across M4 intelligence (17), Gemini diagnostics (7), operator intelligence (27), bot foundation (10), and business source/quality (13); isolated adapters only, with zero real provider or notification calls. |
| `npm run test:master:pwa` | Passed: 5 passed, 0 failed for exact manifest/application identity, one-pass route title composition, separate social titles, and unchanged S icon routes. |
| `npm run test:master:m5` | Passed after the PWA remediation: 125 passed, 0 failed across M5 platform/SEO (13, including exact manifest names), FileStorage (12), fake Mongo (28), migration (39), storage acceptance (20), revenue integrity (5), and business search/SEO (8). |
| `npm run test:master:m6` | Passed: 5 passed, 0 failed across complete/incomplete correlation, redaction, bounds, strict identifiers, and authentication ordering. |
| `npm test` | Passed: the complete chained repository suite exited successfully after production-shaped fixture corrections; no production gates or assertions were relaxed. |
| `node scripts/master-m3-remote-content-security-tests.cjs` | Passed after central serializer refactor: 11 passed, 0 failed, including browser-safe URL validation and centralized script-termination escaping. |
| `npm run test:prompt08` | Passed: 58 passed, 0 failed across its five product/UI/API suites. |
| `npm run test:accesstrade` | Passed: 34 passed, 0 failed. |
| `npm run test:hardening` | Passed: 12 passed, 0 failed. |
| `npm run test:prompt10:resilience` | Passed: 11 passed, 0 failed with production-shaped product and provider-readiness fixtures. |
| `npm run test:operator-intelligence` | Passed: 27 passed, 0 failed. |
| `npm run test:release-ui` | Passed: 17 passed, 0 failed. |
| `npm run test:production-readiness` | Passed: 5 passed, 0 failed. |
| `npm run test:automation` | Passed: 29 passed, 0 failed across automation (20) and stabilization (9). |
| `npm run test:durable-health` | Passed: 25 passed, 0 failed. |
| `npm run test:prompt10:orchestration` | Passed: 12 passed, 0 failed. |
| `npm run test:prompt10:job-schema` | Passed: 10 passed, 0 failed. |
| `npm run test:health-readiness` | Passed: 33 passed, 0 failed. |
| `npm run test:prompt10:runtime` | Passed: 18 passed, 0 failed. |
| `npm run test:prompt10:backup` | Passed: 7 passed, 0 failed using isolated backup/recovery fixtures. |
| `npm run release:backup-verify` | Passed: `BACKUP_RESTORE_VERIFICATION=READY files=3 schema=1`. |
| Isolated `npm run release:migration-check` | Passed: `MIGRATION_COMPATIBILITY_CHECK=READY` against a new empty `.test-tmp` data root; no real data directory was used. |
| `npm run release:secret-scan` | Passed: `SECRET_SCAN=READY files=469`. |
| `npm run release:generated-check` | Passed: `GENERATED_FILE_CHECK=READY`. |
| `npm audit --json` | Completed without manifest/lock mutation: 12 high, 0 critical, 0 moderate, and 0 low package entries; incompatible/invalid npm fix proposals were not applied. |
| `npm run typecheck` | Passed with no TypeScript errors after the PWA remediation. |
| `npm run lint` | Passed after the PWA remediation with 0 errors and the same 10 unrelated pre-existing unused-variable warnings. |
| `npm run build` | Passed on Next.js 16.2.11 after the PWA remediation; manifest matched current HEAD, compiled in 6.8 seconds, TypeScript finished in 12.8 seconds, and 44 static pages generated in 1196 ms. One pre-existing NFT tracing warning remains for `backupManager.ts`/`next.config.ts`. |
| Rebuilt localhost PWA metadata smoke at `http://localhost:3100` | Passed: manifest `name`/`short_name` are exactly `SanDeal`; application metadata is `SanDeal`; `/deals` title contains one suffix; custom 32px/180px S icon routes return 200; live health passes with no release mismatch. |
| Final Windows Chrome PWA uninstall/reinstall verification | Passed: Windows Start name exactly `SanDeal`; correct custom S icon; standalone window; no normal Chrome tab strip/address bar; stale duplicated name removed; descriptive title preserved. |
| `node scripts/master-m3-browser-tests.cjs --base-url=http://localhost:3100 --evidence-dir=.test-tmp/m6-browser-evidence-20260726 --debug-port=9346` | Passed against the final rebuilt artifact: exact HEAD release, 10 rendered states, 10 keyboard focus steps, 9 screenshots, loading/error/retry/desktop/mobile/navigation coverage, and no page overflow. The isolated server was stopped afterward. |
| `git diff --check` | Passed with no whitespace errors; Git emitted only Windows line-ending conversion warnings. |
| M1 verification-mode complete diff review | Passed after resolving consumed-permit TTL capacity, stale scheduler/release checks, audit provenance, risk-level fidelity, Edge runtime compatibility, and publication-audit partial-commit reconciliation findings. |
| M2 verification-mode complete diff review | Passed after resolving stale-worker post-fencing writes, concurrent `workerCurrentJobId` clearing, active-lease release projection, and missing-latest-attempt telemetry reconciliation. |
| M3 verification-mode complete diff review | Passed after resolving transport-ignored aborts, synchronous duplicate races, route-change monitor cleanup, total DNS/socket deadlines, bodyless response reconstruction, redirect-body cleanup, private address gaps, unsafe runtime DNS bypass, and product-table intrinsic-width propagation on mobile. |
| M4 verification-mode complete diff review | Passed after resolving JSON-LD limit detection, optional queue-depth zero handling, local-adapter transport-ignored abort settlement, semaphore handoff, adapter-ID normalization, and strict evidence-bound Gemini parsing. |
| M5 verification-mode complete diff review | Passed after correcting production-shaped publication fixtures, removing an inaccurate native-Mongo-bulk capability claim, rejecting duplicate/over-limit offer ambiguity, hashing all ranking inputs, validating future offer dates, centralizing circular/oversize-safe JSON-LD serialization, and splitting browser-safe URL syntax validation from server DNS enforcement. |
| M6 verification-mode complete diff review | Passed after bounding trace roots/layers, avoiding per-monitor attempt reads, enforcing auth before trace evaluation, hashing raw identifiers/reasons, correcting two double-encoded Vietnamese messages, and reconciling strict secret scanning and legacy production-shaped fixtures without weakening runtime gates. |

## Failed tests

- No current PWA, M1, M2, M3, M4, M5, or M6 automated gate test is failing.
- Historical baseline `npm run test:prompt10:autopublish`: 6 passed, 8 failed before
  M1 source changes. The current fixtures do not provide all fields required by
  the current eligibility policy, so expected publication effects are absent.
  This must be corrected by making fixtures fully eligible, without relaxing
  production gates or assertions.
- Historical baseline `npm run test:prompt10:self-healing`: 4 passed, 4 failed before M1
  source changes. Three failures share stale publication fixture fields. The
  alternate URL recovery case also exposed a production bug: a verified monitor
  URL replacement is saved without the `verifiedHealthUpdate` option, which
  invalidates the public record and then triggers `SAFE_PUBLISH_JOB_REQUIRED`.
- Historical baseline `npm run test:prompt10:slo`: 10 passed, 0 failed.
- Both historical failing suites now pass without weakening production gates:
  autopublish is 21/21 and self-healing is 8/8.
- During M3, AccessTrade source checks, resilience fixtures, App Health labels,
  and the exact safe feature-default whitelist initially exposed stale test
  assumptions. Each was corrected to current production contracts; the final
  results are 34/34, 11/11, 27/27, and 17/17 respectively.
- The Browser connector still returned an empty available-browser list. The
  authorized headless fallback initially failed one application assertion:
  the 390px product list had a 996px page scroll width because a 980px table
  min-content width propagated through CSS Grid ancestors. Adding explicit
  shrink boundaries kept the table's local scroller and removed page overflow;
  the final browser gate passed.
- The first M5 aggregate run exposed six stale business search/SEO fixtures
  missing current publication evidence. Only fixture evidence was completed;
  production gates were unchanged, and the final suite passed 8/8.
- The first post-M5 build exposed a server-only `dns`/`net` import reaching a
  client taxonomy bundle through the centralized serializer. Pure URL syntax
  screening was moved to `urlValidation.ts`; DNS resolution and pinned
  transport remain server-only in `urlSafety.ts`. The final build passed.
- The first full M6 suite found three stale fixture expectations: two verified
  JSON-LD price fixtures lacked current price-verification evidence, and one
  hardening assertion still expected a removed maskable icon. Fixture evidence
  and the assertion were aligned to the unchanged production contract.
- The first M6 lint pass required the repository's standard CommonJS test-file
  exemption for the new headless browser harness. The final lint pass has no
  errors.
- The first M6 secret scan treated clearly synthetic claim/credential strings
  and newly documented public rollout defaults as possible secrets. Synthetic
  test values were explicitly labeled and exact public defaults were
  allowlisted; scanning rules and production code were not weakened.
- Final verification found two double-encoded Vietnamese response messages in
  the new correlation route. The source literals were corrected and the
  focused M6/type gates were re-run.

## Schema changes

- Additive `runtime-recovery-state` record, schema version 1.
- Additive `runtime-recovery-canary-permits` collection, schema version 1.
- Additive SLO metric measurement state/reason fields.
- Additive publication audit metadata and product blocked/publication/canary
  observation fields.
- Additive automation job execution class/resource/critical metadata and
  runnable-at context.
- Additive `automation-job-attempts` records, schema version 1, with a bounded
  10,000-record retention limit and hashed claim token.
- Additive SLO pickup P50/P95, legacy/runnable comparison, retry pickup,
  pending queue age, rollout mode, and source-count fields.
- Additive authenticated automation-health API projection fields.
- M3 adds no canonical data schema and requires no data migration.
- M4 adds versioned derived extraction/AI proposal contracts, additive product
  category-suggestion evidence, and versioned operator-alert delivery state.
  Existing canonical fields and categories are not rewritten by default.
- M5 adds adapter capability/bulk result contracts, additive affiliate-offer
  compliance/suggestion fields, and Mongo schema inventory entries for state
  collections introduced by M1-M4. Structured data remains derived output and
  is not persisted.
- M6 adds no canonical data schema. Correlation output is a read-only
  projection over existing durable records and does not persist raw or derived
  identifiers.
- Old records normalize with explicit fail-closed defaults; old three-effect
  publication journals retain their original contract and replay path.

## Migration status

- Code migration: not required; loaders normalize additive missing fields.
- Data migration: not required for M1, M2, M3, M4, M5, or M6.
- Optional backfill: not recommended; state is created on first real recovery
  evaluation, new job attempts are captured on future claims, and historical
  timing/audit evidence must not be fabricated.
- Downtime: not required by M1, M2, M3, M4, M5, or M6 code.
- Isolated migration crash/resume, compatibility, backup, and restore checks
  pass. Rollback tooling was not executed, in accordance with the explicit
  prohibition.
- Production execution: not authorized.

## Security findings

1. Product health remote fetches now use a single bounded safety transport that
   validates the URL and every resolved address, pins the runtime connection to
   the validated address, and revalidates every redirect.
2. HTTP credentials, unsafe protocols/ports, localhost, private/link-local/
   metadata destinations, mixed public/private DNS sets, redirect loops,
   oversized bodies, non-identity encodings, response deadlines, and unsafe
   product MIME types fail closed.
3. Client image sources are restricted to local-relative or HTTPS public-looking
   URLs and fail to a local placeholder. Server-side DNS/IP validation remains
   authoritative for server fetches.
4. Token Vault safe projections and automation audit sanitization exist.
5. No secret was displayed during M0.
6. PM2 verification reads and reports only the selected release fields; recent
   logs pass through a bounded credential redactor.
7. Recovery canaries revalidate current worker fencing, scheduler lease,
   operator/emergency/policy controls, release identity, evidence age, and
   product eligibility before the sole runtime-block exception.
8. Global response headers now include CSP, frame/object/base restrictions,
   no-sniff, referrer, permissions, and cross-origin opener policy. The CSP
   retains `unsafe-inline` for Next.js compatibility and is not represented as
   a nonce-based strict CSP.
9. Focused security tests use injected no-network transports; no production or
   external host was contacted.
10. AI canonical/editorial responses now require exact schemas, bounded
    serialization, known evidence IDs, explicit versions/hashes and narrow
    write authorization; unknown URL/price/status keys fail closed.
11. Local AI configuration accepts loopback HTTP with an explicit port only
    and cannot start, install, or download a runtime. Cloud/local fallback and
    external alert delivery default to `OFF`.
12. Operator alert delivery stores a hash of the entity and optional receipt,
    not their raw identifiers; secret-like metadata keys fail closed.
13. M5 JSON-LD entry points use one bounded serializer that escapes script and
    HTML delimiters and rejects circular or oversized payloads.
14. Browser-safe URL syntax/private-literal screening is isolated from
    server-only DNS resolution. Network fetch paths still validate all resolved
    addresses and pin the selected public address.
15. Multi-offer selection fails closed on unsafe URLs, merchant drift,
    unverified disclosure/tracking/source/price, stale or expired evidence,
    duplicate identifiers, and inputs above the 32-offer bound.
16. The M6 correlation projection remains behind the existing route
    authentication, validates a narrow operation-ID grammar, bounds every
    collection layer, hashes operation/job/audit/product/reason references, and
    reports missing evidence rather than fabricating a complete chain.
17. The release secret scan passes across 469 files. M6 tests verify that raw
    worker, product, operation, payload/result credential, idempotency, and
    reason strings do not enter the correlation projection.

## Dependency findings

- No dependency was added, removed, or upgraded by M1 through M6.
- Current direct dependencies are intentionally small.
- Zod and Cheerio are not installed.
- The operator-owned lockfile diff remains byte-for-byte preserved at SHA-256
  `F2708BB721736AFBB9F3B4FF0FE0464E11BCE9E26E9A8D4B0B1F24C6E6F5591A`.
- The refreshed audit in
  `docs/operations/DEPENDENCY_AUDIT_2026-07-24.md` records all installed
  licenses, the two pre-existing lifecycle scripts, reachability, and 12 high
  package entries with no critical finding.
- npm's proposed fixes are incompatible or invalid for the current graph and
  would overwrite the operator-owned lockfile; no fix was applied. A compatible
  dependency remediation requires separate authorization and full revalidation.

## Performance findings

- The opt-in continuous path replaces mixed-batch head-of-line blocking with a
  bounded slot-refill loop and never queues more active promises than
  `maxConcurrency`.
- The production settings still cap `maxConcurrency` at 4; the launcher caps a
  pool cycle at 50 claims and normally uses the configured `maxItemsPerRun`.
- A controlled slow-sibling scenario proved that freed capacity starts
  replacement work before the unrelated sibling completes.
- A controlled Guardian scenario measured pickup below the unchanged
  30-second target when capacity existed. This is isolated test evidence, not
  a production latency claim.
- A 40-job kernel load case stayed at peak in-flight 3 with 40 bounded claim
  attempts and no unbounded promise queue.
- Runnable-at SLO telemetry preserves true congestion while excluding time
  before future schedules and reports never-claimed pending age separately.
- M3 client requests default to a 15-second deadline and 1 MiB response cap,
  with hard helper maxima of 60 seconds and 4 MiB.
- M3 server remote checks retain bounded task-specific deadlines and enforce a
  2 MiB hard response cap, five redirects, and no compressed transfer.
- M4 provider routing caps the chain at three providers and four total attempts
  under a 60-second hard deadline. Declared provider response limits are at
  most 512 KiB and provider concurrency is at most four.
- M4 local AI readiness requires a separate loopback process, at least 1 GiB
  free memory by default, event-loop delay at most 100 ms, bounded concurrency
  and queue depth, and a strict 256 KiB response limit.
- The synthetic local benchmark evaluator requires at least 20 samples, 95%
  success, response P95 at most 5 seconds, event-loop delay at most 100 ms, RSS
  delta at most 512 MiB, and Guardian pickup below 30 seconds. This verifies
  gate logic only and is not a real model performance result.
- The final M3 build compiled in 3.5 seconds, TypeScript finished in 8.2
  seconds, and 44 static pages generated in 542 ms. These are local timings.
- M5 bulk requests are capped at 100 mutations and 64 KiB per upsert value;
  FileStorage and Mongo apply successful items in one atomic collection
  revision while reporting deterministic per-item failures.
- M5 offer evaluation is capped at 32 offers and fails the entire selection
  closed when the input exceeds that bound.
- M5 JSON-LD serialization is capped at 256 KiB and product/category text fields
  are normalized and truncated before serialization.
- The final M5 build compiled in 3.9 seconds, TypeScript finished in 10.6
  seconds, and 44 static pages generated in 631 ms. These are local timings.
- M6 correlation reads at most 20 root jobs, 50 records per normal evidence
  layer, and 50 child monitor jobs. It reuses persisted monitor attempt counts
  instead of creating per-monitor attempt queries.
- The final M6 build compiled in 4.1 seconds, TypeScript finished in 10.0
  seconds, and 44 static pages generated in 608 ms. These are local timings.
- The final rebuilt localhost browser run repeated desktop/mobile, keyboard,
  loading, error/retry, navigation, and overflow proof using isolated data.

## M1 baseline test evidence

| Command | Result | Isolated artifacts |
| --- | --- | --- |
| `npm run test:prompt10:autopublish` | Failed: 6 passed, 8 failed | `.test-tmp\prompt10-autopublish-23504-1785046997401` |
| `npm run test:prompt10:slo` | Passed: 10 passed, 0 failed | `.test-tmp\prompt10-slo-error-budget-21536-1785047017486` |
| `npm run test:prompt10:self-healing` | Failed: 4 passed, 4 failed | `.test-tmp\prompt10-self-healing-12588-1785047024984` |

All three commands used isolated test storage. No production collection, role
lease, job, audit, snapshot, or provider quota was touched.

## Known limitations

- The continuous pool remains `OFF`; no production workload or PM2 process was
  used to validate it.
- Runnable-at SLO authority remains `SHADOW`; production historical attempts
  are not backfilled.
- App Health and product UI are covered by isolated/API/source regressions and
  rebuilt-artifact headless browser desktop/mobile and keyboard verification.
- No Mongo adapter integration was contacted.
- Installed-app/OS-specific PWA install, S icon, exact Windows Start name,
  standalone launch, absence of normal Chrome controls, stale-name removal, and
  descriptive title were all manually verified against the rebuilt artifact.
- No local AI runtime was installed or started. Benchmark gate logic was
  verified with deterministic samples; actual model performance was not
  measured or claimed.
- No production host, PM2 process, lease, health endpoint, or data was accessed.
- The build retains one pre-existing Turbopack NFT warning caused by dynamic
  backup filesystem paths tracing through an application route.
- `SANDEAL_BUILD_MANIFEST_COMMIT` is an internal build/deployment identity
  derived from the same reviewed HEAD; it is not an operator secret.
- Remote security tests use deterministic no-network fixtures; live DNS,
  redirect-server, CDN, and decompression behavior has not been integration
  tested against external hosts.
- The refreshed audit has 12 unresolved high-severity package entries and no
  critical finding. Remediation was not authorized and npm's proposals are
  incompatible or invalid for this dependency graph.
- M6 performance/resource findings are isolated deterministic evidence; no
  production workload, latency, memory, event-loop, or trace-volume claim is
  made.
- Rollback execution remains untested by explicit instruction. Static guarded
  rollback checks and feature-off compatibility are verified.

## Known risks

- The repository starts from a historical production SHA, but that fact does
  not authorize deployment or rollback.
- The dirty lockfile requires continued overlap checks before any dependency
  action.
- M1 cross-collection effects depend on durable idempotent replay rather than a
  database-wide transaction; failure-path tests prove the intended recovery,
  but production observation remains unauthorized.
- A consumed canary permit intentionally retains capacity until a real monitor
  finalizes it; a missing monitor therefore fails closed and requires
  operational diagnosis rather than automatic permit reuse.
- FileStorage job-attempt persistence is a second idempotent transaction after
  the canonical claim. If interrupted, the committed job context supplies the
  latest sample; older attempt records do not suppress that reconciliation.
- The legacy worker path remains available and retains its previous mixed-batch
  behavior while `WORKER_CONTINUOUS_POOL_V2` is `OFF`.
- Next-compatible CSP currently permits inline scripts and styles. This is a
  documented residual risk until a nonce/hash architecture is proven compatible.
- The dependency audit chain remains an explicit supply-chain risk until a
  separately authorized compatible dependency graph is available.

## Exact next safe action

No further implementation milestone is eligible without additional authority.
The next safe actions are operator decisions, independently:

1. Review and commit the completed release-candidate worktree, then push only
   when explicitly authorized.
2. Optionally authorize and review a compatible dependency remediation that explicitly
   takes ownership of `package-lock.json`.
3. Separately authorize any production validation, deployment, PM2 action,
   migration/cutover, restore, or rollback execution.

## Resume instructions

At the next session or after context compaction:

1. Verify the working directory is `C:\duan\sandeal`.
2. Verify the branch is `master`.
3. Read the master upgrade contract in the conversation.
4. Read this ledger in full.
5. Run `git rev-parse HEAD` and compare it with `Current Git SHA`.
6. Run `git status --short --branch`.
7. Review the complete existing diff, preserving the operator-owned lockfile.
8. Treat M0-M6 as locally verified for the authorized scope; do not repeat
   already verified implementation work.
9. Treat `CODE COMPLETE` and `RELEASE-CANDIDATE COMPLETE` as verified, including
   final Windows PWA acceptance.
10. Continue only from a separately authorized
    commit/push/production/dependency/rollback item
    after obtaining the specific authority it requires.

Do not commit, push, migrate, restart PM2, deploy, alter production
configuration, or mutate production data without separate explicit approval.
