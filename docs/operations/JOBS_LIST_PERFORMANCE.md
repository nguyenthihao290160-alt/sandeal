# Automation Jobs list contract and payload budget

The authenticated `GET /api/automation/jobs` endpoint uses the `compact-v2`
read model for table/list views. The page size is capped at 50.

## Budget

- Maximum regression-test budget: **307,200 bytes uncompressed** for the full
  JSON envelope containing 50 representative rows.
- The budget is enforced deterministically by
  `scripts/operator-intelligence-regression-tests.cjs`.
- The verified production baseline before this change was approximately
  **2.48–2.52 MB** for 50 rows. That production value is retained only as the
  comparison baseline; tests and implementation do not access production.
- On 2026-07-24, the deterministic local fixture measured **40,581 bytes
  uncompressed** for the complete 50-row response envelope (about 98.4% below
  the 2.5 MB midpoint baseline).

## Compact fields

The list projection contains the stable job and operation IDs, type,
capability/bot summary, status/outcome, priority, requested/executed mode,
provider summary, bounded progress, external/AI request counts, fallback and
evidence summaries, approval/risk state, attempt/retry summary, short sanitized
failure information, and lifecycle timestamps.

It deliberately excludes payload, result, execution plan, checkpoint,
disclosure internals, lease/claim tokens, worker-instance identifiers,
idempotency keys, raw provider metadata, approval/audit bodies, and all
credential-like fields.

Full sanitized detail is loaded only after explicit operator action from
`GET /api/automation/jobs/{id}`. Nested arrays, object depth, strings, and
secret-like keys are bounded or redacted before serialization.

## Data access

- MongoDB uses one revision lookup and one filtered/sorted `$facet`
  aggregation over the compact projection. The facet returns the requested
  page plus its count without loading the durable job collection.
- File storage reads the capped compact projection collection (2,000 rows by
  default and a hard maximum of 10,000), filters/sorts it, and slices the
  requested page. It does not read the heavy durable job collection during
  normal list requests.
- The compact rows live in the additive, versioned
  `automation-job-list-projections-v2` read model. The established
  `automation-job-projections` status model remains populated for rollback and
  polling compatibility; canonical jobs are not transformed.
- A one-time compatibility bootstrap can materialize the compact projection
  from a bounded page of legacy durable jobs when the projection is absent.
- The API reports the read-model source and query-count equivalent in
  `data.meta.dataAccess`; regression coverage requires no more than two storage
  operations for a normal page.

This is a payload/query regression budget, not a wall-clock service-level test.
Local filesystem and CI timing are intentionally not treated as production
latency measurements. The representative fixture intentionally fills bounded
summary fields but cannot reproduce production database, network, compression,
or browser timing.
