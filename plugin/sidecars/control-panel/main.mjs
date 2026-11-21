import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import {
    resolveUserPaths,
    getStatusPayload,
    saveConfigPatch,
    getMessagesPayload,
    saveMessagesPayload,
    getLogsPayload,
} from './handlers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const userPaths = resolveUserPaths();
const app = new SidecarApp();

function jsonOrError(result) {
    if (result && result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
            status: result.status || 400,
            contentType: 'application/json',
        });
    }
    return result;
}

function parseBody(data) {
    if (typeof data === 'string') {
        try { return JSON.parse(data); } catch { return null; }
    }
    if (data && typeof data === 'object' && typeof data.body === 'string') {
        try { return JSON.parse(data.body); } catch { return null; }
    }
    return data;
}

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf8'));

app.api('/api/status', () => getStatusPayload(userPaths), 'GET');

app.api('/api/config', (data) => jsonOrError(saveConfigPatch(userPaths, parseBody(data))), 'POST');

app.api('/api/messages', () => getMessagesPayload(userPaths), 'GET');

app.api('/api/messages', (data) => {
    const parsed = parseBody(data);
    const raw = parsed && typeof parsed.text === 'string' ? parsed.text : '';
    return jsonOrError(saveMessagesPayload(userPaths, raw));
}, 'POST');

app.api('/api/logs', () => getLogsPayload(userPaths, 120), 'GET');

app.run();
