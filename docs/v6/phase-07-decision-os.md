# Phase 7 — Decision OS Local Foundation

Date: September 13, 2026. Baseline branch: `master`. Baseline HEAD:
`620fa3f07f0dd11a94ee2f26d6536302caca2fa0`. The initial working tree was clean.
No commit, push, deployment, Cloudflare login, production resource, DNS change,
production migration, external notification, live AI request, or real-money
transaction is part of this phase.

## Verification Gate

```text
PHASE7=PASS
DECISION_OS=PASS
DECISION_CONTEXT=PASS
DECISION_EVIDENCE_PACK=PASS
POLICY_ENGINE=PASS
POLICY_VERSION=decision-policy-v1
POLICY_PRECEDENCE=PASS
AI_REASONER=PASS_LOCAL_CONTRACT
AI_REASONER_CONTRACT=PASS
AI_PROVIDER_ABSTRACTION=PASS_EXISTING_AIPROVIDER
STRUCTURED_AI_OUTPUT=PASS
AI_IS_ADVISORY=YES
PROMPT_INJECTION_DEFENSE=PASS
DATA_MINIMIZATION=PASS
AI_PROMPT_VERSION=decision-reasoner-v1
AI_COST_GOVERNOR=PASS
AI_PROVIDER_HEALTH=PASS_LOCAL_CIRCUIT_BREAKER
AI_PROVIDER_FAILURE=PASS
AI_FALLBACK=PASS_BOUNDED_FIXTURE_VERIFIED
ACTION_PLANNER=PASS
POLICY_RECONCILIATION=PASS
DECISION_EXECUTION_MODE=SHADOW
SHADOW_MODE=PASS
DECISION_AUDIT_JOURNAL=PASS
EVIDENCE_FINGERPRINT=PASS
DECISION_IDEMPOTENCY=PASS
DUPLICATE_DECISION_EFFECT=0
DUPLICATE_ACTION_PLAN_EFFECT=0
DUPLICATE_AI_REASONING_EFFECT=0
AI_POLICY_OVERRIDE_EFFECT=0
AI_DEAL_SCORE_MUTATION_EFFECT=0
HUMAN_REVIEW_SIGNAL=PASS
ACCESSTRADE_SHOPEE_DECISIONS=PASS
DIRECT_SHOPEE_STATUS=DISABLED_NO_CREDENTIALS
DIRECT_SHOPEE_API_CALLS=0
DECISION_FULL_SCAN=NO
AI_ADVICE_FULL_SCAN=NO
ACTION_PLAN_FULL_SCAN=NO
DUE_DECISION_WORK_FULL_SCAN=NO
DEAL_EVALUATION_FULL_SCAN=NO
REVENUE_HOT_PATH_FULL_SCAN=NO
FILE_STORAGE_CALLS=0
FILESYSTEM_SETTINGS_CALLS=0
PM2_REQUIRED=NO
VPS_REQUIRED=NO
LONG_RUNNING_PROCESS_REQUIRED=NO
CONTINUOUS_POLLING=NO
LIVE_AI_PROBE=NOT_RUN
TEST_CASES_SKIPPED=0
ASSERTIONS_WEAKENED=NO
POLICY_ASSERTIONS_WEAKENED=NO
AI_SAFETY_ASSERTIONS_WEAKENED=NO
SAFETY_GATES_RELAXED=NO
FAKE_PRODUCTION_AI_RESPONSE=NO
FAKE_FINANCIAL_PRODUCTION_PATH=NO
NEW_TEST_CASES_PASSED=132
NEW_TEST_CASES_FAILED=0
CRITICAL_REGRESSIONS_PASSED=432
CRITICAL_REGRESSIONS_FAILED=0
TESTS_PASSED=564
TESTS_FAILED=0
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
RESULT=PASS_LOCAL_FOUNDATION
SAFE_FOR_PHASE_7_5=YES_LOCAL_FOUNDATION_ONLY_REQUIRES_AUTHORIZATION
SAFE_FOR_PHASE_8=NO_NOT_AUTHORIZED
BLOCKERS=NONE_FOR_LOCAL_PHASE_7
NEXT_RECOMMENDED_PHASE=PHASE_7_5_ONLY_AFTER_SEPARATE_AUTHORIZATION
```

## Reconstruction

The Phase 5/6 checkpoints, Phase 4.5 AutoPilot checkpoint, runtime decision,
existing README, and LONG_RUN_STATE were read before implementation. The
installed Next.js 16.2.11 static-export and data-security guides were read; no
framework version, application, frontend, legacy worker, or deployment model
was replaced.

The saved state had `currentPhase=PHASE_6` but retained a Phase 5 program name,
Phase 5 resume fields, and historical HEADs. These are historical evidence, not
proof of the current source. Phase 6's model-description paragraph also contains
pre-existing encoding damage. Its score/confidence contracts were reconciled
against code and the exact 79-case suite rather than that damaged paragraph.
The existing D1 test expected five migrations although the baseline already
contained six. Its assertion now names all seven migrations exactly, including
the new additive Phase 7 schema; no assertion is removed or relaxed.

| Boundary | Reuse and scope |
| --- | --- |
| AI | Existing `AiProvider`, `ProviderDeclaration`, registry IDs `gemini` and `local-ai`; no new vendor registry or credentials |
| Existing AI routing | Gemini editorial/canonical-proposal and local-AI contracts are task-specific; credential routing, usage, and fallback import legacy stores and are not safe Worker dependencies |
| Deal input | `evaluateDeal`, `DealEvaluation`, `D1DealStore`, 0..100 deterministic score, 0..1 DealConfidence, `deal-intelligence-v1` |
| Money input | Existing `selectMoneyRoute`, normalized offers, provider observations, verified revenue summary; AccessTrade first, TikTok secondary |
| Publication | Existing `isPublicSafeProductAt`, recovery-canary pending gate, `evaluatePublicOffer`; no readiness promotion or public-state mutation |
| Health | Existing affiliate health observations plus explicit structured system/security/quarantine constraints |
| Jobs | Existing `DEAL_EVALUATE`, indexed `deal_work`, provider revision fanout, D1 job claims, retry/quarantine, outbox, Cron and Queue |
| Actions | New inert decision vocabulary only; existing publishing, campaign, operator-alert and self-healing executors are not invoked |
| Missing foundation | Cross-evidence decision policy, minimized advisory contract, model-role mapping, D1 AI reservations and normalized decision journal |

Legacy operational-health readers use process/filesystem storage. They are not
silently imported into the supported Worker path. The local Worker's system
health assertion is narrowly scoped to its validated local runtime, working D1
reads, and required Queue binding. It is not a claim of global production
health, external provider availability, or a live legacy operator-control sync.
Callers of the decision store may provide verified structured degraded,
unavailable, security-risk, or quarantine snapshots. Changing those constraints
invalidates current reads through the configuration fingerprint.

## Authority And Actions

The flow is verified deal/money/publication evidence → deterministic policy →
permitted AI evidence → strict validation and reconciliation → ordered SHADOW
plan → D1 audit. There is no action dispatcher.

Policy severity is `QUARANTINE > BLOCK > HOLD > ALLOW_WITH_REVIEW > ALLOW`.
Unknown policy outcomes also fail closed. Safety, identity, destination,
currency, price, expiration, evidence integrity and runtime gates cannot be
overridden by high scores or AI confidence. Review requirements cannot be
removed by AI. The Phase 6 publication recommendation remains authoritative;
an AI cannot make a nonpublishable product publishable.

The complete vocabulary is `NO_ACTION`, `HOLD`, `REJECT`,
`REQUEST_REFRESH_PRICE`, `REQUEST_REFRESH_OFFER`, `REQUEST_REEVALUATION`,
`REQUEST_PROVIDER_RECHECK`, `MARK_PUBLISH_CANDIDATE`, `MARK_CONTENT_CANDIDATE`,
`MARK_HIGH_PRIORITY`, `MARK_REVIEW_REQUIRED`, and `QUARANTINE`.
These are internal data only. Even `QUARANTINE` is an audit-plan marker, not a
provider/product mutation. Refresh plans order price, offer, provider recheck,
reevaluation, and required review deterministically.

Configuration is centralized in `src/lib/decision-os/config.ts`. Default high
score is 70, low score 40, and review confidence 0.8. Existing Phase 6 freshness
thresholds are reused. Hard price age is three days; hard offer age is one day.
Invalid configuration or a non-SHADOW mode cannot produce an active decision.
The two confidence concepts stay separate: DealConfidence and AiAdviceConfidence
both have validated 0..1 scales, but only deterministic DealConfidence drives
the policy's review gate. AI never writes a DealEvaluation or revenue record.

## AI Boundary And Minimization

`DecisionModelRoles` maps `FAST_CLASSIFIER`, `REASONER`, and `OPTIONAL_REVIEWER`
to at most two explicit provider/model bindings per role. Multiple roles can
share one model. There is no automatic fanout or dependency on a specific
vendor's HTTP API. Only already-registered AI providers are accepted; affiliate
provider IDs cannot enter this registry. OpenAI is not falsely presented as an
already-implemented repository adapter.

The default Worker runs with AI disabled. Explicit code-level
`DecisionRuntimeOptions` / `D1DecisionStore` dependency injection can supply a
registered, configured `AiProvider<DecisionAiRequest, DecisionAiResponse>`.
Providers must honor the abort signal and must not add hidden provider retries.
The model-role contract is exercised with test-only providers, not fake
production implementations. A production-default store rejects bindings marked
`TEST_FIXTURE`. Existing Gemini OAuth/key routing and the legacy local proxy
are not repurposed behind this interface; a live deployment adapter remains a
separately verified integration. No HTTP parameter grants fixture or AI access.

The central prompt version is `decision-reasoner-v1`. Evidence projection is
explicit, not an object spread of a product or environment. It sends bounded
internal signals, opaque product/offer references, allowed/blocked actions, and
four `OMITTED` markers for product title, merchant text, campaign name, and offer
description. **Raw external text is deliberately not sent at all in this
foundation**, including ordinary titles. The reasoner interprets structured
signals, not raw semantic product content. Injection tests insert hostile text
into each real input field and inspect the actual request received by the
fixture `AiProvider`; policy stays unchanged and tools remain an empty list.

Keys, cookies, credentials, sessions, customer identifiers, local paths and
raw configuration are absent from the evidence pack. No developer agent,
proxy endpoint, coding-agent credentials or OAuth session is read or copied.
The schema accepts only six exact fields and known enums, confidence in 0..1,
bounded arrays, a bounded summary, and at most 4096 response bytes. Extra fields
such as a new score, financial facts, tools, or arbitrary commands are rejected.
Free-text summary is replaced with a neutral deterministic advisory summary
before caching or journaling. Raw prompts/responses are not persisted.
Cached AI records and commit-time AI metadata are validated again.

## Cost And Failure Controls

AI is avoided for hard blocks, quarantines, obvious decisions, low-priority
deals, unchanged evidence, cooldown, or exhausted budget. By default it is
considered only for at least NORMAL priority and meaningful ambiguity/review.
Bounds: three attempts per batch and per fixed five-minute budget window,
two total provider attempts per advice, five-second attempt timeout, five-minute
product cooldown, and one-hour maximum advisory validity. A shared in-memory
batch allowance also prevents a batch crossing a budget-window boundary from
resetting its allowance; D1 is the cross-worker authority for window limits.

D1 reserves an evidence/policy/prompt/role/model-route identity before the first
provider operation. Exact duplicate requests converge on the same reservation
or validated cached result, including across new reasoner instances. An
abandoned reservation is not blindly retried: within validity it produces a
deterministic result without a second chargeable request. This is conservative
at-most-once local request reservation, **not a claim of exactly-once billing at
an external provider after an ambiguous network failure**.

Provider-level D1 reservations honor the existing single-provider concurrency
bound even if several roles use different models at that provider. Health
states are AVAILABLE, DEGRADED, UNAVAILABLE and COOLDOWN. Failure backoff starts
at 30 seconds; two failures open the five-minute cooldown. Retries do not sleep
in a daemon. One explicitly configured fallback may be tried; invalid output
is terminal for that advice. Timeout aborts and prevents a late health response
from starting an execution. All-AI failure still yields a valid deterministic
policy and plan. Evidence expiring before commit receives bounded job retry,
not an invalid terminal audit.

Usage records contain provider/model, request attempts, latency, and actual
provider-supplied token counts where available. Missing counts are null and
monetary cost is always `UNKNOWN`, never fabricated as zero. Health-check
attempts reserve quota conservatively even when no model execution follows.

## Persistence And Events

`0007_decision_os.sql` is additive and was applied only to ephemeral local D1:

- `decision_records`: normalized journal plus embedded ordered action plan;
  no redundant action-plan table, unique evidence identity, 16 KiB row bound.
- `decision_ai_advice`: reserved/completed advisory identity and normalized
  result, 8 KiB bound; successful cache and crash-safe reservation share a row.
- `decision_ai_budget`: per-origin fixed-window request count, atomic cap.
- `decision_ai_health`: bounded registered-provider circuit state per origin.

Indexes cover current/latest product decision, priority, review, block, expiry,
AI failure, provider/platform, advisory product cooldown, expiry and budgets.
Current reads cross-check the current Phase 6 evaluation, provider/work
revision validity and configuration fingerprint; historical journal pages are
explicitly labeled `journalOnly`. Bounded summaries describe a sample, not
fabricated catalogue-wide totals. Reads are capped at 50; work, provider fanout,
retention cleanup, and job dispatch preserve their existing bounded limits.

The existing `DEAL_EVALUATE` job is reused; no extra job type, worker, scheduler,
or full-catalogue decision sweeper is added. With the local decision feature
enabled, the claimed job prepares the decision and commits the deal evaluation,
decision journal/embedded action plan, due time, and terminal job state in the
**same D1 transaction**. Revision, provider-version and claim fences are retained.
An audit insertion failure rolls everything back. Lost acknowledgement and
duplicate Queue delivery produce no additional decision or action-plan effect.

Existing product/offer/publication, price, provider and meaningful revenue
triggers already invalidate `deal_work`; its indexed event-driven work therefore
recomputes decisions for affected products. Provider fanout is keyset bounded.
Configuration/policy changes invalidate reads immediately and converge through
the existing bounded due schedule; they do not synchronously rewrite the whole
catalogue. Fingerprints include deal identity, normalized current gates, source
revision, policy/configuration, model-role mapping and prompt version. Explicit
validity epochs and evidence-expiration boundaries are semantic time inputs;
unrelated clock ticks do not change identity. There is incremental 30-day audit
retention and bounded expired-advisory/window cleanup, not a promise that an
idle system has physically deleted every old record without another event.

AccessTrade/Shopee provenance is preserved as `provider=accesstrade`,
`platform=shopee`. Direct Shopee stays `DISABLED_NO_CREDENTIALS`. Executable
direct-Shopee method spies, the normalized fixture path and compiled Worker
checks establish zero direct API calls. Phase 7 makes no offer, price, revenue,
publication, campaign or notification mutation.

## Local Proof And Limitations

`npm run test:v6:decisions` is the repeatable focused proof. It includes real
Phase 6 evaluations, exact cases A–J, all severity pairs, corrupt boundaries,
four actual injection boundaries, score immutability, all action vocabulary,
AI disable/failure/fallback, strict output rejection, quotas, concurrency,
cache/replay/crash safety, D1 transactional rollback, expiry, current-read
invalidation, indexed EXPLAIN plans and zero-filesystem spies. A native workerd
Cron/Queue proof uses the compiled Worker and confirms that fixture-only money
evidence cannot become an authenticated production publish candidate.

Validation artifacts are under `.test-tmp/phase7/`, with the final durable
verification ledger under `docs/v6/evidence/`. Earlier focused runs are progress
evidence, not additional cases to add to the final count. The first run's single
failure was a test fixture that removed an optional campaign without marking it
required. The test now explicitly sets `campaignRequired=true`; the expected
BLOCK and missing-identity reason remain unchanged.

Core PASS never depends on live AI availability. No production deployment,
global operational-health projection, live AI adapter, real affiliate reporting,
production cost, autonomous publication or SEO/content generation is proven.
The legacy build is unaffected: modified call sites are Cloudflare-only, and
the shared legacy factory still refuses binding-free Cloudflare adapters.
Phase 7.5 and Phase 8 require separate authorization. Stop at Phase 7.

## Final Validation Ledger

| Suite | Passed | Failed |
| --- | ---: | ---: |
| Phase 7 focused, including native Worker proof | 132 | 0 |
| Phase 6 Deal Intelligence | 79 | 0 |
| Phase 5 Affiliate Money Engine | 57 | 0 |
| D1 and exact additive migration inventory | 25 | 0 |
| Queue | 17 | 0 |
| Cron | 10 | 0 |
| Native AutoPilot | 4 | 0 |
| Cloudflare runtime | 14 | 0 |
| Cloudflare routing | 11 | 0 |
| AccessTrade link safety | 34 | 0 |
| AccessTrade/TikTok integration | 43 | 0 |
| Publication | 25 | 0 |
| Provider/runtime foundation | 28 | 0 |
| Gemini provider diagnostics, isolated fixtures | 7 | 0 |
| Self-healing, isolated fixtures | 10 | 0 |
| Health/readiness, isolated fixtures | 34 | 0 |
| Rollout/stabilization | 20 | 0 |
| Zero-VPS storage | 9 | 0 |
| Revenue integrity | 5 | 0 |
| **Total** | **564** | **0** |

Final focused counts come from `.test-tmp/phase7/focused-results.json` and
`.test-tmp/phase7-focused-final.log`. The matrix's earlier 127-case Phase 7 entry
is superseded, not added to the final count. The 18 affected suites are recorded
in `.test-tmp/phase7/tests/results.json`. Late hardening changed only the new
decision boundary/store and focused suite; the existing regression code and
shared integration call sites were not changed after their final matrix runs.
The final focused native Worker proof, TypeScript and Worker build exercise the
final decision source, including that hardening.

Quality command logs are in `.test-tmp/phase7/quality/`. One final wrapper ESLint
attempt exited without diagnostics and produced an empty log. It is retained
as an unsuccessful attempt, not relabeled PASS. A direct full-repository retry
then exited 0 with zero errors and the same 34 existing warnings; its machine
readable report is `.test-tmp/phase7/eslint-final.json`. No warning suppression,
new ignore rule, test skip or weakened safety assertion was introduced.
The static/Worker build is local-only; the legacy application dependency graph
is unaffected and its build was deliberately not rerun. No migration/shadow
matrix or live external probe was needed.

Durable final summaries, case names, source hashes and command dispositions:
`docs/v6/evidence/phase7-focused.json` and
`docs/v6/evidence/phase7-completion.json`. The final post-checkpoint secret scan
is recorded in `docs/v6/evidence/phase7-final-secret-scan.json`.
