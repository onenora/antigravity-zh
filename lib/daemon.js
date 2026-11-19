const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const app = require('./app');
const { rotateLog } = require('./log');
const { buildBundle, sourcesSignature } = require('./bundle');
const { readActivePort, fetchBrowserWsUrl, listAppTargets, BrowserSession, Session } = require('./cdp');

const RECONCILE_MS = 30000;
const PORT_DEBOUNCE_MS = 150;
const SOURCE_DEBOUNCE_MS = 250;

function log(...args) {
    rotateLog();
    console.log(`[${new Date().toISOString()}]`, ...args);
}

class EventDaemon {
    constructor() {
        this.browser = null;
        this.bundle = null;
        this.sig = '';
        this.lastPort = null;
        this.connecting = false;
        this.stopped = false;
        this.watchers = [];
        this.portWatcherActive = false;
        this.portTimer = null;
        this.sourceTimer = null;
        this.reconcileTimer = null;
    }

    refreshBundle() {
        const sig = sourcesSignature();
        if (this.bundle && sig === this.sig) return false;
        this.sig = sig;
        this.bundle = buildBundle();
        log(`载荷已构建 v${this.bundle.version}（${this.bundle.entries} 条词条，enabled=${this.bundle.config.enabled}）`);
        return true;
    }

    closeBrowser() {
        if (!this.browser) return;
        try { this.browser.close(); } catch {}
        this.browser = null;
    }

    async sync() {
        if (this.stopped || this.connecting) return;
        this.refreshBundle();

        if (app.readHookState()) {
            if (this.browser) {
                this.closeBrowser();
                this.lastPort = null;
                log('检测到主进程 Hook 活跃，停止 CDP 会话');
            }
            return;
        }

        this.ensurePortWatcher();
        const active = readActivePort();
        if (!active) {
            if (this.browser) {
                this.closeBrowser();
                log('DevToolsActivePort 已移除，断开 CDP 会话');
            }
            this.lastPort = null;
            return;
        }

        if (this.browser && !this.browser.closed && active.port === this.lastPort) return;

        this.connecting = true;
        this.closeBrowser();
        try {
            const wsUrl = active.browserPath
                ? `ws://127.0.0.1:${active.port}${active.browserPath}`
                : await fetchBrowserWsUrl(active.port);
            if (!wsUrl) return;

            const session = new BrowserSession(wsUrl);
            session.onCloseCallback = () => {
                if (this.browser === session) {
                    this.browser = null;
                    this.lastPort = null;
                }
            };
            await session.open();
            if (this.stopped) { session.close(); return; }
            await session.startAutoAttach(() => this.bundle, log);
            this.browser = session;
            this.lastPort = active.port;
            log(`已连接 Browser CDP (端口 ${active.port}，事件驱动 autoAttach)`);
        } catch (e) {
            log(`CDP 连接失败 (端口 ${active.port}): ${e.message}`);
        } finally {
            this.connecting = false;
        }
    }

    scheduleSync() {
        if (this.stopped) return;
        clearTimeout(this.portTimer);
        this.portTimer = setTimeout(() => { void this.sync(); }, PORT_DEBOUNCE_MS);
    }

    scheduleSourceReload() {
        if (this.stopped) return;
        clearTimeout(this.sourceTimer);
        this.sourceTimer = setTimeout(async () => {
            try {
                if (!this.refreshBundle()) return;
                if (this.browser && !this.browser.closed) {
                    await this.browser.applyAll(this.bundle);
                    log(`已热更新全部窗口 -> v${this.bundle.version}`);
                }
            } catch (e) {
                log(`热更新异常: ${e.message}`);
            }
        }, SOURCE_DEBOUNCE_MS);
    }

    ensurePortWatcher() {
        if (this.portWatcherActive || this.stopped) return;
        const dir = path.dirname(paths.DEVTOOLS_PORT_FILE);
        const base = path.basename(paths.DEVTOOLS_PORT_FILE);
        if (!fs.existsSync(dir)) return;
        try {
            const w = fs.watch(dir, (_ev, filename) => {
                if (!filename || filename === base) this.scheduleSync();
            });
            w.on('error', () => { this.portWatcherActive = false; });
            this.watchers.push(w);
            this.portWatcherActive = true;
        } catch {}
    }

    startWatchers() {
        this.ensurePortWatcher();
        const runtimeStateName = path.basename(paths.RUNTIME_STATE_FILE);
        for (const dir of [paths.DATA_DIR, paths.LOCALE_DIR, path.join(paths.ROOT_DIR, 'runtime')]) {
            try {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const w = fs.watch(dir, (_ev, filename) => {
                    if (dir === paths.DATA_DIR && filename === runtimeStateName) {
                        this.scheduleSync();
                        return;
                    }
                    this.scheduleSourceReload();
                });
                w.on('error', () => {});
                this.watchers.push(w);
            } catch {}
        }
    }

    start() {
        this.refreshBundle();
        this.startWatchers();
        void this.sync();
        this.reconcileTimer = setInterval(() => { void this.sync(); }, RECONCILE_MS);
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.portTimer);
        clearTimeout(this.sourceTimer);
        clearInterval(this.reconcileTimer);
        while (this.watchers.length) {
            try { this.watchers.pop().close(); } catch {}
        }
        this.closeBrowser();
    }
}

/** 常驻模式：由 LaunchAgent 拉起，事件驱动监听端口与文件变更（降级 CDP 兜底） */
async function runDaemon() {
    const daemon = new EventDaemon();
    log('antigravity-zh 守护进程启动（事件驱动模式）');
    const stop = () => { daemon.stop(); process.exit(0); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    daemon.start();
}

/** 对当前全部主窗口各开一个短连接执行 fn，结束即断开 */
async function forEachWindow(fn) {
    const { port, reachable, targets } = await listAppTargets();
    if (!port || !reachable) return { port, reachable: false, results: [] };
    const results = await Promise.all(targets.map(async (t) => {
        const s = new Session(t);
        try { await s.open(); return { url: t.url, ok: true, ...(await fn(s)) }; }
        catch (e) { return { url: t.url, ok: false, error: e.message }; }
        finally { s.close(); }
    }));
    return { port, reachable: true, results };
}

/** 单次注入（不常驻，刷新后失效）；teardown=true 时停止窗口内引擎 */
async function runOnce({ teardown = false } = {}) {
    const bundle = buildBundle();
    const res = await forEachWindow((s) => (teardown ? s.teardown() : s.apply(bundle)).then(() => ({})));
    return { ...res, bundle };
}

/** 读取各窗口当前注入版本 */
async function probe() {
    return forEachWindow(async (s) => ({ version: await s.currentVersion() }));
}

module.exports = { runDaemon, runOnce, probe, EventDaemon };
