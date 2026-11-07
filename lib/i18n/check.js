/**
 * 词条校验与整理。翻译判定复用 runtime/translator.js，与页面内行为完全一致。
 *
 * 规则              级别    fmt 自动修复
 * normalize         error   ✓ 键规范化（空白、弯引号、省略号）
 * empty             error   ✗ 译文为空
 * placeholder       error   ✗ 译文使用了原文没有的占位符；内联元素占位 {0} {1}… 缺失或顺序不一致
 * generic           error   ✗ 仅含文本占位的模式字面量过短（< 8 个字母），会误配任意文本
 * number            warn    ✗ 原文中的数字未出现在译文
 * glossary          warn    ✗ 使用了术语表禁止的译名
 * noop              warn    ✓ 译文与原文相同
 * whitespace        warn    ✓ 译文首尾空白
 * redundant         warn    ✓ 已被其他词条或规则以相同译文覆盖
 * stale             warn    ✓ 原文不在当前版本清单（catalog）中
 */
const { createTranslator, normalize, PLACEHOLDER } = require('../../runtime/translator');
const { BRAND } = require('./store');
const { skeleton } = require('./extract');

const FIXABLE = new Set(['normalize', 'noop', 'whitespace', 'redundant', 'stale']);
const ERRORS = new Set(['normalize', 'empty', 'placeholder', 'generic']);
const MIN_PATTERN_LETTERS = 8;

const placeholders = (s) => [...s.matchAll(PLACEHOLDER)].map((m) => m[2]);
const literal = (s) => s.split(PLACEHOLDER).filter((_, i) => i % 3 === 0);

function placeholderIssue(key, value) {
    const a = placeholders(key);
    const b = placeholders(value);
    const unknown = b.filter((n) => !a.includes(n));
    if (unknown.length) return `译文含原文没有的占位符 ${unknown.join(',')}`;
    const slots = (list) => list.filter((n) => /^\d+$/.test(n)).join();
    if (slots(a) !== slots(b)) return '内联元素占位 {0} {1}… 必须全部保留且保持原顺序';
    return null;
}

/** 当前版本原文判定：骨架相同，或可由清单中的模板（含 {0}）生成 */
function knownSet(catalog) {
    const skeletons = new Set(catalog.strings.map(skeleton));
    const templates = catalog.strings.filter((s) => /\{\d+\}/.test(s)).map((s) =>
        new RegExp(`^${s.split(/\{\d+\}/).map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*?')}$`, 'i'));
    return (key) => skeletons.has(skeleton(key)) || templates.some((re) => re.test(key));
}

function glossaryRules(glossary) {
    return Object.entries(glossary).map(([term, { zh, avoid = [] }]) => ({
        term, zh, avoid,
        re: new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es)?\\b`, 'i')
    }));
}

/** @returns {{ level, rule, key, message }[]} */
function lint(messages, { glossary = {}, catalog } = {}) {
    const issues = [];
    const add = (rule, key, message) => issues.push({ level: ERRORS.has(rule) ? 'error' : 'warn', rule, key, message });
    const { fallback } = createTranslator(messages);
    const terms = glossaryRules(glossary);
    const known = catalog && catalog.strings.length ? knownSet(catalog) : null;

    for (const [key, value] of Object.entries(messages)) {
        if (key !== normalize(key)) add('normalize', key, `应为 ${JSON.stringify(normalize(key))}`);
        if (key === BRAND) continue;
        if (!value.trim()) { add('empty', key, '译文为空'); continue; }
        if (value === key) { add('noop', key, '译文与原文相同'); continue; }
        if (value !== value.trim()) add('whitespace', key, '译文含首尾空白');
        const ph = placeholderIssue(key, value);
        if (ph) add('placeholder', key, ph);
        const slots = [...key.matchAll(PLACEHOLDER)];
        const textOnly = slots.some((m) => !m[1] && !/^\d+$/.test(m[2])) && !slots.some((m) => m[1]);
        const letters = literal(key).join('').replace(/[^A-Za-z]/g, '').length;
        if (textOnly && letters < MIN_PATTERN_LETTERS) add('generic', key, `字面量仅 ${letters} 个字母，请改用精确词条或数字占位 {#n}`);
        for (const n of literal(key).join(' ').match(/\d+(?:\.\d+)*/g) || []) {
            if (!value.includes(n)) add('number', key, `译文缺少数字 ${n}`);
        }
        for (const t of terms) {
            const bad = t.re.test(key) && t.avoid.find((v) => value.includes(v));
            if (bad) add('glossary', key, `${t.term} 应译为「${t.zh}」，而非「${bad}」`);
        }
        if (known && !known(key)) add('stale', key, `不在 ${catalog.app} 原文清单中`);
        else if (fallback(key) === value) add('redundant', key, '已被其他规则覆盖');
    }
    return issues;
}

/** 清单中尚无译文的原文；模板占位以示例值代入，作为富文本/模式片段出现或已列入 ignore 的视为已处理 */
function missing(messages, catalog, ignore = []) {
    const skipped = new Set(ignore);
    const { translate } = createTranslator(messages);
    const fragments = new Set();
    for (const key of Object.keys(messages)) {
        if (/\{#?\w+\}/.test(key)) for (const c of literal(key)) if (c.trim()) fragments.add(c.trim().toLowerCase());
    }
    return catalog.strings.filter((s) => {
        if (skipped.has(s) || translate(s.replace(PLACEHOLDER, '2')) != null) return false;
        return !fragments.has(s.toLowerCase());
    });
}

/** 应用全部可自动修复项，直到稳定 */
function fix(messages, options) {
    let next = {};
    for (const [k, v] of Object.entries(messages)) next[normalize(k)] = v.trim() === v || !v.trim() ? v : v.trim();
    for (let round = 0; round < 5; round++) {
        const drop = new Set(lint(next, options).filter((i) => ['noop', 'redundant', 'stale'].includes(i.rule)).map((i) => i.key));
        if (!drop.size) break;
        next = Object.fromEntries(Object.entries(next).filter(([k]) => !drop.has(k)));
    }
    return next;
}

module.exports = { lint, missing, fix, FIXABLE };
