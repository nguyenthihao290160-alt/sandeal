# Phase 5 — Affiliate Money Engine

Local-only continuation on `master`, HEAD `3f2ee7d8bd1ef57fa9207f021cc03519b7eecde7`. Phase 4 and Phase 4.5 remain formally PASS. Existing dirty changes and legacy rollback paths are preserved. This checkpoint does not authorize deployment or Phase 6.

```text
AFFILIATE_DOMAIN_MODEL=EXISTING_PRODUCT_AND_PRODUCT_OFFER_WITH_NORMALIZED_MONETIZATION_AND_D1_EVIDENCE_LEDGER
AFFILIATE_PROVIDER_CONTRACT=EXISTING_AFFILIATE_PROVIDER_V1_WITH_EXPLICIT_CAPABILITIES
PRIMARY_PROVIDER=AccessTrade
SECONDARY_PROVIDER=TikTok
DIRECT_SHOPEE_STATUS=DISABLED_NO_CREDENTIALS
ACCESSTRADE=PASS
TIKTOK=PASS
DIRECT_SHOPEE=PASS_FAIL_CLOSED
ACCESS_TRADE_SHOPEE_SUPPORT=PROVIDER_RETURNED_DATAFEED_OR_OFFERS_DESTINATIONS_ONLY
ACCESS_TRADE_SHOPEE_PROVENANCE=provider:accesstrade_platform:shopee_sourceEvidence:accesstrade
ACCESS_TRADE_SHOPEE_NORMALIZATION=PASS
ACCESS_TRADE_SHOPEE_MONETIZATION=PASS
OFFER_NORMALIZATION=CANONICAL_IDENTITY_VALIDATION_AND_BOUNDED_CAS_MERGE
PRODUCT_TO_MULTI_OFFER_MODEL=ONE_PRODUCT_MULTIPLE_PROVIDER_PLATFORM_MERCHANT_CAMPAIGN_OFFERS
CONFIDENCE_SCALE=PRODUCT_OFFER_0_TO_1_MONEY_SOURCE_SCORE_0_TO_100_EXPLICIT_DIVIDE_BY_100
MONEY_ROUTER=PASS
MONEY_ROUTER_REASON_CODES=ELIGIBILITY_REJECTIONS_AND_DETERMINISTIC_EXPLAINABLE_SELECTION
CLICK_ATTRIBUTION=PASS
CONVERSION_ATTRIBUTION=PASS
COMMISSION_LEDGER=PASS
COMMISSION_STATES=UNKNOWN,ESTIMATED,PENDING,APPROVED,REJECTED,PAID
REVENUE_SNAPSHOTS=PASS
AFFILIATE_REDIRECT_SECURITY=PUBLISHED_PRODUCT_CAS_PROVIDER_HEALTH_PROVENANCE_ALLOWLIST_NO_CALLER_TARGET
EVENT_DRIVEN_SYNC=BOUNDED_REVENUE_SNAPSHOT_JOB_USING_PHASE_4_5_LIFECYCLE
LIVE_PROVIDER_CONVERSION_SYNC=NOT_SUPPORTED
LIVE_PROVIDER_COMMISSION_SYNC=NOT_SUPPORTED
DUPLICATE_CONVERSION_EFFECT=0
DUPLICATE_COMMISSION_EFFECT=0
DUPLICATE_REVENUE_EFFECT=0
DUE_WORK_FULL_SCAN=NO
REVENUE_HOT_PATH_FULL_SCAN=NO
HEARTBEAT_WRITES=0
CONTINUOUS_POLLING=NO
FILE_STORAGE_CALLS=0
FILESYSTEM_SETTINGS_CALLS=0
PM2_REQUIRED=NO
VPS_REQUIRED=NO
LONG_RUNNING_PROCESS_REQUIRED=NO
DIRECT_SHOPEE_API_CALLS=0
TEST_CASES_SKIPPED=0
ASSERTIONS_WEAKENED=NO
MONEY_ASSERTIONS_WEAKENED=NO
SAFETY_GATES_RELAXED=NO
FAKE_REVENUE_PRODUCTION_PATH=NO
FAKE_DIRECT_SHOPEE_PRODUCTION_PATH=NO
NEW_TEST_CASES_PASSED=57
NEW_TEST_CASES_FAILED=0
TESTS_PASSED=280
TESTS_FAILED=0
TYPESCRIPT=PASS
ESLINT=PASS_0_ERRORS_34_EXISTING_WARNINGS
SECRET_SCAN=PASS
BUILD_LEGACY=PASS_VALIDATION_ONLY
BUILD_CLOUDFLARE=PASS_STATIC_AND_WORKER
PRODUCTION_RESOURCE_CREATED=NO
REAL_MONEY_TRANSACTION_CREATED=NO
REAL_PRODUCTION_DATA_MIGRATED=NO
CLOUDFLARE_LOGIN_USED=NO
DEPLOYED=NO
RESULT=PASS
SAFE_FOR_PHASE_6=YES_LOCAL_FOUNDATION_ONLY
BLOCKERS=NONE_FOR_LOCAL_PHASE_5
```

## Resume and confidence correction

Reconstruction read the persisted state and prior checkpoints before editing. The saved focused result was 42 passed, zero failed/skipped, in `.test-tmp/v6-resume-3-ZFJo4r/v6-money-engine.log`. The earlier 35- and 40-case runs are historical progress, not additional cases to sum. Another 223 affected regression cases and pre-correction quality/build results existed. The Phase 5 checkpoint did not yet exist.

The confidence correction was already saved when the run resumed: `projectedOffer()` divides the normalized money source score by 100. Existing `evaluatePublicOffer()` uses a 0..1 confidence scale with a 0.75 threshold. The money router's 0..100 score remains explicitly separate; it is an ordinal source verification score, not a predicted conversion probability. Exact assertions check projected 1 and normalized 100. The corrected files postdated the 42-case manifest, so that run was not accepted as final validation of the correction.

First unverified step: validate the saved confidence correction, then implement the newly requested AccessTrade/platform provenance and platform summaries. The existing money model, evidence tables, atomic job lifecycle and tests were extended rather than restarted. The raw AccessTrade normalizer gains only preservation of an explicit boolean `available`; missing or string-valued availability stays unknown. No provider endpoint, credential flow, discovery algorithm, commission assumption or live API is invented.

## Provider, platform and provenance

`AffiliateProvider` remains the provider boundary. AccessTrade discovery uses the existing source adapter and returned links; fresh generic AccessTrade tracking-link creation and live transaction/commission sync remain NOT_SUPPORTED. TikTok retains its existing registry ID, AccessTrade TikTok source adapter, Product Feed V2 behavior and tracking-link resolver. Its explicit `sourceEvidence.provider=accesstrade` records the existing transport provenance; `platform=tiktok_shop` is separate. The Money Engine does not relabel an AccessTrade Shopee offer as a direct Shopee provider.

Supported Shopee normalization requires a verified AccessTrade item with a canonical Shopee Vietnam merchant domain, an actual returned affiliate destination, a source endpoint/field and an authoritative campaign ID. The existing normalizer historically labels its platform as `accesstrade`; the money projection derives `shopee` from the verified merchant domain and records `platformBasis=MERCHANT_DOMAIN`. Contradictory provider/platform/domain claims and absent required evidence fail closed. Unsupported marketplace domains or unknown fields are not guessed. Local merchant IDs are domain-derived identities, not invented upstream IDs; supplied shop IDs are preserved separately. Campaign IDs come from the provider-returned campaign field.

Direct Shopee stays unavailable: default missing credentials yields DISABLED_NO_CREDENTIALS; explicitly enabled but awaiting access yields PENDING_EXTERNAL_ACCESS. Every existing direct API operation returns an unavailable result. No direct order/payout capability or fake direct Shopee API is added. Direct Shopee unavailability does not disable valid AccessTrade-sourced Shopee offers.

## Canonical offers and routing

Normalized monetization metadata lives on the existing `ProductOffer` aggregate and its existing D1 projection. `discoverNormalizedOffers()` resolves existing canonical/source identities; zero or ambiguous matches return unmatched instead of creating a product. Offer IDs distinguish provider, external item, platform, merchant domain and campaign. Multiple AccessTrade campaigns and TikTok offers coexist on one canonical product. A refresh upgrades an exact pre-platform offer identity without deleting unrelated legacy offers or accepting an older observation. Merge retries are capped at three and total offers at 50.

The router rejects unpublished/canary products, disabled/unknown providers, unsupported discovery capability, origin mismatch, invalid provenance, missing required campaign/merchant identity, low or invalid source confidence, stale/future verification, expired/not-started offers, unavailable stock, unsafe destinations and unavailable required attribution. Invalid offers are never rescued by a high nominal commission.

Eligible ranking compares source confidence, freshness, AccessTrade-first preference, known commission evidence, then actual comparable commission amounts only when every eligible currency matches. Stable offer ID breaks ties. AccessTrade priority cannot override eligibility, lower source confidence or older freshness. Unknown commissions remain null and no CTR/CVR/revenue prediction is synthesized.

Reason codes include SELECTED_ACCESSTRADE_SHOPEE, SELECTED_ONLY_ELIGIBLE_PROVIDER, SELECTED_HIGH_CONFIDENCE, NO_MONETIZABLE_OFFER, REJECTED_EXPIRED, REJECTED_PROVIDER_DISABLED, REJECTED_PROVIDER_CAPABILITY, REJECTED_SOURCE_PROVENANCE, REJECTED_SOURCE_CONFIDENCE, REJECTED_MISSING_IDENTITY, REJECTED_MERCHANT_IDENTITY, REJECTED_UNSAFE_DESTINATION, REJECTED_STALE and REJECTED_ATTRIBUTION_UNAVAILABLE.

## Redirects and attribution

The Cloudflare `/go/[productId]` money flow is opt-in via `SANDEAL_MONEY_ENGINE_ENABLED=true`; local configuration remains false. The default Phase 4 secure redirect and the legacy Next `/go` route remain unchanged. Public DTOs never expose private normalized offers, clicks or revenue.

A public click rechecks publication and route safety, generates a UUID, optionally uses the existing supported tracking resolver, then persists attribution before a no-store redirect. Click insertion is conditional on the unchanged product token and a fresh, enabled provider observation. Provider, platform, offer, origin, merchant and campaign must match the persisted offer. Caller-supplied destination parameters, bot/prefetch traffic, unsafe schemes, non-allowlisted hosts, credentials in URLs and mismatched nested redirects reject. Records contain no IP, user agent, arbitrary referrer, raw provider body or secret; only the public page context, identifiers and a destination hash are retained.

An internal click reference does not automatically prove provider-side attribution. AccessTrade stored-link clicks currently record transport UNAVAILABLE. TikTok can use the existing SUB1 link resolver when explicitly injected. Production conversion attribution requires supported provider SUB1 evidence; the fixture harness explicitly supplies test-only matching evidence. The Worker does not silently import legacy filesystem-backed provider configuration to invent live sync.

## Durable evidence and money states

Conversions use provider/external ID and provider/event ID uniqueness plus canonical fingerprints. Commission events are append-only, unique by provider/event and provider/commission/revision. The current commission head uses consecutive revisions and guarded state transitions. Provider evidence must match the attributed conversion, origin, currency and chronology. A PAID head cannot downgrade or change its amount. Unknown/unmatched, malformed or conflicting evidence writes a sanitized reason/hash to the unmatched/quarantine table and does not create revenue.

All ledger amounts are bounded integer minor units with an explicit VND, USD or EUR currency. UNKNOWN can carry a null amount; unknown amounts are counted separately. ESTIMATED, PENDING, APPROVED, REJECTED and PAID remain distinct balances. State changes remove the old state's balance and add the new balance rather than summing successive reports. Click, conversion, commission event and incremental journal rows have immutable update/delete guards.

Provider sync accepts at most 20 records and never automatically loops through every cursor. Unsupported live APIs reject before network calls. RETRYABLE, FINAL and QUARANTINE classification is retained. No public evidence-ingestion endpoint accepts arbitrary claimed provider payloads.

## D1 snapshots and event lifecycle

The existing `AGGREGATE_GROWTH_METRICS` job with fixed payload `{productId:'revenue-all'}` performs only the justified bounded snapshot operation. The Phase 4.5 flow remains Cron → indexed due tasks → deterministic persisted job/outbox → Queue → claim → fenced D1 commit → durable SUCCEEDED → acknowledgement. Business retries remain capped at three, outbox dispatches at five, transport retries at three per enqueue and job age at 24 hours. No heartbeat, continuous polling or SanDeal daemon is added.

Each snapshot processes at most 10 journal events using a primary-key keyset range. A trailing old-state event is deferred so a commission transition cannot be split across two commits. Cursor compare-and-swap, projection deltas and terminal job state commit atomically. Duplicate delivery, concurrent projection races and postcommit/pre-ack crashes cannot replay money.

Five dimensions are maintained: provider, provider-qualified platform, merchant, provider-qualified campaign and product. PLATFORM key `accesstrade:shopee` is deliberately different from provider `shopee`. Projection initialization uses bounded multi-row inserts with at most 96 bound parameters per statement; at most 56 prepared snapshot statements plus the job fence/completion statements are needed for a full ten-event batch. Existing 25-event workload tests are not reduced. Snapshot reads require scope/key/currency and an indexed date range of at most 31 days. Product click validation inspects only one indexed product's bounded offer array, not a growing-table scan.

Revenue dates are conversion-cohort dates for commission balances, not payout cash-flow dates; click counts use click dates. No cross-currency total, paid-money estimate, all-time growing-table aggregation or heavyweight analytics infrastructure is added. The private Basic-authenticated `/api/admin/affiliate/revenue` route returns only production-origin snapshots and marks live provider sync unavailable.

Additive schema files 0003 and 0004 from the interrupted run are retained. New 0005 adds platform metadata and expands the snapshot dimension constraint while preserving prior snapshots, cursor position, jobs and evidence. Old click/journal platform remains `unknown`; prior snapshots are not retroactively relabeled or claimed as complete platform history. No real database is migrated. The existing Phase 3 migration engine is unchanged and its expensive matrices are not rerun.

## Local proof and fixture isolation

`node scripts/v6-money-engine-tests.cjs` is the repeatable local suite. It uses explicit test fixtures, real local workerd/D1, the existing AccessTrade normalizer/provider wrapper, HTTP redirect handler, Queue/Cron adapters and D1 ledger. The AccessTrade Shopee fixture returns a synthetic tracking URL; production code never constructs such a link. It verifies one canonical product, multiple campaign offers, provider/platform provenance, a real local HTTP redirect, one conversion, one commission, one pending balance, duplicate evidence and duplicate Queue delivery with zero additional money. All fixture evidence is tagged TEST_FIXTURE.

Production-default stores reject fixture ingress and hide fixture balances. Fixture-enabled stores/HTTP calls require explicit test dependency injection; there is no request parameter or public environment switch granting fixture revenue access. A production snapshot job encountering a fixture journal fails rather than claiming success. Throwing FileStorage/filesystem spies and the Worker dependency audit verify zero such runtime calls/imports for supported money paths. Local build tools/emulators still use the filesystem; that is not a deployed SanDeal filesystem dependency.

Live AccessTrade/Shopee availability, real commissions, credentials, production rollout, external attribution and payout reconciliation are not proven by this fixture. These remain honest unsupported/unverified external capabilities, not fake successful integrations and not prerequisites for this local Phase 5 foundation.

## Validation ledger

The final current-source run passes 280 cases with zero failures/skips: 57 Phase 5 cases and 223 affected regressions. Fifteen Phase 5 cases are additions to the previously passing 42-case suite. Earlier runs are not double-counted. The intermediate resume run had 53 passes and two failures in newly added test fixture assumptions (a legacy non-monetization offer was present). The fixes select the correct normalized offer and preserve/assert the unrelated legacy offer; they do not relax monetary assertions, workload, retry or duplicate bounds.

| Suite | Passed | Failed |
| --- | ---: | ---: |
| Affiliate Money Engine, including AccessTrade Shopee and direct Shopee safety | 57 | 0 |
| Affected D1 and additive schema | 25 | 0 |
| Cron | 10 | 0 |
| Queue | 17 | 0 |
| Local autopilot | 4 | 0 |
| Cloudflare runtime | 14 | 0 |
| Integrated routing/assets | 11 | 0 |
| AccessTrade link safety | 34 | 0 |
| AccessTrade TikTok integration | 43 | 0 |
| Publication | 25 | 0 |
| Product/source pipeline | 16 | 0 |
| Import identity/dedup | 6 | 0 |
| Revenue integrity | 5 | 0 |
| Existing provider/runtime foundation contracts | 13 | 0 |
| Total | 280 | 0 |

The new schema, money runtime and the explicit-availability source change invalidate the affected old suite evidence, so these bounded critical checks were rerun. No Phase 3/3.5 matrix or unrelated legacy scheduler matrix was restarted. Every final suite, TypeScript, ESLint and both build flavors has unchanged source/test/config hashes at closure. Per-command manifests are retained under `docs/v6/evidence/`; final suite logs and exit/count ledger are `.test-tmp/v6-resume-3-ItB0NK/`. The existing quality runner uses historical `phase4-*` evidence filenames; the Phase 5 completion evidence records the current command logs and hashes without treating those filenames as a repeated Phase 4 implementation.

TypeScript, ESLint, secret scan, legacy validation build and Worker build logs: `.test-tmp/v6-runtime-quality-QDd0LF/`. Static build log: `.test-tmp/phase5-completion-static.log`. Final suite wrapper: `.test-tmp/phase5-completion-tests.log`.

ESLint has zero errors and the same 34 warnings (14 existing source/test and 20 generated Worker warnings). No new money source/test warning or lint suppression is introduced. The legacy build retains its existing Turbopack tracing warning and is a validation-only artifact; the Cloudflare static build exports 10 pages. `git diff --check` passes; pre-existing whitespace elsewhere is not reformatted. The three changed/new test/helper files contain no skip/only/fit/fdescribe or empty catch blocks. Failure counters cause nonzero exits; exact duplicate/state/money assertions remain intact. The D1 migration assertion is extended to exactly five migrations, not weakened.

Proof artifacts: `docs/v6/evidence/phase5-local-money-proof.json` and `docs/v6/evidence/phase5-accesstrade-shopee-proof.json`. The final completion ledger is `docs/v6/evidence/phase5-completion.json`; the final post-checkpoint secret scan is recorded separately as `docs/v6/evidence/phase5-final-secret-scan.json`.

The final post-checkpoint secret scan exits 0 (`SECRET_SCAN=READY`); its log is `.test-tmp/phase5-final-secret-scan.log`. Phase 5 is PASS for the local foundation, not a live financial integration or production rollout certification. External conversion/commission APIs remain NOT_SUPPORTED until implemented against actual provider access and evidence.

The original legacy `automation-worker.cjs`, `automation-scheduler.cjs`, PM2 configuration, queue/scheduler implementation and earlier V6 checkpoints remain available. No commit, push, Cloudflare login/resource, DNS change, deployment or real-money transaction occurs. Stop after Phase 5; Phase 6 requires separate authorization.
