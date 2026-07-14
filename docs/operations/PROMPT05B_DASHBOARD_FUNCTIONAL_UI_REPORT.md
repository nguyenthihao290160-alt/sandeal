# PROMPT #05B - Dashboard chức năng và giao diện

## 1. Git

- Branch: `feature/prompt05b-dashboard-ui`.
- Baseline: `7239c6962d842cf3ee1f04b68395e6a024e7d1a0`.
- Working tree ban đầu sạch; không commit, push, merge, rebase, reset hoặc stage file.

## 2. Kiến trúc và dữ liệu

- `/dashboard/products` là Server Component có `Suspense`; phần tương tác nằm tại `products-dashboard.tsx`.
- `/api/dashboard/products` đọc `products` storage thật, áp dụng một contract filter duy nhất rồi tính summary và list trong cùng lần xử lý.
- Contract tại `src/lib/dashboard/products.ts` whitelist query, giới hạn `pageSize` tối đa 50, sort theo danh sách cho phép và chỉ trả DTO cần cho giao diện.
- Summary hard-code cũ trong production path đã bị loại bỏ. Tổng quan, chỉ số chi tiết, list/grid và pagination đều dùng response backend hiện tại.
- API phân biệt `EMPTY`, `CONFIGURATION_REQUIRED`, `VALIDATION_ERROR`, `NOT_FOUND` và `INTERNAL_ERROR`; không trả stack trace hoặc object sản phẩm nội bộ.

## 3. Chức năng

- Quét và kiểm tra sản phẩm: có dialog xác nhận, giới hạn 1-30, mặc định chạy thử; `/api/dashboard/scan` tính kết quả thật và bảo đảm không ghi storage.
- Chế độ tự động: khi bỏ chọn chạy thử, gọi workflow `/api/ai-bots`, nhận `runId` thật và theo dõi `/api/ai-bots/runs/[id]` tối đa 90 giây; không báo hoàn thành khi backend mới chỉ nhận tác vụ.
- Thêm nguồn sản phẩm: form thật gọi `/api/product-sources`, trim input, validate URL/field, chống URL trùng và lưu bằng JSON storage nguyên tử hiện có. Không nhận hoặc trả credential.
- Xem trang công khai: đọc `NEXT_PUBLIC_SITE_URL` qua `/api/dashboard/config`; khi thiếu hiển thị “Chưa thiết lập địa chỉ trang công khai”, không mở URL rỗng.
- Search debounce 350 ms; filter, sort, page và page size đồng bộ query string. Back/forward và reload giữ query. Response cũ bị hủy bằng `AbortController`.
- Danh sách/Dạng lưới dùng cùng `data.items`, không fetch lại khi đổi layout; lựa chọn được lưu localStorage có fallback an toàn.
- Phê duyệt, lưu trữ và xóa gọi API thật, khóa khi đang gửi, refresh dữ liệu sau thành công và không dùng optimistic update. Xóa có dialog xác nhận.
- Route lưu trữ sản phẩm và tìm kiếm AccessTrade đã bổ sung `requireAuth`; app-health dashboard cũng yêu cầu xác thực.
- Chưa có cancel/retry backend và persistent worker đầy đủ. UI không giả lập các khả năng này; contract giữ `canCancel`, `canRetry`, `requiresApproval` cho PROMPT #06.

## 4. Dịch vụ ngoài

- AccessTrade chưa cấu hình trả `sourceReady:false`; dashboard vẫn render và hiển thị “Cần thiết lập kết nối”.
- URL công khai chưa cấu hình trả `CONFIGURATION_REQUIRED`.
- Thiếu Gemini/AccessTrade không gây crash, không có retry vô hạn và không tạo credential giả.

## 5. Giao diện

- Dashboard được scope sang nền off-white, sidebar/card trắng, viền neutral, xanh dương tiết chế và shadow nhẹ; public marketplace không bị đổi theme.
- Sidebar, topbar, menu, filter, badge, dialog, toast, loading/error/empty state và thao tác chính đã Việt hóa. Chuỗi dùng lại nằm tại `src/lib/dashboard/strings.ts`.
- Bố cục gồm đầu trang, bốn chỉ số chính, dải chế độ vận hành, ba nhóm chỉ số chi tiết và khu vực filter/kết quả.
- Responsive CSS có breakpoint desktop/tablet/mobile; sidebar drawer cũ được giữ, table chỉ cuộn trong vùng chủ ý, grid về hai cột rồi một cột, modal giới hạn theo viewport.
- Input có label; lỗi field liên kết bằng `aria-describedby`; dialog có role/aria-modal, focus ban đầu và Esc; loading có `aria-busy`; nút view dùng `aria-pressed`.
- Browser backend không khả dụng trong phiên nên chưa có bằng chứng screenshot/console tại 375/768/1440. Không cài thêm framework để thay thế.

## 6. PROMPT #06

- `DashboardOperation` chuẩn hóa `operationId`, `jobId`, `status`, `progress`, `result`, `errorCode`, thời gian, quyền hủy/chạy lại và yêu cầu phê duyệt.
- `TaskStatus` hiển thị trạng thái tác vụ, tiến độ, yêu cầu phê duyệt và chi tiết kỹ thuật đã giới hạn.
- Không tạo queue memory-only và không tuyên bố job sống qua restart. Bot workflow hiện tại vẫn là integration point; persistence/worker/cancel/retry thuộc PROMPT #06.

## 7. Kiểm thử và validation

- Targeted: `npm run test:dashboard` - 10 passed, 0 failed.
- Typecheck: `npx tsc --noEmit --pretty false` - exit 0.
- Lint file sửa: exit 0, không warning/error từ code mới.
- Full test chính: `npm test` - 87 test nền + 10 test dashboard, tổng 97 passed, 0 failed.
- Production build chính: `npm run build` - exit 0; compile, TypeScript và 24 static pages thành công.
- HTTP smoke production server:
  - `/dashboard/products`: 200.
  - `/api/dashboard/products`: 200 `EMPTY`.
  - search/filter hợp lệ/xóa filter: 200.
  - filter sai: 400 `VALIDATION_ERROR`.
  - source validation: 400 `VALIDATION_ERROR`.
  - scan dry-run: 200 `completed`.
  - public URL thiếu: 200 `CONFIGURATION_REQUIRED`.
  - AccessTrade thiếu: 200, `sourceReady:false`.
  - Basic Auth server: admin API không auth 401, đúng auth 200; source/archive không auth 401.
- Hai local server trên cổng 3105 và 3106 đã được tắt sạch sau smoke test.

## 8. File thay đổi

- UI: dashboard layout, products page/client/CSS, global dashboard tokens, task status component/CSS.
- API: dashboard products/scan/config, product sources, bot run status; auth bổ sung cho app-health, AccessTrade search và archive.
- Service/storage: dashboard product/operation/string contract và product source storage.
- Test: `scripts/prompt05b-dashboard-tests.cjs`, package test scripts.
- Tài liệu: báo cáo này.

## 9. Blocker còn lại

- Không có source blocker local.
- Browser console và ảnh responsive chưa xác minh do browser backend không khả dụng.
- Persistent worker, cancel/retry thật và queue automation đầy đủ được để đúng phạm vi PROMPT #06.

Kết luận: `READY_FOR_AUTOMATION_ENGINE`.
