# PROMPT #06 - Báo cáo hệ thống tự động hóa

## 1. Giao diện và điều hướng

- Dashboard mặc định dùng theme sáng, surface trắng, border nhẹ và font hệ thống.
- Sidebar được nhóm theo: Tổng quan, Vận hành, Dữ liệu và nội dung, Bảo mật và hệ thống, Công cụ cũ.
- Trung tâm điều khiển cũ được thay bằng trang `Tác vụ và tiến độ` đọc hàng chờ thật.
- Đã bỏ card chồng, banner tối, badge ON/OFF hard-code và một trong hai hàng chọn nguồn bị lặp.
- Trang Sức khỏe hệ thống đọc một contract `/api/automation/health`; không còn tự gán Safe Mode ON/OFF.
- Route công cụ cũ chưa có backend hiển thị `Tạm thời chưa khả dụng`, không giả lập thành công.
- Bảng tổng quan có KPI, biểu đồ SVG, fallback dạng bảng, hiệu suất nguồn, queue, worker, AI usage và lịch sử từ backend.
- Browser runtime không có backend khả dụng nên chưa thể xác minh hình ảnh tại 375/768/1440. CSS responsive đã build và lint; web local được giữ để kiểm tra thủ công.

## 2. Queue và state machine

- Storage: JSON trong `SANDEAL_DATA_DIR`, temp file + rename, lock file cross-process trên một host, backup `.bak` và fallback khi file chính hỏng.
- Trạng thái: PENDING, WAITING_APPROVAL, RUNNING, RETRY_SCHEDULED, SUCCEEDED, FAILED, CANCELLED, BLOCKED, PAUSED.
- Claim dùng lease, heartbeat và worker id; lease hết hạn chuyển retry/failed theo số lần đã chạy.
- Idempotency được kiểm tra trong transaction theo `type + idempotencyKey`.
- Payload giới hạn 16 KB, sanitize đệ quy; DTO browser không trả payload.
- Giới hạn: phù hợp single-host/shared filesystem. Chưa có distributed lock, không tuyên bố multi-instance safe.

## 3. Worker, scheduler và an toàn

- `npm run worker`: process độc lập, claim batch nhỏ, heartbeat, lease, retry exponential backoff và dừng sạch.
- `npm run scheduler`: process độc lập, timezone `Asia/Ho_Chi_Minh`, heartbeat, pause/resume, next run và idempotency theo time bucket.
- Scheduler tạo AUTO_PILOT rủi ro cao ở trạng thái chờ phê duyệt; không tự thực thi side effect.
- Dry-run tính preview từ product storage thật, không ghi business data và không gọi dịch vụ ngoài.
- Circuit breaker có CLOSED/OPEN/HALF_OPEN. AI budget có request/token limit và block counter.
- Free-only và allow-paid-AI là policy bất biến. AI handler chưa nối thì trả unavailable, không trừ usage giả.
- Kill switch chặn claim, scheduler, AI và publish; website public không bị dừng.
- Audit lưu operation/job/actor/transition/risk/reason, sanitize secret đệ quy.

## 4. API quản trị

- `/api/automation/jobs`, `/api/automation/jobs/[id]`, action cancel/retry/approve/reject.
- `/api/automation/control`, `/api/automation/dashboard`, `/api/automation/health`, `/api/automation/audit`.
- Authentication dùng Basic Auth admin convention hiện có; repo chưa có mô hình nhiều role để phân biệt admin và operator.
- Query validate status/type/page/pageSize; page size tối đa 50; lỗi có cấu trúc và không trả stack trace.

## 5. Validation

- Targeted dashboard: `npm run test:dashboard` - 10 passed.
- Targeted automation: `npm run test:automation` - 20 passed.
- Typecheck: `npx tsc --noEmit --pretty false` - exit 0.
- Lint scoped: exit 0, 3 warning cũ (hai `img`, một import không dùng ở trang chi tiết), không có error.
- Full test: `npm test` - 117 passed, 0 failed.
- Build: `npm run build` - exit 0, Next.js 16.2.10.
- HTTP smoke: 9 dashboard pages 200; dashboard/jobs/health/audit/config 200; anonymous 401; invalid filter 400; invalid source URL 400.
- Idempotency smoke: CREATED sau đó IN_PROGRESS cùng job id.
- Restart recovery: worker đầu thoát; task mới vẫn nằm trên đĩa; worker mới claim và SUCCEEDED, operationId giữ nguyên.
- Scheduler smoke: paused -> scheduled -> not_due; task tạo ra WAITING_APPROVAL.
- Approval/cancel/kill smoke: WAITING_APPROVAL -> PENDING -> CANCELLED; kill switch làm worker claim 0.
- Browser verification: unavailable (`agent.browsers.list()` trả danh sách rỗng), không đánh dấu browser pass.

## 6. Lệnh vận hành local

```text
npm run start -- -p 3107
npm run worker
npm run scheduler
npm run test:automation
GET /api/automation/health
```

## 7. Migration, external access và deploy

- Migration: không có.
- Production side effect: không có; smoke dùng data dir tạm và dry-run.
- Deploy/VPS: không truy cập.
- Gemini, AccessTrade và public URL chưa cấu hình trong smoke; UI hiện trạng thái cần kết nối, không crash.
- Trước deploy cần thay file lock bằng distributed/database transaction nếu chạy nhiều host, cấu hình secret thật và chạy browser acceptance test.

## 8. File chính

- Automation: `src/lib/automation/*`, `src/app/api/automation/*`, worker và scheduler scripts.
- UI: dashboard/layout, ai-bots, queue, automation, app-health, settings, product-sources, token-vault, products và CSS module.
- Test: `scripts/prompt06-automation-tests.cjs` và bộ test PROMPT #05B.
- Tài liệu: file này. Không có migration hoặc artifact smoke trong repository.
