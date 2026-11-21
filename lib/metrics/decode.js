'use strict';

const MIN_CONTEXT_LIMIT = 8000;
const MAX_CONTEXT_LIMIT = 10_000_000;
const MAX_DURATION_SEC = 600;

function readVarintRaw(buf, offset, end) {
    let value = 0;
    let multiplier = 1;
    for (let i = 0; i < 10; i++) {
        if (offset >= end) {
            throw new RangeError('Truncated varint');
        }
        const byte = buf[offset++];
        value += (byte & 0x7f) * multiplier;
        if ((byte & 0x80) === 0) {
            const safe = Number.isSafeInteger(value);
            return { value: safe ? value : null, safe, nextOffset: offset };
        }
        multiplier *= 128;
    }
    throw new RangeError('Varint exceeds 10 bytes');
}

function readSafeVarint(buf, offset, end) {
    const res = readVarintRaw(buf, offset, end);
    if (!res.safe) {
        throw new RangeError('Varint exceeds MAX_SAFE_INTEGER');
    }
    return res;
}

function requireSafeInt(val) {
    if (val === null || !Number.isSafeInteger(val)) {
        throw new RangeError('Varint exceeds MAX_SAFE_INTEGER');
    }
    return val;
}

function skipField(buf, wireType, offset, end) {
    switch (wireType) {
        case 0:
            return readVarintRaw(buf, offset, end).nextOffset;
        case 1:
            if (offset + 8 > end) throw new RangeError('Truncated 64-bit field');
            return offset + 8;
        case 2: {
            const len = readSafeVarint(buf, offset, end);
            const next = len.nextOffset + len.value;
            if (len.value < 0 || next > end) throw new RangeError('Truncated length-delimited field');
            return next;
        }
        case 5:
            if (offset + 4 > end) throw new RangeError('Truncated 32-bit field');
            return offset + 4;
        default:
            throw new RangeError(`Unsupported wire type: ${wireType}`);
    }
}

function walkMessage(buf, start, end, onField) {
    let offset = start;
    while (offset < end) {
        const tag = readSafeVarint(buf, offset, end);
        offset = tag.nextOffset;
        const fieldNo = Math.floor(tag.value / 8);
        const wireType = tag.value % 8;
        if (fieldNo <= 0) throw new RangeError(`Invalid field number: ${fieldNo}`);

        if (wireType === 0) {
            const val = readVarintRaw(buf, offset, end);
            offset = val.nextOffset;
            onField(fieldNo, wireType, val.value, 0, 0);
        } else if (wireType === 2) {
            const len = readSafeVarint(buf, offset, end);
            const sliceStart = len.nextOffset;
            const sliceEnd = sliceStart + len.value;
            if (len.value < 0 || sliceEnd > end) {
                throw new RangeError('Truncated length-delimited field');
            }
            offset = sliceEnd;
            onField(fieldNo, wireType, 0, sliceStart, sliceEnd);
        } else {
            offset = skipField(buf, wireType, offset, end);
        }
    }
}

function decodeDuration(buf, start, end) {
    let seconds = 0;
    let nanos = 0;
    walkMessage(buf, start, end, (fieldNo, wireType, val) => {
        if (wireType !== 0) return;
        if (fieldNo === 1) seconds = requireSafeInt(val);
        else if (fieldNo === 2) nanos = requireSafeInt(val);
    });
    return { seconds, nanos };
}

function decodeUsage(buf, start, end) {
    const usage = {
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: null,
        responseTokens: 0,
        hasThinking: false,
        hasResponse: false,
    };

    walkMessage(buf, start, end, (fieldNo, wireType, val, s, e) => {
        if (fieldNo === 1 && wireType === 2) {
            usage.model = buf.toString('utf8', s, e);
        } else if (wireType === 0) {
            if (fieldNo === 2) usage.inputTokens = requireSafeInt(val);
            else if (fieldNo === 3) usage.outputTokens = requireSafeInt(val);
            else if (fieldNo === 4) usage.cacheWriteTokens = requireSafeInt(val);
            else if (fieldNo === 5) usage.cacheReadTokens = requireSafeInt(val);
            else if (fieldNo === 9) {
                usage.thinkingTokens = requireSafeInt(val);
                usage.hasThinking = true;
            } else if (fieldNo === 10) {
                usage.responseTokens = requireSafeInt(val);
                usage.hasResponse = true;
            }
        }
    });

    return usage;
}

function decodeContextWindow(buf, start, end) {
    let used = null;
    let limit = null;
    walkMessage(buf, start, end, (fieldNo, wireType, val) => {
        if (wireType !== 0) return;
        if (fieldNo === 1) used = requireSafeInt(val);
        else if (fieldNo === 4) limit = requireSafeInt(val);
    });
    return { used, limit };
}

function decodeRequestInfo(buf, start, end) {
    let contextWindow = null;
    walkMessage(buf, start, end, (fieldNo, wireType, _val, s, e) => {
        if (fieldNo === 10 && wireType === 2) {
            contextWindow = decodeContextWindow(buf, s, e);
        }
    });
    return contextWindow;
}

function durationToMs(dur) {
    if (!dur) return null;
    return Math.round(dur.seconds * 1000 + dur.nanos / 1_000_000);
}

function isValidDuration(dur) {
    if (!dur) return true;
    return (
        dur.seconds >= 0 &&
        dur.seconds < MAX_DURATION_SEC &&
        dur.nanos >= 0 &&
        dur.nanos < 1_000_000_000
    );
}

function decodeChatModelMetadata(buf, start, end) {
    let modelEnum = null;
    let model = null;
    let usage = null;
    let contextWindow = null;
    let ttft = null;
    let streaming = null;

    walkMessage(buf, start, end, (fieldNo, wireType, val, s, e) => {
        if (fieldNo === 3 && wireType === 0) {
            modelEnum = requireSafeInt(val);
        } else if (fieldNo === 4 && wireType === 2) {
            usage = decodeUsage(buf, s, e);
        } else if (fieldNo === 9 && wireType === 2) {
            contextWindow = decodeRequestInfo(buf, s, e);
        } else if (fieldNo === 11 && wireType === 2) {
            ttft = decodeDuration(buf, s, e);
        } else if (fieldNo === 12 && wireType === 2) {
            streaming = decodeDuration(buf, s, e);
        } else if (fieldNo === 19 && wireType === 2) {
            model = buf.toString('utf8', s, e);
        }
    });

    if (!usage) {
        return { empty: true };
    }

    if (usage.hasThinking && usage.outputTokens !== usage.thinkingTokens + usage.responseTokens) {
        return { incompatible: true, reason: 'usage_sum_mismatch' };
    }

    if (contextWindow && contextWindow.limit !== null) {
        if (contextWindow.limit < MIN_CONTEXT_LIMIT || contextWindow.limit > MAX_CONTEXT_LIMIT) {
            return { incompatible: true, reason: 'context_limit_out_of_range' };
        }
    }

    if (!isValidDuration(ttft) || !isValidDuration(streaming)) {
        return { incompatible: true, reason: 'duration_out_of_range' };
    }

    const resolvedModel = usage.model || model || null;
    const responseTokens = usage.hasThinking
        ? usage.responseTokens
        : (usage.hasResponse ? usage.responseTokens : usage.outputTokens);

    return {
        incompatible: false,
        empty: false,
        modelEnum,
        model: resolvedModel,
        usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            cacheReadTokens: usage.cacheReadTokens,
            thinkingTokens: usage.hasThinking ? usage.thinkingTokens : null,
            responseTokens,
        },
        contextUsed: contextWindow ? contextWindow.used : null,
        contextLimit: contextWindow ? contextWindow.limit : null,
        ttftMs: durationToMs(ttft),
        streamingMs: durationToMs(streaming),
    };
}

function decodePackedMaxVarint(buf, start, end) {
    let maxVal = null;
    let offset = start;
    while (offset < end) {
        const res = readSafeVarint(buf, offset, end);
        offset = res.nextOffset;
        if (maxVal === null || res.value > maxVal) {
            maxVal = res.value;
        }
    }
    return maxVal;
}

/**
 * 解码 gen_metadata.data Protobuf 二进制。
 * 严格仅深入顶层 field #1（ChatModelMetadata）与 #2（关联 step 索引列表），其余字段仅按长度跳过，不解析不缓存。
 */
function decodeGenMetadata(raw) {
    if (!raw || raw.length === 0) return { empty: true };
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

    let chatSlice = null;
    let maxStepIdx = null;
    try {
        // 顶层仅提取 #1 切片与 #2 步号，其余字段严格跳过
        let offset = 0;
        const end = buf.length;
        while (offset < end) {
            const tag = readSafeVarint(buf, offset, end);
            offset = tag.nextOffset;
            const fieldNo = Math.floor(tag.value / 8);
            const wireType = tag.value % 8;
            if (fieldNo <= 0) throw new RangeError(`Invalid top-level field: ${fieldNo}`);

            if (fieldNo === 1 && wireType === 2) {
                const len = readSafeVarint(buf, offset, end);
                const sliceStart = len.nextOffset;
                const sliceEnd = sliceStart + len.value;
                if (len.value < 0 || sliceEnd > end) {
                    throw new RangeError('Truncated #1 slice');
                }
                chatSlice = { start: sliceStart, end: sliceEnd };
                offset = sliceEnd;
            } else if (fieldNo === 2 && wireType === 2) {
                const len = readSafeVarint(buf, offset, end);
                const sliceStart = len.nextOffset;
                const sliceEnd = sliceStart + len.value;
                if (len.value < 0 || sliceEnd > end) {
                    throw new RangeError('Truncated #2 slice');
                }
                const val = decodePackedMaxVarint(buf, sliceStart, sliceEnd);
                if (val !== null && (maxStepIdx === null || val > maxStepIdx)) {
                    maxStepIdx = val;
                }
                offset = sliceEnd;
            } else if (fieldNo === 2 && wireType === 0) {
                const val = readSafeVarint(buf, offset, end);
                offset = val.nextOffset;
                if (maxStepIdx === null || val.value > maxStepIdx) {
                    maxStepIdx = val.value;
                }
            } else {
                offset = skipField(buf, wireType, offset, end);
            }
        }
    } catch (err) {
        return { incompatible: true, reason: err.message };
    }

    if (!chatSlice) {
        return { empty: true };
    }

    try {
        const result = decodeChatModelMetadata(buf, chatSlice.start, chatSlice.end);
        if (!result.empty && !result.incompatible) {
            result.maxStepIdx = maxStepIdx;
        }
        return result;
    } catch (err) {
        return { incompatible: true, reason: err.message };
    }
}

/**
 * 轻量解析压缩检查点（step_type = 23）：仅提取关联 gen_metadata 索引（#20.#3）与摘要字节数（#30.#5 长度），不解码摘要正文。
 */
function decodeCheckpointStep(metadataRaw, payloadRaw) {
    let cpMetaIdx = null;
    let summaryBytes = 0;

    if (metadataRaw && metadataRaw.length > 0) {
        try {
            const buf = Buffer.isBuffer(metadataRaw) ? metadataRaw : Buffer.from(metadataRaw);
            walkMessage(buf, 0, buf.length, (fieldNo, wireType, _val, s, e) => {
                if (fieldNo === 20 && wireType === 2) {
                    walkMessage(buf, s, e, (subNo, subType, subVal) => {
                        if (subNo === 3 && subType === 0 && subVal !== null) {
                            cpMetaIdx = requireSafeInt(subVal);
                        }
                    });
                }
            });
        } catch {}
    }

    if (payloadRaw && payloadRaw.length > 0) {
        try {
            const buf = Buffer.isBuffer(payloadRaw) ? payloadRaw : Buffer.from(payloadRaw);
            walkMessage(buf, 0, buf.length, (fieldNo, wireType, _val, s, e) => {
                if (fieldNo === 30 && wireType === 2) {
                    walkMessage(buf, s, e, (subNo, subType, _subVal, ss, se) => {
                        if (subNo === 5 && subType === 2) {
                            summaryBytes = se - ss;
                        }
                    });
                }
            });
        } catch {}
    }

    return { cpMetaIdx, summaryBytes };
}

module.exports = { decodeGenMetadata, decodeCheckpointStep };
