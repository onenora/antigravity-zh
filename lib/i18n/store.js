/**
 * locale/ 读写：
 *   messages.json  { 英文: 中文 }，唯一译文来源
 *   glossary.json  { 术语: { zh, avoid[] } }，统一译名
 *   catalog.json   { app, strings[] }，Antigravity 当前版本的英文原文清单（i18n extract 生成）
 *   ignore.json    string[]，确认无需翻译的原文（品牌、按键名、第三方库内部文案等）
 * 所有文件按键排序、两空格缩进写回，保证 diff 最小、便于 AI 与人工维护。
 */
const fs = require('fs');
const path = require('path');
const paths = require('../paths');
const { normalize } = require('../../runtime/translator');

const BRAND = 'Antigravity';
const FILES = {
    messages: path.join(paths.LOCALE_DIR, 'messages.json'),
    glossary: path.join(paths.LOCALE_DIR, 'glossary.json'),
    catalog: path.join(paths.LOCALE_DIR, 'catalog.json'),
    ignore: path.join(paths.LOCALE_DIR, 'ignore.json')
};
const EMPTY = { messages: {}, glossary: {}, catalog: { app: null, strings: [] }, ignore: [] };

const compareKeys = (a, b) => {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

const sortObject = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => compareKeys(a, b)));

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        if (e.code === 'ENOENT') return fallback;
        throw new Error(`${paths.tilde(file)} 解析失败: ${e.message}`);
    }
}

const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

const read = (name) => readJson(FILES[name], EMPTY[name]);

function write(name, data) {
    if (name === 'catalog') data = { ...data, strings: [...new Set(data.strings)].sort(compareKeys) };
    else if (name === 'ignore') data = [...new Set(data)].sort(compareKeys);
    else data = sortObject(data);
    writeJson(FILES[name], data);
}

/**
 * 运行时词条：项目词条 + 用户自定义（~/.antigravity-zh/messages.json，优先级最高）。
 * brandTitle: english 保留品牌英文 | hidden 隐藏 | translated 使用译名
 */
function loadMessages({ brandTitle = 'english', overrideFile = paths.USER_MESSAGES_FILE } = {}) {
    const messages = {};
    let user = {};
    try { user = readJson(overrideFile, {}); } catch (e) { console.warn(`[词条] 跳过自定义词条: ${e.message}`); }
    for (const source of [read('messages'), user]) {
        for (const [k, v] of Object.entries(source)) {
            const key = normalize(k);
            if (key && typeof v === 'string') messages[key] = v;
        }
    }
    if (brandTitle === 'english') delete messages[BRAND];
    else if (brandTitle === 'hidden') messages[BRAND] = '';
    return messages;
}

module.exports = { FILES, BRAND, compareKeys, sortObject, read, write, loadMessages };
