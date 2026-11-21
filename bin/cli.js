#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('node:util');
const paths = require('../lib/paths');
const { loadConfig, saveConfig, BRAND_TITLE_MODES, ENGINES } = require('../lib/config');
const { buildBundle } = require('../lib/bundle');
const service = require('../lib/service');
const launcher = require('../lib/launcher');
const app = require('../lib/app');
const { runDaemon, runOnce, probe } = require('../lib/daemon');
const { isSqliteAvailable } = require('../lib/metrics');
const i18n = require('../lib/i18n');

const HELP = `
Antigravity 简体中文汉化（双引擎零侵入注入，不修改官方应用包）

用法: node bin/cli.js <命令> [选项]

命令:
  install            部署运行时与降级守护进程（默认通过 launch 命令启动）
  launch             通过 CLI 启动 Antigravity（Hook 优先，不可用时自动降级 CDP）
  launcher [remove]  单独编译原生 Swift 启动器 ${paths.tilde(paths.LAUNCHER_APP)}（remove 移除）
  metrics [on|off]   一键开启或关闭实时遥测胶囊（默认开启，热更新生效）
  uninstall          移除守护进程与启动器，恢复英文界面
  status             查看应用签名、Fuse、启动器、遥测与窗口状态
  daemon             前台运行事件驱动守护进程（供 LaunchAgent 调用）

词条维护（见 AGENTS.md）:
  i18n extract   从运行中的 Antigravity 生成原文清单 locale/catalog.json
  i18n check     校验词条，存在错误时退出码为 1
  i18n fmt       规范化排序，移除冗余与过期词条
  i18n missing   列出当前版本尚未翻译的原文

选项:
  --font <名称>         字体，默认 JKaiMono，none 表示不注入
  --brand-title <模式>  ${BRAND_TITLE_MODES.join(' | ')}
  --engine <模式>       注入引擎：${ENGINES.join(' | ')}（默认 auto）
  --metrics / --no-metrics  开启或关闭实时遥测胶囊
  --restart             launch 时若应用正在英文模式下运行，先退出再重启
  --bundle <文件>       i18n extract 使用本地前端 bundle，不连接应用
  --json                i18n check / missing 输出 JSON

配置: ${paths.tilde(paths.CONFIG_FILE)}
自定义词条: ${paths.tilde(paths.USER_MESSAGES_FILE)}
`;

function printApp() {
    const info = app.inspect();
    if (!info) {
        console.warn('[应用] 未找到 Antigravity.app');
        return null;
    }
    console.log(`[应用] ${paths.tilde(info.path)} v${info.version}`);
    if (info.updatable) console.log('[签名] Google 官方签名有效，应用内更新可用');
    else console.warn(`[签名] 签名无效或非官方 (TeamID=${info.teamId || '无'})，应用内更新会失败，请重新安装官方版`);
    const fuses = app.readElectronFuses(info.path);
    const fuseText = !fuses.found
        ? '未检测到 Electron Fuse（将使用 CDP 引擎）'
        : fuses.cliInspect
            ? 'CLI Inspect (--inspect-brk) 可用（支持主进程 Hook + 原生菜单汉化）'
            : 'CLI Inspect 已禁用（自动降级为事件驱动 CDP）';
    console.log(`[内核] ${fuseText}`);
    return info;
}

async function install({ font, brandTitle, engine, metrics }) {
    const info = printApp();
    const current = loadConfig();
    const targetEngine = engine || current.engine;
    const resolved = info ? app.resolveEngine(targetEngine, info.path) : (targetEngine === 'cdp' ? 'cdp' : 'hook');
    const config = saveConfig({
        enabled: true,
        ...(font && { font }),
        ...(brandTitle && { brandTitle }),
        ...(engine && { engine }),
        ...(typeof metrics === 'boolean' && { metrics })
    });
    const { entries } = buildBundle(config);
    service.install(process.execPath, { engine: config.engine });
    console.log(`[配置] 字体=${config.font} 品牌标题=${config.brandTitle} 引擎=${config.engine}（当前生效=${resolved}）遥测=${config.metrics ? '开启' : '关闭'} 词条=${entries}`);
    if (config.engine !== 'hook') console.log(`[服务] ${paths.tilde(paths.AGENT_PLIST)}`);
    console.log(`[日志] ${paths.tilde(paths.LOG_FILE)}`);

    const lStatus = launcher.launcherStatus();
    if (!lStatus.installed) {
        console.log(`[启动器] 未构建（默认使用 node bin/cli.js launch 启动；如需图标启动可运行 node bin/cli.js launcher）`);
    } else {
        console.log(`[启动器] 已存在 ${paths.tilde(lStatus.path)}（可运行 node bin/cli.js launcher 重新编译）`);
    }

    const hookState = app.readHookState();
    if (hookState) {
        console.log('[完成] 主进程 Hook 运行中，新配置将在数秒内热更新');
        return;
    }
    const { reachable } = await probe();
    if (app.isRunning() && !reachable) {
        console.log('[提示] 当前运行中的 Antigravity 未启用汉化，请运行 node bin/cli.js launch --restart');
    } else if (reachable) {
        console.log('[完成] 运行中的 Antigravity 将在数秒内切换为中文');
    } else {
        console.log('[完成] 运行 node bin/cli.js launch 启动汉化版');
    }
}

async function launch({ restart, engine }) {
    const info = app.inspect();
    if (!info) throw new Error('未找到 Antigravity.app');
    const config = loadConfig();
    const requestedEngine = engine || config.engine;

    const hookState = app.readHookState();
    const cdpProbe = hookState ? { reachable: false } : await probe();
    if (hookState || cdpProbe.reachable) {
        app.activate(info.path);
        console.log('[完成] Antigravity 已处于汉化运行中，已切至前台');
        return;
    }

    if (app.isRunning()) {
        if (!restart) {
            throw new Error('Antigravity 正在以官方英文模式运行；请先退出应用，或传入 --restart 重启');
        }
        console.log('[应用] 正在退出 Antigravity...');
        if (!app.quit()) throw new Error('等待 Antigravity 退出超时，请手动退出后重试');
    }

    const hookPath = fs.existsSync(paths.MAIN_HOOK_FILE)
        ? paths.MAIN_HOOK_FILE
        : path.join(paths.ROOT_DIR, 'runtime', 'main-hook.js');
    const { engine: actual } = await app.launch(info.path, { engine: requestedEngine, hookPath });
    if (actual === 'hook') {
        console.log('[完成] 已通过主进程 Hook 模式启动 Antigravity（临时调试端口将自动关闭，支持原生菜单/托盘汉化与零首屏闪烁）');
    } else {
        console.log('[完成] 已以 --remote-debugging-port=0 启动 Antigravity（事件驱动 Browser CDP 模式）');
    }
}

async function buildLauncherCmd(_options, sub = 'build') {
    if (sub === 'remove' || sub === 'uninstall') {
        launcher.uninstallLauncher();
        console.log(`[启动器] 已移除 ${paths.tilde(paths.LAUNCHER_APP)}`);
        return;
    }
    if (sub !== 'build') {
        throw new Error(`未知子命令 launcher ${sub}，可用: build | remove`);
    }
    const info = app.inspect();
    if (!info) throw new Error('未找到 Antigravity.app');
    if (!fs.existsSync(paths.MAIN_HOOK_FILE)) service.deployRuntime();
    console.log('[启动器] 正在编译原生 Swift 启动器...');
    const out = launcher.buildLauncher(info.path);
    console.log(`[启动器] 构建完成: ${paths.tilde(out)}`);
    console.log('[完成] 现在可直接双击或在启动台/Spotlight 中打开 Antigravity-zh.app');
}

async function metricsCmd(options, sub) {
    let next;
    if (sub === 'on' || sub === 'enable' || sub === 'true') next = true;
    else if (sub === 'off' || sub === 'disable' || sub === 'false') next = false;
    else if (typeof options.metrics === 'boolean') next = options.metrics;
    else {
        const cur = loadConfig();
        console.log(`[遥测] 当前=${cur.metrics ? '开启' : '关闭'}（node:sqlite ${isSqliteAvailable() ? '可用' : '不可用'}）`);
        console.log('[提示] 使用 node bin/cli.js metrics on | off 切换');
        return;
    }
    const config = saveConfig({ metrics: next });
    console.log(`[遥测] 已设为 ${config.metrics ? '开启' : '关闭'}（运行中窗口将在数百毫秒内热更新，不重注汉化）`);
}

async function uninstall() {
    const hookState = app.readHookState();
    if (hookState) {
        saveConfig({ enabled: false, metrics: false });
        await new Promise((r) => setTimeout(r, 500));
    }
    service.uninstall();
    const { results } = await runOnce({ teardown: true });
    const cdpCount = results.filter((r) => r.ok).length;
    const extras = [];
    if (hookState) extras.push('已还原活跃 Hook 窗口与原生菜单');
    if (cdpCount) extras.push(`停止 ${cdpCount} 个 CDP 窗口的汉化`);
    console.log(`[完成] 已移除守护进程与启动器${extras.length ? `（${extras.join('，')}）` : ''}`);
}

async function status() {
    printApp();
    const config = loadConfig();
    const lStatus = launcher.launcherStatus();
    console.log(`[启动器] ${lStatus.installed ? `已构建 (${paths.tilde(lStatus.path)})` : '未构建（默认 CLI 启动；可运行 node bin/cli.js launcher 构建）'}`);
    console.log(`[遥测] ${config.metrics ? '开启' : '关闭'}（node:sqlite ${isSqliteAvailable() ? '可用' : '不可用'}）`);
    const agent = service.status();
    console.log(`[服务] ${!agent.loaded ? (config.engine === 'hook' ? '未安装（纯 Hook 模式无需常驻）' : '未安装') : agent.pid ? `运行中 (pid ${agent.pid})` : '已加载，未运行'}`);

    const expected = buildBundle(config).version;
    const hookState = app.readHookState();
    if (hookState) {
        console.log(`[引擎] 主进程 Hook (pid ${hookState.pid}，配置=${config.engine})`);
        if (!hookState.windows || !hookState.windows.length) {
            console.log('[窗口] 主进程 Hook 就绪（暂无活跃主窗口）');
            return;
        }
        for (const url of hookState.windows) {
            const state = !hookState.enabled ? '已暂停' : hookState.version === expected ? '已汉化' : '待更新';
            console.log(`[窗口] ${url} ${state}`);
        }
        return;
    }

    const { port, reachable, results } = await probe();
    if (!reachable) {
        if (app.isRunning()) {
            console.log('[窗口] Antigravity 运行中（未检测到主进程 Hook 或 CDP 端口）');
            console.log('[提示] 运行 node bin/cli.js launch --restart 以开启汉化');
            return;
        }
        return console.log(`[窗口] Antigravity 未运行${port ? ` (端口 ${port} 无响应)` : ''}`);
    }
    console.log(`[引擎] Browser CDP (端口 ${port}，配置=${config.engine})`);
    for (const w of results) {
        const state = w.version === expected ? '已汉化' : w.version ? '待更新' : '未汉化';
        console.log(`[窗口] ${w.url} ${state}`);
    }
}

const COMMANDS = {
    install,
    launch,
    launcher: buildLauncherCmd,
    metrics: metricsCmd,
    uninstall,
    status,
    daemon: runDaemon,
    i18n: (options, sub) => i18n.run(sub, options)
};

async function main() {
    const { positionals, values } = parseArgs({
        allowPositionals: true,
        allowNegative: true,
        options: {
            font: { type: 'string' },
            'brand-title': { type: 'string' },
            engine: { type: 'string' },
            metrics: { type: 'boolean' },
            restart: { type: 'boolean' },
            bundle: { type: 'string' },
            json: { type: 'boolean' },
            help: { type: 'boolean', short: 'h' }
        }
    });
    const command = COMMANDS[positionals[0]];
    if (values.help || !command) return console.log(HELP);

    if (process.platform !== 'darwin') throw new Error('仅支持 macOS');
    if (typeof WebSocket !== 'function') throw new Error(`需要 Node.js >= 22，当前 ${process.version}`);

    const options = {
        bundle: values.bundle,
        json: values.json,
        restart: values.restart
    };
    if (typeof values.metrics === 'boolean') options.metrics = values.metrics;
    if (values.font) options.font = values.font;
    if (values['brand-title']) {
        if (!BRAND_TITLE_MODES.includes(values['brand-title'])) throw new Error(`--brand-title 仅支持 ${BRAND_TITLE_MODES.join(' | ')}`);
        options.brandTitle = values['brand-title'];
    }
    if (values.engine) {
        if (!ENGINES.includes(values.engine)) throw new Error(`--engine 仅支持 ${ENGINES.join(' | ')}`);
        options.engine = values.engine;
    }
    await command(options, positionals[1]);
}

main().catch((err) => {
    console.error(`[失败] ${err.message}`);
    process.exit(1);
});
