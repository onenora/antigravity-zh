/** i18n 子命令：extract | check | fmt | missing */
const store = require('./store');
const { buildCatalog } = require('./catalog');
const { lint, missing, fix, FIXABLE } = require('./check');

const options = () => ({ glossary: store.read('glossary'), catalog: store.read('catalog'), ignore: store.read('ignore') });

async function extract({ bundle }) {
    const messages = store.read('messages');
    const before = store.read('catalog');
    const catalog = await buildCatalog(Object.keys(messages), { bundleFile: bundle });
    store.write('catalog', catalog);
    const prev = new Set(before.strings);
    const next = new Set(catalog.strings);
    const added = catalog.strings.filter((s) => !prev.has(s)).length;
    const removed = before.strings.filter((s) => !next.has(s)).length;
    console.log(`[清单] Antigravity ${catalog.app}：${catalog.strings.length} 条原文（新增 ${added}，移除 ${removed}）→ ${store.FILES.catalog}`);
    console.log('[下一步] node bin/cli.js i18n fmt && node bin/cli.js i18n missing');
}

function check({ json }) {
    const messages = store.read('messages');
    const opts = options();
    const issues = lint(messages, opts);
    const todo = opts.catalog.strings.length ? missing(messages, opts.catalog, opts.ignore) : [];
    if (json) return console.log(JSON.stringify({ app: opts.catalog.app, entries: Object.keys(messages).length, issues, missing: todo }, null, 2));

    const byRule = new Map();
    for (const i of issues) byRule.set(i.rule, [...(byRule.get(i.rule) || []), i]);
    for (const [rule, list] of byRule) {
        console.log(`\n[${list[0].level}] ${rule} × ${list.length}${FIXABLE.has(rule) ? '（i18n fmt 可修复）' : ''}`);
        for (const i of list.slice(0, 10)) console.log(`  ${JSON.stringify(i.key)}  ${i.message}`);
        if (list.length > 10) console.log(`  … 其余 ${list.length - 10} 条见 --json`);
    }
    const errors = issues.filter((i) => i.level === 'error').length;
    console.log(`\n[词条] ${Object.keys(messages).length} 条，错误 ${errors}，警告 ${issues.length - errors}，待翻译 ${todo.length}（版本 ${opts.catalog.app || '未生成清单'}）`);
    if (errors) process.exitCode = 1;
}

function fmt() {
    const opts = options();
    const messages = store.read('messages');
    const next = fix(messages, opts);
    store.write('messages', next);
    store.write('glossary', opts.glossary);
    // 忽略项只保留当前版本仍存在、且未被翻译的原文
    const current = new Set(opts.catalog.strings);
    const pending = new Set(missing(next, opts.catalog));
    const ignore = opts.catalog.strings.length ? opts.ignore.filter((s) => current.has(s) && pending.has(s)) : opts.ignore;
    store.write('ignore', ignore);
    console.log(`[整理] 词条 ${Object.keys(messages).length} → ${Object.keys(next).length}，忽略 ${opts.ignore.length} → ${ignore.length}`);
}

function list({ json }) {
    const catalog = store.read('catalog');
    if (!catalog.strings.length) throw new Error('尚未生成原文清单，请先运行 i18n extract');
    const todo = missing(store.read('messages'), catalog, store.read('ignore'));
    console.log(json ? JSON.stringify(todo, null, 2) : todo.join('\n'));
}

const COMMANDS = { extract, check, fmt, missing: list };

async function run(sub, opts = {}) {
    const command = COMMANDS[sub];
    if (!command) throw new Error(`未知子命令 i18n ${sub || ''}，可用: ${Object.keys(COMMANDS).join(' | ')}`);
    await command(opts);
}

module.exports = { run };
