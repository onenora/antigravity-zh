'use strict';

function createSessionState() {
    return {
        calls: 0,
        model: null,
        hasIncompatible: false,
        incompatibleReason: null,
        lastMaxStepIdx: null,
        contextUsed: null,
        contextLimit: null,
        contextPct: null,
        sumOutputTokens: 0,
        sumThinkingTokens: null,
        sumResponseTokens: 0,
        sumUncachedInputTokens: 0,
        sumCacheWriteTokens: 0,
        sumCacheReadTokens: 0,
        sumTotalInputTokens: 0,
        lastCall: null,
    };
}

function applyRecord(state, record) {
    if (!record || record.empty) return false;
    if (record.incompatible) {
        state.hasIncompatible = true;
        state.incompatibleReason = record.reason || 'decode_error';
        return true;
    }

    const u = record.usage;
    const totalInput = u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens;
    const ttftMs = record.ttftMs;
    const streamingMs = record.streamingMs;

    const totalDurationSec = (ttftMs !== null || streamingMs !== null)
        ? ((ttftMs || 0) + (streamingMs || 0)) / 1000
        : 0;

    const tokPerSec = (totalDurationSec > 0 && u.outputTokens > 0)
        ? u.outputTokens / totalDurationSec
        : null;

    const streamTokPerSec = (streamingMs !== null && streamingMs >= 1000 && u.responseTokens >= 50)
        ? u.responseTokens / (streamingMs / 1000)
        : null;

    const cacheHitRate = totalInput > 0 ? u.cacheReadTokens / totalInput : null;

    state.calls += 1;
    if (record.model) state.model = record.model;
    state.hasIncompatible = false;
    state.incompatibleReason = null;
    if (typeof record.maxStepIdx === 'number') {
        state.lastMaxStepIdx = record.maxStepIdx;
    }

    state.sumOutputTokens += u.outputTokens;
    if (u.thinkingTokens !== null) {
        state.sumThinkingTokens = (state.sumThinkingTokens || 0) + u.thinkingTokens;
    }
    state.sumResponseTokens += u.responseTokens;
    state.sumUncachedInputTokens += u.inputTokens;
    state.sumCacheWriteTokens += u.cacheWriteTokens;
    state.sumCacheReadTokens += u.cacheReadTokens;
    state.sumTotalInputTokens += totalInput;

    if (record.contextLimit !== null && record.contextLimit > 0) {
        state.contextLimit = record.contextLimit;
    }
    if (record.contextUsed !== null) {
        state.contextUsed = record.contextUsed;
    }
    if (state.contextUsed !== null && state.contextLimit !== null && state.contextLimit > 0) {
        state.contextPct = (state.contextUsed / state.contextLimit) * 100;
    }

    state.lastCall = {
        model: record.model || state.model,
        inputUncached: u.inputTokens,
        cacheWrite: u.cacheWriteTokens,
        cacheRead: u.cacheReadTokens,
        totalInput,
        outputTokens: u.outputTokens,
        thinkingTokens: u.thinkingTokens,
        responseTokens: u.responseTokens,
        ttftMs,
        streamingMs,
        tokPerSec,
        streamTokPerSec,
        cacheHitRate,
    };

    return true;
}

function toSnapshot(state, meta = {}) {
    let status = meta.status;
    if (!status) {
        if (state.hasIncompatible) status = 'incompatible';
        else if (state.calls > 0) status = 'ready';
        else status = 'waiting';
    }

    return {
        status,
        reason: meta.reason || state.incompatibleReason || null,
        cascadeId: meta.cascadeId || null,
        model: state.model,
        calls: state.calls,
        contextUsed: state.contextUsed,
        contextLimit: state.contextLimit,
        contextPct: state.contextPct,
        sessionCacheHitRate: state.sumTotalInputTokens > 0
            ? state.sumCacheReadTokens / state.sumTotalInputTokens
            : null,
        session: {
            calls: state.calls,
            outputTokens: state.sumOutputTokens,
            thinkingTokens: state.sumThinkingTokens,
            responseTokens: state.sumResponseTokens,
            uncachedInputTokens: state.sumUncachedInputTokens,
            cacheWriteTokens: state.sumCacheWriteTokens,
            cacheReadTokens: state.sumCacheReadTokens,
            totalInputTokens: state.sumTotalInputTokens,
        },
        lastCall: state.lastCall,
        compact: meta.compact || null,
        updatedAt: Date.now(),
    };
}

module.exports = { createSessionState, applyRecord, toSnapshot };
