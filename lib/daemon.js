const { buildBundle, sourcesSignature } = require('./bundle');
const { listAppTargets, Session } = require('./cdp');

const TICK_MS = 1500;
const VERIFY_EVERY = 10; // 每 N 个周期校验一次页面内版本，兜底异常丢失

function log(...args) {
    console.log(`[${new Date().toISOString()}]`, ...args);
}

class Injector {
    constructor() {
        this.sessions = new Map();
        this.connecting = new Set();
        this.bundle = null;
        this.sig = '';
        this.tickCount = 0;
        this.lastPort = null;
    }

    refreshBundle() {
        const sig = sourcesSignature();
        if (this.bundle && sig === this.sig) return false;
        this.sig = sig;
        this.bundle = buildBundle();
        log(`载荷已构建 v${this.bundle.version}（${this.bundle.entries} 条词条，enabled=${this.bundle.config.enabled}）`);
        return true;
    }

    async attach(target) {
        this.connecting.add(target.id);
        const s = new Session(target);
        try {
            await s.open();
            await s.send('Page.enable');
            await s.apply(this.bundle);
            this.sessions.set(target.id, s);
            log(`已注入 ${target.url} (${target.id.slice(0, 8)})`);
        } catch (e) {
            s.close();
            log(`注入失败 ${target.url}: ${e.message}`);
        } finally {
            this.connecting.delete(target.id);
        }
    }

    async tick() {
        this.tickCount++;
        const changed = this.refreshBundle();
        const { port, targets } = await listAppTargets();
        if (port !== this.lastPort) {
            if (port) log(`发现 DevTools 端口 ${port}`);
            this.lastPort = port;
        }

        const alive = new Set(targets.map((t) => t.id));
        for (const [id, s] of this.sessions) {
            if (s.closed || !alive.has(id)) { s.close(); this.sessions.delete(id); }
        }

        const verify = this.tickCount % VERIFY_EVERY === 0;
        await Promise.allSettled(targets.map(async (t) => {
            const s = this.sessions.get(t.id);
            if (!s) {
                if (!this.connecting.has(t.id)) await this.attach(t);
                return;
            }
            if (changed || (verify && (await s.currentVersion()) !== this.bundle.version)) {
                try { await s.apply(this.bundle); log(`已更新 ${t.id.slice(0, 8)} -> v${this.bundle.version}`); }
                catch (e) { log(`更新失败 ${t.id.slice(0, 8)}: ${e.message}`); }
            }
        }));
    }

    closeAll() {
        for (const s of this.sessions.values()) s.close();
        this.sessions.clear();
    }
}

/** 常驻模式：由 LaunchAgent 拉起，持续发现窗口并注入 */
async function runDaemon() {
    const inj = new Injector();
    log('antigravity-zh 守护进程启动');
    let busy = false;
    const loop = async () => {
        if (busy) return;
        busy = true;
        try { await inj.tick(); } catch (e) { log(`周期异常: ${e.message}`); }
        finally { busy = false; }
    };
    const stop = () => { inj.closeAll(); process.exit(0); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    await loop();
    setInterval(loop, TICK_MS);
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

module.exports = { runDaemon, runOnce, probe };
