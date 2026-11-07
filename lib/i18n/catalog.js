/**
 * 生成原文清单 locale/catalog.json：Antigravity 当前版本中真实存在的英文界面文本。
 *
 * 来源（均来自本机已安装的官方版本，不修改应用）：
 *   - 前端 bundle：由 language_server 内嵌并在 https://127.0.0.1:<port>/ 提供，需应用运行中，经 CDP 发现地址后下载
 *   - language_server 二进制：后端下发的提示、错误与配额文案
 * 清单 = 前端提取出的界面文本 ∪ 在上述来源中能找到原文的现有词条。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { listAppTargets } = require('../cdp');
const app = require('../app');
const { extractStrings, skeleton } = require('./extract');
const { PLACEHOLDER } = require('../../runtime/translator');

function get(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { rejectUnauthorized: false, timeout: 15000 }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} HTTP ${res.statusCode}`)); }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }).on('error', reject).on('timeout', function () { this.destroy(new Error(`${url} 超时`)); });
    });
}

/** 从运行中的 Antigravity 下载主界面全部同源脚本 */
async function fetchFrontend() {
    const { targets } = await listAppTargets();
    if (!targets.length) throw new Error('未发现 Antigravity 主窗口，请先启动应用');
    const origin = new URL(targets[0].url).origin;
    const html = await get(`${origin}/`);
    const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)]
        .map((m) => new URL(m[1], `${origin}/`))
        .filter((u) => u.origin === origin);
    if (!srcs.length) throw new Error('主界面未包含脚本');
    return (await Promise.all(srcs.map((u) => get(u.href)))).join('\n');
}

/** 二进制中的可打印文本段（≥ 6 字符），统一小写便于检索 */
function binaryText(file) {
    const text = fs.readFileSync(file).toString('utf8');
    return (text.match(/[^\x00-\x1f\x7f�]{6,}/g) || []).join('\n').toLowerCase();
}

/**
 * 词条原文能否在来源中找到：占位符两侧的字面片段需全部出现。
 * 紧贴占位符的单位（{#n}m）与片段两端标点不参与比对。
 */
function found(corpus, key) {
    const chunks = key.replace(/(\{#?\w+\})[a-z]{1,2}\b/gi, '$1').split(PLACEHOLDER).filter((_, i) => i % 3 === 0)
        .map((c) => c.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9.]+$/g, ''))
        .filter((c) => /[a-z]{2,}/.test(c));
    if (!chunks.length) return true;
    return chunks.every((c) => {
        const forms = new Set([c, c.replace(/'/g, '’'), c.replace(/\.\.\.$/, '…'), c.replace(/"/g, '\\"'), c.replace(/\.\.\.$/, '')]);
        return corpus.some((text) => [...forms].some((f) => text.includes(f)));
    });
}

async function buildCatalog(messageKeys, { bundleFile } = {}) {
    const info = app.inspect();
    if (!info) throw new Error('未找到 Antigravity.app');
    const frontend = bundleFile ? fs.readFileSync(bundleFile, 'utf8') : await fetchFrontend();
    const strings = new Set(extractStrings(frontend));

    const lsPath = path.join(info.path, 'Contents', 'Resources', 'bin', 'language_server');
    const corpus = [frontend.toLowerCase(), fs.existsSync(lsPath) ? binaryText(lsPath) : ''];
    const known = new Set([...strings].map(skeleton));
    for (const key of messageKeys) {
        if (!known.has(skeleton(key)) && found(corpus, key)) strings.add(key);
    }
    return { app: info.version, strings: [...strings] };
}

module.exports = { buildCatalog, fetchFrontend };
