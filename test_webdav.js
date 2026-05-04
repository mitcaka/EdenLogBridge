const fs = require('fs');
const path = require('path');
const WebdavAdapter = require('./WebdavAdapter');

// Thử load .env file nếu chạy trên Node 20+
try {
    process.loadEnvFile(path.join(__dirname, '.env'));
} catch (e) {
    console.log('[Lưu ý] Không tìm thấy file .env hợp lệ hoặc đang dùng Node < 20. Sẽ sử dụng process.env mặc định nếu có.');
}

async function runTests() {
    console.log('--- Bắt đầu test WebDAV Adapter ---');
    let adapter;
    
    try {
        adapter = new WebdavAdapter();
    } catch (e) {
        console.error('Lỗi khởi tạo Adapter:', e.message);
        console.log('=> Hướng dẫn: Hãy copy file .env.example thành .env và điền cấu hình thực tế!');
        return;
    }

    try {
        // 1. Test connection
        console.log('\n[1] Testing connection...');
        const isConnected = await adapter.testConnection();
        if (!isConnected) {
            console.error('=> Kết nối thất bại. Vui lòng kiểm tra lại cấu hình NC_BASE, NC_USER, NC_PASS trong .env');
            return;
        }
        console.log('=> Kết nối thành công (207 Multi-Status).');

        const testFolder = 'eden/test-dav-adapter-' + Date.now();
        const testFile1 = `${testFolder}/hello.txt`;
        const testFile2 = `${testFolder}/upload-atomic.txt`;

        // 2. Tạo folder recursive
        console.log(`\n[2] Đang tạo thư mục: ${testFolder}`);
        await adapter.ensureDirRecursive(testFolder);
        console.log('=> Tạo thư mục thành công.');

        // 3. Upload Text
        console.log(`\n[3] Đang upload text vào: ${testFile1}`);
        await adapter.uploadText('Hello from Eden Log Bridge WebDAV Adapter!', testFile1);
        console.log('=> Upload text thành công.');

        // 4. Download Text
        console.log(`\n[4] Đang download text từ: ${testFile1}`);
        const textContent = await adapter.downloadText(testFile1);
        console.log('=> Nội dung tải về:', textContent);

        // 5. Upload Atomic
        const localTmpFile = path.join(__dirname, 'test-atomic-local.txt');
        fs.writeFileSync(localTmpFile, 'This is atomic upload content.');
        console.log(`\n[5] Đang upload atomic từ local file lên: ${testFile2}`);
        await adapter.uploadAtomic(localTmpFile, testFile2);
        console.log('=> Upload atomic thành công.');
        fs.unlinkSync(localTmpFile);

        // 6. List thư mục
        console.log(`\n[6] Đang liệt kê thư mục: ${testFolder}`);
        const files = await adapter.list(testFolder);
        console.log('=> Danh sách items trả về (bao gồm href):');
        files.forEach(f => console.log('   - ' + f));

        // 7. Xoá thư mục test
        console.log(`\n[7] Đang dọn dẹp thư mục test: ${testFolder}`);
        await adapter.delete(testFolder);
        console.log('=> Xoá thành công.');

        console.log('\n--- TẤT CẢ TEST ĐỀU PASS! ---');

    } catch (e) {
        console.error('\n[LỖI TRONG QUÁ TRÌNH TEST]:', e);
        if (e.status) {
            console.error(`=> HTTP Status: ${e.status}`);
        }
    }
}

runTests();
