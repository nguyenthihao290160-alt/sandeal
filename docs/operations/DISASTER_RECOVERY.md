# Disaster recovery

Mục tiêu là phục hồi có kiểm soát mà không ghi đè `.data` production, không tạo side effect trùng và không che mất bằng chứng sự cố.

## Chuẩn bị bắt buộc

- Tạo backup trước deploy, migration, CANARY hoặc AUTONOMOUS.
- Manifest phải liệt kê file, checksum, thời điểm, schema và source state hash; mọi artifact có kích thước lớn hơn 0.
- Verify checksum và restore round-trip vào **thư mục rỗng riêng**, không restore trực tiếp đè production.
- Ghi release artifact/commit, job schema version, handler/policy version và backup ID.
- Giữ nguyên `.data`; snapshot/di chuyển chỉ theo runbook đã phê duyệt. Không xóa để “làm sạch”.

## Emergency Stop

1. Bật Emergency Stop/kill switch qua control path được xác thực và ghi lý do.
2. Dừng scheduler trước để chặn enqueue mới, sau đó dừng worker để không cắt giữa durable write.
3. Không `pm2 save`, không xóa queue, lease, journal hoặc `.data`.
4. Thu thập health, role leases/conflicts, queue counts, last jobs, operation journals, publication audit và runtime reasons; redaction credential/header.
5. Nếu có secret exposure, thu hồi/rotate secret ngoài ứng dụng theo authority riêng; không in giá trị cũ vào ticket.

## Artifact rollback và fencing

1. Xác minh rollback artifact là build đã biết tốt và tương thích data/job schema hiện tại.
2. Nếu job schema/handler không tương thích, giữ worker dừng; không cho binary cũ claim job mới.
3. Rollback application artifact, không rollback data mù quáng.
4. Invalidate/fence lease cũ bằng cơ chế role ownership hiện có; instance restart phải nhận fencing token mới.
5. Khởi động web ở read-only/SHADOW trước; audit public và internal GET.
6. Chỉ khởi động worker sau khi schema compatibility và operation journal được xác minh.
7. Khởi động scheduler cuối cùng; duplicate process phải bị role rejection.

## Restore dữ liệu

1. Giữ production `.data` bất biến và tạo một thư mục restore rỗng.
2. Restore backup vào thư mục rỗng, verify lại checksum và số file.
3. Chạy validation/read-only tooling trỏ vào bản restore nếu runbook/tool hỗ trợ; không dùng production port.
4. So sánh canonical products, candidates, jobs, journals, audits và schema version.
5. Chỉ thực hiện cutover dữ liệu sau phê duyệt riêng, maintenance window và kế hoạch quay lại rõ ràng.

## Kịch bản xử lý

| Sự cố | Hành động an toàn ban đầu | Điều kiện phục hồi |
|---|---|---|
| Corrupt JSON | Emergency Stop; giữ file gốc; verify backup và restore vào thư mục rỗng | Parser/schema/counts hợp lệ trên restore |
| Disk full | Dừng scheduler rồi worker; giữ `.data`; giải phóng dung lượng theo quy trình hạ tầng | Có headroom, atomic write test và checksum pass |
| Stale lease | Không chạy process thứ hai mù quáng; kiểm tra expiry/fencing | Takeover tạo fencing token mới, owner cũ bị reject |
| Duplicate process | Giữ instance có lease hợp lệ, dừng instance bị reject | Chỉ một scheduler và một worker active |
| Public 5xx | Auto-pause publish, Emergency Stop nếu lan rộng; giữ bằng chứng route | Route audit pass và error budget phục hồi |
| Wrong product/price/link/image | Pause wave; hide/rollback bằng durable guarded path, không sửa trực tiếp hàng loạt | Canonical/evidence/price truth được xác minh lại |
| Duplicate publication | Pause, kiểm tra operation journal/idempotency/audit | Không có duplicate side effect và reconciler ổn định |
| Queue stuck | Dừng enqueue; kiểm tra heartbeat, lease, retry/deadline và malformed schema | Claim/resume idempotent, không mất job |
| Source degraded/rate limited | Dừng scan nguồn đó, tôn trọng Retry-After/circuit/budget; dùng approved datafeed | Source ready hoặc datafeed owner-approved |
| Secret exposure | Emergency Stop nếu có rủi ro publish; rotate/revoke qua hệ thống sở hữu secret | Secret mới hoạt động, log/report đã redaction |

## Kiểm tra sau phục hồi

- Chạy read-only audit; không có 5xx hoặc secret/internal leakage.
- Xác minh public count, product identity, duplicate count và publication audit trước/sau.
- Xác minh malformed job `BLOCKED`, stale processing resume idempotent, journal không inconsistent.
- Xác minh worker/scheduler heartbeat và role ownership; scheduler khởi động sau worker.
- Giữ SHADOW, `publishPaused=true`, `launchEnabled=false` cho đến khi owner phê duyệt lại.
- Nếu quay lại controlled wave, bắt đầu lại từ WAVE 0 hoặc re-approve current paused wave sau backup, health evidence và observation window.

Mọi quyết định, actor, thời điểm, backup/checksum, artifact và số liệu phải được ghi vào incident record. Không coi fixture/smoke count là số liệu production.
