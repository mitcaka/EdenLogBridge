const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

class WebdavError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = 'WebdavError';
    }
}

class WebdavAdapter {
    constructor(config = {}) {
        this.ncBase = config.NC_BASE || process.env.NC_BASE;
        this.ncUser = config.NC_USER || process.env.NC_USER;
        this.ncPass = config.NC_PASS || process.env.NC_PASS;
        this.davBase = config.DAV || process.env.DAV || `${this.ncBase}/remote.php/dav/files/${this.ncUser}`;

        if (!this.ncBase || !this.ncUser || !this.ncPass) {
            throw new Error('Thiếu cấu hình WebDAV (NC_BASE, NC_USER, NC_PASS)');
        }

        // Tạo auth header Basic Base64
        this.authHeader = `Basic ${Buffer.from(`${this.ncUser}:${this.ncPass}`).toString('base64')}`;
    }

    /**
     * Encode URI an toàn, xử lý path Windows backslash (\)
     */
    _encodePath(remotePath) {
        // Thay thế \ thành /
        const normalizedPath = remotePath.replace(/\\/g, '/');
        // Tránh bị dính // hoặc dấu / đầu chuỗi gây lỗi URL
        const cleanPath = normalizedPath.startsWith('/') ? normalizedPath.substring(1) : normalizedPath;
        return cleanPath.split('/').map(part => encodeURIComponent(part)).join('/');
    }

    _getFullUrl(remotePath) {
        if (!remotePath) return this.davBase;
        return `${this.davBase}/${this._encodePath(remotePath)}`;
    }

    async _request(method, remotePath, options = {}, retries = 3) {
        const url = this._getFullUrl(remotePath);
        
        const fetchOptions = {
            method,
            headers: {
                'Authorization': this.authHeader,
                ...(options.headers || {})
            },
            // Nếu options.timeout === 0, vô hiệu hoá cứng timeout đối với Stream/Large files
            ...(options.timeout !== 0 ? { signal: AbortSignal.timeout(options.timeout || 30000) } : {}),
            ...options.fetchOptions
        };

        if (options.body) {
            fetchOptions.body = options.body;
        }

        let lastError;
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(url, fetchOptions);
                // 200 OK, 201 Created, 204 No Content, 207 Multi-Status
                if (!response.ok && ![200, 201, 204, 207].includes(response.status)) {
                    throw new WebdavError(`WebDAV ${method} failed: ${response.status} ${response.statusText}`, response.status);
                }
                return response;
            } catch (err) {
                lastError = err;
                // Không retry nếu là lỗi quyền hạn, xác thực, không tìm thấy, hoặc trùng đột (401, 403, 404, 409)
                if (err instanceof WebdavError && [401, 403, 404, 409].includes(err.status)) {
                    throw err;
                }
                // Các lỗi như 5xx, timeout, ngắt kết nối sẽ được retry
                console.warn(`[WebDAV] Retry ${i+1}/${retries} cho lệnh ${method} ${remotePath}: ${err.message}`);
                await new Promise(res => setTimeout(res, 1500 * (i + 1))); // Tăng thời gian chờ sau mỗi lần fail
            }
        }
        throw lastError;
    }

    async testConnection() {
        try {
            const res = await this._request('PROPFIND', '', {
                headers: { 'Depth': '0' }
            });
            return res.status === 207;
        } catch (err) {
            console.error('[WebDAV] testConnection lỗi:', err.message);
            return false;
        }
    }

    async ensureDirRecursive(remotePath) {
        const normalizedPath = remotePath.replace(/\\/g, '/');
        const parts = normalizedPath.split('/').filter(p => p.length > 0);
        
        let currentPath = '';
        for (const part of parts) {
            currentPath += `/${part}`;
            try {
                await this._request('MKCOL', currentPath, {}, 1); // Không retry MKCOL nhiều lần
            } catch (err) {
                // HTTP 405 Method Not Allowed tức là thư mục/file đã tồn tại
                if (err.status !== 405 && err.status !== 201) {
                    throw err;
                }
            }
        }
    }

    async uploadFile(localPath, remotePath) {
        const fileStream = fs.createReadStream(localPath);
        
        await this._request('PUT', remotePath, {
            fetchOptions: {
                duplex: 'half' // Cần có trong Node fetch khi body là ReadableStream
            },
            body: fileStream,
            timeout: 0 // Vô hiệu hoá timeout cứng để tránh đứt stream với file lớn
        });
    }

    async uploadText(text, remotePath) {
        await this._request('PUT', remotePath, {
            body: Buffer.from(text, 'utf-8')
        });
    }

    async move(remoteFrom, remoteTo, overwrite = true) {
        const destUrl = this._getFullUrl(remoteTo);
        await this._request('MOVE', remoteFrom, {
            headers: {
                'Destination': destUrl,
                'Overwrite': overwrite ? 'T' : 'F'
            }
        });
    }

    /**
     * Upload Atomic: Đẩy file tạm lên server, sau đó MOVE đè lên file chính thức.
     * Cách này tránh file bị hỏng nếu đang upload mà mất kết nối.
     */
    async uploadAtomic(localPath, remotePath) {
        const tmpExt = `.uploading-${Date.now()}`;
        const tmpRemotePath = remotePath + tmpExt;
        
        try {
            await this.uploadFile(localPath, tmpRemotePath);
            await this.move(tmpRemotePath, remotePath, true);
        } catch (err) {
            // Cố gắng dọn dẹp file tạm nếu quá trình bị lỗi
            this.delete(tmpRemotePath).catch(() => {});
            throw err;
        }
    }

    async list(remotePath) {
        const response = await this._request('PROPFIND', remotePath, {
            headers: { 'Depth': '1' }
        });
        const xml = await response.text();
        
        // Phân tích nhanh XML để lấy href
        const hrefRegex = /<[a-z0-9]*:?href[^>]*>([^<]+)<\/[a-z0-9]*:?href>/gi;
        const hrefs = [];
        let match;
        while ((match = hrefRegex.exec(xml)) !== null) {
            hrefs.push(decodeURIComponent(match[1]));
        }
        
        // Trả về list các item (loại bỏ cái root ra khỏi list nếu muốn)
        return hrefs;
    }

    async downloadText(remotePath) {
        const response = await this._request('GET', remotePath);
        return await response.text();
    }

    async downloadStream(remotePath, localDestPath) {
        const response = await this._request('GET', remotePath, { timeout: 0 });
        if (!response.body) throw new Error('Response body is empty');
        
        const dest = fs.createWriteStream(localDestPath);
        await pipeline(Readable.fromWeb(response.body), dest);
    }

    async delete(remotePath) {
        try {
            await this._request('DELETE', remotePath);
        } catch (err) {
            // HTTP 404 là file không tồn tại, có thể an tâm bỏ qua
            if (err.status !== 404) throw err;
        }
    }
}

module.exports = WebdavAdapter;
