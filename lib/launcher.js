const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');

const EXECUTABLE = paths.LAUNCHER_NAME;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 使用系统原生 Swift 编译器构建 ~/Applications/Antigravity-zh.app：
 * - 运行期零 Node.js 依赖，直接原生完成 Fuse 扫描、--inspect-brk 注入与 CDP 降级；
 * - LSUIElement=true，启动后即拉起官方版并退出，不在 Dock 留双图标；
 * - 配置 NSAllowsLocalNetworking=true 允许访问 127.0.0.1 调试端口。
 */
function buildLauncher(appPath, { outputApp = paths.LAUNCHER_APP, sourceFile = paths.LAUNCHER_SRC } = {}) {
    if (!fs.existsSync(sourceFile)) {
        throw new Error(`未找到启动器源码: ${paths.tilde(sourceFile)}`);
    }
    const swiftCheck = spawnSync('swiftc', ['--version'], { encoding: 'utf8' });
    if (swiftCheck.status !== 0) {
        throw new Error('未找到 swiftc，请先运行 xcode-select --install 安装 Xcode Command Line Tools');
    }

    const contents = path.join(outputApp, 'Contents');
    const macosDir = path.join(contents, 'MacOS');
    const resDir = path.join(contents, 'Resources');
    const executable = path.join(macosDir, EXECUTABLE);

    fs.rmSync(outputApp, { recursive: true, force: true });
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

    const compile = spawnSync(
        'swiftc',
        ['-O', '-framework', 'AppKit', '-framework', 'Foundation', '-o', executable, sourceFile],
        { encoding: 'utf8' }
    );
    if (compile.status !== 0) {
        fs.rmSync(outputApp, { recursive: true, force: true });
        throw new Error(`Swift 启动器编译失败:\n${(compile.stderr || compile.stdout || '').trim()}`);
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
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key><true/>
    </dict>
    <key>AGZHRepoRoot</key><string>${xml(paths.ROOT_DIR)}</string>
</dict>
</plist>
`);

    const sign = spawnSync('codesign', ['--force', '--sign', '-', outputApp], { encoding: 'utf8' });
    if (sign.status !== 0) {
        throw new Error(`启动器签名失败: ${(sign.stderr || sign.stdout || '').trim()}`);
    }
    return outputApp;
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

module.exports = { buildLauncher, uninstallLauncher, launcherStatus };
