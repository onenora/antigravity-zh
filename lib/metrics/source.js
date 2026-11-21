'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('../paths');
const { decodeGenMetadata } = require('./decode');
const { createSessionState, applyRecord, toSnapshot } = require('./compute');

const DB_EVENT_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.db(?:-wal|-shm)?$/i;
const DEBOUNCE_MS = 400;
const POLL_INTERVAL_MS = 30_000;
const IDLE_CLOSE_MS = 30_000;

function getSqliteModule() {
    try {
        return process.getBuiltinModule ? process.getBuiltinModule('node:sqlite') : null;
    } catch {
        return null;
    }
}

function isSqliteAvailable() {
    const mod = getSqliteModule();
    return Boolean(mod && typeof mod.DatabaseSync === 'function');
}

function cloneState(state) {
    return {
        ...state,
        lastCall: state.lastCall ? { ...state.lastCall } : null,
    };
}

class MetricsSource {
    constructor(options = {}) {
        this.dir = options.dir || paths.CONVERSATIONS_DIR;
        this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
        this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
        this.idleCloseMs = options.idleCloseMs ?? IDLE_CLOSE_MS;
        this.onSnapshot = options.onSnapshot || (() => {});
        this.log = options.log || (() => {});

        this.sessions = new Map();
        this.trackedIds = new Set();
        this.watcher = null;
        this.pollTimer = null;
        this.started = false;
    }

    isAvailable() {
        return isSqliteAvailable();
    }

    start() {
        if (this.started) return;
        this.started = true;
        if (!isSqliteAvailable()) return;

        this._startWatcher();
        if (this.pollIntervalMs > 0) {
            this.pollTimer = setInterval(() => this._pollTracked(), this.pollIntervalMs);
            if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
        }
    }

    stop() {
        this.started = false;
        if (this.watcher) {
            try { this.watcher.close(); } catch {}
            this.watcher = null;
        }
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        for (const entry of this.sessions.values()) {
            this._clearTimers(entry);
            this._closeWalWatcher(entry);
            this._closeDb(entry);
        }
        this.sessions.clear();
        this.trackedIds.clear();
    }

    setTrackedIds(ids) {
        const next = new Set(ids);
        for (const oldId of Array.from(this.trackedIds)) {
            if (!next.has(oldId)) this.untrack(oldId);
        }
        for (const id of next) {
            this.track(id);
        }
    }

    track(cascadeId) {
        if (!cascadeId) return null;
        this.trackedIds.add(cascadeId);
        return this.refresh(cascadeId);
    }

    untrack(cascadeId) {
        this.trackedIds.delete(cascadeId);
        const entry = this.sessions.get(cascadeId);
        if (!entry) return;
        this._clearTimers(entry);
        this._closeWalWatcher(entry);
        this._closeDb(entry);
        this.sessions.delete(cascadeId);
    }

    getCachedSnapshot(cascadeId) {
        if (!isSqliteAvailable()) {
            return toSnapshot(createSessionState(), {
                cascadeId,
                status: 'unavailable',
                reason: 'no_node_sqlite',
            });
        }
        const entry = this.sessions.get(cascadeId);
        return entry ? entry.snapshot : null;
    }

    refresh(cascadeId) {
        if (!cascadeId) return null;
        if (!isSqliteAvailable()) {
            const unavailable = toSnapshot(createSessionState(), {
                cascadeId,
                status: 'unavailable',
                reason: 'no_node_sqlite',
            });
            this.onSnapshot(cascadeId, unavailable);
            return unavailable;
        }

        const entry = this._ensureEntry(cascadeId);
        const dbPath = path.join(this.dir, `${cascadeId}.db`);
        if (!fs.existsSync(dbPath)) {
            entry.snapshot = toSnapshot(entry.state, { cascadeId, status: 'waiting' });
            return entry.snapshot;
        }

        try {
            const changed = this._readIncremental(entry, dbPath);
            if (!entry.snapshot || changed) {
                entry.snapshot = toSnapshot(entry.state, { cascadeId });
                this.onSnapshot(cascadeId, entry.snapshot);
            }
            if (this.started && this.trackedIds.has(cascadeId)) {
                this._ensureWalWatcher(entry, dbPath);
            }
            this._touchIdleClose(entry);
            return entry.snapshot;
        } catch (err) {
            const msg = String(err && err.message || err || '');
            if (msg.includes('SQLITE_BUSY') || msg.includes('database is locked')) {
                this.log(`metrics SQLITE_BUSY for ${cascadeId}`);
                this._closeDb(entry);
                return entry.snapshot;
            }
            this.log(`metrics read error (${cascadeId}): ${msg}`);
            this._closeDb(entry);
            return entry.snapshot;
        }
    }

    _ensureEntry(cascadeId) {
        let entry = this.sessions.get(cascadeId);
        if (!entry) {
            entry = {
                cascadeId,
                state: createSessionState(),
                stateBeforeLastIdx: null,
                lastIdx: -1,
                lastLen: 0,
                lastHadRecord: false,
                db: null,
                walWatcher: null,
                debounceTimer: null,
                idleTimer: null,
                snapshot: null,
            };
            this.sessions.set(cascadeId, entry);
        }
        return entry;
    }

    _openDb(entry, dbPath) {
        if (entry.db) return entry.db;
        const { DatabaseSync } = getSqliteModule();
        try {
            entry.db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 });
        } catch {
            entry.db = new DatabaseSync(dbPath, { readOnly: true });
        }
        return entry.db;
    }

    _closeDb(entry) {
        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = null;
        }
        if (entry.db) {
            try { entry.db.close(); } catch {}
            entry.db = null;
        }
    }

    _touchIdleClose(entry) {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        if (this.idleCloseMs <= 0) return;
        entry.idleTimer = setTimeout(() => {
            entry.idleTimer = null;
            this._closeDb(entry);
        }, this.idleCloseMs);
        if (typeof entry.idleTimer.unref === 'function') entry.idleTimer.unref();
    }

    _closeWalWatcher(entry) {
        if (!entry.walWatcher) return;
        try { entry.walWatcher.close(); } catch {}
        entry.walWatcher = null;
    }

    _ensureWalWatcher(entry, dbPath) {
        if (entry.walWatcher || !this.started) return;
        const walPath = `${dbPath}-wal`;
        if (!fs.existsSync(walPath)) return;
        try {
            const w = fs.watch(walPath, { persistent: false }, (ev) => {
                if (!this.started) return;
                this._scheduleRefresh(entry.cascadeId);
                if (ev === 'rename' && !fs.existsSync(walPath)) {
                    this._closeWalWatcher(entry);
                }
            });
            w.on('error', () => this._closeWalWatcher(entry));
            entry.walWatcher = w;
        } catch {}
    }

    _clearTimers(entry) {
        if (entry.debounceTimer) {
            clearTimeout(entry.debounceTimer);
            entry.debounceTimer = null;
        }
        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = null;
        }
    }

    _readIncremental(entry, dbPath) {
        const db = this._openDb(entry, dbPath);

        const maxRows = db.prepare('SELECT MAX(idx) AS maxIdx FROM gen_metadata').all();
        const maxIdx = maxRows.length > 0 && maxRows[0].maxIdx !== null ? Number(maxRows[0].maxIdx) : null;

        if (maxIdx === null) {
            if (entry.lastIdx >= 0) {
                entry.state = createSessionState();
                entry.stateBeforeLastIdx = null;
                entry.lastIdx = -1;
                entry.lastLen = 0;
                entry.lastHadRecord = false;
                return true;
            }
            return false;
        }

        // 会话回滚（rewind）：maxIdx 回退到当前游标之前时重置累计状态
        if (entry.lastIdx >= 0 && maxIdx < entry.lastIdx) {
            entry.state = createSessionState();
            entry.stateBeforeLastIdx = null;
            entry.lastIdx = -1;
            entry.lastLen = 0;
            entry.lastHadRecord = false;
        }

        // 首次挂载仅读最后一条，避免全历史大 BLOB 扫描
        if (entry.lastIdx < 0) {
            const rows = db.prepare('SELECT idx, length(data) AS len, data FROM gen_metadata ORDER BY idx DESC LIMIT 1').all();
            if (rows.length === 0) return false;
            const row = rows[0];
            entry.stateBeforeLastIdx = cloneState(entry.state);
            const record = decodeGenMetadata(row.data);
            entry.lastHadRecord = applyRecord(entry.state, record);
            entry.lastIdx = Number(row.idx);
            entry.lastLen = Number(row.len || 0);
            return true;
        }

        const tailMeta = db
            .prepare('SELECT idx, length(data) AS len FROM gen_metadata WHERE idx >= ? ORDER BY idx ASC')
            .all(entry.lastIdx);

        const dirtyIds = [];
        for (const row of tailMeta) {
            const idx = Number(row.idx);
            const len = Number(row.len || 0);
            if (idx > entry.lastIdx || (idx === entry.lastIdx && len !== entry.lastLen)) {
                dirtyIds.push(idx);
            }
        }
        if (dirtyIds.length === 0) return false;

        const placeholders = dirtyIds.map(() => '?').join(', ');
        const rows = db
            .prepare(`SELECT idx, length(data) AS len, data FROM gen_metadata WHERE idx IN (${placeholders}) ORDER BY idx ASC`)
            .all(...dirtyIds);

        let changed = false;
        for (const row of rows) {
            const idx = Number(row.idx);
            const len = Number(row.len || 0);
            if (idx === entry.lastIdx && entry.lastHadRecord && entry.stateBeforeLastIdx) {
                entry.state = cloneState(entry.stateBeforeLastIdx);
            }
            entry.stateBeforeLastIdx = cloneState(entry.state);
            const record = decodeGenMetadata(row.data);
            const applied = applyRecord(entry.state, record);
            entry.lastHadRecord = applied;
            entry.lastIdx = idx;
            entry.lastLen = len;
            changed = true;
        }
        return changed;
    }

    _startWatcher() {
        if (this.watcher) return;
        try {
            if (!fs.existsSync(this.dir)) return;
            this.watcher = fs.watch(this.dir, { persistent: false }, (_eventType, filename) => {
                if (!this.started || !filename) return;
                const match = DB_EVENT_RE.exec(String(filename));
                if (!match) return;
                const cascadeId = match[1].toLowerCase();
                if (this.trackedIds.size > 0 && !this.trackedIds.has(cascadeId)) return;
                this._scheduleRefresh(cascadeId);
            });
            this.watcher.on('error', () => {
                try { this.watcher.close(); } catch {}
                this.watcher = null;
            });
        } catch (err) {
            this.log(`metrics watcher error: ${err.message}`);
        }
    }

    _scheduleRefresh(cascadeId) {
        const entry = this._ensureEntry(cascadeId);
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
        entry.debounceTimer = setTimeout(() => {
            entry.debounceTimer = null;
            if (!this.started) return;
            this.refresh(cascadeId);
        }, this.debounceMs);
        if (typeof entry.debounceTimer.unref === 'function') entry.debounceTimer.unref();
    }

    _pollTracked() {
        if (!this.started) return;
        if (!this.watcher) this._startWatcher();
        for (const cascadeId of this.trackedIds) {
            this.refresh(cascadeId);
        }
    }
}

module.exports = { MetricsSource, isSqliteAvailable };
