const path = require('path');
const os = require('os');

const HOME = os.homedir();
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(HOME, '.antigravity-zh');
const AGENT_LABEL = 'com.onenora.antigravity-zh';
const AGENT_NAME = 'Antigravity 汉化';
const LAUNCHER_ID = 'com.onenora.antigravity-zh.launcher';
const LAUNCHER_NAME = 'Antigravity 中文版';
const RUNTIME_DIR = path.join(DATA_DIR, 'app');

/** 输出用：家目录前缀替换为 ~ */
const tilde = (p) => (p === HOME || p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p);

module.exports = {
    ROOT_DIR,
    LOCALE_DIR: path.join(ROOT_DIR, 'locale'),
    DATA_DIR,
    RUNTIME_DIR,
    CONFIG_FILE: path.join(DATA_DIR, 'config.json'),
    USER_MESSAGES_FILE: path.join(DATA_DIR, 'messages.json'),
    RUNTIME_STATE_FILE: path.join(DATA_DIR, 'runtime-state.json'),
    MAIN_HOOK_FILE: path.join(RUNTIME_DIR, 'runtime', 'main-hook.js'),
    LOG_FILE: path.join(HOME, 'Library', 'Logs', 'antigravity-zh.log'),
    AGENT_LABEL,
    AGENT_NAME,
    LAUNCHER_ID,
    LAUNCHER_NAME,
    LAUNCHER_APP: path.join(HOME, 'Applications', `${LAUNCHER_NAME}.app`),
    // 后台服务以该应用包启动，系统设置「登录项与扩展」中显示 AGENT_NAME
    AGENT_APP: path.join(RUNTIME_DIR, `${AGENT_NAME}.app`),
    AGENT_PLIST: path.join(HOME, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`),
    DEVTOOLS_PORT_FILE: path.join(HOME, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'),
    APP_CANDIDATES: [
        '/Applications/Antigravity.app',
        path.join(HOME, 'Applications', 'Antigravity.app')
    ],
    GOOGLE_TEAM_ID: 'EQHXZ8M8AV',
    tilde
};
