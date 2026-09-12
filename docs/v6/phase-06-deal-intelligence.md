# Phase 6 ‚Äî Deal Intelligence Engine

PHASE6=PASS
DEAL_INTELLIGENCE_ENGINE=PASS_LOCAL_FOUNDATION

DEAL_SCORE_SCALE=0..100
DEAL_CONFIDENCE_SCALE=0..1
ALGORITHM_VERSION=deal-intelligence-v1

PRICE_EVIDENCE=PASS
PRICE_HISTORY_WINDOWS=7D_14D_30D
PRICE_QUALITY=PASS

DISCOUNT_AUTHENTICITY=PASS_MEDIAN_REFERENCE
FRESHNESS_INTELLIGENCE=PASS

OFFER_QUALITY=PASS
MONETIZATION_INTELLIGENCE=PASS
REVENUE_EVIDENCE=PASS_BONUS_ONLY

PROVIDER_PLATFORM_PROVENANCE=PASS

RISK_PENALTIES=PASS

DEAL_SCORE=PASS
PRIORITY_MODEL=PASS
PUBLISH_RECOMMENDATION=PASS
EXPLAINABILITY=PASS

EVIDENCE_FINGERPRINT=PASS
IDEMPOTENCY=PASS
DUPLICATE_EVALUATION_EFFECT=0

ACCESS_TRADE_SHOPEE_INTELLIGENCE=PASS_NO_DIRECT_SHOPEE

DIRECT_SHOPEE_STATUS=DISABLED_NO_CREDENTIALS
DIRECT_SHOPEE_API_CALLS=0

EVENT_DRIVEN_RECOMPUTATION=PASS

PRICE_HISTORY_FULL_SCAN=NO
DEAL_EVALUATION_FULL_SCAN=NO
RANKING_FULL_SCAN=NO
DUE_WORK_FULL_SCAN=NO

FILE_STORAGE_CALLS=0
FILE_SYSTEM_SETTINGS_CALLS=0

PM2_REQUIRED=NO
VPS_REQUIRED=NO
LONG_RUNNING_PROCESS_REQUIRED=NO
CONTINUOUS_POLLING=NO

TEST_CASES_SKIPPED=0
ASSERTIONS_WEAKENED=NO
SCORING_ASSERTIONS_WEAKENED=NO
SAFETY_GATES_RELAXED=NO

NEW_TEST_CASES_PASSED=79
NEW_TEST_CASES_FAILED=0

TYPESCRIPT=PASS
ESLINT=PASS_0_ERRORS
SECRET_SCAN=PASS

BUILD_LEGACY=PASS_LOCAL_ONLY
BUILD_CLOUDFLARE=PASS_STATIC_AND_WORKER

PRODUCTION_RESOURCE_CREATED=NO
REAL_PRODUCTION_DATA_MIGRATED=NO
REAL_MONEY_TRANSACTION_CREATED=NO
DEPLOYED=NO

SAFE_FOR_PHASE_7=YES_LOCAL_FOUNDATION_ONLY
BLOCKERS=NONE_FOR_LOCAL_PHASE_6

## Design principles and constraints
The Phase 6 evaluation provides transparent scoring using only explicitly verified evidence, historical samples, and existing publication gating logic. Deal evaluation never synthesizes prices, invents demand signals, or assumes nominal list-price percentages represent real discounts. Unknown inputs result in low confidence or risk penalties, not assumed baseline metrics.

## Model representation
1. **DealScore (0‚Äì100)ääàŸZY⁄Y€€Xö[ò][€àŸàöXŸKúô\⁄ô\‹ÀŸôô\à€€ôöY[òŸK[€ô]^ò][€à›]K[ô‹[€ò[ô]ô[ùYH]öY[òŸKZ[ù\»õ›[ôYö\⁄»[ò[Y\ÀÇåãà
äëX[€€ôöY[òŸH
8†$ÃJNääà]H]òZ[Xö[]H[ô]X[]H][\Y\à[ô\[ô[ùŸàÿ€‹ôKàHŸXZÀX€€ôöY[òŸHÿ€‹ôH\»õ›[ôY»HY⁄ÿ€‹ôH⁄]Z\‹⁄[ô»\›‹öXÿ[€›ô\òYŸHõŸXŸ\»H’ÿ‹àQQUSX€€ôöY[òŸH]ò[X][€ãÇåÀà
äîö[‹ö]H
‘»Q“»ì‘ìPS»’»»ëRëP’
Nääà]\õZ[ö\›Xÿ[HX\Yúõ€Hÿ€‹ôKõ›[ôYûH^X⁄]ÿYô]Hÿ]\ÀÇçà
äîôX€€[Y[ô][€à
PìT“»ëQîëT“—íTî’»”»ëRëP’
Nääà[ôXÿ]\»ÿ][Ÿ›YHôXY[ô\‹»⁄]›]]]€õ€[›\€H[òX›[ô»›]H⁄[ôŸ\ÀÇÇ## Source inputs and persistence
Phase 6 reuses the existing `src/lib/affiliate/money/router.ts` for safe candidate offers, maintaining platform provenance (e.g. `accesstrade_tiktok_shop` or AccessTrade Shopee). The evaluation does not invoke the direct Shopee API. It applies the Phase 4 AutoPilot Cloudflare foundations (Queue/Cron adapter) and existing `D1JobStore` to enforce idempotency.

Storage creates four tables (in `0006_deal_intelligence.sql`):
- `deal_work`: Tracks the latest event-modified revision per product and the bounded `due_at`epoch.
- `deal_provider_products`: Materialized index for mapping offer providers back to parent products.
- `deal_provider_refresh`: Tracks global observation bumps for bounded global deal staleness detection.
- `deal_evaluations`: Persists the latest evaluation with `origin`, `algorithm_version`, `fingerprint` idempotency guard, and indexes for `score`, `priority`, `monetization_state`, `confidence` and `valid_until`.

All D1 access is fully indexed and bounded (`LIMIT` statements). Scanning full histories or performing unlimited batch materializations is explicitly excluded from the Cloudflare runtime.

## Tests
79 new validation cases, asserting zero additional legacy FileStorage dependencies, determinism, deduplication under duplicate Queue delivery/delay, explicit score thresholds, exact `FAIL_CLOSED` behavior on invalid/infinity prices, isolated fixture boundaries, and bounded SQLite `EXPLAIN QUERY LLAN` compliance.
