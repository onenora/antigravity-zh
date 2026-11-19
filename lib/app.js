const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');

const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const FUSE_CHUNK = 4 * 1024 * 1024;
const FUSE_OVERLAP = FUSE_SENTINEL.length + 32;

const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * 应用内更新（Squirrel.Mac）要求当前应用持有完整的 Google 签名；
 * 任何对 .app 内文件的改动都会破坏资源封印，导致更新被拒绝。
 */
function inspect() {
    const appPath = paths.APP_CANDIDATES.find((p) => fs.existsSync(p));
    if (!appPath) return null;
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    const version = run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist]).stdout.trim();
    const teamId = (/TeamIdentifier=(\S+)/.exec(run('codesign', ['-dv', appPath]).stderr) || [])[1] || null;
    const valid = run('codesign', ['--verify', '--strict', appPath]).status === 0;
    return { path: appPath, version, teamId, updatable: valid && teamId === paths.GOOGLE_TEAM_ID };
}

/** 分块扫描 Electron Framework 中的 Fuses 标志位，判断能否通过 CLI Inspect 注入主进程 */
function readElectronFuses(appPath) {
    const empty = { found: false, runAsNode: false, nodeOptions: false, cliInspect: false, asarIntegrity: false };
    if (!appPath) return empty;
    const bin = path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
    let fd;
    try {
        fd = fs.openSync(bin, 'r');
        const size = fs.fstatSync(fd).size;
        const buf = Buffer.allocUnsafe(FUSE_CHUNK);
        let offset = 0;
        while (offset < size) {
            const read = fs.readSync(fd, buf, 0, FUSE_CHUNK, offset);
            if (!read) break;
            const slice = buf.subarray(0, read);
            const idx = slice.indexOf(FUSE_SENTINEL);
            if (idx !== -1) {
                const abs = offset + idx + FUSE_SENTINEL.length;
                const tail = Buffer.allocUnsafe(32);
                const got = fs.readSync(fd, tail, 0, tail.length, abs);
                if (got < 2) return empty;
                const version = tail[0];
                const count = tail[1];
                const flags = tail.subarray(2, Math.min(got, 2 + count));
                const flag = (i) => i < flags.length && flags[i] === 0x31;
                return {
                    found: true,
                    version,
                    count,
                    runAsNode: flag(0),
                    nodeOptions: flag(2),
                    cliInspect: flag(3),
                    asarIntegrity: flag(4)
                };
            }
            if (offset + read >= size) break;
            offset += read - FUSE_OVERLAP;
        }
        return empty;
    } catch {
        return empty;
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
}

function resolveEngine(requestedEngine = 'auto', appPath) {
    const engine = requestedEngine || 'auto';
    if (engine === 'cdp') return 'cdp';
    const fuses = readElectronFuses(appPath);
    if (engine === 'hook') {
        if (!fuses.cliInspect) {
            throw new Error('当前 Antigravity 版本未启用 CLI Inspect Fuse，无法使用 hook 引擎，请改用 auto 或 cdp');
        }
        return 'hook';
    }
    if (engine === 'auto') return fuses.cliInspect ? 'hook' : 'cdp';
    throw new Error(`未知引擎: ${engine}`);
}

function readHookState(stateFile = paths.RUNTIME_STATE_FILE) {
    try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (!state || state.engine !== 'hook' || !Number.isInteger(state.pid) || state.pid <= 0) return null;
        try {
            process.kill(state.pid, 0);
            return state;
        } catch (e) {
            if (e && e.code === 'EPERM') return state;
            return null;
        }
    } catch {
        return null;
    }
}

function isRunning() {
    return Boolean(run('lsappinfo', ['find', 'bundleid=com.google.antigravity']).stdout.trim())
        || run('pgrep', ['-f', 'Antigravity\\.app/Contents/']).status === 0;
}

/** 退出当前运行中的 Antigravity 并等待进程结束 */
function quit(timeoutMs = 10000) {
    if (!isRunning()) return true;
    run('osascript', ['-e', 'tell application id "com.google.antigravity" to quit']);
    const deadline = Date.now() + timeoutMs;
    while (isRunning() && Date.now() < deadline) pause(200);
    return !isRunning();
}

/** 唤醒已运行的 Antigravity 到前台 */
function activate(appPath) {
    const res = run('open', ['-a', appPath]);
    if (res.status !== 0) throw new Error((res.stderr || res.stdout || '唤醒失败').trim());
}

function pickFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = addr && typeof addr === 'object' ? addr.port : 0;
            srv.close(() => (port ? resolve(port) : reject(new Error('无法分配空闲端口'))));
        });
    });
}

function fetchInspectorTarget(port, timeout = 500) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                try {
                    const list = JSON.parse(data);
                    resolve(Array.isArray(list) ? list.find((t) => t && t.webSocketDebuggerUrl) || null : null);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

async function injectViaInspector(port, hookPath, { timeoutMs = 8000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let target = null;
    while (Date.now() < deadline) {
        target = await fetchInspectorTarget(port);
        if (target && target.webSocketDebuggerUrl) break;
        await new Promise((r) => setTimeout(r, 40));
    }
    if (!target || !target.webSocketDebuggerUrl) {
        throw new Error(`等待主进程 Inspector 超时 (端口 ${port})，请改用 --engine cdp`);
    }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let seq = 0;
    const pending = new Map();
    let resolvePaused;
    const pausedPromise = new Promise((r) => { resolvePaused = r; });

    ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.id && pending.has(msg.id)) {
            const cb = pending.get(msg.id);
            pending.delete(msg.id);
            cb(msg);
            return;
        }
        if (msg.method === 'Debugger.paused' && resolvePaused) {
            const fn = resolvePaused;
            resolvePaused = null;
            fn(msg.params || {});
        }
    });

    await new Promise((resolve, reject) => {
        let settled = false;
        const fail = (err) => { if (!settled) { settled = true; reject(err); } };
        const timer = setTimeout(() => { try { ws.close(); } catch {} fail(new Error('Inspector WebSocket 连接超时')); }, 4000);
        ws.addEventListener('open', () => { clearTimeout(timer); if (!settled) { settled = true; resolve(); } });
        ws.addEventListener('error', () => { clearTimeout(timer); fail(new Error('Inspector WebSocket 连接失败')); });
        ws.addEventListener('close', () => {
            clearTimeout(timer);
            for (const cb of pending.values()) cb({ error: { message: 'closed' } });
            pending.clear();
            fail(new Error('Inspector WebSocket 已关闭'));
        });
    });

    const send = (method, params = {}) => new Promise((resolve) => {
        if (ws.readyState !== WebSocket.OPEN) return resolve({ error: { message: 'closed' } });
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); resolve({ error: { message: 'timeout' } }); }, 4000);
        pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
        try {
            ws.send(JSON.stringify({ id, method, params }));
        } catch (e) {
            clearTimeout(timer);
            pending.delete(id);
            resolve({ error: { message: e.message } });
        }
    });

    try {
        await send('Debugger.enable');
        await send('Runtime.enable');
        await send('Runtime.runIfWaitingForDebugger');
        await Promise.race([pausedPromise, new Promise((r) => setTimeout(r, 1500))]);

        const expr = `(() => {
            const m = process.getBuiltinModule ? process.getBuiltinModule('module') : require('module');
            m.createRequire(${JSON.stringify(hookPath)})(${JSON.stringify(hookPath)});
            return Boolean(globalThis.__agzhMainHooked);
        })()`;
        const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
        const exc = res.result && res.result.exceptionDetails;
        if (res.error || exc) {
            const msg = (res.error && res.error.message)
                || (exc && ((exc.exception && exc.exception.description) || exc.text))
                || '执行主进程 Hook 失败';
            throw new Error(msg);
        }
        const ok = res.result && res.result.result && res.result.result.value === true;
        if (!ok) throw new Error('主进程 Hook 加载未就绪');
    } finally {
        await send('Debugger.disable');
        await send('Debugger.resume');
        await send('Runtime.runIfWaitingForDebugger');
        try { ws.close(); } catch {}
    }
}

/** 按指定引擎启动 Antigravity（不修改 .app 包） */
async function launch(appPath, { engine = 'auto', hookPath = paths.MAIN_HOOK_FILE } = {}) {
    const actual = resolveEngine(engine, appPath);
    if (actual === 'hook') {
        if (!fs.existsSync(hookPath)) throw new Error(`未找到主进程 Hook 脚本: ${paths.tilde(hookPath)}`);
        const port = await pickFreePort();
        const res = run('open', ['-a', appPath, '--args', `--inspect-brk=127.0.0.1:${port}`]);
        if (res.status !== 0) throw new Error((res.stderr || res.stdout || '启动失败').trim());
        await injectViaInspector(port, hookPath);
        return { engine: 'hook', port };
    }
    const res = run('open', ['-a', appPath, '--args', '--remote-debugging-port=0']);
    if (res.status !== 0) throw new Error((res.stderr || res.stdout || '启动失败').trim());
    return { engine: 'cdp' };
}

module.exports = {
    inspect,
    readElectronFuses,
    resolveEngine,
    readHookState,
    isRunning,
    quit,
    activate,
    pickFreePort,
    injectViaInspector,
    launch
};
