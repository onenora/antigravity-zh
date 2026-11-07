const fs = require('fs');
const paths = require('./paths');

const DEFAULT_CONFIG = { enabled: true, font: 'JKaiMono', brandTitle: 'english' };
const BRAND_TITLE_MODES = ['english', 'hidden', 'translated'];

function loadConfig() {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(paths.CONFIG_FILE, 'utf8')); } catch {}
    return { ...DEFAULT_CONFIG, ...saved };
}

function saveConfig(patch) {
    const next = { ...loadConfig(), ...patch };
    fs.mkdirSync(paths.DATA_DIR, { recursive: true });
    fs.writeFileSync(paths.CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
    return next;
}

module.exports = { DEFAULT_CONFIG, BRAND_TITLE_MODES, loadConfig, saveConfig };
