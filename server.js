const express = require('express');
const cors = require('cors');
const path = require('path');
const { Readable } = require('stream');
const readline = require('readline');
const WebdavAdapter = require('./WebdavAdapter');

// Load environment variables
try {
    process.loadEnvFile(path.join(__dirname, '.env'));
} catch (e) {
    console.log('[Lưu ý] Không tìm thấy file .env, dùng biến môi trường mặc định.');
}

const app = express();

const config = {
    port: process.env.PORT || 3010,
    adminToken: process.env.ADMIN_TOKEN,
    frontendOrigin: process.env.FRONTEND_ORIGIN || '*',
    remoteBase: process.env.REMOTE_BASE || 'pz-logs/eden'
};

if (!config.adminToken) {
    console.warn('⚠️ CẢNH BÁO: ADMIN_TOKEN chưa được cấu hình. Hệ thống sẽ không an toàn!');
}

let adapter;
try {
    adapter = new WebdavAdapter();
} catch (err) {
    console.error('Lỗi khởi tạo WebDAV Adapter:', err.message);
    process.exit(1);
}

// --- Middlewares ---

// CORS
app.use(cors({ origin: config.frontendOrigin }));

// Basic In-Memory Rate Limiter (Tránh dùng module ngoài)
const rateLimitMap = new Map();
function rateLimiter(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const windowMs = 60000; // 1 phút
    const maxRequests = 120; // 120 req / phút

    let record = rateLimitMap.get(ip);
    if (!record || record.resetTime < now) {
        record = { count: 0, resetTime: now + windowMs };
    }
    record.count++;
    rateLimitMap.set(ip, record);

    if (record.count > maxRequests) {
        return res.status(429).json({ error: 'Too Many Requests' });
    }
    next();
}
app.use(rateLimiter);

// Auth Middleware
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid token format' });
    }
    const token = authHeader.split(' ')[1];
    if (token !== config.adminToken) {
        return res.status(403).json({ error: 'Forbidden: Invalid token' });
    }
    next();
}

// Validation Utils
function isValidDate(d) {
    return /^\d{4}-\d{2}-\d{2}$/.test(d);
}

function isSafeFilename(f) {
    if (!f || f.includes('..') || f.includes('/') || f.includes('\\')) return false;
    return true;
}

// Global Error Handler để che NC_PASS
function safeErrorHandler(err, req, res, next) {
    // Không bao giờ log trực tiếp err.stack ra cho user
    console.error(`[API Error] ${req.method} ${req.url}:`, err.message);
    res.status(500).json({ error: 'Internal Server Error', details: err.status || 'WebDAV operation failed' });
}

// --- API Routes ---

// 1. Health check (Public)
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Các API bên dưới cần xác thực
app.use('/api', requireAuth);

// 2. Storage Health
app.get('/api/storage/health', async (req, res, next) => {
    try {
        const isConnected = await adapter.testConnection();
        if (isConnected) res.json({ status: 'connected' });
        else res.status(502).json({ error: 'Bad Gateway: Cannot connect to Nextcloud' });
    } catch (err) { next(err); }
});

// Helper stream file từ WebDAV thẳng sang Express Response
async function streamRemoteFile(remotePath, res, next) {
    try {
        const response = await adapter._request('GET', remotePath, { timeout: 0 });
        if (!response.ok) return res.status(response.status).json({ error: 'File not found' });
        
        const contentType = response.headers.get('content-type') || 'text/plain; charset=utf-8';
        res.setHeader('Content-Type', contentType);
        
        Readable.fromWeb(response.body).pipe(res);
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ error: 'File not found on storage' });
        next(err);
    }
}

// 3, 4, 5. GET Latest Logs (console, errors, warnings)
app.get('/api/logs/latest/:type', async (req, res, next) => {
    const { type } = req.params;
    let fileName = '';
    
    if (type === 'console') fileName = 'latest-server-console.txt';
    else if (type === 'errors') fileName = 'latest-server-console-errors.txt';
    else if (type === 'warnings') fileName = 'latest-server-console-warnings.txt';
    else return res.status(400).json({ error: 'Invalid type. Use console, errors, or warnings' });

    const remotePath = `${config.remoteBase}/latest/${fileName}`;
    await streamRemoteFile(remotePath, res, next);
});

// GET Available dates
app.get('/api/logs/dates', async (req, res, next) => {
    try {
        const remotePath = `${config.remoteBase}/hourly/`;
        const items = await adapter.list(remotePath);
        const dates = items
            .map(href => decodeURIComponent(href))
            .map(p => {
                const parts = p.split('/').filter(Boolean);
                return parts[parts.length - 1].trim();
            })
            .filter(name => name !== 'hourly' && isValidDate(name))
            .sort().reverse(); // Mới nhất lên đầu
        res.json({ dates });
    } catch (err) {
        if (err.status === 404) return res.json({ dates: [] });
        next(err);
    }
});

// 6. GET Hourly logs by date
app.get('/api/logs/hourly', async (req, res, next) => {
    const { date } = req.query;
    if (!date || !isValidDate(date.trim())) return res.status(400).json({ error: 'Invalid date format YYYY-MM-DD' });

    const remotePath = `${config.remoteBase}/hourly/${date.trim()}/`;
    try {
        const files = await adapter.list(remotePath);
        // Trả về danh sách tên file, bỏ thư mục gốc
        const fileNames = files
            .map(href => decodeURIComponent(href))
            .map(p => {
                const parts = p.split('/').filter(Boolean);
                return parts[parts.length - 1].trim();
            })
            .filter(name => name !== date.trim()); 
        res.json({ date: date.trim(), files: fileNames });
    } catch (err) {
        if (err.status === 404) return res.json({ date, files: [] }); // Thư mục trống/chưa có
        next(err);
    }
});

// 7. GET Specific hourly log file
app.get('/api/logs/hourly/:date/:file', async (req, res, next) => {
    const { date, file } = req.params;
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date' });
    if (!isSafeFilename(file)) return res.status(400).json({ error: 'Invalid filename' });

    const remotePath = `${config.remoteBase}/hourly/${date}/${file}`;
    await streamRemoteFile(remotePath, res, next);
});

// 8. GET Search log (Memory efficient streaming, Multi-file partial match)
app.get('/api/logs/search', async (req, res, next) => {
    const { q, date, file } = req.query;
    if (!date || !isValidDate(date)) return res.status(400).json({ error: 'Missing or invalid "date"' });
    if (!file) return res.status(400).json({ error: 'Missing "file" keyword' });

    const remoteDirPath = `${config.remoteBase}/hourly/${date}/`;
    try {
        // Lấy danh sách tất cả file trong ngày
        const allFiles = await adapter.list(remoteDirPath);
        const matchedFiles = allFiles
            .map(href => decodeURIComponent(href))
            .map(p => {
                const parts = p.split('/').filter(Boolean);
                return parts[parts.length - 1].trim();
            })
            // Lọc ra các file KHÔNG phải là folder mẹ và có CHỨA từ khóa file
            .filter(name => name !== date && name.toLowerCase().includes(file.toLowerCase()));

        if (matchedFiles.length === 0) {
            return res.json({ results: [], total_matched: 0, message: "No files matched your file keyword" });
        }

        // Nếu KHÔNG có từ khoá tìm kiếm nội dung (q), chỉ trả về danh sách file
        if (!q || q.trim() === '') {
            const results = matchedFiles.map(fileName => ({ file: fileName, line: '-', text: `Match file: ${fileName}` }));
            return res.json({ results, total_matched: results.length });
        }

        const results = [];
        // Lặp qua từng file để tải và tìm kiếm (tuần tự để tiết kiệm RAM)
        for (const fileName of matchedFiles) {
            const remotePath = `${config.remoteBase}/hourly/${date}/${fileName}`;
            const response = await adapter._request('GET', remotePath, { timeout: 0 });
            if (!response.ok) continue;

            const rl = readline.createInterface({
                input: Readable.fromWeb(response.body),
                crlfDelay: Infinity
            });

            let lineNum = 0;
            for await (const line of rl) {
                lineNum++;
                if (line.toLowerCase().includes(q.toLowerCase())) {
                    // Thêm trường file để frontend hiển thị
                    results.push({ file: fileName, line: lineNum, text: line });
                }
                if (results.length >= 10000) break; // Giới hạn tổng số lượng kết quả
            }
            if (results.length >= 10000) break;
        }

        res.json({ results, total_matched: results.length });
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ error: 'Folder or files not found' });
        next(err);
    }
});

// 9. GET Download Archive ZIP
app.get('/api/logs/download/archive/:date', async (req, res, next) => {
    const { date } = req.params;
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date' });

    const remotePath = `${config.remoteBase}/archive/${date}.zip`;
    try {
        const response = await adapter._request('GET', remotePath, { timeout: 0 });
        if (!response.ok) return res.status(response.status).json({ error: 'Archive not found' });
        
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="eden_logs_${date}.zip"`);
        Readable.fromWeb(response.body).pipe(res);
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ error: 'Archive file not found' });
        next(err);
    }
});

// Error handling middleware
app.use(safeErrorHandler);

// Serve Static Frontend (Admin UI)
const frontendPath = path.join(__dirname, 'admin-frontend', 'out');
app.use(express.static(frontendPath));

// Fallback for React/Next.js Client-Side Routing
app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(frontendPath, 'index.html'));
});

app.listen(config.port, () => {
    console.log(`[INFO] Eden Log Bridge Backend is running on port ${config.port}`);
});
