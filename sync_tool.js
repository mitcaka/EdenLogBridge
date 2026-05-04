const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const WebdavAdapter = require('./WebdavAdapter');

// Load .env
try {
    process.loadEnvFile(path.join(__dirname, '.env'));
} catch (e) {
    console.log('[Lưu ý] Không tìm thấy file .env, dùng biến môi trường mặc định.');
}

const config = {
    serverName: process.env.SERVER_NAME || 'EdenServer',
    pzLogFiles: (process.env.PZ_LOG_FILES || '').split(',').map(s => s.trim()).filter(Boolean),
    pzLogDir: process.env.PZ_LOG_DIR || '',
    stateFile: process.env.STATE_FILE || path.join(__dirname, 'state.json'),
    localWorkDir: process.env.LOCAL_WORK_DIR || path.join(__dirname, 'temp_workspace'),
    remoteBase: process.env.REMOTE_BASE || 'pz-logs/eden',
    firstSyncMode: process.env.FIRST_SYNC_MODE || 'tail', // 'tail' or 'full'
    maxLatestLines: parseInt(process.env.MAX_LATEST_LINES, 10) || 2000,
    maxErrorLines: parseInt(process.env.MAX_ERROR_LINES, 10) || 300,
    enableArchive: process.env.ENABLE_ARCHIVE === 'true',
    isDryRun: process.argv.includes('--dry-run')
};

function logInfo(msg) { console.log(`[INFO] ${msg}`); }
function logWarn(msg) { console.log(`[WARN] ${msg}`); }
function logError(msg) { console.error(`[ERROR] ${msg}`); }

// Đọc state
function loadState() {
    try {
        if (fs.existsSync(config.stateFile)) {
            return JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
        }
    } catch (err) {
        logWarn('Không thể đọc state.json, tạo mới.');
    }
    return {};
}

// Ghi state
function saveState(state) {
    if (config.isDryRun) {
        logInfo('[DRY-RUN] Bỏ qua ghi state.json');
        return;
    }
    fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}

// Lấy N dòng cuối từ một buffer text
function tailText(text, maxLines) {
    const lines = text.split('\n');
    if (lines.length <= maxLines) return text;
    return lines.slice(-maxLines).join('\n');
}

// Quét đệ quy thư mục
function walkDir(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        try {
            if (fs.statSync(fullPath).isDirectory()) {
                walkDir(fullPath, fileList);
            } else {
                if (fullPath.endsWith('.txt') || fullPath.endsWith('.log')) {
                    fileList.push(fullPath);
                }
            }
        } catch (err) {
            logWarn(`Không thể truy cập ${fullPath}: ${err.message}`);
        }
    }
    return fileList;
}

// Xử lý zip bằng PowerShell (Windows native)
function zipFiles(sourceFilesArray, destZipPath) {
    if (sourceFilesArray.length === 0) return;
    const paths = sourceFilesArray.map(p => `"${p}"`).join(',');
    const dest = `"${destZipPath}"`;
    const psCommand = `Compress-Archive -Path ${paths} -DestinationPath ${dest} -Force`;
    logInfo(`Creating Zip: ${psCommand}`);
    if (!config.isDryRun) {
        execSync(`powershell -NoProfile -Command "${psCommand}"`);
    }
}

async function processFile(filePath, state, adapter) {
    if (!fs.existsSync(filePath)) {
        logWarn(`File không tồn tại, bỏ qua: ${filePath}`);
        return;
    }

    const stats = fs.statSync(filePath);
    const fileId = stats.ino; // Windows NTFS file index
    const currentSize = stats.size;
    const creationTimeUtc = stats.birthtime.toISOString();
    const lastWriteTimeUtc = stats.mtime.toISOString();
    
    let fileState = state[filePath] || null;
    let isNewFile = false;
    let isTruncated = false;

    // 1. Phân tích trạng thái file
    if (!fileState) {
        logInfo(`[New File] Chưa từng sync: ${filePath}`);
        isNewFile = true;
    } else if (fileState.file_id !== fileId || fileState.creation_time_utc !== creationTimeUtc) {
        logInfo(`[Identity Changed] File bị rotate/recreate: ${filePath}`);
        isNewFile = true;
    } else if (currentSize < fileState.last_offset) {
        logInfo(`[Truncated] Kích thước file nhỏ hơn offset cũ (${currentSize} < ${fileState.last_offset}).`);
        isTruncated = true;
    } else if (currentSize === fileState.last_offset) {
        logInfo(`[No Change] Không có dữ liệu mới cho: ${filePath}`);
        return; // Không có gì mới
    }

    // Xác định offset bắt đầu
    let startOffset = 0;
    if (isNewFile) {
        if (config.firstSyncMode === 'tail') {
            // Lấy xấp xỉ 1MB cuối nếu file quá lớn
            startOffset = Math.max(0, currentSize - 1024 * 1024);
        } else {
            startOffset = 0; // mode 'full'
        }
    } else if (isTruncated) {
        startOffset = 0;
    } else {
        startOffset = fileState.last_offset;
    }

    const bytesToRead = currentSize - startOffset;
    logInfo(`Đang đọc ${bytesToRead} bytes từ offset ${startOffset} của file ${filePath}`);

    // Đọc file an toàn không lock
    const buffer = Buffer.alloc(bytesToRead);
    let bytesRead = 0;
    try {
        const fd = fs.openSync(filePath, 'r');
        bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, startOffset);
        fs.closeSync(fd);
    } catch (err) {
        logError(`Không thể đọc file (có thể bị lock gắt): ${filePath} - Lỗi: ${err.message}`);
        return; // Soft fail, tiếp tục file khác
    }

    const newLogText = buffer.toString('utf8', 0, bytesRead);
    
    // Trích xuất error/warning
    const lines = newLogText.split('\n');
    const errors = [];
    const warnings = [];
    for (const line of lines) {
        if (line.includes('ERROR') || line.includes('Exception') || line.includes('Failed')) {
            errors.push(line);
        }
        if (line.includes('WARN')) {
            warnings.push(line);
        }
    }

    // Chuẩn bị file tải lên
    if (!fs.existsSync(config.localWorkDir)) fs.mkdirSync(config.localWorkDir, { recursive: true });

    const fileNameBase = path.basename(filePath, path.extname(filePath));
    const d = new Date();
    const dateStr = d.toISOString().split('T')[0];
    const hourStr = String(d.getUTCHours()).padStart(2, '0');
    
    const remoteHourlyDir = `${config.remoteBase}/hourly/${dateStr}`;
    const remoteHourlyPath = `${remoteHourlyDir}/${fileNameBase}_${hourStr}.log`;
    
    const remoteLatestDir = `${config.remoteBase}/latest`;
    const remoteLatestLog = `${remoteLatestDir}/latest-${path.basename(filePath)}`;
    const remoteLatestErr = `${remoteLatestDir}/latest-${fileNameBase}-errors.txt`;
    const remoteLatestWarn = `${remoteLatestDir}/latest-${fileNameBase}-warnings.txt`;

    if (!config.isDryRun) {
        try {
            await adapter.ensureDirRecursive(remoteHourlyDir);
            await adapter.ensureDirRecursive(remoteLatestDir);

            // 1. Upload Hourly (Append logic: chúng ta upload file mới với timestamp. 
            // Do Nextcloud WebDAV không hỗ trợ append trực tiếp hiệu quả, upload thành file theo giờ là tốt nhất)
            // Nếu muốn strict hourly incremental không lặp, ta upload file chunk với timestamp chính xác tới phút/giây 
            // hoặc ghi đè file giờ nhưng append local. Ở đây ta upload atomic đè lên file của giờ đó nhưng chỉ chứa text của lần sync này?
            // Yêu cầu: "hourly log incremental, không upload lại toàn bộ log mỗi giờ".
            // Do WebDAV PUT ghi đè, nếu ta lưu file `HH.log`, lần sync thứ 2 trong giờ sẽ xoá mất lần 1.
            // Giải pháp: Gắn thêm timestamp vào tên file hoặc append local rồi mới upload.
            // Để đơn giản và an toàn nhất, append thêm timestamp vào tên: `_HH_MM_SS.log`.
            const mmss = String(d.getUTCMinutes()).padStart(2, '0') + String(d.getUTCSeconds()).padStart(2, '0');
            const incrementalHourlyPath = `${remoteHourlyDir}/${fileNameBase}_${hourStr}_${mmss}.log`;
            
            await adapter.uploadText(newLogText, incrementalHourlyPath);

            // 2. Upload Latest (Ghi đè)
            const latestText = tailText(newLogText, config.maxLatestLines);
            await adapter.uploadAtomic(Buffer.from(latestText), remoteLatestLog);

            // 3. Upload Error summary
            if (errors.length > 0) {
                const errText = tailText(errors.join('\n'), config.maxErrorLines);
                await adapter.uploadAtomic(Buffer.from(errText), remoteLatestErr);
            }

            // Upload Warning summary
            if (warnings.length > 0) {
                const warnText = tailText(warnings.join('\n'), config.maxErrorLines);
                await adapter.uploadAtomic(Buffer.from(warnText), remoteLatestWarn);
            }

            // 4. Archive (nếu bật)
            // Tạo zip và lưu vào thư mục archive
            if (config.enableArchive && hourStr === '00' && d.getUTCMinutes() < 15) {
               // Logic archive có thể gom các file log ngày hôm trước. 
               // (Để rút gọn, bỏ qua phần tìm file cũ, chỉ demo lệnh zip)
            }

        } catch (err) {
            logError(`Upload WebDAV thất bại cho ${filePath}: ${err.message}`);
            return; // THẤT BẠI -> KHÔNG CẬP NHẬT STATE
        }
    } else {
        logInfo(`[DRY-RUN] Sẽ upload ${bytesRead} bytes lên ${remoteHourlyPath}`);
        logInfo(`[DRY-RUN] Sẽ upload latest log lên ${remoteLatestLog}`);
    }

    // THÀNH CÔNG -> CẬP NHẬT STATE
    state[filePath] = {
        path: filePath,
        size: currentSize,
        last_offset: startOffset + bytesRead,
        creation_time_utc: creationTimeUtc,
        last_write_time_utc: lastWriteTimeUtc,
        file_id: fileId,
        last_synced_at: new Date().toISOString()
    };
    logInfo(`Sync thành công. Đã cập nhật state cho ${filePath}.`);
}

// Custom WebDAV adapter method bổ sung (uploadAtomic từ buffer/text)
WebdavAdapter.prototype.uploadAtomic = async function(content, remotePath) {
    const tmpExt = `.uploading-${Date.now()}`;
    const tmpRemotePath = remotePath + tmpExt;
    try {
        if (Buffer.isBuffer(content)) {
            await this._request('PUT', tmpRemotePath, { body: content });
        } else {
            // Assume file path
            await this.uploadFile(content, tmpRemotePath);
        }
        await this.move(tmpRemotePath, remotePath, true);
    } catch (err) {
        this.delete(tmpRemotePath).catch(() => {});
        throw err;
    }
};

async function main() {
    logInfo('--- BẮT ĐẦU EDEN LOG BRIDGE SYNC ---');
    if (config.isDryRun) logInfo('CHẾ ĐỘ DRY-RUN ĐANG BẬT');
    
    let adapter;
    if (!config.isDryRun) {
        try {
            adapter = new WebdavAdapter();
        } catch (err) {
            logError(`Lỗi WebDAV Adapter: ${err.message}`);
            process.exit(1);
        }
    }

    const state = loadState();

    let allFiles = [...config.pzLogFiles];

    // Thu thập file từ thư mục Logs đệ quy
    if (config.pzLogDir) {
        logInfo(`Đang quét đệ quy thư mục logs: ${config.pzLogDir}`);
        const dirFiles = walkDir(config.pzLogDir);
        const now = Date.now();
        const oneDayMs = 24 * 60 * 60 * 1000;
        let recentCount = 0;

        for (const file of dirFiles) {
            try {
                const stats = fs.statSync(file);
                // Bộ lọc 24h: Chỉ lấy những file có thay đổi trong 24h gần nhất
                if (now - stats.mtime.getTime() <= oneDayMs) {
                    if (!allFiles.includes(file)) {
                        allFiles.push(file);
                        recentCount++;
                    }
                }
            } catch (e) {
                logWarn(`Lỗi kiểm tra stats cho ${file}`);
            }
        }
        logInfo(`Tìm thấy ${recentCount} file log bị chỉnh sửa trong 24h qua tại thư mục.`);
    }

    logInfo(`Tổng cộng cần xử lý ${allFiles.length} file.`);

    for (const filePath of allFiles) {
        await processFile(filePath, state, adapter);
    }

    saveState(state);
    logInfo('--- KẾT THÚC SYNC ---');
}

main().catch(err => logError(`Lỗi hệ thống: ${err.stack}`));
