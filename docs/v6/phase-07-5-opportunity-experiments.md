# Phase 7.5 — Opportunity Engine And Experiment Foundation

Date: September 13, 2026. Baseline: `master`,
`0ee3ea152bc6ea40fcafad8f203a446018d51ffc`, clean working tree.
Scope: existing repository, local D1/Queue and explicit shadow fixtures only.
No commit, push, deployment, Cloudflare login/resource, DNS change, production
migration, publication, real-money transaction or live AI request is authorized.

## Verification Gate

The final local evidence includes 127 focused cases and 564 affected regression
cases. Both test groups have zero failures/skips. Quality and build commands
exit successfully; the legacy build is unaffected and was not rerun.

```text
PHASE7_5=PASS
OPPORTUNITY_ENGINE=PASS
OPPORTUNITY_SCORE_SCALE=0..100
OPPORTUNITY_CONFIDENCE_SCALE=0..1
OPPORTUNITY_ALGORITHM_VERSION=opportunity-engine-v1
DEAL_SCORE_SEPARATION=PASS
MONETIZATION_POTENTIAL=PASS
PROVIDER_TRUST=PASS
MERCHANT_TRUST=UNKNOWN
CONTENT_OPPORTUNITY=PASS
SEO_EXTERNAL_EVIDENCE=NOT_AVAILABLE
RESOURCE_EFFICIENCY=PASS
EXPLORATION_MODEL=PASS
COLD_START=PASS
RICH_GET_RICHER_PROTECTION=PASS
OPPORTUNITY_RISK=PASS
OPPORTUNITY_PRIORITY=PASS
RESOURCE_RECOMMENDATION=PASS
OPPORTUNITY_EXPLAINABILITY=PASS
OPPORTUNITY_EVIDENCE_FINGERPRINT=PASS
OPPORTUNITY_IDEMPOTENCY=PASS
DUPLICATE_OPPORTUNITY_EFFECT=0
DUPLICATE_RESOURCE_RECOMMENDATION_EFFECT=0
OPPORTUNITY_POLICY_OVERRIDE_EFFECT=0
OPPORTUNITY_DEAL_SCORE_MUTATION_EFFECT=0
EXPERIMENT_FOUNDATION=PASS
EXPERIMENT_EXECUTION_MODE=SHADOW
EXPERIMENT_TYPES=TITLE_VARIANT,CTA_VARIANT,DEAL_BADGE_VARIANT,CARD_LAYOUT_VARIANT,SORT_PRIORITY_VARIANT,CONTENT_ANGLE_VARIANT
EXPERIMENT_ASSIGNMENT=PASS
EXPERIMENT_METRICS=PASS
EXPERIMENT_GUARDRAILS=PASS
EXPERIMENT_OUTCOME_MODEL=INCONCLUSIVE_OR_SUFFICIENT_EVIDENCE_NO_SIGNIFICANCE_NO_WINNER
DUPLICATE_EXPERIMENT_ASSIGNMENT_EFFECT=0
DUPLICATE_EXPERIMENT_METRIC_EFFECT=0
PRODUCTION_EXPERIMENT_TRAFFIC=0
ACTIVE_PRODUCTION_EXPERIMENTS=0
ACCESS_TRADE_SHOPEE_OPPORTUNITY=PASS
DIRECT_SHOPEE_STATUS=DISABLED_NO_CREDENTIALS
DIRECT_SHOPEE_API_CALLS=0
LIVE_AI_PROBE=NOT_RUN
OPPORTUNITY_FULL_SCAN=NO
OPPORTUNITY_RANKING_FULL_SCAN=NO
EXPERIMENT_ASSIGNMENT_FULL_SCAN=NO
EXPERIMENT_METRIC_FULL_SCAN=NO
DUE_OPPORTUNITY_WORK_FULL_SCAN=NO
DEAL_EVALUATION_FULL_SCAN=NO
REVENUE_HOT_PATH_FULL_SCAN=NO
FILE_STORAGE_CALLS=0
FILESYSTEM_SETTINGS_CALLS=0
PM2_REQUIRED=NO
VPS_REQUIRED=NO
LONG_RUNNING_PROCESS_REQUIRED=NO
CONTINUOUS_POLLING=NO
NEW_TEST_CASES_PASSED=127
NEW_TEST_CASES_FAILED=0
CRITICAL_REGRESSIONS_PASSED=564
CRITICAL_REGRESSIONS_FAILED=0
TESTS_PASSED=691
TESTS_FAILED=0
TEST_CASES_SKIPPED=0
ASSERTIONS_WEAKENED=NO
OPPORTUNITY_ASSERTIONS_WEAKENED=NO
EXPERIMENT_ASSERTIONS_WEAKENED=NO
SAFETY_GATES_RELAXED=NO
FAKE_SEARCH_VOLUME_PRODUCTION_PATH=NO
FAKE_REVENUE_PRODUCTION_PATH=NO
FAKE_DIRECT_SHOPEE_PRODUCTION_PATH=NO
TYPESCRIPT=PASS
ESLINT=PASS_0_ERRORS_34_EXISTING_WARNINGS
SECRET_SCAN=PASS
BUILD_LEGACY=NOT_RUN_UNAFFECTED
BUILD_CLOUDFLARE=PASS_STATIC_AND_WORKER
PRODUCTION_RESOURCE_CREATED=NO
REAL_PRODUCTION_DATA_MIGRATED=NO
REAL_MONEY_TRANSACTION_CREATED=NO
DEPLOYED=NO
COMMITTED=NO
PUSHED=NO
CLOUDFLARE_LOGIN_USED=NO
DNS_CHANGED=NO
RESULT=PASS_LOCAL_SHADOW_FOUNDATION
SAFE_FOR_PHASE_8=YES_LOCAL_FOUNDATION_ONLY_REQUIRES_SEPARATE_AUTHORIZATION
BLOCKERS=NONE_FOR_LOCAL_PHASE_7_5
NEXT_RECOMMENDED_PHASE=PHASE_8_ONLY_AFTER_SEPARATE_AUTHORIZATION
```

## Reconstruction And Reuse

The specified Phase 4.5/5/6/7 checkpoints and LONG_RUN_STATE were read, then
checked against source rather than treated as proof for this HEAD. The installed
Next.js 16.2.11 output guide was read. No application or framework is replaced.

The legacy `product-intelligence/scoring.ts` already has `opportunity-v1` and
`Product.opportunityScore`; it is based on legacy quality/deal scores, product
completeness and analytics counters. It does not have V6 policy, normalized
money-route, confidence, evidence-origin, fingerprint or durable experiment
contracts. Those legacy callers and public search ranking remain unchanged.
V6 has one authoritative `opportunity-engine-v1` projection and never consumes
legacy `Product.opportunityScore`, `Product.dealScore` or AI prose as authority.

Reused boundaries:

- Phase 5 normalized offers, selected Money Router route, provider/platform
  provenance, exact click/conversion attribution, commission ledger and bounded
  product revenue snapshots. AccessTrade/Shopee is not relabeled direct Shopee.
- Phase 6 `DealEvaluation`, immutable score/confidence inputs, price freshness,
  canonical hashing, latest D1 evaluation and provider-revision fences.
- Phase 7 policy, shadow decision record, publication/security gates and the
  existing AI governor's disabled path. Enabling AI on an opportunity store's
  Decision OS dependency is rejected before reasoning; there is no second budget.
- Existing product category, verified source, review approval, canonical slug,
  content-package state, duplicate status and duplicate-confidence thresholds.
- Existing `deal_work`, provider membership/fanout, Queue claims/outbox and Cron.

There is no equivalent durable experiment framework in the baseline. SEO code
provides metadata/indexability, not external search demand. Legacy operational
and analytics stores are not imported into the Worker. Merchant-level historical
reliability and external SEO/competition evidence are unavailable, not zero.

## Score And Confidence

Both configuration shape and bounds are validated. Unknown numeric components
are `null`, with explicit UNKNOWN signals and zero contribution, not fabricated
measurements. NaN, infinity, negative monetary evidence, mismatched identities,
future observations and invalid scales fail closed.

| Component | Maximum weighted points |
| --- | ---: |
| Verified DealScore | 38 |
| DealConfidence contribution | 7 |
| Safe monetization / commission evidence | 14 |
| Bounded revenue evidence | 8 |
| Current provider health evidence | 8 |
| Known offer validity horizon | 6 |
| Price/product freshness | 7 |
| Internal content coverage | 7 |
| Internal resource efficiency | 5 |
| **Base total** | **100** |

A separate configuration-driven exploration bonus is at most four points. The
result is clamped to 0..100 after distinct coded penalties. Revenue uses verified
approved/paid evidence presence and a logarithmically diminishing conversion
sample term capped at 20; increasing the amount itself cannot inflate rank.
Commission terms are explicitly not paid revenue. Approved and paid balances
remain distinct upstream; this model only tests positive verified evidence, not
predicted earnings. Zero observed revenue and absent history retain different
signals. No CTR, CVR, RPM, EPC, conversion probability or future revenue is made up.

OpportunityConfidence is independently bounded to 0..1: deal confidence 0.35,
safe monetization coverage 0.15, revenue sample strength 0.15, current provider
evidence coverage 0.10, known offer horizon 0.10 and content coverage 0.15. Missing
history, horizon or content evidence lowers it. The score can remain useful with
lower confidence. This is evidence coverage, not a calibrated probability.

Provider trust describes current internal provider health only, not merchant
reputation or a claimed longitudinal success rate. Offer stability describes a
known expiry horizon, not invented historical retention. Merchant trust stays
UNKNOWN. A missing direct Shopee credential never reduces AccessTrade trust.

Canonical coverage takes precedence over a contradictory missing-content marker.
Known duplicate status/confidence blocks experiment proposals and contributes a
single coded penalty. Absent content-package data stays UNKNOWN unless existing
canonical review coverage is independently known. Content gaps are internal
review signals, never claims about keyword demand or permission to create pages.

Hard BLOCK/QUARANTINE, unsafe/unavailable routes, security/quarantine constraints,
publication denial or expired evidence produce BLOCKED. HOLD cannot become P0/P1.
P0 requires score 88, confidence 0.8 and DealScore at least 70; P1 uses score 74
with the same confidence/deal thresholds. P2 starts at 50; other cases are P3.
No priority, revenue or experiment result overrides upstream gates.

Recommendations are inert SHADOW resource classes and coded actions. Classes are
CHEAP/STANDARD/EXPENSIVE/REVIEW_HEAVY based on internal refresh/review work, not
invented token or currency costs. Cost stays UNKNOWN. AI-review recommendation
vocabulary is reserved but never emitted with the required disabled governor;
no calls or reservations occur. No future AI budget is assumed available.

## Persistence And Recalculation

Additive migration `0008_opportunity_experiments.sql` is exercised only in
ephemeral local D1. One latest opportunity row per origin/product stores the
structured audit record, reasons, risks, component contributions, resource
recommendation and optional DRAFT experiment proposal. These markers have no
executor. There is no growing opportunity event journal to scan or purge.

Fingerprints include the deal fingerprint, Decision OS result/policy, selected
money-route identity/version, sorted product revenue evidence/sequence, current
provider-health version, content coverage/hash, semantic validity boundaries,
origin and complete versioned scoring configuration. No secrets or external
free-form text are persisted. Unrelated clock ticks do not change identity;
crossing a freshness/expiry boundary invalidates the result.

Opportunity, deal, decision and terminal job effects commit in the same existing
D1 transaction under product-revision, provider-version and job-claim fences.
Duplicate evidence leaves the opportunity payload and recommendation unchanged.
Insertion failure rolls back the entire transaction. Lost Queue acknowledgments
are redelivery-safe. There is no new scheduler, polling loop or job system.

Existing product/price/offer/revenue/provider events reuse `deal_work`. Product
payload changes include content coverage. A changed decision with an existing
opportunity marks that product due. Provider fanout remains keyset-bounded.
Configuration versions enter job keys and current-read validation; convergence
uses existing due work rather than a synchronous catalogue sweep.

Ranking uses SQL indexes for top, provider/platform, priority, limited-history,
low-confidence, content, experiment, refresh, review and stale queries. Blocked
score leaders are excluded before the SQL top-page limit. At most 50 candidate
rows are inspected; each current-read validation is a bounded indexed lookup.
Invalidated/stale candidates can produce a partial page, explicitly reported as
such, rather than scanning until the page fills. This is a bounded current page,
not a claim that all catalogue opportunities were materialized or refreshed.
Summary counts are explicitly bounded samples, never global population totals.

## Experiment Foundation

Six permitted types are modeled: TITLE_VARIANT, CTA_VARIANT, DEAL_BADGE_VARIANT,
CARD_LAYOUT_VARIANT, SORT_PRIORITY_VARIANT and CONTENT_ANGLE_VARIANT. Variants
carry only stable identifiers and basis-point weights, not generated wording,
destinations, prices or executable layout code. The state vocabulary includes
ACTIVE for future compatibility, but both current transitions and D1 reject it.

Actual experiments are explicitly created from current eligible opportunities;
a score only produces an embedded DRAFT proposal. Human review is always required.
Unknown traffic evidence permits a shadow proposal, not a production experiment.
There is no live audience, exposure collector, public API, middleware, cookie,
traffic splitter or automatic rollout. Assignment and metric writes require
test-only dependency injection; environment/request parameters cannot enable it.

Definitions are immutable, versioned and content-addressed. A product/type/version
cannot change weights; multiple simultaneous shadow/review experiments for one
product are conservatively prohibited. Two to eight variants have positive
integer weights summing to 10,000. SHA256 of experiment/version/subject determines
assignment without Math.random. Durable enrollment uses an experiment/subject
unique key and immutable assignment. Future starts, expiry and current policy
are checked before enrollment; transactional current-evidence fences catch races.

Metrics implemented now are CLICK and CONVERSION, each counting unique assigned
fixture subjects with an actual attributed Phase 5 event. The fixture subject
identifier is the associated click ID, not a claimed real-user identity. Stable
`click:<id>` and `conversion:<provider>:<externalId>` money-event keys, exact click
attribution and timestamps are verified. Duplicate delivery cannot increment a
counter twice; conflicting event/subject mappings are rejected. This does not
implement a production subject identity or exposure instrumentation contract.
Revenue and approved-commission experiment aggregation are NOT_SUPPORTED in this
foundation, although OpportunityScore consumes the existing verified snapshots.
Experiment revenue therefore remains UNKNOWN rather than a synthetic amount.

Guardrails reuse current publication/policy and provider-availability evidence.
They are zero-tolerance current-state checks, not invented invalid-destination,
provider-error or bounce rates. A policy/health change blocks further enrollment
and metric ingestion until current evidence is safe and reevaluated.

Result summaries expose per-variant sample counts, shadow assignment counts,
verified click/conversion counts, minimum runtime and explicit completion.
Minimums cannot be below 20 subjects and five primary events per variant or one
minute runtime. Default fixture completion is the declared expiry; early
completion cannot manufacture a winner. INCONCLUSIVE remains the outcome until
the thresholds, runtime and completion are all met. SUFFICIENT_EVIDENCE means
only those configured thresholds passed. Statistical significance is explicitly
NOT_IMPLEMENTED, winner is always null and production rollout is always false.

Experiment headers are capped at 20 per product/origin and retained as bounded
immutable definitions/tombstones; variant summaries are at most eight rows.
Assignments are capped at 10,000 and metric events at 20,000 per experiment.
After expiry plus 30 days, cleanup deletes at most 10 metric rows and considers
at most 10 assignment rows per call using retention indexes. Aggregate counts
remain in variant summaries. Expired experiments can never reingest events after
dedup rows are removed. Cleanup is an explicit local bounded operation, not a
promise of physical deletion while no local work runs. No metric hot path scans
raw history; summaries read at most eight counter rows.

## Local Proof And Boundaries

The focused suite covers cases A–H and experiment cases A–E with exact outcomes,
monotonic/bounded contributions, invalid inputs and versions, current-read
invalidation, D1 rollback, duplicate/concurrent assignment, metric deduplication,
fixture isolation, SQL EXPLAIN plans and native Worker Cron/Queue redelivery.
FileStorage/filesystem-settings spies and the Worker dependency graph prove no
such runtime dependency. Local test/build tools still use the host filesystem.

Core PASS does not imply live provider conversion APIs, external SEO data,
merchant reputation, calibrated financial predictions, production exposure
measurement, statistical significance, autonomous content generation or rollout.
Phase 8 requires a separate explicit instruction. Stop after this local phase.

## Final Validation Ledger

| Suite | Passed | Failed |
| --- | ---: | ---: |
| Phase 7.5 focused including native Worker proof | 127 | 0 |
| Phase 7 Decision OS / AI Cost Governor | 132 | 0 |
| Phase 6 Deal Intelligence | 79 | 0 |
| Phase 5 Affiliate Money Engine | 57 | 0 |
| D1 and exact eight-migration inventory | 25 | 0 |
| Queue | 17 | 0 |
| Cron | 10 | 0 |
| Native AutoPilot | 4 | 0 |
| Cloudflare runtime | 14 | 0 |
| Cloudflare routing | 11 | 0 |
| AccessTrade link safety | 34 | 0 |
| AccessTrade/TikTok integration | 43 | 0 |
| Publication | 25 | 0 |
| Provider/runtime foundation | 28 | 0 |
| Gemini diagnostics, fixtures only | 7 | 0 |
| Self-healing, fixtures only | 10 | 0 |
| Health/readiness, fixtures only | 34 | 0 |
| Rollout/stabilization | 20 | 0 |
| Zero-VPS storage | 9 | 0 |
| Revenue integrity | 5 | 0 |
| **Total** | **691** | **0** |

Final focused output: `.test-tmp/phase7-5-focused-complete.log` and
`.test-tmp/phase7-5/focused-results.json`. The matrix's earlier 125-pass/one-failure
focused entry is explicitly superseded, not relabeled or added to the total.
All 19 other matrix entries pass and are retained in
`.test-tmp/phase7-5/tests/results.json`. Its wrapper exits 1 because that earlier
focused fixture failed; this is not claimed as a successful aggregate command.
The final combined evidence accounts for the successful focused rerun separately.

During iteration, tests exposed stale product-price labeling, an incorrect
fixture expectation of P1 instead of the stronger P0, a fixture passing a version
object instead of its token, an intentionally invalidated provider capability
snapshot requiring reevaluation, and duplicate canonical identity in a second
product fixture. The stale-price source logic was fixed; fixture identity/token
and timing setup were corrected without removing assertions. An added test also
ensures absent optional commission fields are never treated as known terms.
Earlier attempts remain progress evidence and are not counted as extra cases.

Final quality results and command logs are under `.test-tmp/phase7-5/quality/`.
TypeScript passes, ESLint has zero errors and the same 34 existing warnings, and
the secret scan is READY. The Cloudflare static export and Worker build are local
only. IDE build invocation succeeds but reports limited diagnostics, so the
actual TypeScript and build commands, not that IDE response, are the quality
proof. No ignore rule, warning suppression, skip, focused test or weakened
baseline safety assertion is added. The only baseline D1 assertion change is the
exact additive eighth migration and exact count of eight.

| Opportunity fixture | DealScore | OpportunityScore | Confidence | Priority |
| --- | ---: | ---: | ---: | --- |
| A: excellent deal and business evidence | 95 | 93.2 | 1 | P0 |
| B: excellent deal, weak monetization, short offer | 95 | 63.35 | 0.7625 | P2 |
| C: moderate deal, stronger business evidence | 84 | 89.02 | 1 | P0 |
| D: strong new deal, no revenue history | 90 | 81.7 | 0.85 | P1 |
| E: historical winner, weak current deal | 35 | 70.4 | 1 | P3 |

These are explicit local fixture score cases, not actual merchant revenue or
calibrated predictions. The durable completion manifest and case ledger are
`docs/v6/evidence/phase7-5-completion.json`; the final post-checkpoint secret-scan
record is `docs/v6/evidence/phase7-5-final-secret-scan.json`.
