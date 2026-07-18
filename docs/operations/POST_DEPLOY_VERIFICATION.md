# Post-deploy verification

Tài liệu này chỉ dùng sau một deployment đã được owner phê duyệt. Phiên build Prompt 10 không deploy, không đổi production settings và không bật publish.

## Điều kiện bắt đầu

- Xác nhận đúng release commit/artifact, host được phê duyệt và maintenance window.
- Backup trước deploy đã có manifest, checksum, kích thước lớn hơn 0 và restore thử vào thư mục rỗng thành công.
- Worker và scheduler chỉ có một owner lease; mode ban đầu là `SHADOW`, `publishPaused=true`, `launchEnabled=false`.
- Không đưa credential lên command line. Nếu audit cần Basic Auth, chỉ đặt `SANDEAL_AUDIT_AUTH_USER` và `SANDEAL_AUDIT_AUTH_PASSWORD` trong môi trường của terminal được kiểm soát.

## Audit read-only

Chạy từ release workspace:

```powershell
$env:SANDEAL_AUDIT_AUTH_USER='<approved-user>'
$env:SANDEAL_AUDIT_AUTH_PASSWORD='<approved-password>'
npm.cmd run verify:production:readonly -- --base-url=https://approved-host
```

Audit chỉ dùng `GET`, redirect ở chế độ manual, không tạo job và không đổi settings. Báo cáo nằm trong `.test-tmp/production-readonly-audit/`, được phân loại `PASS`, `WARNING` hoặc `CRITICAL`. Không gửi báo cáo ra ngoài trước khi kiểm tra nội dung nhạy cảm. `CRITICAL` dừng rollout và kích hoạt quy trình recovery.

## Browser checklist

Browser automation trong repository: **NOT AVAILABLE**. `package.json` không có Playwright, Puppeteer hoặc Cypress và Prompt 10 không cài dependency. Thực hiện checklist thủ công bằng DevTools ở các viewport `1366x768`, `1440x900`, `360x800`, `390x844`, `540x960`.

Tại mỗi viewport, kiểm tra:

- `/`, `/deals`, một product detail thật, `/compare`;
- `/dashboard`, `/dashboard/products`, `/dashboard/ai-bots`, `/dashboard/automation`, `/dashboard/alerts`, `/dashboard/product-sources`;
- loading, empty, error và degraded state không làm vỡ layout;
- không overflow ngang, text/encoding tiếng Việt đúng, ảnh lỗi có fallback, không hiển thị giá thiếu hoặc giá stale như giá hiện hành;
- keyboard navigation, focus visible, thứ tự tab và modal confirmation hoạt động;
- affiliate disclosure, Trust Panel, source/price freshness và outbound redirect rõ ràng;
- card “Vì sao website chưa có sản phẩm?” phản ánh blocker thật;
- card “Kho sản phẩm sẵn sàng ra mắt” phân biệt target với số đo thật;
- source hiển thị configured/ready đúng sự thật; scheduler online/active chỉ khi heartbeat và role lease còn fresh.

Trong Console, không chấp nhận uncaught exception, hydration mismatch, request loop hoặc secret/token. Trong Network, lọc `4xx`, `5xx`, `pending`, kiểm tra request lặp, payload nội bộ, cache sai và redirect affiliate. Với redirect, dùng Preserve log và xác minh một lần chuyển hướng đúng merchant; không copy query nhạy cảm vào ticket.

## Pipeline và runtime

1. So sánh public product count trước/sau deploy; deploy SHADOW không được làm count tăng.
2. Xác minh health, automation health, onboarding, jobs và dashboard đều trả trạng thái nhất quán.
3. Xác minh scheduler role được acquire đúng một lần; instance trùng phải bị reject.
4. Xác minh worker heartbeat fresh, không có queue stuck, malformed schema chuyển `BLOCKED`, stale lease được fenced.
5. Xác minh source probe phân biệt not configured, invalid credential, rate limit, circuit open, timeout và no results; không log credential/header.
6. Xác minh source scan tạo candidate durable; worker tạo canonical hidden; evidence/dedupe/health chạy trước launch-ready.
7. Xác minh SHADOW chặn publish và `publicProductCount` không tăng.

## Controlled publish waves

- WAVE 0: chỉ SHADOW, tích lũy launch-ready pool.
- WAVE 1: owner xác nhận, backup verified, tối đa 10 sản phẩm.
- WAVE 2: sau observation window và health pass, tối đa 25 sản phẩm bổ sung (cumulative 35).
- WAVE 3: sau observation window và health pass, tối đa 50 sản phẩm bổ sung (cumulative 85).

Trước mỗi wave phải có `CANARY` hoặc `AUTONOMOUS`, `publishPaused=false`, `launchEnabled=true`, kill switch tắt, worker/scheduler fresh, public route healthy, health pass rate tối thiểu 95%, error rate tối đa 5%, rollback rate tối đa 2%, không duplicate/unsafe side effect và owner confirmation server-side. Không sửa immutable safety fields từ frontend.

Sau mỗi wave, quan sát tối thiểu 30 phút kể từ publish cuối: kiểm tra public route, product detail, redirect, ảnh, giá, product count, duplicate, audit và monitor jobs. Public 5xx, wrong data, link/image failure tăng, queue stuck, role stale, source degraded hoặc health breach phải auto-pause. Tiếp tục chỉ sau health recovery và owner re-approval.

## Bằng chứng bàn giao

Lưu release commit, thời gian, audit report, viewport/screenshots, Console/Network export đã redaction, counts trước/sau, wave approval/audit ID, backup manifest và mọi blocker. Không dùng fixture count của smoke để kết luận production có sản phẩm.
