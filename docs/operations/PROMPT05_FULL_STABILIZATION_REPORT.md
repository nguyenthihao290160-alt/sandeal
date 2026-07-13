# PROMPT #05 — Full Stabilization Report

Ngày kiểm tra: 2026-07-13 (Asia/Saigon)
Repository: `C:\duan\sandeal`
Branch/HEAD: `master` / `1ef09d915832177e0227ff4c4556697d05c81f4b`
Kết luận: **NEEDS_EXTERNAL_ACCESS**

## 1. Kiến trúc và lệnh chuẩn

- Next.js 16.2.10 App Router, React 19.2.4, TypeScript 5.9.3.
- Package manager: npm, lockfile `package-lock.json`; Node thực tế: 24.13.
- Storage: JSON file atomic trong `SANDEAL_DATA_DIR` hoặc `.data`; không có database/migration.
- Development: `npm run dev`.
- Build/start production-like: `npm run build`, sau đó `npm run start`.
- Test: `npm test`; test ổn định bổ sung: `npm run test:stabilization`.
- Typecheck: `npm exec tsc -- --noEmit --incremental false`.
- Lint: `npm run lint`.
- External services: AccessTrade và Gemini/Token Vault.
- `.env.example` đã bổ sung tên biến `SCHEDULER_SECRET`; không thêm giá trị bí mật.

`npm ls --depth=0` exit 0. Dependency đã có sẵn nên không chạy lại `npm ci`; có một package extraneous `@emnapi/runtime@1.11.2`, không ảnh hưởng build/test và không được tự ý xóa.

## 2. Core journeys đã kiểm tra

- Public: `/`, `/deals`, `/review-methodology`, 404 và public Product selector.
- Authentication: dashboard/API anonymous bị 401; authenticated local fixture được 200; cấu hình auth rỗng fail closed.
- Product/data: input lỗi 400, create hợp lệ 201, dữ liệu mới luôn `needs_review`/hidden, duplicate 409, list nội bộ cần auth, empty public list không crash.
- Operations: Safe Publish không thể bị bypass qua POST/PATCH; scheduler secret vẫn bắt buộc; scheduler dry-run không ghi dữ liệu; Token Vault handler tự kiểm tra auth.
- Provider: thiếu Gemini credential trả `local_only`, không gọi network và không làm crash website.

## 3. P0/P1 đã sửa

- P0: anonymous `GET /api/products` và `GET /api/products/[id]` từng lộ canonical/internal Product. Proxy giờ chỉ miễn auth cho đúng `GET /api/products?public=true`; route handlers cũng kiểm tra auth.
- P0: Basic Auth từng có thể chấp nhận `Basic Og==` khi bật auth nhưng thiếu username/password. Validation mới fail closed và so sánh constant-time.
- P0: Product POST/PATCH từng có thể yêu cầu trạng thái public trực tiếp. Create luôn vào review; PATCH public fields trả `SAFE_PUBLISH_REQUIRED` 409.
- P1: malformed JSON và URL/giá/platform/kind/source/risk không hợp lệ được trả 400 thay vì 500/ghi dữ liệu sai.
- P1: duplicate Product theo original/affiliate URL bị trả 409; slug được cấp duy nhất dưới write lock.
- P1: server error không trả raw exception cho client; log được sanitize.
- P1: build phụ thuộc tải Google Inter bị lỗi mạng. Bỏ loader build-time trùng lặp trong layout, giữ CSS `Inter` và system fallback hiện có; final build chạy offline thành công.

## 4. Safety guardrails

- `operationGuard` chuẩn hóa LOW/MEDIUM/HIGH/BLOCKER, approval, dry-run, environment và idempotency.
- BLOCKER không override; HIGH side effect thiếu approval hoặc environment unknown bị chặn.
- Scheduler và publication gọi guard trước side effect.
- Scheduler `?dryRun=true` trả `DRY_RUN` mà không gọi tick.
- Publication dùng fingerprint theo source/review/health/risk/gate state; gate đổi thì cho phép retry, state không đổi thì không lặp.
- Idempotency registry của guard chỉ process-local và được ghi rõ như vậy. Scheduler vẫn dùng file run lock hiện có để chống overlap trên một host; chưa tuyên bố multi-instance safe.
- Publication audit append qua collection transaction; rollback giữ canonical state trước publication.
- Sanitizer che authorization, API key, token, password, secret, cookie, private key và credential trong object/error text.
- Retry hiện có được giữ nguyên: auth/validation không retry; AccessTrade 429 không retry và hai timeout kết thúc scan; Gemini giới hạn tối đa ba quota group, invalid input không failover.

## 5. Test đã thêm

`scripts/stabilization-tests.cjs` có 15 integration/guard tests cho:

- auth fail closed và password có dấu `:`;
- exact public Product route;
- HIGH/BLOCKER, dry-run, idempotency IN_PROGRESS/ALREADY_PROCESSED;
- publication fingerprint thay đổi khi health gate hồi phục;
- secret sanitization;
- Product auth/input/create/duplicate/Safe Publish bypass/empty data;
- Token Vault defense-in-depth auth;
- scheduler dry-run không ghi;
- Gemini missing credential local fallback;
- generic server error không lộ raw error.

Full suite hiện có tiếp tục bảo vệ retry, auth error không retry, health, transaction/corrupt JSON, Safe Publish, scheduler lock, Gemini quota routing, JSON-LD và sitemap.

## 6. Validation

- Targeted cuối: `npm run test:stabilization` — exit 0, **15 passed / 0 failed**.
- Typecheck cuối: exit 0, không error.
- Lint chính: exit 0, **0 error / 28 warning**; warning đều ở code cũ, không có warning trong file sửa. Targeted lint file sửa: exit 0.
- Full test chính: `npm test` — exit 0, **87 passed / 0 failed / 0 skipped**.
- Build đầu tiên fail do không tải được `fonts.googleapis.com`; quyền mạng retry không được cấp. Sau khi bỏ loader trùng, final `npm run build` — exit 0, 24 static/dynamic page entries được tạo.

## 7. Production-like smoke cuối

Tất cả dùng port local, data directory cô lập trong `.next`, credential giả chỉ tồn tại trong process test; server đã tắt và fixture đã xóa.

| Method | Path | Expected | Actual |
|---|---|---:|---:|
| GET | `/api/app-health` | 200 | 200 |
| GET | `/` | 200 | 200 |
| GET | `/deals` | 200 | 200 |
| GET | `/missing` | 404 | 404 |
| GET | `/dashboard` anonymous | 401 | 401 |
| GET | `/api/token-vault/list` anonymous | 401 | 401 |
| POST | `/api/products` invalid | 400 | 400 |
| POST | `/api/products` valid/authenticated | 201 | 201 |
| GET | `/api/products` anonymous | 401 | 401 |
| GET | `/api/products?public=true` | 200 | 200 |
| POST | `/api/ai-bots/scheduler/tick?dryRun=true` | 200 | 200 |

Product fixture không xuất hiện trong public selector; create bị ép về safe state. Log không có 5xx, unhandled hoặc uncaught exception. Một smoke rộng hơn trước đó cũng pass `/review-methodology`, dashboard authenticated, Token Vault authenticated, PATCH publish bypass 409 và scheduler thiếu secret 401.

## 8. Migration và external access

- Không tạo hoặc chạy migration; không có database server trong kiến trúc hiện tại.
- Success path thực của AccessTrade chưa thể xác minh nếu không có `ACCESS_TRADE_API_KEY` hợp lệ.
- Success path Gemini chưa thể xác minh nếu không có credential mã hóa trong Token Vault được quản trị xác nhận Free, model allowlist hợp lệ và quota group khả dụng. Fallback `LOCAL_ONLY` đã được kiểm tra.
- Release environment cần giá trị thực cho `BASIC_AUTH_USERNAME` (hoặc alias `BASIC_AUTH_USER`), `BASIC_AUTH_PASSWORD`, `SCHEDULER_SECRET` và `TOKEN_VAULT_SECRET_KEY`; không giá trị nào được đọc hoặc ghi trong tác vụ.
- Browser backend của phiên kiểm tra không khả dụng, nên chưa xác minh trực quan mobile/tablet/desktop. HTTP render và route smoke đã pass nhưng visual responsive cần người kiểm tra bổ sung.

## 9. Rủi ro còn lại

- Idempotency guard dùng memory và scheduler file lock phù hợp single-host, chưa đủ cho nhiều instance dùng shared storage.
- 28 lint warnings cũ chưa sửa vì không cản trở chức năng.
- CSS vẫn có `@import` Inter ở runtime; khi Google Fonts không truy cập được, system fallback hoạt động và không làm build/runtime crash.
- Cần test thật provider success paths và visual responsive trước release production.

## 10. File thay đổi

- Source/config: `.env.example`, `package.json`, `src/proxy.ts`, `src/app/layout.tsx`, Product API/storage/pipeline, scheduler route, toàn bộ Token Vault routes, auth/API response helpers, `src/lib/basicAuth.ts`, `src/lib/safety/operationGuard.ts`.
- Test: `scripts/stabilization-tests.cjs`, `scripts/test-runner.cjs`.
- Documentation: file này.
- `.env.example` được đưa vào mốc lưu như config mẫu an toàn. `.gitignore` có thay đổi trộn từ tác vụ trước nên được giữ ngoài commit PROMPT #05; `docs/operations/PROMPT03_RECOVERY_REPORT.md` cũng được giữ riêng.

Secret scan trên các file thay đổi: 0 known credential/private-key pattern; không có `.env`, dump, database, log hoặc backup trong Git status. Không truy cập production, không deploy, không commit, không push và không tạo production side effect.

## 11. Kết luận

**NEEDS_EXTERNAL_ACCESS**

Source local đã ổn định: targeted/full tests, typecheck, lint, build và production-like smoke đều pass. Chưa thể gọi `READY_FOR_RELEASE_PREP` cho đến khi một người có quyền cung cấp môi trường release hợp lệ để kiểm tra AccessTrade/Gemini success paths, các secret vận hành bắt buộc và visual responsive trên browser thật.
