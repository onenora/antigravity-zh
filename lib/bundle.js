const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const { loadConfig } = require('./config');
const { loadMessages } = require('./i18n/store');

const RUNTIME_DIR = path.join(paths.ROOT_DIR, 'runtime');
const readRuntime = (name) => fs.readFileSync(path.join(RUNTIME_DIR, name), 'utf8');

/** 配置、词条与 runtime 脚本的 mtime 签名，供守护进程判断是否需要热重载 */
function sourcesSignature() {
    const files = [paths.CONFIG_FILE, paths.USER_MESSAGES_FILE];
    for (const dir of [paths.LOCALE_DIR, RUNTIME_DIR]) {
        try { for (const f of fs.readdirSync(dir)) files.push(path.join(dir, f)); } catch {}
    }
    return files.map((f) => {
        try { const s = fs.statSync(f); return `${f}:${s.mtimeMs}:${s.size}`; } catch { return `${f}:0`; }
    }).join('|');
}

function buildBody(config) {
    if (!config.enabled) return { body: '', entries: 0 };
    const messages = loadMessages({ brandTitle: config.brandTitle });
    const parts = [`const AGZH_MESSAGES = ${JSON.stringify(messages)};`, readRuntime('translator.js'), readRuntime('i18n.js')];
    if (config.font && config.font.toLowerCase() !== 'none') {
        parts.push(`const AGZH_FONT = ${JSON.stringify(config.font)};`, readRuntime('font.js'));
    }
    return { body: parts.join('\n'), entries: Object.keys(messages).length };
}

/**
 * 生成注入载荷。外层包装负责：
 * - 仅在 Antigravity 主界面源（https://127.0.0.1:*）执行；
 * - 相同版本幂等跳过，新版本先 teardown 旧观察器与样式再加载。
 */
function buildBundle(config = loadConfig()) {
    const { body, entries } = buildBody(config);
    const version = crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
    const source = `(() => {
if (!/^https:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(location.origin)) return;
const VERSION = ${JSON.stringify(version)};
const prev = window.__agzh;
if (prev && prev.version === VERSION) return;
if (prev) { try { prev.teardown(); } catch (e) {} }
const teardowns = [];
const AGZH_ONTEARDOWN = (fn) => teardowns.push(fn);
const self = {
  version: VERSION,
  teardown() {
    while (teardowns.length) { try { teardowns.pop()(); } catch (e) {} }
    if (window.__agzh === self) delete window.__agzh;
  }
};
window.__agzh = self;
${body}
})();`;
    return { version, source, entries, config };
}

module.exports = { sourcesSignature, buildBundle };
