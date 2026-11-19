import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_CONFIG = {
    enabled: true,
    font: 'JKaiMono',
    brandTitle: 'english',
    engine: 'auto',
    metrics: false,
};

export const BRAND_TITLE_MODES = ['english', 'hidden', 'translated'];

export function resolveUserPaths(home = homedir()) {
    const dataDir = join(home, '.antigravity-zh');
    return {
        dataDir,
        configFile: join(dataDir, 'config.json'),
        messagesFile: join(dataDir, 'messages.json'),
        runtimeStateFile: join(dataDir, 'runtime-state.json'),
        devtoolsPortFile: join(home, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'),
        logFile: join(home, 'Library', 'Logs', 'antigravity-zh.log'),
    };
}

export function atomicWriteFile(filePath, content) {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, filePath);
}

export function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export function readConfig(userPaths) {
    let saved = {};
    try {
        saved = JSON.parse(readFileSync(userPaths.configFile, 'utf8'));
    } catch {}
    return { ...DEFAULT_CONFIG, ...(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}) };
}

export function saveConfigPatch(userPaths, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { error: '无效的配置参数', status: 400 };
    }

    const current = readConfig(userPaths);
    const next = { ...current };

    if ('enabled' in patch) {
        if (typeof patch.enabled !== 'boolean') return { error: 'enabled 必须为布尔值', status: 400 };
        next.enabled = patch.enabled;
    }
    if ('metrics' in patch) {
        if (typeof patch.metrics !== 'boolean') return { error: 'metrics 必须为布尔值', status: 400 };
        next.metrics = patch.metrics;
    }
    if ('font' in patch) {
        if (typeof patch.font !== 'string' || !patch.font.trim()) return { error: 'font 必须为非空字符串', status: 400 };
        next.font = patch.font.trim();
    }
    if ('brandTitle' in patch) {
        if (!BRAND_TITLE_MODES.includes(patch.brandTitle)) {
            return { error: `brandTitle 仅支持: ${BRAND_TITLE_MODES.join(', ')}`, status: 400 };
        }
        next.brandTitle = patch.brandTitle;
    }

    atomicWriteFile(userPaths.configFile, JSON.stringify(next, null, 2) + '\n');
    return { ok: true, config: next };
}

export function readRuntimeState(userPaths) {
    try {
        const raw = JSON.parse(readFileSync(userPaths.runtimeStateFile, 'utf8'));
        if (!raw || typeof raw !== 'object') return null;
        if (!isPidAlive(raw.pid)) return { ...raw, alive: false };
        return { ...raw, alive: true };
    } catch {
        return null;
    }
}

export function readDevtoolsPort(userPaths) {
    try {
        const firstLine = readFileSync(userPaths.devtoolsPortFile, 'utf8').split(/\r?\n/)[0];
        const port = parseInt(firstLine, 10);
        return Number.isInteger(port) && port > 0 ? port : null;
    } catch {
        return null;
    }
}

export function getStatusPayload(userPaths) {
    const config = readConfig(userPaths);
    const runtime = readRuntimeState(userPaths);
    const devtoolsPort = readDevtoolsPort(userPaths);
    const hookAlive = Boolean(runtime && runtime.alive);
    const activeEngine = hookAlive ? 'hook' : (devtoolsPort ? 'cdp-ready' : 'inactive');

    return {
        config,
        runtime,
        devtoolsPort,
        activeEngine,
        paths: {
            configFile: userPaths.configFile,
            messagesFile: userPaths.messagesFile,
            logFile: userPaths.logFile,
        },
    };
}

export function getMessagesPayload(userPaths) {
    if (!existsSync(userPaths.messagesFile)) {
        return { exists: false, text: '{\n}\n', count: 0 };
    }
    const text = readFileSync(userPaths.messagesFile, 'utf8');
    let count = 0;
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            count = Object.keys(parsed).length;
        }
    } catch {}
    return { exists: true, text, count };
}

export function saveMessagesPayload(userPaths, rawText) {
    if (typeof rawText !== 'string') {
        return { error: '词条内容必须为字符串', status: 400 };
    }
    let parsed;
    try {
        parsed = JSON.parse(rawText);
    } catch (err) {
        return { error: `JSON 语法错误: ${err.message}`, status: 400 };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: '词条文件顶层必须是 JSON 对象 { "原文": "译文" }', status: 400 };
    }

    const sorted = {};
    for (const key of Object.keys(parsed).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
        const val = parsed[key];
        if (typeof val !== 'string') {
            return { error: `词条 "${key}" 的译文必须为字符串`, status: 400 };
        }
        sorted[key] = val;
    }

    const formatted = JSON.stringify(sorted, null, 2) + '\n';
    atomicWriteFile(userPaths.messagesFile, formatted);
    return { ok: true, count: Object.keys(sorted).length, text: formatted };
}

export function getLogsPayload(userPaths, maxLines = 120) {
    if (!existsSync(userPaths.logFile)) {
        return { exists: false, lines: [], totalBytes: 0 };
    }
    const st = statSync(userPaths.logFile);
    const content = readFileSync(userPaths.logFile, 'utf8');
    const allLines = content.split(/\r?\n/).filter((l) => l.length > 0);
    return {
        exists: true,
        lines: allLines.slice(-maxLines),
        totalBytes: st.size,
    };
}
