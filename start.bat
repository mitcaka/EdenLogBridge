@echo off
title Eden Log Bridge - Cập nhật và Khởi động
echo ===================================================
echo     EDEN LOG BRIDGE - UPDATE ^& START TOOL
echo ===================================================
echo.

echo [1/3] Dang keo ma nguon moi nhat (Git Pull)...
git pull origin main
echo.

echo [2/3] Dang cai dat va Build lai Giao dien (Frontend)...
cd admin-frontend
call npm install
call npm run build
cd ..
echo.

echo [3/3] Dang tat cac phien ban Server cu (Neu co) de giai phong Port 3010...
FOR /F "tokens=5" %%T IN ('netstat -aon ^| find ":3010" ^| find "LISTENING"') DO taskkill /F /PID %%T >nul 2>&1
echo.

echo [4/4] Thanh cong! Dang khoi dong Server (Backend) moi nhat...
echo.
node server.js

pause
