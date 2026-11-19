const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const MAX_BYTES = 1024 * 1024;
const KEEP_BYTES = 200 * 1024;

/** 超过上限时原地截断保留尾部完整行，保持 inode 不变以兼容 LaunchAgent stdout 重定向 */
function rotateLog(file = paths.LOG_FILE, maxBytes = MAX_BYTES, keepBytes = KEEP_BYTES) {
    try {
        const stat = fs.statSync(file);
        if (stat.size <= maxBytes) return false;
        const fd = fs.openSync(file, 'r');
        let tail;
        try {
            const start = Math.max(0, stat.size - keepBytes);
            const len = stat.size - start;
            const buf = Buffer.allocUnsafe(len);
            fs.readSync(fd, buf, 0, len, start);
            const nl = buf.indexOf(0x0a);
            tail = nl >= 0 && nl + 1 < buf.length ? buf.subarray(nl + 1) : buf;
        } finally {
            fs.closeSync(fd);
        }
        fs.writeFileSync(file, tail);
        return true;
    } catch {
        return false;
    }
}

function appendLog(line, file = paths.LOG_FILE) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        rotateLog(file);
        fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
    } catch {}
}

module.exports = { rotateLog, appendLog, MAX_BYTES, KEEP_BYTES };
