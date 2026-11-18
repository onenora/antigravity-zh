const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');

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

/** 以 --remote-debugging-port=0 启动 Antigravity（不修改 .app 包） */
function launch(appPath) {
    const res = run('open', ['-a', appPath, '--args', '--remote-debugging-port=0']);
    if (res.status !== 0) throw new Error((res.stderr || res.stdout || '启动失败').trim());
}

module.exports = { inspect, isRunning, quit, launch };
