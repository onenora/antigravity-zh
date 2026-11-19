const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');

const EXECUTABLE = 'antigravity-zh-launcher';
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 创建 ~/Applications/Antigravity 中文版.app：
 * - LSUIElement=true，启动后即拉起官方版并退出，不在 Dock 留双图标；
 * - 复用官方 icon.icns，支持从启动台、Spotlight、Dock 打开。
 */
function installLauncher(nodePath = process.execPath, appPath) {
    const contents = path.join(paths.LAUNCHER_APP, 'Contents');
    const macosDir = path.join(contents, 'MacOS');
    const resDir = path.join(contents, 'Resources');
    const executable = path.join(macosDir, EXECUTABLE);
    const cliPath = path.join(paths.RUNTIME_DIR, 'bin', 'cli.js');

    fs.rmSync(paths.LAUNCHER_APP, { recursive: true, force: true });
    fs.mkdirSync(macosDir, { recursive: true });
    fs.mkdirSync(resDir, { recursive: true });

    let hasIcon = false;
    if (appPath) {
        const srcIcon = path.join(appPath, 'Contents', 'Resources', 'icon.icns');
        if (fs.existsSync(srcIcon)) {
            fs.copyFileSync(srcIcon, path.join(resDir, 'icon.icns'));
            hasIcon = true;
        }
    }

    fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key><string>${paths.LAUNCHER_ID}</string>
    <key>CFBundleName</key><string>${xml(paths.LAUNCHER_NAME)}</string>
    <key>CFBundleDisplayName</key><string>${xml(paths.LAUNCHER_NAME)}</string>
    <key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>${require('../package.json').version}</string>${hasIcon ? '\n    <key>CFBundleIconFile</key><string>icon.icns</string>' : ''}
    <key>LSUIElement</key><true/>
</dict>
</plist>
`);

    fs.mkdirSync(path.dirname(paths.LOG_FILE), { recursive: true });
    fs.writeFileSync(executable, `#!/bin/sh
exec ${shellQuote(nodePath)} ${shellQuote(cliPath)} launch --from-launcher >> ${shellQuote(paths.LOG_FILE)} 2>&1
`, { mode: 0o755 });

    spawnSync('codesign', ['--force', '--sign', '-', paths.LAUNCHER_APP]);
    return paths.LAUNCHER_APP;
}

function uninstallLauncher() {
    fs.rmSync(paths.LAUNCHER_APP, { recursive: true, force: true });
}

function launcherStatus() {
    return {
        installed: fs.existsSync(paths.LAUNCHER_APP),
        path: paths.LAUNCHER_APP
    };
}

module.exports = { installLauncher, uninstallLauncher, launcherStatus };
