# Hướng dẫn Vận hành Task Scheduler - Eden Log Bridge

Tài liệu này cung cấp các lệnh quản lý công cụ đồng bộ log chạy ngầm trên Windows Server 2019, đảm bảo tiến trình chạy liên tục kể cả khi bạn tắt Remote Desktop (RDP).

## 1. Cách Tạo Task Ban Đầu
Mở cửa sổ **PowerShell với quyền Administrator (Run as Administrator)**, trỏ tới thư mục chứa code và chạy lệnh:
```powershell
cd C:\Đường_dẫn_tới\EdenLogBridge
.\setup_task.ps1
```
*Lưu ý: Nếu gặp lỗi chặn thực thi script, chạy lệnh `Set-ExecutionPolicy RemoteSigned` trước, sau đó chạy lại.*

---

## 2. Các Lệnh PowerShell Quản Lý Task
(Thực hiện trong PowerShell As Admin)

**▶️ Chạy thử task (Thực thi ngay lập tức):**
```powershell
Start-ScheduledTask -TaskName "EdenLogBridge_Sync"
```

**🔍 Xem trạng thái task hiện tại:**
```powershell
Get-ScheduledTask -TaskName "EdenLogBridge_Sync" | Select-Object State, LastRunTime, NextRunTime
```
*(State là `Running` nghĩa là đang chạy, `Ready` là đang chờ tới lịch tiếp theo)*

**⏸️ Vô hiệu hoá (Tạm dừng) task:**
```powershell
Disable-ScheduledTask -TaskName "EdenLogBridge_Sync"
```

**❌ Xóa bỏ task hoàn toàn:**
```powershell
Unregister-ScheduledTask -TaskName "EdenLogBridge_Sync" -Confirm:$false
```

---

## 3. Cách Kiểm Tra Task History & Log Output

Vì tiến trình chạy ngầm qua user `SYSTEM`, bạn sẽ không nhìn thấy cửa sổ console.
Toàn bộ `console.log` và lỗi mạng sẽ được ghi vào file:
📂 `logs/sync-task.log` (Trong thư mục dự án)

Để xem log realtime trên Windows (giống lệnh `tail -f` của Linux), bạn mở PowerShell gõ:
```powershell
Get-Content .\logs\sync-task.log -Wait -Tail 20
```

---

## 4. Gỡ lỗi (Troubleshooting) khi Task không chạy

Nếu bạn thấy file log không thay đổi hoặc Nextcloud không nhận file mới, hãy kiểm tra các nguyên nhân sau:

1. **Lỗi: Không tìm thấy lệnh `node`**
   - *Dấu hiệu:* Mở file `sync-task.log` lên thấy thông báo *"'node' is not recognized as an internal or external command"*
   - *Cách sửa:* Tiến trình `SYSTEM` không lấy được biến môi trường `PATH` của user Admin. Bạn cần sửa `$Argument` trong `setup_task.ps1` từ `node sync_tool.js` thành đường dẫn tuyệt đối, ví dụ: `"C:\Program Files\nodejs\node.exe" sync_tool.js`.
2. **Lỗi: Status `LastTaskResult` khác 0**
   - Chạy lệnh: `(Get-ScheduledTaskInfo -TaskName "EdenLogBridge_Sync").LastTaskResult`
   - Nếu trả về 0 (Thành công). Nếu trả về số lạ (vd: 1, -1), nghĩa là Script Node.js bị crash. Hãy đọc `sync-task.log` để xem dấu vết Exception.
3. **PZ Log bị chặn quyền Đọc (Access Denied)**
   - Tài khoản `SYSTEM` thường có quyền Root trên Windows. Nhưng nếu thư mục PZ Log bị phân quyền cực đoan chỉ cho riêng User Admin hiện tại, `SYSTEM` sẽ báo lỗi đọc file. Hãy cấp quyền **Read** cho User `SYSTEM` trên thư mục `C:\Users\...\Zomboid\Logs`.
4. **Xem lịch sử từ Event Viewer (Windows Task Scheduler History)**
   - Mở giao diện `Task Scheduler` trên Windows (Gõ vào Start Menu).
   - Tìm task `EdenLogBridge_Sync`. Nhấp chuột phải -> `Properties`.
   - Chuyển sang tab **History** để xem chi tiết từng giây task khởi động, kích hoạt và kết thúc.
