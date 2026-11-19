const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const { loadConfig } = require('./config');
const { loadMessages } = require('./i18n/store');

const RUNTIME_DIR = path.join(paths.ROOT_DIR, 'runtime');
const readRuntime = (name) => fs.readFileSync(path.join(RUNTIME_DIR, name), 'utf8');
const SIGNATURE_FILES = [
    paths.CONFIG_FILE,
    paths.USER_MESSAGES_FILE,
    path.join(paths.LOCALE_DIR, 'messages.json'),
    path.join(paths.LOCALE_DIR, 'native.json'),
    path.join(RUNTIME_DIR, 'translator.js'),
    path.join(RUNTIME_DIR, 'i18n.js'),
    path.join(RUNTIME_DIR, 'font.js'),
    path.join(RUNTIME_DIR, 'metrics.js'),
    path.join(RUNTIME_DIR, 'main-hook.js')
];

/** 运行时依赖文件（配置、词条与脚本）的 mtime 签名，供守护进程与主进程 Hook 判断是否需要热重载 */
function sourcesSignature() {
    return SIGNATURE_FILES.map((f) => {
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
 * - 仅在 Antigravity 主界面（https://127.0.0.1:* 顶层窗口）与内置 Swarm 协作面板（plugin://swarm--*）执行；
 * - 相同版本幂等跳过，新版本先 teardown 旧观察器与样式（并还原原文）再加载。
 */
function buildBundle(config = loadConfig()) {
    const { body, entries } = buildBody(config);
    const version = crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
    const source = `(() => {
const isMain = /^https:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(location.origin) && window.top === window;
const isSwarm = /^plugin:\\/\\/swarm--[^/]+$/i.test(location.origin) && location.href !== 'about:srcdoc';
if (!isMain && !isSwarm) return;
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

/**
 * 生成独立遥测胶囊载荷，与 buildBundle 完全解耦：
 * 开关 config.metrics 不会改变 window.__agzh.version，不会触发汉化重注或原文闪烁。
 */
function buildMetricsBundle(config = loadConfig(), initialSnapshot = null) {
    const enabled = Boolean(config.metrics);
    const font = config.font && config.font.toLowerCase() !== 'none' ? config.font : '';
    const body = enabled ? readRuntime('metrics.js') : '';
    const version = crypto.createHash('sha1').update(`metrics:${enabled}:${font}:${body}`).digest('hex').slice(0, 12);
    const source = `(() => {
const isMain = /^https:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(location.origin) && window.top === window;
if (!isMain) return;
const VERSION = ${JSON.stringify(version)};
const initSnap = ${JSON.stringify(initialSnapshot)};
const prev = window.__agzhMetrics;
if (prev && prev.version === VERSION) {
  if (initSnap && typeof prev.update === 'function') { try { prev.update(initSnap); } catch (e) {} }
  return;
}
if (prev) { try { prev.teardown(); } catch (e) {} }
const teardowns = [];
const AGZH_ONTEARDOWN = (fn) => teardowns.push(fn);
let updater = null;
const AGZH_METRICS_REGISTER = (fn) => { updater = fn; };
const AGZH_METRICS_INIT = initSnap;
const AGZH_METRICS_FONT = ${JSON.stringify(font)};
const self = {
  version: VERSION,
  update(snapshot) {
    if (typeof updater === 'function') updater(snapshot);
  },
  teardown() {
    while (teardowns.length) { try { teardowns.pop()(); } catch (e) {} }
    if (window.__agzhMetrics === self) delete window.__agzhMetrics;
  }
};
window.__agzhMetrics = self;
${body}
})();`;
    return { version, source, enabled, config };
}

function buildMetricsUpdateScript(snapshot) {
    return `(() => { const m = window.__agzhMetrics; if (m && typeof m.update === 'function') m.update(${JSON.stringify(snapshot)}); })();`;
}

module.exports = { sourcesSignature, buildBundle, buildMetricsBundle, buildMetricsUpdateScript };
