#!/usr/bin/env bash
# ===========================================
# SanDeal — Scheduler Cron Template
# ===========================================
#
# ĐÂY LÀ FILE MẪU (TEMPLATE).
# KHÔNG chứa mật khẩu thật.
# KHÔNG tự kích hoạt cron.
#
# Mục đích:
#   Gọi endpoint /api/ai-bots/scheduler/tick định kỳ
#   để AutoPilot chạy theo lịch đã cấu hình trong dashboard.
#
# Cách sử dụng:
#   1. Copy file này ra vị trí an toàn trên VPS:
#      cp sandeal-scheduler-cron.example.sh /root/sandeal-cron.sh
#
#   2. Sửa thông tin đăng nhập dashboard:
#      BASIC_AUTH_USER="tên_đăng_nhập_thật"
#      BASIC_AUTH_PASS="mật_khẩu_thật"
#
#   3. Cấp quyền chạy:
#      chmod +x /root/sandeal-cron.sh
#
#   4. Test thủ công:
#      bash /root/sandeal-cron.sh
#
#   5. Thêm vào crontab (chạy mỗi 60 phút):
#      crontab -e
#      0 * * * * /root/sandeal-cron.sh >> /var/log/sandeal-cron.log 2>&1
#
#   Hoặc chạy mỗi 30 phút:
#      */30 * * * * /root/sandeal-cron.sh >> /var/log/sandeal-cron.log 2>&1
#
# LƯU Ý QUAN TRỌNG:
#   - Không để chu kỳ dưới 30 phút.
#   - Scheduler phải được BẬT trong dashboard trước khi cron có tác dụng.
#   - Endpoint tự kiểm tra: scheduler tắt? → bỏ qua. Chưa đến lịch? → bỏ qua.
#   - Không sửa file .env nếu không hiểu rõ.
#   - Không log mật khẩu ra file log.
#
# ===========================================

set -euo pipefail

# ---- CẤU HÌNH (SỬA LẠI TRƯỚC KHI DÙNG) ----
APP_URL="https://sandeal.tech"
BASIC_AUTH_USER="YOUR_DASHBOARD_USER"
BASIC_AUTH_PASS="YOUR_DASHBOARD_PASSWORD"

# ---- GỌI SCHEDULER TICK ----
echo "[$(date -Iseconds)] SanDeal scheduler tick..."

RESPONSE=$(curl -fsS \
  --max-time 120 \
  -X POST \
  -u "${BASIC_AUTH_USER}:${BASIC_AUTH_PASS}" \
  "${APP_URL}/api/ai-bots/scheduler/tick" \
  2>&1) || {
  echo "[$(date -Iseconds)] ERROR: Scheduler tick thất bại."
  echo "${RESPONSE}"
  exit 1
}

echo "[$(date -Iseconds)] OK: ${RESPONSE}"
