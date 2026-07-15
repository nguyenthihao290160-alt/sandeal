# PROMPT #08 - Product Intelligence and Growth

Ngày kiểm tra: 2026-07-15
Branch: `wip/prompt08-20260714`
Commit WIP tiếp quản: `93f29b81f166a87c9670278c37a3dad1e49591d9`
Baseline: `origin/master` tại `e913094e523c034944650484abc6cb87d5627a06`
Deploy: không thực hiện

## Trạng thái Git

- Repository đã xác minh là `nguyenthihao290160-alt/sandeal`.
- Local branch và `origin/wip/prompt08-20260714` cùng trỏ tới commit WIP khi bắt đầu.
- Working tree sạch trước khi tiếp quản; không có merge, rebase, cherry-pick hoặc revert dang dở.
- Diff WIP ban đầu gồm 102 file, 13.331 dòng thêm và 3.533 dòng xóa so với `origin/master`.
- Working tree hiện có thay đổi có chủ đích của phiên hoàn thiện PROMPT #08; không reset, revert, discard, clean, commit, push, merge hoặc đổi branch.
- `git diff --check` đã đạt sau khi sửa. Cảnh báo chuyển LF sang CRLF là cấu hình working tree trên Windows, không phải whitespace error và không có thao tác format toàn dự án.

## Code WIP đã tiếp quản

- Public website: homepage, danh sách deal, chi tiết deal, filter, pagination, compare, DTO công khai và public API.
- Import: CSV preview/apply, formula neutralization, manual metadata staging, URL validation và SSRF guard.
- Product Intelligence: dedupe preview/review/merge gate, Quality Score, Opportunity Score, Deal Score và price history.
- Content Studio: local draft, evidence, Editorial Guard, workflow và dashboard editor.
- Growth: affiliate redirect, view/click event, aggregation, affiliate link dashboard, alerts và recommended actions.
- Dashboard: business overview, Today, Growth, Import, Quality, Price History, Alerts và navigation.
- Automation: job types PROMPT #08, worker dispatch, scheduler rotation, cancellation checkpoints, approval, audit, idempotency và kill switch.
- Năm targeted test script PROMPT #08 đã tồn tại nhưng chưa được gọi bởi `npm test` ở commit WIP.

## Phần đã sửa và hoàn thiện

- Nối `SavedViewsToolbar` vào `/dashboard/products`; bộ lọc đã lưu khớp đúng contract của trang sản phẩm và hỗ trợ lưu chế độ list/grid.
- Nối chọn từng sản phẩm, chọn toàn bộ trang và `BulkProductActions` cho cả list/grid.
- Sửa bulk dry-run: không yêu cầu xác nhận thay đổi dữ liệu, tạo durable LOW-risk job, không chờ approval và không thay đổi sản phẩm trong HTTP request.
- Bulk apply thật vẫn yêu cầu xác nhận; thao tác HIGH-risk vẫn ở `WAITING_APPROVAL`.
- Mỗi preview bulk có operation/idempotency key ổn định; retry cùng key trả lại cùng job. Fallback server dùng ID duy nhất, không dùng khóa theo phút có nguy cơ va chạm.
- Sửa whitelist Saved Views, thêm `grid` vào model và giữ một default view cho mỗi page/actor.
- Sửa lint error `react-hooks/set-state-in-effect` trong Saved Views bằng callback timer có cleanup.
- Thêm regression test cho UI wiring, Saved Views thực tế và bulk dry-run idempotent.
- Thêm `test:prompt08` và nối đủ năm suite PROMPT #08 vào full `npm test`.
- Không gọi Gemini, AccessTrade, paid AI, publishing API hoặc API bên ngoài thật trong quá trình kiểm tra.

## Safety và regression

- Public selector chỉ trả sản phẩm đã publish và đạt public safety gate; DTO không lộ URL affiliate/original, raw payload hoặc secret nội bộ.
- CSV/manual import không public trực tiếp; apply đi qua durable job và sản phẩm vẫn `needs_review`/`publicHidden`.
- Dedupe không tự merge; merge thật tạo HIGH-risk job chờ approval, preview không đổi dữ liệu.
- Content Studio không ghi đè canonical specifications; Editorial Guard và Safe Publish chặn claim/evidence không hợp lệ.
- Worker kiểm tra cancellation và kill switch trước các checkpoint ghi dữ liệu.
- Safe Mode, Free Only, approval, audit, idempotency, kill switch và dry-run đều có targeted regression test đạt.

## Kết quả kiểm tra thực tế

| Gate | Kết quả |
| --- | --- |
| Git precondition | PASS |
| Initial typecheck | PASS |
| PROMPT #08 targeted tổng hợp | PASS, 58/58 |
| Automation regression | PASS, 20/20 |
| Edited-file lint | PASS, 0 error |
| Final typecheck | PASS |
| Full lint | PASS, 0 error và 26 warning không chặn |
| Full `npm test` | PASS, 192/192 |
| Next.js production build | PASS, compile/type validation và 37 trang |
| Secret scan | PASS vòng repair, 260 file |
| Generated-file check | PASS |
| Migration check | PASS, schema 1 và không có migration |
| HTTP smoke | PASS, 17/17 route/API và health contract |
| Worker smoke | PASS, claimed 1 và succeeded 1 |
| Scheduler smoke | PASS ở trạng thái an toàn `paused`, không tạo job |
| Restart recovery | PASS, giữ nguyên job ID/operation ID rồi worker hoàn tất |
| Local preflight | WARNING, health READY nhưng thiếu cấu hình production |
| Browser verification | UNAVAILABLE, discovery trả danh sách rỗng; không tuyên bố PASS |

Targeted PROMPT #08 gồm:

- Public API/filter/pagination, DTO và public safety.
- CSV/manual import, URL safety/SSRF và dedupe.
- Quality/Opportunity/Deal Score và price history.
- Content Studio và Editorial Guard.
- Affiliate links, analytics, alerts và recommendations.
- Saved Views, bulk actions, automation job, worker, scheduler, cancellation và permission.

## Smoke thực tế

- Production server được chạy local tại `127.0.0.1:3118` trên data directory tạm rỗng ngoài repository.
- Tiến trình smoke đặt `ALLOW_PAID_AI=false`, `ALLOW_PUBLISHING_API=false`, `AUTO_PUBLISH_ENABLED=false` và bỏ provider key khỏi môi trường tiến trình.
- HTTP 200: `/`, `/deals`, `/compare`, sáu dashboard PROMPT #08, health, public products, dashboard products/quality/saved views/affiliate links và automation health.
- Validation smoke: `/api/public/products?pageSize=51` trả đúng 400.
- Health contract trả `ok=true`, `app=sandeal`, `safeMode=true` và `freeOnly=true`.
- Gửi hai lần cùng idempotency key tạo lần đầu `CREATED`, lần hai `IN_PROGRESS`, cùng một dry-run job.
- Sau khi dừng và khởi động lại web process, job vẫn có cùng ID, `operationId` và trạng thái `PENDING`.
- Worker one-shot claim đúng một job, hoàn tất `SUCCEEDED`; result có `preview=true`, `businessDataChanged=false`, `externalSideEffect=false`.
- Scheduler one-shot thoát thành công với automation và Product Intelligence scheduler cùng `paused`; không tạo side effect. Đường scheduler enabled/rotation/duplicate đã đạt targeted test.
- Local preflight là `WARNING`: thiếu public URL, production Basic Auth, vault key, provider và TZ; health, runtime commands, Free Only, publishing block và kill switch đều READY.
- Browser runtime đã được kiểm tra theo Browser plugin nhưng không có browser nào khả dụng. Không có screenshot/interaction desktop-mobile và không có browser PASS.

## Phần còn thiếu hoặc giới hạn

- Browser desktop/mobile chưa được xác minh vì runtime discovery không tìm thấy browser khả dụng.
- Saved Views UI hiện được nối vào trang sản phẩm; backend generic cho Quality, Content, Tasks và Alerts chưa được nối vào toàn bộ các page tương ứng.
- Manual import mặc định không tự fetch metadata. Nếu bổ sung adapter fetch thật sau này, cần pin kết nối vào IP đã kiểm tra để khép khoảng trống DNS rebinding/TOCTOU, đồng thời mở rộng policy cho toàn bộ special-use IP ranges.
- Import JSON nhiều dòng không phải transaction xuyên nhiều collection; source hash và durable job giúp replay an toàn ở mức hiện tại nhưng không thay thế database transaction/resumable ledger.
- Không có xác minh Gemini/AccessTrade thật; trạng thái cấu hình thiếu phải tiếp tục fail closed hoặc `CONFIGURATION_REQUIRED`.

## Giới hạn JSON storage

- Storage adapter dùng JSON file, atomic temp-write/rename, lock theo file và backup recovery.
- Thiết kế chỉ an toàn cho một application/worker instance dùng chung local filesystem.
- Không có distributed lock, distributed transaction, multi-instance coordination hoặc database isolation.
- Không được scale ngang hay chạy nhiều replica production trên cùng dữ liệu JSON.

## File thay đổi trong phiên hoàn thiện

- `package.json`
- `scripts/prompt08-product-intelligence-tests.cjs`
- `scripts/prompt08-import-dedupe-tests.cjs`
- `scripts/prompt08-content-studio-tests.cjs`
- `scripts/prompt08-growth-alerts-links-tests.cjs`
- `scripts/prompt08-backend-hardening-tests.cjs`
- `src/app/api/dashboard/bulk/route.ts`
- `src/app/dashboard/products/products-dashboard.tsx`
- `src/app/dashboard/products/products.module.css`
- `src/components/dashboard/bulk-product-actions.tsx`
- `src/components/dashboard/bulk-product-actions.module.css`
- `src/components/dashboard/saved-views-toolbar.tsx`
- `src/components/dashboard/saved-views-toolbar.module.css`
- `src/lib/product-intelligence/savedViews.ts`
- `src/lib/product-intelligence/types.ts`
- `docs/operations/PROMPT08_PRODUCT_INTELLIGENCE_GROWTH_REPORT.md`

## Runtime/generated không được commit

- `.data/`, `.next/`, `.release/`, `.backups/`, `node_modules/`, `coverage/` và `*.tsbuildinfo` phải tiếp tục được ignore.
- Kiểm tra Git ban đầu xác nhận `.data`, `.next`, `.release`, `node_modules` và `tsconfig.tsbuildinfo` không được theo dõi.
- `.env.example` chỉ là template; không được thêm `.env*`, token, credential, private key hoặc log chứa secret vào Git.

## Việc cần làm trước production

1. Xác minh browser thật ở desktop/mobile và kiểm tra Saved Views, selection, bulk preview/dry-run, public filter/compare.
2. Lặp lại HTTP/worker/scheduler/restart smoke trong staging được phê duyệt với Basic Auth bật.
3. Review toàn bộ diff 102 file cộng thay đổi hoàn thiện hiện tại; commit phải do người có thẩm quyền thực hiện.
4. Chạy strict preflight với production auth, vault key, public URL, backup location và rollback window đã được phê duyệt.
5. Thay JSON storage bằng backend có transaction/distributed coordination trước khi chạy nhiều instance.
6. Không deploy cho đến khi artifact/checksum, backup/restore, browser verification và production approval đều đạt.
