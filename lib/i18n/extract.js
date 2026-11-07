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

const LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

const UI_PROPS = [
    'label', 'sublabel', 'title', 'placeholder', 'description', 'shortDescription', 'tooltip', 'tooltipText',
    'tooltipContent', 'ariaLabel', '"aria-label"', '"data-tooltip-content"', 'emptyMessage', 'emptyText',
    'errorMessage', 'helperText', 'confirmText', 'cancelText', 'confirmLabel', 'cancelLabel', 'buttonText',
    'actionLabel', 'heading', 'subheading', 'subtitle', 'header', 'content', 'message', 'detail', 'text',
    'children', 'hint', 'caption', 'alt'
].join('|');

// 前缀匹配：UI 属性值（允许 cond ? / && / || 前缀）、三元分支、return、数组元素与 push
const UI_CONTEXT = new RegExp(
    String.raw`(?:(?:${UI_PROPS})\s*:\s*(?:[^,;{}()"'` + '`' + String.raw`]{0,80}(?:\?|&&|\|\||\?\?)\s*)?|[?:]\s*|\breturn\s*|\.push\(\s*|\[\s*)$`
);
const CODE_WORDS = /\b(function|return|const|var|let|import|export|typeof|undefined|null|true|false|Promise|Object|Array|String|Number|async|await)\b|=>/;
const CSS_WORDS = /(^|\s)(flex|items-|justify-|bg-|text-|border-|p[xytblr]?-|m[xytblr]?-|w-|h-|gap-|rounded|hidden|block|inline|relative|absolute|shrink-|truncate|select-none|cursor-|outline-|hover:|focus:|dark:)/;

function unescape(s) {
    return s
        .replace(/\\u\{([0-9a-f]+)\}/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\n/g, ' ')
        .replace(/\\(.)/g, '$1');
}

const TERNARY = /^[^?"'`]+\?\s*"([^"\\]*)"\s*:\s*"([^"\\]*)"$/;
const MAX_VARIANTS = 8;

/** 模板字符串 → 消息列表：插值替换为 {0}、{1}…，字符串三元式展开；含嵌套模板时放弃 */
function templateToMessages(raw) {
    let outs = [''];
    let index = 0;
    for (let i = 0; i < raw.length;) {
        if (raw[i] !== '$' || raw[i + 1] !== '{') {
            const c = raw[i++];
            outs = outs.map((o) => o + c);
            continue;
        }
        let depth = 1;
        let j = i + 2;
        for (; j < raw.length && depth; j++) {
            if (raw[j] === '`') return [];
            if (raw[j] === '{') depth++;
            else if (raw[j] === '}') depth--;
        }
        if (depth) return [];
        const branches = TERNARY.exec(raw.slice(i + 2, j - 1).trim());
        if (branches && outs.length * 2 <= MAX_VARIANTS) outs = outs.flatMap((o) => [o + branches[1], o + branches[2]]);
        else { const ph = `{${index++}}`; outs = outs.map((o) => o + ph); }
        i = j;
    }
    return outs;
}

function isUiText(s) {
    if (s.length < 2 || s.length > 600) return false;
    if (/^\[object |^[Mm]\s?-?[\d.]+[\s,]/.test(s)) return false;
    if ((s.match(/\d/g) || []).length > s.length * 0.3) return false;
    if (!/[A-Za-z]{2,}/.test(s.replace(/\{\d+\}/g, ''))) return false;
    if (!/^[A-Z0-9{(\[+•"'@]/.test(s)) return false;
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

const inUiContext = (js, index) => UI_CONTEXT.test(js.slice(Math.max(0, index - 120), index)) || isElementArg(js, index);

/** @returns {string[]} 去重排序后的界面文本 */
function extractStrings(js) {
    const found = new Set();
    for (const m of js.matchAll(LITERAL)) {
        let raws;
        if (m[3] !== undefined) raws = templateToMessages(m[3]);
        else {
            raws = [m[1] ?? m[2]];
            // "Send feedback as " + a.email → "Send feedback as {0}"
            if (/^\s*\+\s*[\w$(]/.test(js.slice(m.index + m[0].length, m.index + m[0].length + 8))) raws.push(`${raws[0]}{0}`);
        }
        if (!raws.length || !inUiContext(js, m.index)) continue;
        if (m[1] !== undefined && isElementArg(js, m.index)) {
            const seq = childSequence(js, m.index + m[0].length, m[1]);
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
