# Hướng dẫn triển khai AutoPilot Scheduler lên Production

> **Dự án**: SanDeal / ReviewPilot AI  
> **Domain**: https://sandeal.tech  
> **VPS IP**: 206.189.144.34  
> **PM2 app**: sandeal  
> **Port**: 3001  

---

## 1. Mục tiêu

Triển khai AutoPilot Scheduler an toàn trên VPS:
- Bot tự động quét nguồn, kiểm tra link/ảnh, dọn sản phẩm lỗi.
- Chạy theo lịch cấu hình từ dashboard.
- Không chạy nếu scheduler tắt hoặc chưa đến lịch.
- Không chạy song song (run lock).
- Không public sản phẩm link/ảnh lỗi.
- Không dùng paid API.

---

## 2. Điều kiện trước khi bật

| Điều kiện | Cách kiểm tra |
|---|---|
| `npm run build` pass | Chạy local: `cd C:\duan\sandeal && npm run build` |
| PM2 app `sandeal` chạy ổn | SSH: `pm2 status sandeal` |
| Nginx proxy đúng port 3001 | SSH: `sudo nginx -t && sudo systemctl reload nginx` |
| `/api/health` trả `ok: true` | `curl https://sandeal.tech/api/health` |
| Dashboard login hoạt động | Mở `https://sandeal.tech/dashboard` |
| Scheduler trong dashboard đang OFF | Mặc định OFF — bật thủ công khi sẵn sàng |
| Product Health Guard hoạt động | Nút "🩺 Kiểm tra sức khỏe SP" trong dashboard |
| Public site không hiện link dashboard | Kiểm tra trang chủ, `/deals`, `/deals/[slug]` |

---

## 3. Lệnh kiểm tra local

```powershell
cd C:\duan\sandeal
npm run build
```

Nếu build pass → sẵn sàng deploy.

---

## 4. Lệnh deploy VPS thủ công

```bash
ssh root@206.189.144.34

cd /var/www/sandeal
git pull
npm run build
pm2 restart sandeal --update-env
pm2 logs sandeal --lines 80
```

Kiểm tra sau deploy:
```bash
pm2 status sandeal
curl -I https://sandeal.tech
curl https://sandeal.tech/api/health
```

---

## 5. Kiểm tra Nginx

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Nếu trả `syntax is ok` → Nginx ổn.

---

## 6. Kiểm tra production

```bash
# Health check
curl https://sandeal.tech/api/health

# Kết quả mong đợi:
# {
#   "ok": true,
#   "app": "sandeal",
#   "service": "SanDeal / ReviewPilot AI",
#   "environment": "production",
#   "safeMode": true,
#   "freeOnly": true,
#   "autoPilot": true,
#   "safePublish": true
# }
```

---

## 7. Test scheduler tick thủ công

```bash
# Thay YOUR_USER và YOUR_PASS bằng thông tin đăng nhập dashboard thật
curl -X POST \
  -u "YOUR_USER:YOUR_PASS" \
  https://sandeal.tech/api/ai-bots/scheduler/tick
```

**Kết quả mong đợi** (nếu scheduler tắt):
```json
{
  "ok": true,
  "message": "Lịch tự động đang tắt. Bỏ qua.",
  "data": { "status": "skipped", "reason": "disabled" }
}
```

> ⚠️ **KHÔNG ghi mật khẩu thật vào file docs hoặc git.**

---

## 8. Cách tạo cron trên VPS

### Bước 1: Copy script mẫu
```bash
cp /var/www/sandeal/scripts/sandeal-scheduler-cron.example.sh /root/sandeal-cron.sh
```

### Bước 2: Sửa thông tin đăng nhập
```bash
nano /root/sandeal-cron.sh
# Sửa BASIC_AUTH_USER và BASIC_AUTH_PASS
```

### Bước 3: Cấp quyền
```bash
chmod +x /root/sandeal-cron.sh
```

### Bước 4: Test
```bash
bash /root/sandeal-cron.sh
```

### Bước 5: Thêm vào crontab

Chạy mỗi 60 phút:
```bash
crontab -e
# Thêm dòng:
0 * * * * /root/sandeal-cron.sh >> /var/log/sandeal-cron.log 2>&1
```

Hoặc mỗi 30 phút:
```bash
*/30 * * * * /root/sandeal-cron.sh >> /var/log/sandeal-cron.log 2>&1
```

### Bước 6: Bật scheduler trong dashboard
- Vào `/dashboard/ai-bots`
- Section "AutoPilot Scheduler & Operations"
- Chọn chế độ + chu kỳ
- Bấm "▶️ Bật lịch tự động"

> ⚠️ Scheduler phải BẬT trong dashboard thì cron mới có tác dụng.  
> Endpoint tự kiểm tra: scheduler tắt → bỏ qua, chưa đến lịch → bỏ qua.

---

## 9. Cảnh báo an toàn

| Quy tắc | Lý do |
|---|---|
| ❌ Không để cron < 30 phút | Quá tải server, AccessTrade rate limit |
| ❌ Không public sản phẩm link/ảnh lỗi | Product Health Guard chặn tự động |
| ❌ Không log token/API key | Tuân thủ bảo mật |
| ❌ Không bật paid API | Free Only ON |
| ❌ Không sửa `.env` nếu không hiểu rõ | Có thể gây mất kết nối |
| ❌ Không commit mật khẩu vào git | Dùng file cron riêng ngoài repo |
| ✅ Kiểm tra `/api/health` sau deploy | Đảm bảo app hoạt động |
| ✅ Kiểm tra `pm2 logs` nếu có lỗi | Debug nhanh |
| ✅ Test scheduler tick thủ công trước | Đảm bảo auth + config đúng |

---

## 10. Kiến trúc scheduler

```
VPS crontab (mỗi 30–60 phút)
  └── /root/sandeal-cron.sh
        └── curl POST /api/ai-bots/scheduler/tick (Basic Auth)
              └── requireAuth() kiểm tra
                    └── getSchedulerConfig() → enabled? → due?
                          └── acquireRunLock() → chặn chạy song song
                                └── runAutoPilot() → execute bot
                                      └── releaseRunLock()
                                            └── markSchedulerRunCompleted()
                                                  └── updateRunLog()
```

Tất cả đều safe:
- Auth bảo vệ endpoint
- Scheduler OFF mặc định
- Run lock chặn song song
- TTL 25 phút phòng crash
- Run log ghi lại kết quả
