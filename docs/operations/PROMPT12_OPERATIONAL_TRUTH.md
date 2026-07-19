# Prompt 12 — Operational truth and safe remediation

Tài liệu này mô tả semantics của code local tại Prompt 12. Đây không phải bằng chứng runtime production và Prompt 12 không deploy.

## Automation truth

Nguồn đọc thống nhất là `getAutomationTruth()`. Read model kết hợp cấu hình schedule, runtime role leases, heartbeat, fencing token, automation job store, queue và usage record. Dashboard chính và API admin không được suy diễn ACTIVE chỉ từ việc schedule được bật hoặc process tồn tại.

Scheduler chỉ là `ACTIVE` khi đồng thời có đúng một lease active chưa hết hạn, heartbeat mới, owner hiện tại, fencing token dương, tick gần đây hoặc `nextRunAt` hợp lệ, không có owner conflict mới và schedule không bị pause. Worker chỉ active khi lease/heartbeat còn mới. Mâu thuẫn được trả về dưới dạng code và evidence đã giới hạn, không chứa payload hoặc stack đầy đủ.

Mốc ngày, usage, activity bucket và hiển thị lịch dùng IANA timezone `Asia/Ho_Chi_Minh`. Không dựa vào timezone máy chủ và không cộng bảy giờ rải rác trong read model.

## Root-cause incidents

Alert occurrence được nhóm bằng root-cause key deterministic gồm category, reason code, provider/source và normalized failure class. Incident chỉ lưu ID thực thể bounded, không copy entity. Các status `NEW`, `ACKNOWLEDGED`, `REMEDIATION_QUEUED`, `REMEDIATION_RUNNING`, `RECHECK_REQUIRED`, `RESOLVED`, `HUMAN_DECISION_REQUIRED`, `IGNORED`, `EXHAUSTED` có nghĩa độc lập.

`ACKNOWLEDGED` chỉ ghi nhận đã xem. `IGNORED` bắt buộc reason và audit. Queue remediation không resolve incident. Retry có giới hạn, cooldown tăng theo attempt và job key idempotent. Auth/permanent/provider-not-ready không được retry tự động.

Chỉ checker phía server tạo evidence. Browser không được nộp evidence. `RESOLVED` yêu cầu recheck `PASS`, checker/version/timestamp hợp lệ, reported count bằng occurrence store và không còn occurrence active. Evidence metadata được redact và giới hạn kích thước. Lỗi quay lại sẽ reopen incident.

## Product pipeline và action semantics

Product truth kết hợp classifier, lifecycle/blockers, `publicHidden`, admin action records và automation job thực tế. Job `RUNNING` có lease/heartbeat stale được hiển thị `STALE`; sự tồn tại của job không chứng minh worker đang chạy.

- `reviewed`: chỉ ghi actor/timestamp/audit rằng admin đã xem.
- `data_verified`: yêu cầu price, link, image và source evidence; không publish.
- `canary_ready`: chỉ vào danh sách xét, bị chặn nếu còn blocker critical; không bật CANARY.
- `safe_publish_requested`: tạo job đánh giá health idempotent; không approve và không publish.
- `publish_approved`: là approval record có quyền riêng; vẫn không publish khi global publishing tắt.
- `published`: cần outbound/public evidence thật; Prompt 12 không tạo trạng thái này.

## Remediation boundaries

URL/image health dùng checker có protocol, timeout, redirect/body limit và SSRF protection; test phải mock network. UI image fallback là SVG local trung tính, không được ghi lại thành ảnh nguồn. Price không được thay bằng 0 hoặc cập nhật thiếu source evidence. Stale job recovery yêu cầu ownership và fencing token hiện tại. Không takeover lease healthy.

## AccessTrade quarantine

Cleanup command mặc định dry-run, scan tối đa 500 record mỗi cursor và không gọi provider. Nó phân loại `PRODUCT`, `VOUCHER`, `STORE_OFFER`, `CAMPAIGN`, `CATEGORY_PAGE`, `UNKNOWN`, `INVALID`; non-product được quarantine, không đi vào product lifecycle. Apply chỉ được CLI cho phép khi `NODE_ENV=test`, có `SANDEAL_DATA_DIR` tạm và flag xác nhận explicit. Raw payload không bị xóa, classification cũ được giữ làm rollback metadata và audit idempotent.

## Token Vault truth

Các state browser thấy là `stored`, `valid`, `generation_ready`, `cooldown`, `quota_limited`, `invalid`, `disabled`, `missing_permission`, `unknown`. Stored/valid không đồng nghĩa generation-ready. Routing chỉ xét credential enabled, ready, không cooldown/quota, hỗ trợ model; ưu tiên số nhỏ hơn trước và ID là stable tie-breaker. Không random rotation.

Browser chỉ nhận masked identifier dạng `****abcd`, metadata whitelist và error category; không nhận encrypted value, raw key hay raw provider error. Probe là POST explicit, không chạy khi render. Paid AI vẫn bị chặn khi `ALLOW_PAID_AI` không bật.

## Storage và public safety

File adapter vẫn là mặc định. Các logical collection mới (`alert-incidents`, `alert-occurrences`, `alert-remediation-runs`, `product-admin-actions`) chỉ được khai báo trong schema plan; startup không tự tạo/apply index và Prompt 12 không migration. Mongo production chưa bật hoặc kiểm chứng trong nhiệm vụ này.

Các mặc định vẫn fail-closed: launch disabled, publishing disabled, CANARY/AUTONOMOUS disabled, paid AI disabled, product mới `publicHidden=true`, public blockers không bị bỏ qua và inventory rỗng không tạo card giả. Production cutover, provider probe thật và runtime verification cần nhiệm vụ riêng.
