#!/usr/bin/env node

const { parseArgs } = require('node:util');
const paths = require('../lib/paths');
const { loadConfig, saveConfig, BRAND_TITLE_MODES } = require('../lib/config');
const { buildBundle } = require('../lib/bundle');
const service = require('../lib/service');
const app = require('../lib/app');
const { runDaemon, runOnce, probe } = require('../lib/daemon');
const i18n = require('../lib/i18n');

const HELP = `
Antigravity 简体中文汉化（CDP 运行时注入，不修改应用包）

用法: node bin/cli.js <命令> [选项]

命令:
  install     部署守护进程，Antigravity 启动后自动汉化
  uninstall   移除守护进程，恢复英文界面
  status      查看守护进程、窗口注入与应用签名状态
  daemon      前台运行守护进程（供 LaunchAgent 调用）

词条维护（见 AGENTS.md）:
  i18n extract   从运行中的 Antigravity 生成原文清单 locale/catalog.json
  i18n check     校验词条，存在错误时退出码为 1
  i18n fmt       规范化排序，移除冗余与过期词条
  i18n missing   列出当前版本尚未翻译的原文

选项:
  --font <名称>         字体，默认 JKaiMono，none 表示不注入
  --brand-title <模式>  ${BRAND_TITLE_MODES.join(' | ')}
  --bundle <文件>       i18n extract 使用本地前端 bundle，不连接应用
  --json                i18n check / missing 输出 JSON

配置: ${paths.tilde(paths.CONFIG_FILE)}
自定义词条: ${paths.tilde(paths.USER_MESSAGES_FILE)}
`;

function printApp() {
    const info = app.inspect();
    if (!info) return console.warn('[应用] 未找到 Antigravity.app');
    console.log(`[应用] ${paths.tilde(info.path)} v${info.version}`);
    if (info.updatable) console.log('[签名] Google 官方签名有效，应用内更新可用');
    else console.warn(`[签名] 签名无效或非官方 (TeamID=${info.teamId || '无'})，应用内更新会失败，请重新安装官方版`);
}

async function install({ font, brandTitle }) {
    const config = saveConfig({ enabled: true, ...(font && { font }), ...(brandTitle && { brandTitle }) });
    const { entries } = buildBundle(config);
    printApp();
    service.install();
    console.log(`[配置] 字体=${config.font} 品牌标题=${config.brandTitle} 词条=${entries}`);
    console.log(`[服务] ${paths.tilde(paths.AGENT_PLIST)}`);
    console.log(`[日志] ${paths.tilde(paths.LOG_FILE)}`);
    console.log('[完成] 运行中的 Antigravity 将在数秒内切换为中文');
}

async function uninstall() {
    service.uninstall();
    const { results } = await runOnce({ teardown: true });
    console.log(`[完成] 已移除守护进程，停止 ${results.filter((r) => r.ok).length} 个窗口的汉化，重启应用后恢复英文`);
}

async function status() {
    printApp();
    const agent = service.status();
    console.log(`[服务] ${!agent.loaded ? '未安装' : agent.pid ? `运行中 (pid ${agent.pid})` : '已加载，未运行'}`);
    const expected = buildBundle(loadConfig()).version;
    const { port, reachable, results } = await probe();
    if (!reachable) return console.log(`[窗口] Antigravity 未运行${port ? ` (端口 ${port} 无响应)` : ''}`);
    for (const w of results) {
        const state = w.version === expected ? '已汉化' : w.version ? '待更新' : '未汉化';
        console.log(`[窗口] ${w.url} ${state}`);
    }
}

const COMMANDS = { install, uninstall, status, daemon: runDaemon, i18n: (options, sub) => i18n.run(sub, options) };

async function main() {
    const { positionals, values } = parseArgs({
        allowPositionals: true,
        options: {
            font: { type: 'string' },
            'brand-title': { type: 'string' },
            bundle: { type: 'string' },
            json: { type: 'boolean' },
            help: { type: 'boolean', short: 'h' }
        }
    });
    const command = COMMANDS[positionals[0]];
    if (values.help || !command) return console.log(HELP);

    if (process.platform !== 'darwin') throw new Error('仅支持 macOS');
    if (typeof WebSocket !== 'function') throw new Error(`需要 Node.js >= 22，当前 ${process.version}`);

    const options = { bundle: values.bundle, json: values.json };
    if (values.font) options.font = values.font;
    if (values['brand-title']) {
        if (!BRAND_TITLE_MODES.includes(values['brand-title'])) throw new Error(`--brand-title 仅支持 ${BRAND_TITLE_MODES.join(' | ')}`);
        options.brandTitle = values['brand-title'];
    }
    await command(options, positionals[1]);
}

main().catch((err) => {
    console.error(`[失败] ${err.message}`);
    process.exit(1);
});
