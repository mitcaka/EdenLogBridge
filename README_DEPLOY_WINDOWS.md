# Hướng dẫn Deploy Eden Log Bridge (Windows Server 2019)

Tài liệu này hướng dẫn cách triển khai hệ thống tự động đồng bộ Log của Server Project Zomboid lên Nextcloud WebDAV và vận hành trang quản trị Admin UI.

## 1. Cài Đặt Ban Đầu

**Yêu cầu hệ thống:** 
- Node.js bản v18 hoặc v20+ (Tải và cài file `.msi` từ nodejs.org).
- Khuyên dùng thư mục dự án tại ổ đĩa hệ thống: `C:\EdenLogBridge`

Mở PowerShell bằng quyền **Administrator** tại thư mục dự án:
```powershell
cd C:\EdenLogBridge
npm install express cors
cd admin-frontend
npm install
cd ..
```

Cấu trúc thư mục chuẩn:
```text
C:\EdenLogBridge\
├── admin-frontend/     # Source code Next.js (Admin UI)
├── logs/               # Nơi lưu output của Task Scheduler
├── WebdavAdapter.js    # Thư viện giao tiếp Nextcloud
├── sync_tool.js        # Script đọc log và đẩy file
├── server.js           # Backend API kiêm Web Server
├── setup_task.ps1      # Script tạo Task chạy ngầm
└── .env                # File cấu hình bảo mật
```

---

## 2. Tìm Đường Dẫn Log Project Zomboid

Log của Project Zomboid trên Windows thường nằm rải rác. Vị trí phổ biến:
- Thư mục root: `C:\Users\<User>\Zomboid`
- Thư mục Logs chi tiết: `C:\Users\<User>\Zomboid\Logs`
- File Console chính: `C:\Users\<User>\Zomboid\server-console.txt`

> [!TIP]
> **Lệnh PowerShell tìm nhanh file log nếu bị mất dấu:**
> ```powershell
> Get-ChildItem -Path C:\Users -Recurse -Include *DebugLog*,*console*.txt,server-console.txt -ErrorAction SilentlyContinue
> ```

---

## 3. Cấu hình Biến Môi Trường (`.env`)

Tạo file `.env` tại `C:\EdenLogBridge\.env` và điền thông tin sau:

```env
# 1. NEXTCLOUD WEBDAV
NC_BASE="https://driver.webtui.vn"
NC_USER="ten_dang_nhap"
NC_PASS="mat_khau_app_co_gach_noi"
DAV="/remote.php/webdav"

# 2. PROJECT ZOMBOID
SERVER_NAME="Eden_PZ_Server"
PZ_LOG_FILES="C:\Users\Admin\Zomboid\Logs\server-console.txt"
REMOTE_BASE="pz-logs/eden"
STATE_FILE="state.json"
MAX_LATEST_LINES=2000

# 3. BACKEND & FRONTEND ADMIN
PORT=3000
ADMIN_TOKEN="NHAP_MOT_CHUOI_MAT_KHAU_BAT_KY_VAO_DAY_DE_DANG_NHAP"
FRONTEND_ORIGIN="http://localhost:3000"

# (Tuỳ chọn) Báo cáo lỗi qua Discord
DISCORD_WEBHOOK_URL=""
```

---

## 4. Chạy Test Sync Tool Thủ Công

Trước khi giao cho hệ thống chạy tự động, hãy test thử tool đồng bộ log:

```powershell
# Chạy ở chế độ an toàn (Chỉ quét, không upload)
node sync_tool.js --dry-run

# Chạy thật (Bắt đầu upload lên WebDAV)
node sync_tool.js
```
*Nếu console báo "Successfully uploaded...", tức là công cụ đẩy log đã kết nối được WebDAV.*

---

## 5. Thiết lập Task Scheduler (Chạy Tự Động ngầm)

Để tool tự động lấy log mỗi 15 phút ngay cả khi bạn đã thoát Remote Desktop (RDP):

1. Mở PowerShell (`Run as Administrator`).
2. Chạy file script được cấp sẵn:
   ```powershell
   cd C:\EdenLogBridge
   .\setup_task.ps1
   ```
> **Lưu ý:** Script sẽ đăng ký một Task tên `EdenLogBridge_Sync` chạy ngầm dưới quyền `NT AUTHORITY\SYSTEM`. Toàn bộ log lỗi trong quá trình tự động hóa sẽ được ghi vào `C:\EdenLogBridge\logs\sync-task.log`.

---

## 6. Chạy Backend & Giao diện Admin

Để Admin có thể xem log từ xa qua Web, ta cần build Frontend Next.js và bật Backend Express:

```powershell
# Bước 1: Build file tĩnh cho Frontend
cd C:\EdenLogBridge\admin-frontend
npm run build
cd ..

# Bước 2: Bật Backend Server (Port 3000)
node server.js
```
> [!TIP]
> *Để Server Backend chạy nền không tắt khi đóng CMD, bạn có thể dùng `pm2` (`npm install -g pm2` -> `pm2 start server.js`).*
>
> *Nên cấu hình Reverse Proxy (Nginx/IIS) hoặc Cloudflare Tunnel để trỏ tên miền về `localhost:3000`.*

---

## 7. Yêu Cầu Bảo Mật (Security Best Practices)

- **Không bao giờ public file `.env`**: Nó chứa App Password của Nextcloud.
- **Không để Frontend biết NC_PASS**: Đó là lý do mọi kết nối WebDAV đều chạy ngầm qua Backend. Frontend chỉ dùng `ADMIN_TOKEN`.
- **Dùng HTTPS**: Nếu mở public ra Internet, BẮT BUỘC dùng HTTPS/SSL để tránh bị chặn bắt chuỗi Token.
- **Windows Firewall**: Chỉ mở port 3000 nếu thực sự cần thiết, tốt nhất là xài Cloudflare Tunnel để không mở port.
- **Lộ Token?**: Nếu nghi ngờ lộ `NC_PASS`, hãy vào Nextcloud xoá App Password cũ và cấp cái mới ngay lập tức.

---

## 8. Xử lý Sự Cố (Troubleshooting)

| Vấn đề | Nguyên nhân & Cách khắc phục |
| :--- | :--- |
| **WebDAV 401/403** | Sai `NC_USER` hoặc `NC_PASS`. Hãy đảm bảo Nextcloud yêu cầu dùng "App Password" chứ không phải password gốc. |
| **WebDAV 409 (Conflict)** | Do thư mục cha chưa tồn tại (`MKCOL`). Kiểm tra `ensureDirRecursive` trong log xem có bị chặn quyền ghi không. |
| **Upload Timeout** | File log quá lớn (>1GB). Đã tắt timeout cứng cho hàm download/upload, nếu vẫn lỗi hãy check băng thông mạng. |
| **Path có dấu cách** | Đường dẫn kiểu `C:\Project Zomboid\...` có dấu cách. Script PowerShell đã bọc Quote `""`, nhưng nếu lỗi hãy đảm bảo tham số không bị bung. |
| **Access Denied (Windows)**| Tool không đọc được file log PZ. Đảm bảo user `SYSTEM` có quyền Full Control ở thư mục `C:\Users\...\Zomboid`. |
| **Task Scheduler không chạy**| Gõ `Get-ScheduledTask -TaskName EdenLogBridge_Sync`. Check file `logs\sync-task.log` xem có bị báo *"node is not recognized"* không (Nếu có, hãy Restart máy chủ để nạp biến PATH). |
| **Lỗi CORS** | Thêm URL thực tế của frontend (vd: `https://admin.tenmien.com`) vào biến `FRONTEND_ORIGIN` trong `.env`. |
| **Sai ADMIN_TOKEN** | Giao diện báo 401 Unauthorized trắng trang. F5 lại và nhập chính xác token lưu ở `.env`. |
