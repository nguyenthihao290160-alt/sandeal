# SanDeal URL, runtime truth, and reprocess runbook

## AccessTrade evidence

SanDeal accepts canonical and affiliate URLs only from explicit provider fields. Each successful AccessTrade request records field names (never credentials or full payload values) in `requests[].observedCanonicalUrlFields` and `requests[].observedAffiliateUrlFields`. Review those observations before expanding either allowlist.

The official AccessTrade v1 datafeed contract documents `url` as the product link and `aff_link` as the deep link. The official top-products example similarly separates `link` from `aff_link`. These values must remain separate; query parameters inside `aff_link` are not canonical provenance.

- <https://developers.accesstrade.vn/api-accesstrade-tai-lieu-tich-hop/get-datafeeds-information>
- <https://developers.accesstrade.vn/api-accesstrade-tai-lieu-tich-hop/top-selling-products>

Canonical merchant URLs and affiliate/tracking URLs are stored independently. A tracking URL is never decoded or used as a canonical URL. Missing or unsupported affiliate URLs remain unavailable and block Safe Publish.

## Reprocess current records

Preview the bounded record set without writing:

```powershell
npm.cmd run reprocess:current:dry -- --limit=100
```

After taking the normal production backup and confirming the preview, enqueue one idempotent operation:

```powershell
npm.cmd run reprocess:current:enqueue -- --confirm-enqueue --operation-id=product-health-YYYYMMDD-HHMM --limit=100
```

The command only enqueues `RECHECK_PRODUCT_HEALTH`; the worker performs bounded SSRF-safe checks. Every product receives a before/after entry in `product-reprocess-audit` and `lastReprocessOperationId`. Retrying the same operation ID performs no network checks and creates no duplicate audit entry. No record is hard-deleted. Unsupported legacy affiliate URLs are retained in `quarantinedAffiliateUrl` while the canonical merchant URL remains intact.

## Runtime truth

Current worker/scheduler status comes from fresh role leases and heartbeats. Schedule state (`nextRunAt`) is shown separately and cannot override an ACTIVE scheduler. Runtime role leases include the release ID; web, worker, and scheduler must match before release approval.

Historical failed jobs and recovered role conflicts remain visible as history. Only failures whose event timestamp falls inside the selected dashboard range count as current-range failures.

## Stale clients after deployment

`deploymentId` is tied to the Git release ID. Next.js version-skew protection and `BuildMismatchGuard` refresh clean sessions. Server Action lookup failures captured in an action context are logged as `STALE_CLIENT_ACTION_MISMATCH`, separately from current server incidents. Do not disable Server Actions or relax security gates.
