/**
 * 翻译核心：纯函数、无 DOM 依赖。
 * 浏览器端由 lib/bundle.js 拼接注入；Node 端由 i18n check 复用，保证校验结果与运行时一致。
 *
 * 词条语法（locale/messages.json）：
 *   "Settings": "设置"                                  精确匹配
 *   "Show {#count} more...": "显示另外 {count} 个..."   {#name} 捕获数字，{name} 捕获任意文本（可为空，递归翻译）
 *   "Search conversations with {0} in the top left."    {0} {1}… 为内联元素占位（富文本），译文须保持顺序
 *
 * 匹配优先级：精确 → 小写（仅多词） → 占位符模式（字面量越长越优先，多词时再忽略大小写）
 *            → 快捷键后缀 / 冒号后缀 → 列表拆分（", " 与 " and "，各项均有译文时） → 省略号截断前缀
 */
function normalize(text) {
    if (!text) return '';
    return String(text)
        .replace(/\s+/g, ' ')
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/…/g, '...')
        .trim();
}

const PLACEHOLDER = /\{(#?)(\w+)\}/g;
const SHORTCUT = /^(.*\S)\s*\(((?:Ctrl|Cmd|Alt|Shift|Option|⌘|⌥|⇧|⌃)[^)]*)\)$/;
const LISTS = [[', ', '，'], [' and ', '和']];
const MAX_DEPTH = 2;
const TRUNCATED_MIN = 30;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isPattern = (key) => /\{#?\w+\}/.test(key);

function compilePattern(key, value) {
    const captures = [];
    let source = '';
    let literal = '';
    let last = 0;
    for (const m of key.matchAll(PLACEHOLDER)) {
        const chunk = key.slice(last, m.index);
        source += escapeRe(chunk) + (m[1] ? '(\\d[\\d,.]*)' : '(.*?)');
        literal += chunk;
        captures.push({ name: m[2], numeric: m[1] === '#' });
        last = m.index + m[0].length;
    }
    source += escapeRe(key.slice(last));
    literal += key.slice(last);
    // 最长字面片段用于快速预筛
    const hint = key.split(PLACEHOLDER).filter((_, i) => i % 3 === 0).sort((a, b) => b.length - a.length)[0].toLowerCase();
    return { key, re: new RegExp(`^${source}$`), loose: new RegExp(`^${source}$`, 'i'), captures, value, weight: literal.length, hint };
}

function createTranslator(messages) {
    const exact = new Map();
    const lower = new Map();
    const patterns = [];
    for (const [key, value] of Object.entries(messages)) {
        exact.set(key, value);
        if (isPattern(key)) patterns.push(compilePattern(key, value));
        else if (key.includes(' ') && !lower.has(key.toLowerCase())) lower.set(key.toLowerCase(), key);
    }
    patterns.sort((a, b) => b.weight - a.weight);
    const longKeys = [...exact.keys()].filter((k) => k.length > TRUNCATED_MIN).map((k) => [k.toLowerCase(), k]);
    const cache = new Map();

    function fill(p, m, depth, skip) {
        return p.value.replace(PLACEHOLDER, (all, _hash, name) => {
            const i = p.captures.findIndex((c) => c.name === name);
            if (i < 0) return all;
            const text = m[i + 1];
            return p.captures[i].numeric || depth >= MAX_DEPTH ? text : (resolve(text, depth + 1, skip) ?? text);
        });
    }

    /** skip：忽略该词条自身，用于判断词条是否已被其他规则覆盖 */
    function resolve(s, depth, skip) {
        if (!s) return null;
        if (s !== skip && exact.has(s)) return exact.get(s);
        const lc = s.toLowerCase();
        if (s.includes(' ')) {
            const k = lower.get(lc);
            if (k !== undefined && k !== skip) return exact.get(k);
        }
        // 模式区分大小写，容忍句首小写（如逗号列表中的 "ran 2 commands"）；多词文本再忽略大小写匹配一轮
        const cap = s[0].toUpperCase() + s.slice(1);
        for (const p of patterns) {
            if (p.key === skip || !lc.includes(p.hint)) continue;
            const m = p.re.exec(s) || (cap !== s && p.re.exec(cap));
            if (m) return fill(p, m, depth, skip);
        }
        if (s.includes(' ')) {
            for (const p of patterns) {
                if (p.key === skip || !lc.includes(p.hint)) continue;
                const m = p.loose.exec(s);
                if (m) return fill(p, m, depth, skip);
            }
        }
        if (depth >= MAX_DEPTH) return null;

        const shortcut = SHORTCUT.exec(s);
        if (shortcut) {
            const base = resolve(shortcut[1], depth + 1, skip);
            if (base != null) return `${base} (${shortcut[2]})`;
        }
        if (s.length > 1 && s.endsWith(':')) {
            const base = resolve(s.slice(0, -1).trim(), depth + 1, skip);
            if (base) return `${base}：`;
        }
        for (const [sep, join] of LISTS) {
            if (!s.includes(sep)) continue;
            const parts = s.split(sep).map((part) => resolve(part, depth + 1, skip));
            if (parts.every((x) => x)) return parts.join(join);
        }
        if (s.endsWith('...') && s.length >= TRUNCATED_MIN + 3) {
            const prefix = lc.slice(0, -3).trim();
            const hit = longKeys.find(([k]) => k.length > prefix.length && k.startsWith(prefix));
            if (hit && hit[1] !== skip) return exact.get(hit[1]);
        }
        return null;
    }

    /** @returns {string|null} 译文；无匹配返回 null（空字符串表示隐藏） */
    function translate(text) {
        const s = normalize(text);
        if (!s) return null;
        if (!cache.has(s)) cache.set(s, resolve(s, 0));
        return cache.get(s);
    }

    /** 不使用该词条本身时的译文（Node 端校验冗余用） */
    const fallback = (key) => resolve(key, 0, key);

    return { translate, fallback };
}

if (typeof module === 'object' && module && module.exports) {
    module.exports = { normalize, createTranslator, isPattern, PLACEHOLDER };
}
