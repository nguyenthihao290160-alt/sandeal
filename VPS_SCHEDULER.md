# Scheduler SanDeal / ReviewPilot AI

Hệ thống chỉ dùng một endpoint server-side để điều phối cả chế độ tăng tốc và ổn định:

`POST /api/ai-bots/scheduler/tick`

Endpoint yêu cầu header `x-sandeal-scheduler-secret` khớp với biến môi trường `SCHEDULER_SECRET`. Code không có secret mặc định và không ghi secret vào log. Nếu biến môi trường chưa được cấu hình, endpoint luôn trả `401`.

## Chu kỳ gọi

VPS cron nên gọi tick mỗi 5 phút. Tick chỉ lấy persistent lock, đọc trạng thái và chạy những job đã tới hạn. Không tạo cron riêng cho scan/review/recheck.

Ví dụ crontab (thay URL và lấy secret từ secret store của VPS, không ghi secret vào repository):

```cron
*/5 * * * * curl --fail --silent --show-error --max-time 290 -X POST -H "x-sandeal-scheduler-secret: $SCHEDULER_SECRET" https://your-domain.example/api/ai-bots/scheduler/tick
```

## Lịch nội bộ

- Dưới 100 sản phẩm công khai: scan 15 phút, review queue 5 phút, recheck 12 giờ.
- Từ 100 sản phẩm công khai: scan 60 phút, review queue 15 phút, recheck 24 giờ.
- Queue, lịch, keyword rotation, quota ngày và lock đều persistent trong `.data`.
- Lock có TTL 25 phút; một tick mới không chạy chồng tick đang hoạt động.
- Run dừng theo `maxRunDurationMs`; item chưa nhận hoặc chưa tới hạn vẫn nằm trong queue cho tick sau.

## Kiểm tra local

Không cần gọi nguồn thật để kiểm tra logic:

```bash
npm run test
npm run lint
npm run build
```

Khi đã cấu hình key AccessTrade và muốn chạy đúng một lượt thủ công, dùng API `run-now` hiện có với mode `source_scan`, sau đó dùng `full_safe_run` để xử lý một batch. Không chạy vòng lặp thủ công và không đặt token trong command history.
