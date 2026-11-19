/**
 * Electron 主进程 Hook 引擎（通过 --inspect-brk 一次性注入主进程并自动关闭临时调试端口）。
 *
 * 职责：
 *   1. 首毫秒清理 NODE_OPTIONS 中的残留引用，并自动关闭临时 Inspector 端口，确保运行期零开放端口、零子进程污染；
 *   2. 通过 Module._load 属性陷阱拦截 require('electron')（兼容 Electron browser_init 后置覆盖）；
 *   3. 在主界面 WebContents dom-ready / did-finish-load 时直接注入汉化载荷，消除英文首屏闪烁；
 *   4. 汉化原生菜单栏、Dock 菜单、系统托盘与原生弹窗，同时保持程序内部英文标识查表不受影响；
 *   5. 通过 fs.watch 在主进程内完成配置/词条热更新与即时回滚，无需常驻外部守护进程。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

function stripSelfFromNodeOptions(raw, hookFile) {
    if (!raw) return '';
    const tokens = raw.match(/(?:"[^"]*"|'[^']*'|\S)+/g) || [];
    const unquote = (s) => s.replace(/^(['"])(.*)\1$/, '$2');
    const isSelf = (p) => {
        const u = unquote(p);
        return u === hookFile || u.endsWith('/main-hook.js') || u.endsWith('\\main-hook.js') || u === 'main-hook.js';
    };
    const kept = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const eq = /^(--require|-r)=(.+)$/.exec(t);
        if (eq && isSelf(eq[2])) continue;
        if ((t === '--require' || t === '-r') && i + 1 < tokens.length && isSelf(tokens[i + 1])) {
            i++;
            continue;
        }
        kept.push(t);
    }
    return kept.join(' ');
}

const cleanedNodeOptions = stripSelfFromNodeOptions(process.env.NODE_OPTIONS, __filename);
if (cleanedNodeOptions) process.env.NODE_OPTIONS = cleanedNodeOptions;
else delete process.env.NODE_OPTIONS;

if (!process.versions || !process.versions.electron || process.type !== 'browser') return;
if (globalThis.__agzhMainHooked) return;
globalThis.__agzhMainHooked = true;

const paths = require('../lib/paths');
const { loadConfig } = require('../lib/config');
const { buildBundle, sourcesSignature } = require('../lib/bundle');
const { loadNativeMessages } = require('../lib/i18n/store');
const { appendLog } = require('../lib/log');
const { createTranslator } = require('./translator');

const APP_URL_RE = /^https:\/\/127\.0\.0\.1:\d+\//;
const RELOAD_DEBOUNCE_MS = 300;
const startedAt = new Date().toISOString();

const state = {
    config: null,
    bundle: null,
    sig: '',
    nativeTranslator: null
};

const appContents = new Set();
const watchers = [];
const patchedModules = new WeakMap();
const hookedApps = new WeakSet();
const hookedTrays = new WeakSet();
const dynamicLabelHooked = new WeakSet();
const suppressLabelRecord = new WeakSet();

const origLabels = new WeakMap();
const origSublabels = new WeakMap();
const origToolTips = new WeakMap();

let appMenuRef = null;
let dockMenuRef = null;
let dockTargetRef = null;
const trackedTrays = new Set(); // Set<{ trayRef: WeakRef, menuRef: WeakRef }>
let electronApis = null;
let reloadTimer = null;

function logHook(msg) {
    appendLog(`[hook:${process.pid}] ${msg}`);
}

function refreshBundleState() {
    const sig = sourcesSignature();
    if (state.bundle && sig === state.sig) return false;
    state.sig = sig;
    state.config = loadConfig();
    state.bundle = buildBundle(state.config);
    state.nativeTranslator = state.config.enabled
        ? createTranslator(loadNativeMessages({ brandTitle: state.config.brandTitle }))
        : null;
    return true;
}

refreshBundleState();
logHook(`主进程 Hook 已加载 v${state.bundle.version} (enabled=${state.config.enabled})`);

// 临时 --inspect-brk 端口仅用于首毫秒注入，延迟关闭以确保主进程已安全恢复执行
const closeInspectorTimer = setTimeout(() => {
    try {
        const inspector = process.getBuiltinModule ? process.getBuiltinModule('inspector') : require('inspector');
        if (inspector && typeof inspector.url === 'function' && inspector.url()) {
            inspector.close();
            logHook('已关闭临时 Inspector 端口');
        }
    } catch {}
}, 500);
if (closeInspectorTimer.unref) closeInspectorTimer.unref();

function translateNativeText(text) {
    if (typeof text !== 'string' || !text.trim() || !state.config.enabled || !state.nativeTranslator) return text;
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    const out = state.nativeTranslator.translate(core);
    if (!out) return text;
    return lead + out + trail;
}

function writeRuntimeState() {
    try {
        fs.mkdirSync(paths.DATA_DIR, { recursive: true });
        const windows = [];
        for (const wc of appContents) {
            try {
                if (!wc.isDestroyed()) {
                    const u = wc.getURL();
                    if (APP_URL_RE.test(u)) windows.push(u);
                }
            } catch {}
        }
        fs.writeFileSync(paths.RUNTIME_STATE_FILE, JSON.stringify({
            engine: 'hook',
            pid: process.pid,
            version: state.bundle ? state.bundle.version : null,
            enabled: Boolean(state.config && state.config.enabled),
            startedAt,
            windows
        }, null, 2) + '\n');
    } catch {}
}

function removeRuntimeState() {
    try {
        const current = JSON.parse(fs.readFileSync(paths.RUNTIME_STATE_FILE, 'utf8'));
        if (current && current.pid && current.pid !== process.pid) return;
    } catch {}
    try { fs.rmSync(paths.RUNTIME_STATE_FILE, { force: true }); } catch {}
}

function findProtoDescriptor(obj, prop) {
    let cur = obj;
    while (cur && cur !== Object.prototype) {
        const desc = Object.getOwnPropertyDescriptor(cur, prop);
        if (desc) return desc;
        cur = Object.getPrototypeOf(cur);
    }
    return null;
}

/** 对动态修改 label 的菜单项（如 check-for-updates）挂钩 setter，兼顾界面汉化与程序内英文读回 */
function installDynamicLabelHook(item) {
    if (!item || typeof item !== 'object' || dynamicLabelHooked.has(item)) return;
    dynamicLabelHooked.add(item);
    const ownDesc = Object.getOwnPropertyDescriptor(item, 'label');
    const protoDesc = findProtoDescriptor(Object.getPrototypeOf(item), 'label');
    const desc = ownDesc && (ownDesc.get || ownDesc.set) ? ownDesc : protoDesc;
    let current = item.label;
    try {
        Object.defineProperty(item, 'label', {
            configurable: true,
            enumerable: true,
            get() {
                return desc && desc.get ? desc.get.call(this) : current;
            },
            set(val) {
                if (!suppressLabelRecord.has(this) && typeof val === 'string') {
                    origLabels.set(this, val);
                }
                const next = !suppressLabelRecord.has(this) && typeof val === 'string' && state.config.enabled
                    ? translateNativeText(val)
                    : val;
                current = next;
                if (desc && desc.set) desc.set.call(this, next);
            }
        });
    } catch {}
}

function wrapClickMenuItem(menuItem) {
    if (!menuItem || typeof menuItem !== 'object') return menuItem;
    return new Proxy(menuItem, {
        get(target, prop) {
            if (prop === 'label' && origLabels.has(target)) return origLabels.get(target);
            const val = Reflect.get(target, prop, target);
            return typeof val === 'function' ? val.bind(target) : val;
        }
    });
}

function setItemProp(item, prop, map, enable) {
    const cur = item[prop];
    if (typeof cur !== 'string') return;
    if (!map.has(item)) {
        map.set(item, cur);
    } else {
        const rawPrev = map.get(item);
        const prevTranslated = translateNativeText(rawPrev);
        // 应用主动写入新英文值（如 Tray 更新正在运行的智能体数量）时刷新原值记录
        if (cur !== rawPrev && cur !== prevTranslated) {
            map.set(item, cur);
        }
    }
    const raw = map.get(item);
    const next = enable ? translateNativeText(raw) : raw;
    if (cur !== next) {
        if (prop === 'label') suppressLabelRecord.add(item);
        try { item[prop] = next; } catch {}
        finally { if (prop === 'label') suppressLabelRecord.delete(item); }
    }
}

function applyMenuTranslation(menu, enable) {
    if (!menu || !Array.isArray(menu.items)) return;
    for (const item of menu.items) {
        if (!item) continue;
        if (item.id === 'check-for-updates') installDynamicLabelHook(item);
        setItemProp(item, 'label', origLabels, enable);
        setItemProp(item, 'sublabel', origSublabels, enable);
        setItemProp(item, 'toolTip', origToolTips, enable);
        if (item.submenu) applyMenuTranslation(item.submenu, enable);
    }
}

function syncBuiltMenuOriginals(template, menu) {
    if (!Array.isArray(template) || !menu || !Array.isArray(menu.items)) return;
    const len = Math.min(template.length, menu.items.length);
    for (let i = 0; i < len; i++) {
        const tpl = template[i];
        const item = menu.items[i];
        if (!tpl || !item) continue;
        if (typeof tpl.label === 'string') origLabels.set(item, tpl.label);
        if (typeof tpl.sublabel === 'string') origSublabels.set(item, tpl.sublabel);
        if (typeof tpl.toolTip === 'string') origToolTips.set(item, tpl.toolTip);
        if (item.id === 'check-for-updates') installDynamicLabelHook(item);
        if (Array.isArray(tpl.submenu) && item.submenu) {
            syncBuiltMenuOriginals(tpl.submenu, item.submenu);
        }
    }
}

function cloneTemplate(template, enable) {
    if (!Array.isArray(template)) return template;
    return template.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const copy = { ...entry };
        if (enable) {
            if (typeof copy.label === 'string') copy.label = translateNativeText(copy.label);
            if (typeof copy.sublabel === 'string') copy.sublabel = translateNativeText(copy.sublabel);
            if (typeof copy.toolTip === 'string') copy.toolTip = translateNativeText(copy.toolTip);
        }
        if (typeof copy.click === 'function') {
            const origClick = copy.click;
            copy.click = function wrappedTemplateClick(menuItem, ...rest) {
                return origClick.call(this, wrapClickMenuItem(menuItem), ...rest);
            };
        }
        if (Array.isArray(copy.submenu)) {
            copy.submenu = cloneTemplate(copy.submenu, enable);
        }
        return copy;
    });
}

function translateDialogOptions(opts) {
    if (!opts || typeof opts !== 'object') return opts;
    const copy = { ...opts };
    for (const key of ['title', 'message', 'detail', 'checkboxLabel']) {
        if (typeof copy[key] === 'string') copy[key] = translateNativeText(copy[key]);
    }
    if (Array.isArray(copy.buttons)) {
        copy.buttons = copy.buttons.map((b) => (typeof b === 'string' ? translateNativeText(b) : b));
    }
    return copy;
}

function injectWebContents(wc) {
    try {
        if (!wc || wc.isDestroyed()) return;
        const url = wc.getURL();
        if (!APP_URL_RE.test(url)) {
            if (appContents.delete(wc)) writeRuntimeState();
            return;
        }
        const isNew = !appContents.has(wc);
        appContents.add(wc);
        if (state.config && state.config.enabled && state.bundle && state.bundle.source) {
            void Promise.resolve(wc.executeJavaScript(state.bundle.source, true)).catch(() => {});
            if (isNew) logHook(`已注入主窗口 ${url}`);
        }
        writeRuntimeState();
    } catch {}
}

function attachWebContents(wc, injectNow = false) {
    if (!wc || typeof wc.on !== 'function') return;
    const onReady = () => injectWebContents(wc);
    wc.on('dom-ready', onReady);
    wc.on('did-finish-load', onReady);
    wc.on('did-navigate-in-page', onReady);
    wc.on('destroyed', () => {
        if (appContents.delete(wc)) writeRuntimeState();
    });
    if (injectNow && typeof wc.getURL === 'function' && APP_URL_RE.test(wc.getURL())) {
        injectWebContents(wc);
    }
}

function reloadAll() {
    try {
        if (!refreshBundleState()) return;
        logHook(`热更新载荷 v${state.bundle.version} (enabled=${state.config.enabled})`);
        const enable = Boolean(state.config.enabled);

        for (const wc of [...appContents]) {
            try {
                if (wc.isDestroyed()) { appContents.delete(wc); continue; }
                if (!APP_URL_RE.test(wc.getURL())) continue;
                const expr = enable ? state.bundle.source : 'window.__agzh && window.__agzh.teardown()';
                if (expr) void Promise.resolve(wc.executeJavaScript(expr, true)).catch(() => {});
            } catch {}
        }

        if (appMenuRef && electronApis && electronApis.origSetApplicationMenu) {
            try {
                applyMenuTranslation(appMenuRef, enable);
                electronApis.origSetApplicationMenu.call(electronApis.RealMenu, appMenuRef);
            } catch {}
        }

        if (dockMenuRef && dockTargetRef && electronApis && electronApis.origDockSetMenu) {
            try {
                applyMenuTranslation(dockMenuRef, enable);
                electronApis.origDockSetMenu.call(dockTargetRef, dockMenuRef);
            } catch {}
        }

        for (const entry of [...trackedTrays]) {
            const tray = entry.trayRef.deref();
            const menu = entry.menuRef.deref();
            if (!tray || !menu) { trackedTrays.delete(entry); continue; }
            try {
                applyMenuTranslation(menu, enable);
                electronApis.origTraySetContextMenu.call(tray, menu);
            } catch {}
        }

        writeRuntimeState();
    } catch (e) {
        logHook(`热更新异常: ${e.message}`);
    }
}

function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reloadAll, RELOAD_DEBOUNCE_MS);
    if (reloadTimer.unref) reloadTimer.unref();
}

function startWatchers() {
    if (watchers.length) return;
    for (const dir of [paths.DATA_DIR, paths.LOCALE_DIR]) {
        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const w = fs.watch(dir, () => scheduleReload());
            if (w.unref) w.unref();
            watchers.push(w);
        } catch {}
    }
}

function cleanupRuntime() {
    clearTimeout(reloadTimer);
    while (watchers.length) {
        try { watchers.pop().close(); } catch {}
    }
    removeRuntimeState();
}

function patchElectron(electron) {
    if (patchedModules.has(electron)) return patchedModules.get(electron);

    const RealApp = electron.app;
    const RealMenu = electron.Menu;
    const RealMenuItem = electron.MenuItem;
    const RealTray = electron.Tray;
    const RealDialog = electron.dialog;

    const origBuildFromTemplate = RealMenu && typeof RealMenu.buildFromTemplate === 'function'
        ? RealMenu.buildFromTemplate.bind(RealMenu)
        : null;
    const origSetApplicationMenu = RealMenu && typeof RealMenu.setApplicationMenu === 'function'
        ? RealMenu.setApplicationMenu
        : null;
    const origTraySetContextMenu = RealTray && RealTray.prototype && typeof RealTray.prototype.setContextMenu === 'function'
        ? RealTray.prototype.setContextMenu
        : null;
    const origDockSetMenu = RealApp && RealApp.dock && typeof RealApp.dock.setMenu === 'function'
        ? RealApp.dock.setMenu
        : null;

    electronApis = { RealMenu, origSetApplicationMenu, origTraySetContextMenu, origDockSetMenu };

    let PatchedMenuItem = RealMenuItem;
    if (typeof RealMenuItem === 'function') {
        PatchedMenuItem = new Proxy(RealMenuItem, {
            construct(target, args, newTarget) {
                const [options, ...rest] = args;
                let nextOptions = options;
                let rawLabel;
                let rawSublabel;
                let rawToolTip;
                if (options && typeof options === 'object') {
                    nextOptions = { ...options };
                    if (typeof options.label === 'string') rawLabel = options.label;
                    if (typeof options.sublabel === 'string') rawSublabel = options.sublabel;
                    if (typeof options.toolTip === 'string') rawToolTip = options.toolTip;
                    if (typeof options.click === 'function') {
                        const origClick = options.click;
                        nextOptions.click = function wrappedMenuItemClick(menuItem, ...clickRest) {
                            return origClick.call(this, wrapClickMenuItem(menuItem), ...clickRest);
                        };
                    }
                }
                const item = Reflect.construct(target, [nextOptions, ...rest], newTarget === PatchedMenuItem ? target : newTarget);
                if (rawLabel !== undefined) origLabels.set(item, rawLabel);
                if (rawSublabel !== undefined) origSublabels.set(item, rawSublabel);
                if (rawToolTip !== undefined) origToolTips.set(item, rawToolTip);
                if (options && options.id === 'check-for-updates') installDynamicLabelHook(item);
                return item;
            }
        });
    }

    let PatchedMenu = RealMenu;
    if (RealMenu) {
        const menuOverrides = {};
        let loggedAppMenu = false;
        if (origBuildFromTemplate) {
            menuOverrides.buildFromTemplate = (template) => {
                try {
                    const cloned = cloneTemplate(template, Boolean(state.config && state.config.enabled));
                    const built = origBuildFromTemplate(cloned);
                    syncBuiltMenuOriginals(template, built);
                    applyMenuTranslation(built, Boolean(state.config && state.config.enabled));
                    return built;
                } catch {
                    return origBuildFromTemplate(template);
                }
            };
        }
        if (origSetApplicationMenu) {
            menuOverrides.setApplicationMenu = (menu) => {
                try {
                    appMenuRef = menu;
                    if (menu) {
                        applyMenuTranslation(menu, Boolean(state.config && state.config.enabled));
                        if (!loggedAppMenu && state.config && state.config.enabled) {
                            loggedAppMenu = true;
                            logHook('已应用原生菜单汉化');
                        }
                    }
                } catch {}
                return origSetApplicationMenu.call(RealMenu, menu);
            };
        }
        PatchedMenu = new Proxy(RealMenu, {
            get(target, prop) {
                if (Object.prototype.hasOwnProperty.call(menuOverrides, prop)) return menuOverrides[prop];
                const v = Reflect.get(target, prop, target);
                return typeof v === 'function' ? v.bind(target) : v;
            }
        });
    }

    if (RealTray && RealTray.prototype && origTraySetContextMenu && !hookedTrays.has(RealTray)) {
        hookedTrays.add(RealTray);
        RealTray.prototype.setContextMenu = function patchedSetContextMenu(menu, ...rest) {
            try {
                if (menu) {
                    applyMenuTranslation(menu, Boolean(state.config && state.config.enabled));
                    let found = false;
                    for (const entry of trackedTrays) {
                        if (entry.trayRef.deref() === this) {
                            entry.menuRef = new WeakRef(menu);
                            found = true;
                            break;
                        }
                    }
                    if (!found) trackedTrays.add({ trayRef: new WeakRef(this), menuRef: new WeakRef(menu) });
                }
            } catch {}
            return origTraySetContextMenu.call(this, menu, ...rest);
        };
    }

    let PatchedDialog = RealDialog;
    if (RealDialog) {
        const dialogOverrides = {};
        for (const fnName of ['showMessageBox', 'showMessageBoxSync']) {
            if (typeof RealDialog[fnName] === 'function') {
                const origFn = RealDialog[fnName].bind(RealDialog);
                dialogOverrides[fnName] = (...args) => {
                    try {
                        if (state.config && state.config.enabled) {
                            if (args.length >= 2 && args[1] && typeof args[1] === 'object') {
                                return origFn(args[0], translateDialogOptions(args[1]), ...args.slice(2));
                            }
                            if (args[0] && typeof args[0] === 'object') {
                                return origFn(translateDialogOptions(args[0]), ...args.slice(1));
                            }
                        }
                    } catch {}
                    return origFn(...args);
                };
            }
        }
        if (typeof RealDialog.showErrorBox === 'function') {
            const origErr = RealDialog.showErrorBox.bind(RealDialog);
            dialogOverrides.showErrorBox = (title, content) => {
                try {
                    if (state.config && state.config.enabled) {
                        return origErr(translateNativeText(title), translateNativeText(content));
                    }
                } catch {}
                return origErr(title, content);
            };
        }
        PatchedDialog = new Proxy(RealDialog, {
            get(target, prop) {
                if (Object.prototype.hasOwnProperty.call(dialogOverrides, prop)) return dialogOverrides[prop];
                const v = Reflect.get(target, prop, target);
                return typeof v === 'function' ? v.bind(target) : v;
            }
        });
    }

    if (RealApp && !hookedApps.has(RealApp)) {
        hookedApps.add(RealApp);
        try {
            RealApp.on('web-contents-created', (_ev, wc) => attachWebContents(wc));
            RealApp.on('will-quit', cleanupRuntime);
            if (RealApp.dock && origDockSetMenu) {
                RealApp.dock.setMenu = function patchedDockSetMenu(menu, ...rest) {
                    try {
                        dockTargetRef = this;
                        dockMenuRef = menu;
                        if (menu) applyMenuTranslation(menu, Boolean(state.config && state.config.enabled));
                    } catch {}
                    return origDockSetMenu.call(this, menu, ...rest);
                };
            }
            if (electron.webContents && typeof electron.webContents.getAllWebContents === 'function') {
                for (const wc of electron.webContents.getAllWebContents()) attachWebContents(wc, true);
            }
            writeRuntimeState();
            startWatchers();
            logHook('已接管 electron 模块');
        } catch (e) {
            logHook(`注册 app 监听失败: ${e.message}`);
        }
    }

    const overrides = {
        Menu: PatchedMenu,
        MenuItem: PatchedMenuItem,
        dialog: PatchedDialog
    };

    const proxy = new Proxy({}, {
        get(_t, prop) {
            if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
            return Reflect.get(electron, prop, electron);
        },
        has(_t, prop) {
            return prop in electron;
        },
        ownKeys() {
            return Reflect.ownKeys(electron);
        },
        getOwnPropertyDescriptor(_t, prop) {
            if (!(prop in electron)) return undefined;
            return {
                enumerable: true,
                configurable: true,
                get: () => (Object.prototype.hasOwnProperty.call(overrides, prop) ? overrides[prop] : Reflect.get(electron, prop, electron))
            };
        }
    });

    patchedModules.set(electron, proxy);
    return proxy;
}

function wrapLoader(fn) {
    return function patchedModuleLoad(request, parent, isMain) {
        const res = fn.apply(this, arguments);
        if (request === 'electron' && res && typeof res === 'object') {
            return patchElectron(res);
        }
        return res;
    };
}

let currentLoader = wrapLoader(Module._load);
try {
    Object.defineProperty(Module, '_load', {
        configurable: true,
        enumerable: true,
        get() {
            return currentLoader;
        },
        set(fn) {
            if (typeof fn === 'function') currentLoader = wrapLoader(fn);
        }
    });
} catch {
    Module._load = currentLoader;
}
