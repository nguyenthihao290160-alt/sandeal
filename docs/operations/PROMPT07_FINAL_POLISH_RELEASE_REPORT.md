# PROMPT #07 - Final polish and release readiness

Date: 2026-07-14  
Branch: `feature/prompt05b-dashboard-ui`  
Deployment performed: no

## Product and design

- Central tokens now define the off-white application background, white and tinted surfaces, semantic colors, borders, radii, shadows, focus, disabled states, and reduced motion.
- Dashboard and Kết quả bot use compact tinted headers, outlined vector icons, differentiated KPI accents, useful chart/history empty states, and solid button hierarchy.
- Sidebar keeps existing routes, adds a clear active rail, lowers Công cụ cũ, labels the unfinished content route, and provides a focus-managed mobile drawer with close button, overlay, and Escape handling.
- Kết quả bot groups common and advanced filters, shows the active-filter count, preserves list/grid data, and provides real next actions when empty.
- Hàng chờ phê duyệt, Tự động hóa, Nguồn sản phẩm, Kết nối bảo mật, Sức khỏe hệ thống, and Cài đặt an toàn received compact empty/locked/error states and Vietnamese labels.
- Sản phẩm và bài đánh giá is explicitly downgraded as `Đang hoàn thiện`; its existing route remains valid and no fake backend was added.

## Functional changes

- Schedule mutations require confirmation and a reason and append a sanitized automation audit event.
- Health exposes only provider configuration state, never connection values; Gemini is `Chưa cấu hình` instead of healthy when no connection exists.
- Automation pause/resume uses persistent control API; dry-run creates a real durable job without business-data side effects.
- Token-vault bulk Gemini test is disabled with a reason when no Gemini connection exists.
- The public URL fallback is local-only; release preflight requires an explicit approved HTTPS URL.

## Release controls

- CI workflow: `.github/workflows/release-quality.yml`; it installs from lock, typechecks, lints, runs targeted/full tests, builds, scans, verifies storage/backup, creates a checksummed artifact and validates the manifest. It does not deploy.
- Preflight reports `READY`, `WARNING`, `CONFIGURATION_REQUIRED`, or `BLOCKED` without printing secret values.
- Secret scan excludes local secret files and reports only file, line, and rule.
- Storage schema: JSON-file v1, atomic temp-write/rename with per-file locks and `.bak` recovery. It is single-instance only; no distributed lock is claimed.
- Migration: no migration is required for this release.
- Backup metadata contains source version and SHA-256. Default backup excludes `token-vault.json`; restore refuses a non-empty target.
- Rollback is documented for application, worker/scheduler, and data layers.
- Generated release output is kept under ignored `.release/` and contains the artifact, checksum, and manifest.
- The manifest records the dirty-working-tree state and a checksum of tracked changes plus untracked source files. A dirty artifact is a local candidate only; production requires a reviewed commit and a clean rebuild.

## Validation

- Targeted dashboard: 10 passed.
- Targeted automation: 20 passed.
- Targeted release UI: 17 passed.
- Typecheck: passed after one targeted repair.
- Edited-file lint: 0 errors; 3 existing warnings (unused helper and unoptimized external images).
- Full lint: 0 errors; 26 existing warnings, with no new release-gate error.
- Full test: 134 passed, 0 failed (87 core, 10 dashboard, 20 automation, 17 release UI).
- Production build: passed with Next.js 16.2.10; compile, type validation and 28-page generation completed.
- Secret scan: passed, 188 source/documentation files checked after documentation was finalized.
- Generated-file check: passed.
- Migration validation: passed, schema v1, no migration.
- Backup/restore round-trip: passed for task, source, and product fixtures in an isolated test directory.
- Local preflight: `WARNING` because production auth/vault key/provider connections are intentionally absent; the local health endpoint is reachable.
- Production-like web smoke: all public/dashboard routes and dashboard/automation APIs returned the expected status. Invalid queue filters and source URLs returned 400.
- Automation smoke: durable dry-run completed without product/source writes; duplicate submission returned the same job; approval, retry, cancel, pause/resume and kill-switch controls worked and were returned to a safe paused state.
- Restart recovery: a pending durable job remained available with the same ID and status after the web process restarted, then completed through an independent one-shot worker.
- Authentication smoke: anonymous admin API access returned 401 and an authenticated local test request returned 200. No production credential was used.
- Missing-provider smoke: an approved AI task ended as `CONFIGURATION_REQUIRED`, was not reported as successful and did not call a provider.
- Browser runtime: unavailable because the browser discovery list was empty. The local server remains available at `http://127.0.0.1:3107` for human visual verification; no browser pass is claimed.
- Release manifest: created with artifact/package/source-state checksums and validated after final source checks.

## Known limitations and approvals

- Gemini and AccessTrade remain unavailable until configured; dependent actions show a safe unavailable/configuration state.
- JSON file locking is not multi-instance safe.
- Browser automation must not be marked passed unless a browser runtime can be opened.
- The local candidate is based on uncommitted work as required by the task. It must be reviewed, committed and rebuilt by the human-approved release process before production use.
- Before deployment a human must approve production credentials, strict preflight, backup location, artifact checksum, platform procedure, and rollback window.

## Files

- UI/source: dashboard layout/pages/modules, shared dashboard icons/status, automation health/schedule routes, config and token-vault labels.
- Tests/tooling: `prompt07-release-ui-tests.cjs`, preflight, validation, storage backup/restore, and release manifest scripts.
- CI: `.github/workflows/release-quality.yml`.
- Documentation: this report plus production release, checklist, and rollback runbooks.
- Generated `.release/`, `.backups/`, `.data/`, `.next/`, and `*.tsbuildinfo` must not be committed.
