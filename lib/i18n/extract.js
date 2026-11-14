/**
 * 从 Antigravity 前端 bundle（main.js）中提取界面文本。
 *
 * - 普通字符串字面量 → 原文
 * - 模板字符串 `Showing ${a} of ${b}` → 占位符形式 "Showing {0} of {1}"
 *   插值为字符串三元式（${n === 1 ? "tool" : "tools"}）时展开为各分支
 * - 字符串拼接 "Send feedback as " + email → "Send feedback as {0}"
 * - 仅保留处于界面上下文（UI 属性值、createElement 子节点、三元分支、return）的自然语言文本
 */
const { normalize } = require('../../runtime/translator');

const UI_PROPS = [
    'label', 'sublabel', 'title', 'placeholder', 'description', 'shortDescription', 'tooltip', 'tooltipText',
    'tooltipContent', 'ariaLabel', '"aria-label"', '"data-tooltip-content"', 'emptyMessage', 'emptyText',
    'errorMessage', 'helperText', 'confirmText', 'cancelText', 'confirmLabel', 'cancelLabel', 'buttonText',
    'actionLabel', 'heading', 'subheading', 'subtitle', 'header', 'content', 'message', 'detail', 'text',
    'children', 'hint', 'caption', 'alt'
].join('|');

// 前缀匹配：UI 属性值、三元分支（含后续 || / ?? / && 回退）、setAttribute、return、数组元素与 push
const UI_CONTEXT = new RegExp(
    String.raw`(?:(?:${UI_PROPS})\s*:\s*(?:[^,;{}()"'` + '`' + String.raw`]{0,80}(?:\?|&&|\|\||\?\?)\s*)?|[?:]\s*(?:[^,;{}()"'` + '`' + String.raw`]{0,60}(?:\|\||\?\?|&&)\s*)?|\.setAttribute\(\s*["'](?:aria-label|title|placeholder)["']\s*,\s*|\breturn\s*|\.push\(\s*|\[\s*)$`
);
const TUPLE_PAIR_PRE = /\[\s*["'][\w.-]{1,40}["']\s*,\s*$/;
const CODE_WORDS = /\b(function|return|const|var|let|import|export|typeof|undefined|null|true|false|Promise|Object|Array|String|Number|async|await)\b|=>/;
const CSS_WORDS = /(^|\s)(flex|items-|justify-|bg-|text-|border-|p[xytblr]?-|m[xytblr]?-|w-|h-|gap-|rounded|hidden|block|inline|relative|absolute|shrink-|truncate|select-none|cursor-|outline-|hover:|focus:|dark:)/;

const REGEX_PRE = /[(,=:[!&|?{};~+\-*\/%^<>]/;
const REGEX_KW = /(?:^|[^$\w.])(?:return|typeof|instanceof|in|of|delete|void|throw|new|case|else|yield|await|do)$/;

function skipQuoted(js, i, quote) {
    for (i++; i < js.length && js[i] !== quote && js[i] !== '\n'; i++) {
        if (js[i] === '\\') i++;
    }
    return js[i] === quote ? i + 1 : i;
}

function skipRegex(js, i) {
    let inClass = false;
    for (i++; i < js.length && js[i] !== '\n'; i++) {
        if (js[i] === '\\') { i++; continue; }
        if (js[i] === '[') inClass = true;
        else if (js[i] === ']') inClass = false;
        else if (js[i] === '/' && !inClass) { i++; break; }
    }
    while (i < js.length && /[a-z]/i.test(js[i])) i++;
    return i;
}

function isRegexStart(js, i, lastSig) {
    if (!lastSig || REGEX_PRE.test(lastSig)) return true;
    return REGEX_KW.test(js.slice(Math.max(0, i - 20), i).trimEnd());
}

/** 从 `${` 之后扫描至匹配的 `}`，返回其后位置（跳过内部字符串、注释、正则与嵌套模板） */
function skipBalancedBrace(js, i) {
    let depth = 1;
    let lastSig = '{';
    while (i < js.length && depth > 0) {
        const c = js[i];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
        if (c === '/' && js[i + 1] === '/') { i = js.indexOf('\n', i + 2); if (i < 0) return js.length; continue; }
        if (c === '/' && js[i + 1] === '*') { i = js.indexOf('*/', i + 2); return i < 0 ? js.length : i + 2; }
        if (c === '/' && isRegexStart(js, i, lastSig)) { i = skipRegex(js, i); lastSig = 'R'; continue; }
        if (c === '"' || c === "'") { i = skipQuoted(js, i, c); lastSig = c; continue; }
        if (c === '`') { i = skipTemplate(js, i); lastSig = '`'; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return i + 1;
        lastSig = c;
        i++;
    }
    return i;
}

function skipTemplate(js, i) {
    for (i++; i < js.length;) {
        if (js[i] === '\\') { i += 2; continue; }
        if (js[i] === '`') return i + 1;
        if (js[i] === '$' && js[i + 1] === '{') { i = skipBalancedBrace(js, i + 2); continue; }
        i++;
    }
    return i;
}

/** 词法级扫描字面量，避免正则字面量（如 /`$/）或嵌套模板导致正则匹配脱轨吞掉代码 */
function* scanLiterals(js) {
    let i = 0;
    let lastSig = '';
    while (i < js.length) {
        const c = js[i];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
        if (c === '/' && js[i + 1] === '/') { i = js.indexOf('\n', i + 2); if (i < 0) break; continue; }
        if (c === '/' && js[i + 1] === '*') { i = js.indexOf('*/', i + 2); if (i < 0) break; i += 2; continue; }
        if (c === '/' && isRegexStart(js, i, lastSig)) { i = skipRegex(js, i); lastSig = 'R'; continue; }
        if (c === '"' || c === "'" || c === '`') {
            const end = c === '`' ? skipTemplate(js, i) : skipQuoted(js, i, c);
            if (end > i + 1 && js[end - 1] === c) yield { index: i, end, quote: c, raw: js.slice(i + 1, end - 1) };
            i = end;
            lastSig = c;
            continue;
        }
        lastSig = c;
        i++;
    }
}

function unescape(s) {
    return s
        .replace(/\\u\{([0-9a-f]+)\}/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\n/g, ' ')
        .replace(/\\(.)/g, '$1');
}

const TERNARY = /^[^?"'`]+\?\s*(?:"([^"\\]*)"|'([^'\\]*)')\s*:\s*(?:"([^"\\]*)"|'([^'\\]*)')$/;
const MAX_VARIANTS = 8;

/** 模板字符串 → 消息列表：插值替换为 {0}、{1}…，字符串三元式展开 */
function templateToMessages(raw) {
    let outs = [''];
    let index = 0;
    for (let i = 0; i < raw.length;) {
        if (raw[i] !== '$' || raw[i + 1] !== '{') {
            const c = raw[i++];
            outs = outs.map((o) => o + c);
            continue;
        }
        const j = skipBalancedBrace(raw, i + 2);
        if (raw[j - 1] !== '}') return [];
        const branches = TERNARY.exec(raw.slice(i + 2, j - 1).trim());
        if (branches && outs.length * 2 <= MAX_VARIANTS) {
            const b1 = branches[1] ?? branches[2];
            const b2 = branches[3] ?? branches[4];
            outs = outs.flatMap((o) => [o + b1, o + b2]);
        } else {
            const ph = `{${index++}}`;
            outs = outs.map((o) => o + ph);
        }
        i = j;
    }
    return outs;
}

function isUiText(s) {
    if (s.length < 2 || s.length > 600) return false;
    if (/^\[object |^[Mm]\s?-?[\d.]+[\s,]/.test(s)) return false;
    if ((s.match(/\d/g) || []).length > s.length * 0.3) return false;
    if (!/[A-Za-z]{2,}/.test(s.replace(/\{\d+\}/g, ''))) return false;
    if (!/^(?:[A-Z0-9{(\[+•✓"'@]|e\.g\.)/.test(s)) return false;
    if (/^(https?:|file:|mailto:|data:|chrome:|antigravity:|vscode:|wss?:|\/|\.\/|#)/i.test(s)) return false;
    if (/^[\w.-]+\/[\w./-]+$/.test(s)) return false;
    if (!s.includes(' ')) return /^[A-Z][a-z]{1,24}[.!?:]?$/.test(s) || /^[A-Z][a-z]+(?:-[a-z]+)+$/.test(s);
    if (/[<>$\\|=;`^~]/.test(s) || /[{}]/.test(s.replace(/\{\d+\}/g, ''))) return false;
    if (CODE_WORDS.test(s) || CSS_WORDS.test(s)) return false;
    return !s.split(/\s+/).some((w) => w.length > 40);
}

/** 字面量是否为 createElement(type, props, ...children) 的直接参数 */
function isElementArg(js, index) {
    let depth = 0;
    for (let i = index - 1, end = Math.max(0, index - 2000); i >= end; i--) {
        const c = js[i];
        if (c === ')' || c === ']' || c === '}') depth++;
        else if (c === '(' || c === '[' || c === '{') {
            if (depth) { depth--; continue; }
            return c === '(' && js.slice(i - 13, i) === 'createElement';
        } else if (c === ';' && !depth) return false;
    }
    return false;
}

/**
 * createElement 子节点拼接：A.createElement("p", null, "No ", u.plural, " yet") → "No {0} yet"。
 * 从首个字面量起读取后续参数直到右括号，变量记为 {0} {1}…；含其他表达式时放弃。
 */
const CHILD = /\s*,\s*(?:"((?:[^"\\]|\\.)*)"|([\w$][\w$.?]*))/y;
function childSequence(js, start, first) {
    let text = first;
    let slot = 0;
    let i = start;
    for (;;) {
        CHILD.lastIndex = i;
        const m = CHILD.exec(js);
        if (!m) break;
        text += m[1] !== undefined ? m[1] : `{${slot++}}`;
        i = CHILD.lastIndex;
    }
    return slot && /^\s*\)/.test(js.slice(i, i + 4)) ? text : null;
}

const inUiContext = (js, index, end) => {
    const pre = js.slice(Math.max(0, index - 120), index);
    return UI_CONTEXT.test(pre) || (TUPLE_PAIR_PRE.test(pre) && /^\s*\]/.test(js.slice(end, end + 8))) || isElementArg(js, index);
};

/** @returns {string[]} 去重排序后的界面文本 */
function extractStrings(js) {
    const found = new Set();
    for (const tok of scanLiterals(js)) {
        let raws;
        if (tok.quote === '`') raws = templateToMessages(tok.raw);
        else {
            raws = [tok.raw];
            // "Send feedback as " + a.email → "Send feedback as {0}"
            if (/^\s*\+\s*[\w$(]/.test(js.slice(tok.end, tok.end + 8))) raws.push(`${raws[0]}{0}`);
        }
        if (!raws.length || !inUiContext(js, tok.index, tok.end)) continue;
        if (tok.quote === '"' && isElementArg(js, tok.index)) {
            const seq = childSequence(js, tok.end, tok.raw);
            if (seq) raws.push(seq);
        }
        for (const raw of raws) {
            if (raw.length > 1200) continue;
            const text = normalize(unescape(raw));
            if (isUiText(text)) found.add(text);
        }
    }
    return [...found].sort();
}

/** 骨架：小写，占位符与数字统一为 {}，"1 tool excluded" 与 "{0} tool excluded" 视为同一原文 */
const skeleton = (s) => s.toLowerCase().replace(/\{#?\w+\}|\b\d[\d,.]*\b/g, '{}');

module.exports = { extractStrings, skeleton };
