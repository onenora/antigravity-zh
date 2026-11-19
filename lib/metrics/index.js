'use strict';

const { decodeGenMetadata } = require('./decode');
const { createSessionState, applyRecord, toSnapshot } = require('./compute');
const { MetricsSource, isSqliteAvailable } = require('./source');

const CASCADE_URL_RE = /(?:\/c\/|[?&](?:cascadeId|conversationId)=)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function extractCascadeId(url) {
    if (!url) return null;
    const match = CASCADE_URL_RE.exec(String(url));
    return match ? match[1].toLowerCase() : null;
}

module.exports = {
    decodeGenMetadata,
    createSessionState,
    applyRecord,
    toSnapshot,
    MetricsSource,
    isSqliteAvailable,
    extractCascadeId,
};
