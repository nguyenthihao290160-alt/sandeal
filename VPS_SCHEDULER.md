# Hướng dẫn thiết lập VPS Scheduler cho SanDeal AutoPilot

Tài liệu này hướng dẫn cách cấu hình `systemd` trên VPS để tự động gọi webhook (API Tick) của hệ thống AutoPilot định kỳ.

Hệ thống sử dụng cơ chế bảo mật bằng Header `x-sandeal-scheduler-secret`. Cơ chế này độc lập với frontend, giúp tiến trình chạy ngầm cực kỳ ổn định, không lo timeout từ Cloudflare hoặc trình duyệt.

## 1. Chuẩn bị

Xác định URL của hệ thống (ví dụ: `http://localhost:3000` hoặc domain của bạn). 
Mặc định script dưới gọi vào: `http://localhost:3000/api/ai-bots/scheduler/tick`

Xác định Secret key (mặc định: `sandeal-vps-scheduler-secret-2024`).

## 2. Tạo Service file

Tạo file `/etc/systemd/system/sandeal-tick.service`:

```ini
[Unit]
Description=SanDeal AutoPilot Tick Service
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/bin/curl -s -X POST http://localhost:3000/api/ai-bots/scheduler/tick -H "x-sandeal-scheduler-secret: sandeal-vps-scheduler-secret-2024"
```

## 3. Tạo Timer file

Tạo file `/etc/systemd/system/sandeal-tick.timer` để gọi service mỗi 15 phút:

```ini
[Unit]
Description=Run SanDeal AutoPilot Tick Every 15 Minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
Unit=sandeal-tick.service

[Install]
WantedBy=timers.target
```

## 4. Kích hoạt Timer

Chạy các lệnh sau để nạp lại systemd và kích hoạt timer:

```bash
sudo systemctl daemon-reload
sudo systemctl enable sandeal-tick.timer
sudo systemctl start sandeal-tick.timer
```

## 5. Kiểm tra

- Xem trạng thái Timer:
  ```bash
  sudo systemctl status sandeal-tick.timer
  ```

- Xem log chạy:
  ```bash
  sudo journalctl -u sandeal-tick.service -f
  ```

**Lưu ý**: Tick API sẽ tự động kiểm tra thời gian (chu kỳ 3h, 6h, 12h) và daily limit trước khi quyết định có chạy workflow thực sự hay không. Vì vậy, gọi Tick mỗi 15 phút là rất an toàn.
