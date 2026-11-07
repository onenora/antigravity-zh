const fs = require('fs');
const http = require('http');
const paths = require('./paths');

/**
 * Antigravity 主进程启动时固定追加 `--remote-debugging-port=0`，
 * 由系统分配端口并写入 userData/DevToolsActivePort（首行为端口号）。
 */
function readPort(portFile = paths.DEVTOOLS_PORT_FILE) {
    try {
        const port = parseInt(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0], 10);
        return Number.isInteger(port) && port > 0 ? port : null;
    } catch {
        return null;
    }
}

function fetchTargets(port, timeout = 1500) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

/**
 * 仅注入 Antigravity 主界面（https://127.0.0.1:<语言服务端口>/），
 * 排除内置浏览器访问的 http://127.0.0.1、devtools 与 data: 页面。
 */
function isAppTarget(t) {
    return t && t.type === 'page' && t.webSocketDebuggerUrl && /^https:\/\/127\.0\.0\.1:\d+\//.test(t.url || '');
}

class Session {
    constructor(target) {
        this.id = target.id;
        this.url = target.webSocketDebuggerUrl;
        this.ws = null;
        this.seq = 0;
        this.pending = new Map();
        this.scriptId = null;
        this.version = null;
        this.closed = false;
    }

    open(timeout = 3000) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url);
            const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP 连接超时')); }, timeout);
            ws.addEventListener('open', () => { clearTimeout(timer); this.ws = ws; resolve(this); });
            ws.addEventListener('message', (ev) => {
                let msg;
                try { msg = JSON.parse(String(ev.data)); } catch { return; }
                const cb = msg.id && this.pending.get(msg.id);
                if (cb) { this.pending.delete(msg.id); cb(msg); }
            });
            const onClose = () => {
                clearTimeout(timer);
                this.closed = true;
                for (const cb of this.pending.values()) cb({ error: { message: 'closed' } });
                this.pending.clear();
                reject(new Error('CDP 连接已关闭'));
            };
            ws.addEventListener('close', onClose);
            ws.addEventListener('error', onClose);
        });
    }

    send(method, params = {}, timeout = 5000) {
        return new Promise((resolve) => {
            if (!this.ws || this.closed) return resolve({ error: { message: 'closed' } });
            const id = ++this.seq;
            const timer = setTimeout(() => { this.pending.delete(id); resolve({ error: { message: 'timeout' } }); }, timeout);
            this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    /** 注册到后续文档加载（刷新/导航），并立即作用于当前文档 */
    async apply(bundle) {
        if (this.scriptId) {
            await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId });
            this.scriptId = null;
        }
        const added = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: bundle.source });
        this.scriptId = added.result && added.result.identifier;
        const res = await this.send('Runtime.evaluate', { expression: bundle.source, returnByValue: true });
        const err = res.error || (res.result && res.result.exceptionDetails);
        if (err) throw new Error(err.message || (err.exception && err.exception.description) || err.text || '注入失败');
        this.version = bundle.version;
    }

    async currentVersion() {
        const res = await this.send('Runtime.evaluate', {
            expression: 'window.__agzh ? window.__agzh.version : null',
            returnByValue: true
        });
        return res.result && res.result.result ? res.result.result.value : null;
    }

    async teardown() {
        await this.send('Runtime.evaluate', { expression: 'window.__agzh && window.__agzh.teardown()' });
    }

    close() {
        this.closed = true;
        try { this.ws && this.ws.close(); } catch {}
    }
}

async function listAppTargets(port = readPort()) {
    if (!port) return { port: null, targets: [] };
    const all = await fetchTargets(port);
    return { port, reachable: Array.isArray(all), targets: (all || []).filter(isAppTarget) };
}

module.exports = { readPort, fetchTargets, isAppTarget, listAppTargets, Session };
