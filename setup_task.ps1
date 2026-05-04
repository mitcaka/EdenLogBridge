<#
.SYNOPSIS
Script thiết lập Windows Task Scheduler cho Eden Log Bridge.
Chạy định kỳ mỗi 15 phút bằng quyền SYSTEM để không cần user login.

.DESCRIPTION
Sử dụng Register-ScheduledTask để tạo lịch chạy background.
Yêu cầu chạy script bằng quyền Administrator.
#>

# Tên task hiển thị trong Task Scheduler
$TaskName = "EdenLogBridge_Sync"

# Lấy thư mục hiện tại của script làm Working Directory
$WorkingDir = $PSScriptRoot
$LogDir = Join-Path $WorkingDir "logs"

Write-Host "Setting up Task '$TaskName'..."
Write-Host "Working Directory: $WorkingDir"

# Đảm bảo thư mục logs tồn tại
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    Write-Host "Created logs directory: $LogDir"
}

# 1. Action: Dùng cmd.exe để gọi node và pipe log ra file
# Ghi chú: Yêu cầu 'node' đã được thêm vào System PATH
$LogFile = Join-Path $LogDir "sync-task.log"
$Argument = "/c `"node sync_tool.js >> `"$LogFile`" 2>&1`""
$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $Argument -WorkingDirectory $WorkingDir

# 2. Trigger: Chạy ngay bây giờ và lặp lại mỗi 15 phút vĩnh viễn
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)

# 3. Principal: Chạy dưới quyền SYSTEM (thoả mãn: Run whether user is logged on or not, Highest Privileges)
$Principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# 4. Settings bổ sung: Đảm bảo task không bị dừng ngẫu nhiên
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)

# 5. Đăng ký Task
try {
    $Task = New-ScheduledTask -Action $Action -Principal $Principal -Trigger $Trigger -Settings $Settings
    Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null
    Write-Host "Thành công! Task '$TaskName' đã được tạo." -ForegroundColor Green
    Write-Host "Vui lòng xem file hướng dẫn để biết cách chạy và kiểm tra." -ForegroundColor Yellow
} catch {
    Write-Host "Lỗi: Không thể tạo task. Bạn đã mở PowerShell bằng Run as Administrator chưa?" -ForegroundColor Red
    Write-Error $_
}
