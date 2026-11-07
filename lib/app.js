const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');

const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

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

module.exports = { inspect };
