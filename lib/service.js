const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const paths = require('./paths');

const RUNTIME_ENTRIES = ['bin', 'lib', 'runtime', 'locale', 'package.json'];
const target = () => `gui/${os.userInfo().uid}/${paths.AGENT_LABEL}`;
const launchctl = (...args) => spawnSync('launchctl', args, { encoding: 'utf8' });
const loaded = () => launchctl('print', target()).status === 0;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 复制运行时到 ~/.antigravity-zh/app，仓库目录移动或删除后守护进程仍可运行 */
function deployRuntime() {
    if (paths.ROOT_DIR === paths.RUNTIME_DIR) return;
    fs.rmSync(paths.RUNTIME_DIR, { recursive: true, force: true });
    for (const entry of RUNTIME_ENTRIES) {
        fs.cpSync(path.join(paths.ROOT_DIR, entry), path.join(paths.RUNTIME_DIR, entry), { recursive: true });
    }
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const EXECUTABLE = 'antigravity-zh';

/**
 * 最小后台应用包：Info.plist 提供显示名称，可执行文件为启动守护进程的脚本。
 * 直接以 node 为程序时，系统设置只会显示 node 的签名者 "Node.js Foundation"。
 */
function buildApp(nodePath) {
    const contents = path.join(paths.AGENT_APP, 'Contents');
    const executable = path.join(contents, 'MacOS', EXECUTABLE);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key><string>${paths.AGENT_LABEL}</string>
    <key>CFBundleName</key><string>${xml(paths.AGENT_NAME)}</string>
    <key>CFBundleDisplayName</key><string>${xml(paths.AGENT_NAME)}</string>
    <key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>${require('../package.json').version}</string>
    <key>LSBackgroundOnly</key><true/>
</dict>
</plist>
`);
    fs.writeFileSync(executable, `#!/bin/sh
exec ${shellQuote(nodePath)} ${shellQuote(path.join(paths.RUNTIME_DIR, 'bin', 'cli.js'))} daemon
`, { mode: 0o755 });
    // ad-hoc 签名使应用包身份完整；失败不影响运行
    spawnSync('codesign', ['--force', '--sign', '-', paths.AGENT_APP]);
    return executable;
}

function buildPlist(executable) {
    const argv = [executable];
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${paths.AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argv.map((a) => `        <string>${xml(a)}</string>`).join('\n')}
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>${xml(paths.LOG_FILE)}</string>
    <key>StandardErrorPath</key><string>${xml(paths.LOG_FILE)}</string>
</dict>
</plist>
`;
}

/** bootout 异步完成；旧服务未移除前 bootstrap 会报 "5: Input/output error" */
function unload() {
    launchctl('bootout', target());
    for (let i = 0; i < 50 && loaded(); i++) pause(100);
}

function load() {
    launchctl('enable', target());
    let res;
    for (let i = 0; i < 3; i++) {
        res = launchctl('bootstrap', `gui/${os.userInfo().uid}`, paths.AGENT_PLIST);
        if (res.status === 0) return;
        pause(500);
    }
    throw new Error(`LaunchAgent 加载失败: ${(res.stderr || res.stdout).trim()}`);
}

function install(nodePath = process.execPath) {
    unload();
    deployRuntime();
    fs.mkdirSync(path.dirname(paths.AGENT_PLIST), { recursive: true });
    fs.mkdirSync(path.dirname(paths.LOG_FILE), { recursive: true });
    fs.writeFileSync(paths.AGENT_PLIST, buildPlist(buildApp(nodePath)));
    load();
}

function uninstall() {
    unload();
    fs.rmSync(paths.AGENT_PLIST, { force: true });
    fs.rmSync(paths.RUNTIME_DIR, { recursive: true, force: true });
}

function status() {
    const res = launchctl('print', target());
    if (res.status !== 0) return { loaded: false, pid: null };
    const pid = /\bpid = (\d+)/.exec(res.stdout);
    return { loaded: true, pid: pid ? Number(pid[1]) : null };
}

module.exports = { install, uninstall, status };
