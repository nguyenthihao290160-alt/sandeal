# SanDeal M3.1.3 — Runbook xác minh production an toàn

> Phạm vi: chỉ operator có phê duyệt mới thực hiện. Tài liệu không tự cấp quyền deploy, không bật publication/canary và không thay thế guard của repository.

## Quy tắc an toàn

- Các block PowerShell chỉ chạy trên Windows trước khi SSH. Các block Bash chỉ chạy sau khi SSH vào VPS; không dán PowerShell vào Bash.
- Không chạy từ /root; deployment chỉ được chạy ở /var/www/sandeal-git.
- Không dùng git reset --hard, git clean -fd, xóa .data/backup/snapshot/lease/history, force publish, hạ SLO, tắt Guardian hay tăng số Worker.
- PM2 online không đủ để kết luận thành công. Cần identity, lease, live-health, App Health và log mới.
- Không đưa credential, token hoặc affiliate query nhạy cảm vào terminal, ticket hay screenshot.

## Phase 1 — Local pre-commit (Windows PowerShell)

Mở Windows PowerShell tại máy local:

~~~powershell
Set-Location C:\duan\sandeal
git branch --show-current
git rev-parse HEAD
git fetch origin
git rev-parse origin/master
$localHead = git rev-parse HEAD
$remoteHead = git rev-parse origin/master
if ($localHead -ne $remoteHead) { throw 'LOCAL_HEAD_DOES_NOT_MATCH_ORIGIN_MASTER' }
git status --short
git diff --stat
git diff --check
git diff -- package.json
git diff -- package-lock.json
~~~

Kỳ vọng: branch là master; local HEAD đúng origin/master; tree chỉ chứa thay đổi M3.1.3 đã review; diff --check trống. Package-lock không đổi nếu không thêm dependency. Dừng nếu branch/tree/lockfile khác kỳ vọng.

Chạy gate local (toàn bộ dùng fixture/mock, không gọi AccessTrade/Gemini thật và không truy cập production):

~~~powershell
npm run test:m3.1.3
npm run test:m3.1.3:release-live-health
node scripts/m3-1-1-projection-repair-tests.cjs
npm run test:m3.1.2:projection-repair
npm run test:m3.1.2:projection-performance
node scripts/bounded-projection-storage-tests.cjs
node scripts/automation-health-reliability-tests.cjs
npm run test:master:m1
npm run test:master:m2
npm run test:master:m3
npm run test:master:m4
npm run test:master:m5
npm run test:master:m6
npm run test:master:pwa
npm run test:post-m3
npm run test:health-readiness
npm run test:accesstrade
npm run test:prompt08
npm run test:prompt10:foundation
npm run test:prompt10:runtime
npm run test:prompt10:shadow
npm run test:prompt10:orchestration
npm run test:prompt10:autopublish
npm run test:prompt10:zero-touch
npm run test:prompt10:business-source
npm run test:prompt10:resilience
npm run test:storage
npm run test:storage:mongo
npm run test:storage:migration
npm run test:storage:acceptance
npm run test:prompt10:lifecycle
npm run test:prompt10:backup
npm run test:prompt10:slo
npm test
npm run typecheck
npm run lint
npm run release:secret-scan
npm run build
npm run release:generated-check
npm run release:migration-check
~~~

Từng lệnh phải exit 0. `test:storage:acceptance` an toàn local: fixture ép data directory tạm, xóa Mongo environment và không mở network; kết quả `REAL_ISOLATED_MONGO_ACCEPTANCE: NOT_RUN` là evidence mock/file-storage, không phải Mongo production acceptance. Không chạy `npm run storage:mongo:acceptance:check -- --user-confirmed` hay bất kỳ real isolated Mongo probe nào trong release local này vì cần opt-in/authority riêng và không được chạm production. Một test skipped không phải PASS: ghi đúng lý do. Dừng khi test/build/secret scan/performance guard fail.

Commit được khuyến nghị:

~~~text
fix: converge health and product recovery safely
~~~

Chỉ phân loại safe-to-commit khi tất cả gate bắt buộc PASS, diff đã review, không secret, và không có thay đổi ngoài M3.1.3.

## Phase 2 — Commit/push an toàn (Windows PowerShell)

In danh sách trước khi stage:

~~~powershell
git status --short
git diff --name-only
~~~

Chỉ stage đúng danh sách M3.1.3 đã review dưới đây. Không dùng `git add .`, và không stage bất kỳ tệp lạ nào, đặc biệt `package-lock.json`.

~~~powershell
git add -- docs/operations/SANDEAL_MASTER_GUARDED_DEPLOYMENT.md docs/operations/SANDEAL_M3_1_3_PRODUCTION_VERIFICATION_RUNBOOK.md package.json
git add -- scripts/automation-worker.cjs scripts/guarded-production-deploy.sh scripts/guarded-release-verify.cjs scripts/m3-1-1-projection-repair-tests.cjs scripts/m3-1-3-gate-a-tests.cjs scripts/m3-1-3-gate-b-worker-scheduling-tests.cjs scripts/m3-1-3-product-publication-recovery-tests.cjs scripts/m3-1-3-release-live-health-tests.cjs scripts/master-m1-release-identity-tests.cjs scripts/master-m1-runtime-recovery-tests.cjs scripts/master-m2-worker-pool-tests.cjs scripts/prompt10-autopublish-tests.cjs scripts/prompt10-business-source-tests.cjs scripts/prompt10-foundation-tests.cjs scripts/prompt10-self-healing-tests.cjs scripts/prompt10-shadow-safety-tests.cjs
git add -- scripts/prompt10-lifecycle-tests.cjs scripts/prompt10-orchestration-tests.cjs scripts/prompt10-zero-touch-tests.cjs
git add -- src/app/api/automation/health/route.ts src/app/api/automation/publication-readiness/route.ts src/app/api/health/live/route.ts src/app/dashboard/app-health/page.tsx
git add -- src/lib/automation/executionPolicy.ts src/lib/automation/featureRollout.ts src/lib/automation/healthService.ts src/lib/automation/jobHealthSummary.ts src/lib/automation/operationalHealth.ts src/lib/automation/postPublishMonitor.ts src/lib/automation/productFlowDiagnostics.ts src/lib/automation/projectionMaintenance.ts src/lib/automation/safeProductRechecks.ts src/lib/automation/sloErrorBudget.ts src/lib/automation/store.ts src/lib/automation/types.ts src/lib/automation/worker.ts
git add -- src/lib/autonomous/priceTruthEngine.ts src/lib/autonomous/sourceAdapterPlatform.ts src/lib/bots/productPipeline.ts src/lib/integrations/accesstrade.ts src/lib/product-intelligence/jobs.ts src/lib/productBlockers.ts src/lib/reviewQuality.ts
git diff --cached --check
git diff --cached --stat
git commit -m "fix: converge health and product recovery safely"
git push origin master
git fetch origin
git rev-parse HEAD
git rev-parse origin/master
$localHead = git rev-parse HEAD
$remoteHead = git rev-parse origin/master
if ($localHead -ne $remoteHead) { throw 'PUSH_DID_NOT_REACH_ORIGIN_MASTER' }
git status --short
~~~

Kỳ vọng: hai SHA cuối giống nhau, status trống. Dừng nếu push reject, remote mismatch hoặc tree bẩn; không amend/force-push để vượt lỗi.

## Phase 3 — VPS pre-deploy guard (Bash)

SSH theo quy trình tổ chức. Khi đã ở Bash, chạy:

~~~bash
cd /var/www/sandeal-git
pwd -P
git branch --show-current
git status --short
git rev-parse HEAD
git fetch origin
git rev-parse origin/master
git log --oneline HEAD..origin/master
~~~

Kỳ vọng: path chính xác, branch master, working tree sạch; log chỉ có commit chờ deploy. Dừng nếu path/branch/tree sai.

Kiểm tra service/tài nguyên:

~~~bash
pm2 status
curl --connect-timeout 3 --max-time 10 --fail -sS http://127.0.0.1:3000/api/health/live
curl --connect-timeout 3 --max-time 10 --fail -sS https://sandeal.tech/api/health/live
free -h
uptime
df -h /var/www/sandeal-git
pm2 jlist | node scripts/guarded-release-verify.cjs data-directory
~~~

Kỳ vọng: đủ ba app sandeal, sandeal-worker, sandeal-scheduler; hai live-health là HTTP 200/JSON; data-directory là một đường dẫn tuyệt đối dùng chung; RAM/disk còn headroom.

Xác minh release hiện đang chạy (trước fast-forward):

~~~bash
CURRENT_RELEASE="$(git rev-parse HEAD)"
node scripts/guarded-release-verify.cjs manifest "$CURRENT_RELEASE"
pm2 jlist | node scripts/guarded-release-verify.cjs processes "$CURRENT_RELEASE"
pm2 jlist | node scripts/guarded-release-verify.cjs runtime "$CURRENT_RELEASE"
pm2 pid sandeal-worker
pm2 pid sandeal-scheduler
~~~

Kỳ vọng: PASS, một Worker lease ACTIVE và một Scheduler lease ACTIVE với SHA/fencing hợp lệ; PID khác 0. Nếu VPS đúng release cũ còn origin/master đã mới, ghi nhận điều đó và dùng current VPS SHA cho pre-deploy verifier.

## Phase 4 — Quyết định tài nguyên an toàn

- Tiếp tục khi RAM còn headroom, swap không tăng, disk đủ, load bình thường và restart count ổn định.
- Cảnh báo: swap đang dùng nhưng ổn định, free memory giảm, hoặc RSS một app tiến gần mức PM2 tự restart 512M. Ghi số liệu, chờ tối đa 5 phút và recheck một lần.
- Dừng rollout khi swap tăng giữa hai lần đo, app chạm/restart gần ngưỡng PM2 512M, load tăng kéo dài, hoặc disk free dưới 256 MiB. 256 MiB là ngưỡng critical thực tế của Runtime Guardian/readiness; repository không định nghĩa một số RAM hệ thống khác, vì vậy không tự bịa ngưỡng để tiếp tục build.
- Không reboot VPS, không update Ubuntu trong deployment.

Cơ chế hiện có cần đủ ba PM2 app: guarded-production-deploy.sh dùng pm2 jlist để suy ra SANDEAL_DATA_DIR trước build. Vì vậy không có lệnh an toàn trong repository này để tự dừng Worker/Scheduler trước build mà vẫn dùng guard. Không tự stop chúng để giải phóng RAM; khi áp lực cao, dừng rollout và điều tra.

## Phase 5 — Fast-forward update (Bash)

Chỉ chạy khi Phase 3–4 đạt:

~~~bash
cd /var/www/sandeal-git
git fetch origin
TARGET_RELEASE="$(git rev-parse origin/master)"
echo "$TARGET_RELEASE"
git merge --ff-only origin/master
DEPLOYED_RELEASE="$(git rev-parse HEAD)"
echo "$DEPLOYED_RELEASE"
if [ "$DEPLOYED_RELEASE" != "$TARGET_RELEASE" ]; then echo "FAST_FORWARD_TARGET_MISMATCH" >&2; exit 1; fi
git status --short
~~~

Kỳ vọng: fast-forward thành công, HEAD đúng target, tree sạch. Dừng khi non-fast-forward/conflict/SHA sai. Không reset, checkout cưỡng bức hay rewrite history.

## Phase 6 — Guarded build/deploy (Bash)

~~~bash
cd /var/www/sandeal-git
pwd -P
TARGET_RELEASE="$(git rev-parse HEAD)"
echo "$TARGET_RELEASE"
DEPLOYMENT_LOG_START="$(date '+%Y-%m-%d %H:%M:%S')"
echo "$DEPLOYMENT_LOG_START"
SANDEAL_DEPLOY_DEFER_PM2_SAVE=true bash scripts/guarded-production-deploy.sh
~~~

Chạy từng dòng, không nối hai lệnh. Khi script hỏi:

~~~text
Type the intended release SHA to continue:
~~~

dán full SHA 40 ký tự vừa in bởi TARGET_RELEASE, không dán chữ SHA hay SHA rút gọn.

Các dòng Repository/Branch/Git HEAD và log đã redact là thông tin bình thường. Với SANDEAL_DEPLOY_DEFER_PM2_SAVE=true, output GUARDED_DEPLOYMENT_VERIFIED_PENDING_PM2_SAVE là kết quả thành công mong đợi: guard đã build/restart/xác minh process, lease, local/public health nhưng cố ý chưa lưu PM2 state. Điều này giữ pm2 save cho Phase 18 sau browser/App Health/product/public verification. Không đặt biến này giá trị nào ngoài true/false.

Một GUARDED_DEPLOYMENT_FAILED, nonzero exit, build failure, identity/lease/health mismatch là fatal: dừng, không xóa lease, không rerun liên tục và không pm2 save tay.

## Phase 7 — Release identity (Bash)

~~~bash
cd /var/www/sandeal-git
TARGET_RELEASE="$(git rev-parse HEAD)"
node scripts/guarded-release-verify.cjs manifest "$TARGET_RELEASE"
pm2 jlist | node scripts/guarded-release-verify.cjs processes "$TARGET_RELEASE"
pm2 jlist | node scripts/guarded-release-verify.cjs runtime "$TARGET_RELEASE"
node scripts/guarded-release-verify.cjs health "$TARGET_RELEASE" http://127.0.0.1:3000/api/health/live https://sandeal.tech/api/health/live
~~~

Kỳ vọng: mọi command PASS. Verifier kiểm SANDEAL_BUILD_MANIFEST_COMMIT, SANDEAL_BUILD_COMMIT, SANDEAL_RELEASE_ID, GIT_COMMIT_SHA, NEXT_PUBLIC_SANDEAL_RELEASE_ID ở web/Worker/scheduler; build manifest; lease và local/public live health. Tất cả phải bằng Git HEAD.

## Phase 8 — PM2 và lease (Bash)

~~~bash
pm2 status
pm2 pid sandeal
pm2 pid sandeal-worker
pm2 pid sandeal-scheduler
sleep 30
pm2 status
TARGET_RELEASE="$(git rev-parse HEAD)"
pm2 jlist | node scripts/guarded-release-verify.cjs runtime "$TARGET_RELEASE"
~~~

Kỳ vọng: ba app online, PID nonzero, uptime tăng, restart count không tăng. Worker/Scheduler leases ACTIVE/fresh/đúng release, không duplicate role. Sau restart, lease có thể chưa fresh: chỉ chờ 30 giây và recheck một lần; tối đa chờ thêm 30 giây và recheck một lần. Sau đó dừng điều tra, không restart lặp lại.

Nếu cần lần recheck thứ hai, chạy đúng block ngắn này một lần:

~~~bash
sleep 30
pm2 status
TARGET_RELEASE="$(git rev-parse HEAD)"
pm2 jlist | node scripts/guarded-release-verify.cjs runtime "$TARGET_RELEASE"
~~~

Output `runtime` đã kiểm luôn PID trong Worker/Scheduler lease bằng PID tương ứng trong PM2; nó in `pid` và `pm2Pid` để operator đọc. Dừng nếu command không PASS hoặc hai PID khác nhau.

## Phase 9 — Server health (Bash)

~~~bash
curl --connect-timeout 3 --max-time 10 --fail -sS -o /dev/null -w 'local live HTTP=%{http_code} time=%{time_total}s\n' http://127.0.0.1:3000/api/health/live
curl --connect-timeout 3 --max-time 10 --fail -sS -o /dev/null -w 'public live HTTP=%{http_code} time=%{time_total}s\n' https://sandeal.tech/api/health/live
curl --connect-timeout 3 --max-time 10 --fail -sS http://127.0.0.1:3000/api/health/live
curl --connect-timeout 3 --max-time 10 --fail -sS https://sandeal.tech/api/health/live
~~~

Kỳ vọng: HTTP 200, releaseMismatch:false và build/release identity đúng target. `curl --fail` (portable trên VPS) fail khi connect quá 3 giây, tổng quá 10 giây hoặc HTTP 4xx/5xx; đó là blocking. App Health cần dashboard auth, nên evidence bắt buộc của nó được lấy trong Phase 12: Network phải có đúng một `GET /api/automation/health`, HTTP không phải 500, Duration dưới client timeout 15 giây và response không che partial/unavailable thành PASS. Ghi HTTP/Duration vào hàng “App Health API” của matrix; không đặt credential vào curl.

## Phase 10 — Memory/CPU/load/disk/swap (Bash)

~~~bash
free -h
uptime
df -h /var/www/sandeal-git
pm2 status
pm2 monit
~~~

pm2 monit là màn hình chỉ quan sát; nhấn q để thoát. Dừng further rollout khi identity mismatch, app không online/restart loop, lease stale sau bounded wait, live-health fail, App Health 500/repeated timeout, memory/swap/disk nguy hiểm, serving projection invalid/repeated repair fail hoặc error log mới tăng.

## Phase 11 — Log theo deployment timestamp (Bash)

DEPLOYMENT_LOG_START được in trước deploy. Nếu shell mới, đặt nó về timestamp trước deploy trong ticket theo YYYY-MM-DD HH:MM:SS. Kiểm từng app riêng, chỉ filter dòng từ mốc trở đi:

~~~bash
set -o pipefail
PATTERN='exception|fatal|unhandled|release[_ -]?mismatch|lease[_ -]?state|manifest[_ -]?mismatch|projection|source[_ -]?revision|duplicate[_ -]?(claim|publication)|timeout|memory|EPIPE|MODULE_NOT_FOUND'
COVERAGE_PARTIAL=0
NEW_ERRORS=0
for APP in sandeal sandeal-worker sandeal-scheduler; do
  LOG_FILE="/tmp/${APP}-postdeploy-redacted.log"
  if ! pm2 logs "$APP" --nostream --raw --lines 500 2>&1 | node scripts/redact-operational-output.cjs > "$LOG_FILE"; then
    echo "PM2_LOG_READ_OR_REDACTION_FAILED:$APP" >&2; exit 1
  fi
  FIRST_TIMESTAMP="$(grep -Eo '[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}' "$LOG_FILE" | head -n 1)"
  FIRST_TIMESTAMP="${FIRST_TIMESTAMP/T/ }"
  if [ -z "$FIRST_TIMESTAMP" ] || [[ "$FIRST_TIMESTAMP" > "$DEPLOYMENT_LOG_START" ]]; then echo "LOG_COVERAGE_PARTIAL:$APP"; COVERAGE_PARTIAL=1; fi
  awk -v since="$DEPLOYMENT_LOG_START" '$0 >= since' "$LOG_FILE" > "${LOG_FILE}.new"
  if [ ! -s "${LOG_FILE}.new" ]; then echo "LOG_COVERAGE_PARTIAL:$APP"; COVERAGE_PARTIAL=1; continue; fi
  grep -Ei "$PATTERN" "${LOG_FILE}.new"
  MATCH_STATUS=$?
  if [ "$MATCH_STATUS" -gt 1 ]; then echo "LOG_SEARCH_FAILED:$APP"; exit 1; fi
  if [ "$MATCH_STATUS" -eq 0 ]; then echo "NEW_ERROR_MATCHED:$APP"; NEW_ERRORS=1; else echo "NO_MATCHING_NEW_ERRORS:$APP"; fi
done
echo "LOG_CHECK_SUMMARY coveragePartial=$COVERAGE_PARTIAL newErrors=$NEW_ERRORS"
if [ "$COVERAGE_PARTIAL" -ne 0 ] || [ "$NEW_ERRORS" -ne 0 ]; then exit 1; fi
~~~

Kỳ vọng: mỗi app in `NO_MATCHING_NEW_ERRORS` và summary là `coveragePartial=0 newErrors=0`. `NEW_ERROR_MATCHED`, `PM2_LOG_READ_OR_REDACTION_FAILED`, `LOG_SEARCH_FAILED` là blocking cần điều tra. `LOG_COVERAGE_PARTIAL` không phải PASS: nó phát hiện cả trường hợp retained 500 lines bắt đầu sau deployment hoặc không có dòng mới; ghi PARTIAL và dùng log system có timestamp để mở rộng evidence thay vì kết luận “không có lỗi”. Dòng trước DEPLOYMENT_LOG_START là historical, không được trộn để kết luận lỗi mới. Tất cả output được redact trước khi lưu/hiển thị.

## Phase 12 — App Health website

Đăng nhập bằng account operator, mở:

~~~text
https://sandeal.tech/dashboard/app-health
~~~

Kiểm từng bước:

1. Trang tải không HTTP 500, REQUEST_TIMEOUT hoặc endless loading.
2. Nhấn Refresh một lần. Nó chỉ đọc state; không tạo job hoặc repair.
3. Chỉ khi projection nói cần repair, nhấn Retry một lần. Đọc thông điệp: Retry chỉ schedule một maintenance repair deduplicated, không rebuild inline. Nút phải disabled khi request tương đương pending.
4. Nhấn Refresh lại. Repair state/next retry có thể đổi theo worker, nhưng không tạo duplicate request.
5. Có last successful refresh, data freshness, partial component failures, current release và rollout flags configured/effective/source/cohort/inactive reason.
6. Projection phải hiện serving generation, pending generation (nếu có), source revision/high-water mark, manifest/fingerprint, repair owner/fence, started/last heartbeat, last success/failure, next retry, serving validity và previous valid serving state. Không được vừa IDLE vừa SYNC_IN_PROGRESS cho cùng generation.
7. Current reasons phải tách historical reasons. Historical không có blocking authority. Labels PASS, BREACH, PARTIAL, INSUFFICIENT_DATA, NOT_APPLICABLE, BOOTSTRAP, RECOVERY, HALF_OPEN, BLOCKED_BY_POLICY, HISTORICAL phải rõ.
8. Web/Worker/scheduler/public identities phải khớp; heartbeat age hợp lý; pickup có counts current/legacy/missing/excluded và critical/normal; AccessTrade hiện configured/credential/format/probe riêng; Gemini Free-only là BLOCKED_BY_POLICY riêng; Guardian hiện current reasons/permit/canary/evidence.

Đo response App Health bằng Chrome Network: clear request cũ, nhấn Refresh, kiểm status và Duration. Dừng nếu request lặp lại vượt client timeout 15 giây, HTTP 500, component timeout bị che thành PASS, serving invalid, repeated repair failure, release mismatch, duplicate repair, hay stale backup banner sau refresh thành công.

## Phase 13 — Dashboard quan trọng

Mở lần lượt Dashboard overview, Jobs/progress, Automation, Schedule, Alerts, Product bot results, Product import, Product quality/duplicate detection, Product detail, Approval queue, Token vault/provider readiness và App Health.

Ở mỗi trang: active navigation visible; navigation/filter/Refresh/open-close phản hồi một lần; không endless loading; stale data có warning; lỗi dễ hiểu; permissions vẫn enforced; inline confirmation đúng chỗ. Không nhấn nút thay đổi state chỉ để “test”, và không double-click control có thể mutate. Ngoại lệ duy nhất là Retry ở Phase 12 khi repair thực sự cần, hoặc một recheck/dry-run đã cần ở Phase 14 với audit evidence. Không publish, erase hay đổi credential/provider để “test”.

## Phase 14 — Product pipeline (không force publish)

Chọn một candidate thật non-public hoặc deterministic record repository cung cấp. Không copy affiliate token/query vào ticket. Xác minh:

1. Candidate và canonical product có mặt.
2. Canonical/merchant/affiliate URL, redirect destination/loop, HTTP/timeout/availability.
3. Price, image URL/response/content type/size và source evidence.
4. AccessTrade states được tách: configured; credential present; credential format valid; probe NOT_RUN/PASSED/FAILED/RATE_LIMITED/UNAVAILABLE/DISABLED.
5. Claims, approved review hoặc explicit manual review, evidence generation, và blocker classification RETRYABLE, RECHECK_SCHEDULED, WAITING_EXTERNAL, WAITING_MANUAL_REVIEW, BLOCKED_BY_POLICY, PERMANENT_FAILURE hoặc RESOLVED.
6. Next automatic action, recheck schedule/backoff và duplicate suppression. Chỉ schedule một lần; restart Worker không được tạo job cùng idempotency key lần hai.
7. Trong browser đã đăng nhập, mở đúng API read-only `/api/automation/publication-readiness?limit=10`. Chỉ `HTTP 200`, `code=OK`, `readOnly:true` và `data.currentState=COMPLETE` là evidence dry-run hoàn chỉnh. `HTTP 200`, `code=PUBLICATION_READINESS_BOOTSTRAP` cùng `data.currentState=INSUFFICIENT_DATA` là PARTIAL/thiếu read model, không phải PASS; `HTTP 503`, `code=PUBLICATION_READINESS_UNAVAILABLE` là stop/investigate. Response phải nêu closest-to-ready, evidence thiếu, next action, manual/policy/runtime-only blocker; chỉ xem JSON, không bấm publish. URL này không enqueue recheck hay mutate dữ liệu. `401` nghĩa là chưa đăng nhập; `400 VALIDATION_ERROR` nghĩa là limit sai (chỉ 1–50), không phải lỗi product.

Gemini bị Free-only block không được cản URL/affiliate/price/image/source checks. Evidence mới supersede failure cũ, không xóa history.

## Phase 15 — Public website

Mở homepage, `/deals`, một public deal detail `/deals/<public-slug>` chỉ khi đã có sản phẩm public hợp lệ, `/deals/category/<category-slug>` và `/deals/brand/<brand-slug>` khi có, `/robots.txt`, `/sitemap.xml`, `/icon` và Open Graph. Chỉ dùng `/go/<public-product-id>` với ID từ một public product hợp lệ, không đoán ID. Redirect này ghi một event OUTBOUND_CLICK: chỉ click/inspect đúng một lần, kỳ vọng một audit event, không retry liên tục.

Kiểm desktop/mobile layout, broken image, 404 link, affiliate redirect, public count và page load. Ghi một tình trạng đúng:

- Website technical healthy nhưng không có product eligible.
- Pipeline blocked/recovering.
- Product eligible nhưng Guardian/SLO block.
- Product published nhưng public monitor fail.
- Có ít nhất một legitimate product public và monitor pass.

Homepage mở không đủ kết luận healthy.

Nếu owner đã có một môi trường terminal kiểm soát với Basic Auth được cấp sẵn (không gõ/export/in secret vào history), có thể chạy đúng script read-only có sẵn một lần để bổ sung evidence:

~~~bash
npm run verify:production:readonly -- --base-url=https://sandeal.tech/
~~~

Script chỉ dùng GET/manual redirect và timeout 8 giây, ghi report metadata đã redacted dưới `.test-tmp/production-readonly-audit`. Nó có thể kiểm `/go` một lần với product public đầu tiên, nên không chạy lại nhiều lần. Nếu auth chưa được cung cấp qua môi trường kiểm soát, bỏ qua command này và dùng browser-auth steps; ghi “skipped: controlled auth unavailable”, không đánh PASS thay thế.

## Phase 16 — Chrome DevTools Network/Console

1. Mở Network, bật Preserve log khi kiểm redirect, clear request cũ.
2. Refresh trang.
3. Kiểm pending request, Duration, 4xx/5xx, API timeout, image 404.
4. Kiểm redirect chain và destination; không lưu tracking query nhạy cảm.
5. Mở Console, kiểm uncaught exception, hydration/CSP error và request loop.

Blocking: API 5xx/repeated timeout/request loop; public image 404 hàng loạt; redirect loop/sai merchant; JavaScript exception ảnh hưởng chức năng; release mismatch.

## Phase 17 — Publication canary

Repository hỗ trợ canary/runtime controls, nhưng runbook này không bật canary. Quyết định mặc định là giữ OFF/SHADOW/OBSERVE nên không publishable; không suy diễn `publishPaused=true`. Xác nhận publishPaused và policy state thực tế trên App Health. Chỉ owner được ủy quyền mới dùng control hiện có sau khi tất cả điều kiện PASS: release identities match; serving projection valid; không repair failure; Worker pickup/current SLO acceptable; Guardian permit current; product evidence/review complete; dry-run ready; không policy blocker; public monitor ready.

Stop/rollback criteria: monitor fail, wrong product/price/link/image, duplicate publication, Guardian breach, lease/release mismatch, queue stuck, error/5xx mới hoặc resource pressure. Chỉ dùng immutable-artifact guard hiện có scripts/guarded-production-rollback.sh sau owner approval; nó giữ data directory. Không tự set ACTIVE bằng command environment.

Chỉ khi incident owner phê duyệt rollback release/process/health (không rollback chỉ vì pipeline còn recovering), xác định trước một thư mục immutable đã verified và tương thích schema. Từ Bash tại repository hiện tại, chạy từng dòng:

~~~bash
cd /var/www/sandeal-git
export SANDEAL_ROLLBACK_RELEASE_DIR='/var/www/releases/<verified-release-directory>'
bash scripts/guarded-production-rollback.sh
~~~

Thay đúng `<verified-release-directory>` bằng artifact đã phê duyệt, không dùng thư mục current. Khi script hỏi, dán full SHA trong `.sandeal-build-manifest.json` của artifact rollback, không dán chữ SHA. Guard giữ active data directory, kiểm identity/lease/local-public health/log rồi mới `pm2 save`; dừng ngay nếu guard reject. Không dùng git reset, checkout cưỡng bức, xóa lease hoặc data restore làm “rollback”.

## Phase 18 — PM2 save cuối cùng

Vì Phase 6 đã dùng SANDEAL_DEPLOY_DEFER_PM2_SAVE=true, đây là lần lưu PM2 đầu tiên cho release. Chỉ chạy sau khi mọi kiểm tra Phase 7–17 đã hoàn tất, release identity/leases/local-public health đúng, không có error mới và resource ổn định:

~~~bash
pm2 save
~~~

Nếu một phase sau chưa đạt, không chạy command này. Saved PM2 state cũ được giữ nguyên; escalate incident thay vì tự restart hoặc bỏ qua guard.

## Ma trận acceptance production

Không đánh PASS nếu chưa có command/API/browser evidence. Dùng PARTIAL khi evidence thiếu/stale và ghi lý do.

| Khu vực | Evidence đã kiểm | Kỳ vọng | Thực tế | PASS/FAIL/PARTIAL | Lý do blocking |
| --- | --- | --- | --- | --- | --- |
| Git release | git SHA/origin | target match | Chưa kiểm | Chưa đánh giá | |
| Build identity | guarded verifier | 5 IDs = HEAD | Chưa kiểm | Chưa đánh giá | |
| PM2 processes | status/PID/uptime | 3 online/stable | Chưa kiểm | Chưa đánh giá | |
| Worker lease | runtime/PID | ACTIVE/fresh/SHA | Chưa kiểm | Chưa đánh giá | |
| Scheduler lease | runtime/PID | ACTIVE/fresh/SHA | Chưa kiểm | Chưa đánh giá | |
| Live health local | curl | HTTP 200/no mismatch | Chưa kiểm | Chưa đánh giá | |
| Live health public | curl | HTTP 200/no mismatch | Chưa kiểm | Chưa đánh giá | |
| App Health API | authenticated dashboard request | bounded/no 500 | Chưa kiểm | Chưa đánh giá | |
| App Health page | browser | accurate/usable | Chưa kiểm | Chưa đánh giá | |
| Projection serving | manifest panel | valid | Chưa kiểm | Chưa đánh giá | |
| Projection repair | maintenance panel | bounded/dedup | Chưa kiểm | Chưa đánh giá | |
| Worker pickup | priority metrics | SLO/evidence sufficient | Chưa kiểm | Chưa đánh giá | |
| Queue | Jobs/App Health | no stuck/duplicate | Chưa kiểm | Chưa đánh giá | |
| Product ingestion | diagnostics | source truth | Chưa kiểm | Chưa đánh giá | |
| Product recheck | diagnostics | bounded/idempotent | Chưa kiểm | Chưa đánh giá | |
| AccessTrade | readiness panel | truthful probe state | Chưa kiểm | Chưa đánh giá | |
| AI policy | provider panel | separate policy block | Chưa kiểm | Chưa đánh giá | |
| Publication readiness | dry-run | current truth | Chưa kiểm | Chưa đánh giá | |
| Runtime Guardian | reasons/permit | no false recovery | Chưa kiểm | Chưa đánh giá | |
| Public product pages | browser | valid routes | Chưa kiểm | Chưa đánh giá | |
| Affiliate redirects | Network | correct/no loop | Chưa kiểm | Chưa đánh giá | |
| Images | browser/Network | no broken public image | Chưa kiểm | Chưa đánh giá | |
| Browser network | DevTools | no blocking errors | Chưa kiểm | Chưa đánh giá | |
| New production errors | timestamp logs | none critical | Chưa kiểm | Chưa đánh giá | |
| Memory/load/swap | free/uptime/PM2 | stable headroom | Chưa kiểm | Chưa đánh giá | |

## Phân loại production cuối cùng

Chọn đúng một:

1. HEALTHY_PUBLICATION_ACTIVE — platform/automation khỏe, ít nhất một product hợp lệ public và public monitor PASS.
2. HEALTHY_NO_ELIGIBLE_PRODUCTS — platform/automation khỏe, chưa có product eligible.
3. PLATFORM_HEALTHY_PIPELINE_RECOVERING — web/runtime khỏe, projection/product recovery đang chạy.
4. PLATFORM_HEALTHY_RUNTIME_BLOCKED — platform kỹ thuật khỏe, Guardian/SLO chặn publication hợp lệ.
5. PARTIAL_SERVICE — chức năng quan trọng thiếu/stale/partial evidence.
6. DEPLOYMENT_FAILED — release/process/lease/health/verification fail.

Không chọn HEALTHY chỉ vì homepage mở hoặc PM2 online.
