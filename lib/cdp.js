const fs = require('fs');
const http = require('http');
const paths = require('./paths');

/**
 * Antigravity 2.33.0 起不再默认开启 CDP，需在启动时传入 `--remote-debugging-port=0`，
 * 由系统分配端口并写入 userData/DevToolsActivePort（第 1 行为端口号，第 2 行为 Browser WS 路径）。
 */
function readActivePort(portFile = paths.DEVTOOLS_PORT_FILE) {
    try {
        const lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
        const port = parseInt(lines[0], 10);
        if (!Number.isInteger(port) || port <= 0) return null;
        const rawPath = (lines[1] || '').trim();
        const browserPath = rawPath.startsWith('/') ? rawPath : null;
        return { port, browserPath };
    } catch {
        return null;
    }
}

function readPort(portFile = paths.DEVTOOLS_PORT_FILE) {
    const info = readActivePort(portFile);
    return info ? info.port : null;
}

function fetchJson(port, pathName, timeout = 1500) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: pathName, timeout }, (res) => {
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

const fetchTargets = (port, timeout = 1500) => fetchJson(port, '/json/list', timeout);

async function fetchBrowserWsUrl(port, timeout = 1500) {
    const info = await fetchJson(port, '/json/version', timeout);
    return info && info.webSocketDebuggerUrl ? info.webSocketDebuggerUrl : null;
}

const isAppUrl = (url) => /^https:\/\/127\.0\.0\.1:\d+\//.test(url || '');
const isSwarmUrl = (url) => /^plugin:\/\/swarm--/i.test(url || '');
const isTargetUrl = (url) => isAppUrl(url) || isSwarmUrl(url);
const isAppTargetInfo = (t) => Boolean(t && t.type === 'page' && isAppUrl(t.url));
const isInjectableTargetInfo = (t) => Boolean(t && ((t.type === 'page' && isAppUrl(t.url)) || (t.type === 'iframe' && isSwarmUrl(t.url))));

/**
 * 仅注入 Antigravity 主界面（https://127.0.0.1:<语言服务端口>/），
 * 排除内置浏览器访问的 http://127.0.0.1、devtools 与 data: 页面。
 */
function isAppTarget(t) {
    return Boolean(t && t.webSocketDebuggerUrl && isAppTargetInfo(t));
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
            let settled = false;
            const ws = new WebSocket(this.url);
            const fail = (err) => {
                if (settled) return;
                settled = true;
                reject(err);
            };
            const timer = setTimeout(() => { try { ws.close(); } catch {} fail(new Error('CDP 连接超时')); }, timeout);
            ws.addEventListener('open', () => {
                clearTimeout(timer);
                if (settled) return;
                settled = true;
                this.ws = ws;
                resolve(this);
            });
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
                fail(new Error('CDP 连接已关闭'));
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
            try {
                this.ws.send(JSON.stringify({ id, method, params }));
            } catch (e) {
                clearTimeout(timer);
                this.pending.delete(id);
                resolve({ error: { message: e.message } });
            }
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

/**
 * 单连接 Browser-level CDP 会话（Flatten 模式）：
 * 通过 Target.setAutoAttach(waitForDebuggerOnStart: true) 在新页面 JS 执行前挂钩，消除首屏闪烁。
 */
class BrowserSession {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.seq = 0;
        this.pending = new Map();
        this.listeners = new Map();
        this.pages = new Map(); // sessionId -> { targetId, url, scriptId, version, evaluated }
        this.closed = false;
        this.onCloseCallback = null;
    }

    open(timeout = 3000) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const ws = new WebSocket(this.wsUrl);
            const fail = (err) => {
                if (settled) return;
                settled = true;
                reject(err);
            };
            const timer = setTimeout(() => { try { ws.close(); } catch {} fail(new Error('Browser CDP 连接超时')); }, timeout);
            ws.addEventListener('open', () => {
                clearTimeout(timer);
                if (settled) return;
                settled = true;
                this.ws = ws;
                resolve(this);
            });
            ws.addEventListener('message', (ev) => {
                let msg;
                try { msg = JSON.parse(String(ev.data)); } catch { return; }
                if (msg.id) {
                    const cb = this.pending.get(msg.id);
                    if (cb) { this.pending.delete(msg.id); cb(msg); }
                    return;
                }
                if (msg.method) {
                    const handlers = this.listeners.get(msg.method);
                    if (handlers) {
                        for (const fn of handlers) {
                            Promise.resolve(fn(msg.params || {}, msg.sessionId)).catch(() => {});
                        }
                    }
                }
            });
            const handleClose = () => {
                clearTimeout(timer);
                const wasClosed = this.closed;
                this.closed = true;
                for (const cb of this.pending.values()) cb({ error: { message: 'closed' } });
                this.pending.clear();
                this.pages.clear();
                fail(new Error('Browser CDP 连接已关闭'));
                if (!wasClosed && this.onCloseCallback) {
                    try { this.onCloseCallback(); } catch {}
                }
            };
            ws.addEventListener('close', handleClose);
            ws.addEventListener('error', handleClose);
        });
    }

    on(method, fn) {
        let list = this.listeners.get(method);
        if (!list) { list = []; this.listeners.set(method, list); }
        list.push(fn);
    }

    send(method, params = {}, { sessionId, timeout = 5000 } = {}) {
        return new Promise((resolve) => {
            if (!this.ws || this.closed) return resolve({ error: { message: 'closed' } });
            const id = ++this.seq;
            const timer = setTimeout(() => { this.pending.delete(id); resolve({ error: { message: 'timeout' } }); }, timeout);
            this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
            const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
            try {
                this.ws.send(JSON.stringify(payload));
            } catch (e) {
                clearTimeout(timer);
                this.pending.delete(id);
                resolve({ error: { message: e.message } });
            }
        });
    }

    async injectPage(sessionId, page, bundle, onLog) {
        if (!bundle || !bundle.source) return;
        const added = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: bundle.source }, { sessionId });
        if (added.result && added.result.identifier) page.scriptId = added.result.identifier;
        if (isTargetUrl(page.url)) {
            const res = await this.send('Runtime.evaluate', { expression: bundle.source, returnByValue: true }, { sessionId });
            const err = res.error || (res.result && res.result.exceptionDetails);
            if (!err) {
                page.version = bundle.version;
                page.evaluated = true;
                if (onLog) onLog(`已注入 ${page.url} (${page.targetId.slice(0, 8)})`);
            } else if (onLog) {
                onLog(`注入异常 ${page.url}: ${err.message || err.text || 'evaluate error'}`);
            }
        }
    }

    async startAutoAttach(getBundle, onLog = () => {}) {
        this.on('Target.attachedToTarget', async ({ sessionId, targetInfo, waitingForDebugger }) => {
            let keepAttached = false;
            try {
                const url = (targetInfo && targetInfo.url) || '';
                const candidate = Boolean(
                    targetInfo && (
                        isInjectableTargetInfo(targetInfo) ||
                        (targetInfo.type === 'page' && (!url || url === 'about:blank'))
                    )
                );
                if (candidate) {
                    keepAttached = true;
                    const page = { targetId: targetInfo.targetId, url, scriptId: null, version: null, evaluated: false };
                    this.pages.set(sessionId, page);
                    await this.send('Page.enable', {}, { sessionId });
                    await this.injectPage(sessionId, page, getBundle(), onLog);
                }
            } finally {
                if (waitingForDebugger) {
                    await this.send('Runtime.runIfWaitingForDebugger', {}, { sessionId });
                }
            }
            if (!keepAttached) {
                await this.send('Target.detachFromTarget', { sessionId });
            }
        });

        this.on('Target.targetInfoChanged', async ({ targetInfo }) => {
            if (!targetInfo) return;
            for (const [sessionId, page] of this.pages) {
                if (page.targetId !== targetInfo.targetId) continue;
                page.url = targetInfo.url || '';
                if (isTargetUrl(page.url)) {
                    if (!page.evaluated) {
                        const bundle = getBundle();
                        if (bundle && bundle.source && !page.scriptId) {
                            await this.injectPage(sessionId, page, bundle, onLog);
                        } else if (bundle && bundle.source) {
                            const res = await this.send('Runtime.evaluate', { expression: bundle.source, returnByValue: true }, { sessionId });
                            if (!(res.error || (res.result && res.result.exceptionDetails))) {
                                page.version = bundle.version;
                                page.evaluated = true;
                                onLog(`已注入 ${page.url} (${page.targetId.slice(0, 8)})`);
                            }
                        }
                    }
                } else if (page.url && page.url !== 'about:blank') {
                    if (page.scriptId) {
                        await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: page.scriptId }, { sessionId });
                    }
                    this.pages.delete(sessionId);
                    await this.send('Target.detachFromTarget', { sessionId });
                }
                break;
            }
        });

        this.on('Target.detachedFromTarget', ({ sessionId }) => {
            this.pages.delete(sessionId);
        });

        const dRes = await this.send('Target.setDiscoverTargets', { discover: true });
        if (dRes.error) throw new Error(dRes.error.message || 'Target.setDiscoverTargets 失败');
        const aRes = await this.send('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true
        });
        if (aRes.error) throw new Error(aRes.error.message || 'Target.setAutoAttach 失败');
    }

    async applyAll(bundle) {
        const entries = [...this.pages.entries()];
        await Promise.allSettled(entries.map(async ([sessionId, page]) => {
            if (page.scriptId) {
                await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: page.scriptId }, { sessionId });
                page.scriptId = null;
            }
            if (bundle && bundle.source) {
                const added = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: bundle.source }, { sessionId });
                if (added.result && added.result.identifier) page.scriptId = added.result.identifier;
            }
            if (isTargetUrl(page.url)) {
                const expr = bundle && bundle.source ? bundle.source : 'window.__agzh && window.__agzh.teardown()';
                const res = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }, { sessionId });
                if (!(res.error || (res.result && res.result.exceptionDetails))) {
                    page.version = bundle ? bundle.version : null;
                    page.evaluated = Boolean(bundle && bundle.source);
                }
            }
        }));
    }

    close() {
        this.closed = true;
        this.pages.clear();
        try { this.ws && this.ws.close(); } catch {}
    }
}

async function listAppTargets(port = readPort()) {
    if (!port) return { port: null, targets: [] };
    const all = await fetchTargets(port);
    return { port, reachable: Array.isArray(all), targets: (all || []).filter(isAppTarget) };
}

module.exports = {
    readActivePort,
    readPort,
    fetchTargets,
    fetchBrowserWsUrl,
    isAppUrl,
    isSwarmUrl,
    isTargetUrl,
    isAppTarget,
    listAppTargets,
    Session,
    BrowserSession
};
