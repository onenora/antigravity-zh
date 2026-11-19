(() => {
const ANCHOR_SELECTORS = [
    '[id="antigravity.agentSidePanelInputBox"]',
    '[data-testid="composer"]',
    'textarea'
];

const fmtNum = (n) => {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`;
    if (abs >= 10_000) return `${Math.round(n / 1000)}k`;
    if (abs >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(Math.round(n));
};

const fmtExact = (n) => {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    return Math.round(n).toLocaleString('en-US');
};

const fmtMs = (ms) => {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
    return `${Math.round(ms)} ms`;
};

const fmtPct = (ratio) => {
    if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
    return `${(ratio * 100).toFixed(1).replace(/\.0$/, '')}%`;
};

const fmtRate = (rate) => {
    if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
    return `${rate.toFixed(1)} tok/s`;
};

let snapshot = (typeof AGZH_METRICS_INIT !== 'undefined' && AGZH_METRICS_INIT) ? AGZH_METRICS_INIT : null;
let anchor = null;
let resizeObserver = null;
let rafId = 0;
let pollTimer = null;
let closeTimer = null;
let pinned = false;
let hovering = false;

const host = document.createElement('div');
host.id = 'agzh-metrics-host';
host.setAttribute('translate', 'no');
host.style.cssText = 'position:fixed;inset:auto;z-index:2147483000;pointer-events:none;display:none;margin:0;padding:0;';

const shadow = host.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = `
:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color-scheme: light dark;
}
.agzh-pill {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  letter-spacing: 0.01em;
  color: rgba(235, 238, 245, 0.92);
  background: rgba(24, 26, 32, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.14);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.24);
  cursor: default;
  user-select: none;
  white-space: nowrap;
  transition: border-color 140ms ease, background 140ms ease;
}
.agzh-pill:hover,
.agzh-pill[data-open="true"] {
  border-color: rgba(120, 175, 255, 0.55);
  background: rgba(28, 32, 42, 0.96);
}
@media (prefers-color-scheme: light) {
  .agzh-pill {
    color: rgba(24, 28, 38, 0.9);
    background: rgba(250, 251, 254, 0.9);
    border-color: rgba(15, 23, 42, 0.14);
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.09);
  }
  .agzh-pill:hover,
  .agzh-pill[data-open="true"] {
    background: rgba(255, 255, 255, 0.98);
    border-color: rgba(37, 99, 235, 0.45);
  }
}
.agzh-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #34d399;
  flex-shrink: 0;
}
.agzh-pill[data-level="warn"] .agzh-dot { background: #fbbf24; }
.agzh-pill[data-level="danger"] .agzh-dot { background: #f87171; }
.agzh-pill[data-level="muted"] .agzh-dot { background: #9ca3af; }
.agzh-sep { opacity: 0.45; }

.agzh-card {
  position: fixed;
  margin: 0;
  padding: 10px 12px;
  width: 288px;
  border-radius: 10px;
  font-size: 11.5px;
  line-height: 1.45;
  color: rgba(235, 238, 245, 0.95);
  background: rgba(22, 25, 33, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  display: none;
  box-sizing: border-box;
  pointer-events: auto;
}
.agzh-card[data-visible="true"] { display: block; }
@media (prefers-color-scheme: light) {
  .agzh-card {
    color: rgba(20, 24, 34, 0.94);
    background: rgba(255, 255, 255, 0.98);
    border-color: rgba(15, 23, 42, 0.14);
    box-shadow: 0 10px 26px rgba(15, 23, 42, 0.14);
  }
}
.agzh-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(128, 138, 160, 0.22);
}
.agzh-title { font-weight: 600; font-size: 12px; }
.agzh-badge {
  font-size: 10.5px;
  opacity: 0.78;
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agzh-section { margin-top: 8px; }
.agzh-sec-label {
  font-size: 10.5px;
  font-weight: 600;
  opacity: 0.65;
  margin-bottom: 4px;
}
.agzh-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  margin: 2px 0;
}
.agzh-k { opacity: 0.76; }
.agzh-v {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  text-align: right;
}
.agzh-bar {
  height: 4px;
  border-radius: 999px;
  background: rgba(128, 138, 160, 0.24);
  overflow: hidden;
  margin: 4px 0 2px;
}
.agzh-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: #34d399;
  transition: width 180ms ease;
}
.agzh-bar-fill[data-level="warn"] { background: #fbbf24; }
.agzh-bar-fill[data-level="danger"] { background: #f87171; }
.agzh-note {
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px solid rgba(128, 138, 160, 0.18);
  font-size: 10.5px;
  opacity: 0.72;
}
`;

const pill = document.createElement('button');
pill.type = 'button';
pill.className = 'agzh-pill';
pill.setAttribute('translate', 'no');

const card = document.createElement('div');
card.className = 'agzh-card';
card.setAttribute('translate', 'no');
try { card.setAttribute('popover', 'manual'); } catch {}

shadow.appendChild(style);
shadow.appendChild(pill);
shadow.appendChild(card);

function mountHost() {
    const parent = document.body || document.documentElement;
    if (parent && !host.isConnected) parent.appendChild(host);
}

function findAnchor() {
    for (const sel of ANCHOR_SELECTORS) {
        if (sel === 'textarea') {
            const list = document.querySelectorAll('textarea');
            let best = null;
            let bestTop = -1;
            for (const el of list) {
                const r = el.getBoundingClientRect();
                if (r.width >= 80 && r.height >= 20 && r.top >= bestTop) {
                    best = el;
                    bestTop = r.top;
                }
            }
            if (best) return best;
        } else {
            const el = document.querySelector(sel);
            if (el) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return el;
            }
        }
    }
    return null;
}

function ensureAnchor() {
    if (anchor && anchor.isConnected) {
        const r = anchor.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return anchor;
    }
    const next = findAnchor();
    if (next !== anchor) {
        if (resizeObserver) {
            try { resizeObserver.disconnect(); } catch {}
        }
        anchor = next;
        if (anchor && typeof ResizeObserver === 'function') {
            resizeObserver = new ResizeObserver(() => schedulePosition());
            resizeObserver.observe(anchor);
        }
    }
    return anchor;
}

function updatePosition() {
    rafId = 0;
    if (document.hidden) {
        host.style.display = 'none';
        hideCard();
        return;
    }
    mountHost();
    const target = ensureAnchor();
    if (!target) {
        host.style.display = 'none';
        hideCard();
        return;
    }
    const r = target.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
        host.style.display = 'none';
        hideCard();
        return;
    }

    const rightPx = Math.max(8, Math.round(window.innerWidth - r.right + 2));
    const preferredBottom = Math.round(window.innerHeight - r.top + 6);
    const maxBottom = Math.max(8, window.innerHeight - 32);
    const bottomPx = Math.max(8, Math.min(preferredBottom, maxBottom));

    host.style.display = 'block';
    host.style.right = `${rightPx}px`;
    host.style.bottom = `${bottomPx}px`;

    if (card.getAttribute('data-visible') === 'true') {
        positionCard();
    }
}

function schedulePosition() {
    if (rafId) return;
    rafId = requestAnimationFrame(updatePosition);
}

function positionCard() {
    const pr = pill.getBoundingClientRect();
    if (!pr || pr.width <= 0) return;
    const cardW = 288;
    const estH = card.offsetHeight || 230;
    const gap = 8;
    let left = pr.right - cardW;
    left = Math.max(8, Math.min(left, window.innerWidth - cardW - 8));
    let top = pr.top - estH - gap;
    if (top < 8) {
        top = Math.min(window.innerHeight - estH - 8, pr.bottom + gap);
    }
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(Math.max(8, top))}px`;
}

function showCard() {
    if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
    }
    renderCard();
    card.setAttribute('data-visible', 'true');
    pill.setAttribute('data-open', 'true');
    try {
        if (typeof card.showPopover === 'function' && !card.matches(':popover-open')) {
            card.showPopover();
        }
    } catch {}
    positionCard();
}

function hideCard() {
    pinned = false;
    card.setAttribute('data-visible', 'false');
    pill.setAttribute('data-open', 'false');
    try {
        if (typeof card.hidePopover === 'function' && card.matches(':popover-open')) {
            card.hidePopover();
        }
    } catch {}
}

function scheduleClose() {
    if (pinned) return;
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
        closeTimer = null;
        if (!hovering && !pinned) hideCard();
    }, 150);
}

function ctxLevel(pct) {
    if (pct === null || pct === undefined) return 'muted';
    if (pct >= 95) return 'danger';
    if (pct >= 75) return 'warn';
    return 'ok';
}

function clearEl(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
}

function makeSpan(text, cls) {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    return s;
}

function makeRow(label, value) {
    const row = document.createElement('div');
    row.className = 'agzh-row';
    row.appendChild(makeSpan(label, 'agzh-k'));
    row.appendChild(makeSpan(value, 'agzh-v'));
    return row;
}

function renderPill() {
    clearEl(pill);
    const dot = document.createElement('span');
    dot.className = 'agzh-dot';
    pill.appendChild(dot);

    if (!snapshot || snapshot.status === 'waiting') {
        pill.setAttribute('data-level', 'muted');
        pill.appendChild(makeSpan('遥测 · 等待首轮响应'));
        return;
    }
    if (snapshot.status === 'unavailable') {
        pill.setAttribute('data-level', 'muted');
        pill.appendChild(makeSpan('遥测 · SQLite 不可用'));
        return;
    }
    if (snapshot.status === 'incompatible') {
        pill.setAttribute('data-level', 'warn');
        pill.appendChild(makeSpan('遥测 · 数据结构不兼容'));
        return;
    }

    const level = ctxLevel(snapshot.contextPct);
    pill.setAttribute('data-level', level);

    const ctxText = snapshot.contextLimit
        ? `上下文 ${fmtNum(snapshot.contextUsed)}/${fmtNum(snapshot.contextLimit)} (${Math.round(snapshot.contextPct || 0)}%)`
        : '上下文 —';
    pill.appendChild(makeSpan(ctxText));

    const lc = snapshot.lastCall;
    if (lc && lc.tokPerSec !== null) {
        pill.appendChild(makeSpan('·', 'agzh-sep'));
        pill.appendChild(makeSpan(fmtRate(lc.tokPerSec)));
    }
    if (lc && lc.cacheHitRate !== null) {
        pill.appendChild(makeSpan('·', 'agzh-sep'));
        pill.appendChild(makeSpan(`缓存 ${fmtPct(lc.cacheHitRate)}`));
    }
}

function renderCard() {
    clearEl(card);
    const head = document.createElement('div');
    head.className = 'agzh-head';
    head.appendChild(makeSpan('实时遥测', 'agzh-title'));
    const badgeText = snapshot && snapshot.model
        ? `${snapshot.model}${snapshot.calls ? ` · ${snapshot.calls} 轮` : ''}`
        : (snapshot && snapshot.calls ? `累计 ${snapshot.calls} 轮` : '未开始');
    head.appendChild(makeSpan(badgeText, 'agzh-badge'));
    card.appendChild(head);

    if (!snapshot || snapshot.status === 'waiting') {
        card.appendChild(makeRow('状态', '等待当前对话产生模型调用'));
        const note = document.createElement('div');
        note.className = 'agzh-note';
        note.textContent = '仅在本机读取会话增量遥测，不解析提示词原文。';
        card.appendChild(note);
        return;
    }
    if (snapshot.status === 'unavailable') {
        card.appendChild(makeRow('状态', '运行环境缺少 node:sqlite'));
        const note = document.createElement('div');
        note.className = 'agzh-note';
        note.textContent = '建议升级 Node >= 22.13 或使用 Hook 模式启动。';
        card.appendChild(note);
        return;
    }
    if (snapshot.status === 'incompatible') {
        card.appendChild(makeRow('状态', '数据结构已变更'));
        card.appendChild(makeRow('校验原因', snapshot.reason || 'decode_error'));
        return;
    }

    // 1. 上下文水位
    const ctxSec = document.createElement('div');
    ctxSec.className = 'agzh-section';
    ctxSec.appendChild(makeSpan('上下文压缩水位', 'agzh-sec-label'));
    const ctxStr = snapshot.contextLimit
        ? `${fmtExact(snapshot.contextUsed)} / ${fmtExact(snapshot.contextLimit)} (${fmtPct((snapshot.contextPct || 0) / 100)})`
        : '—';
    ctxSec.appendChild(makeRow('已用 / 上限', ctxStr));
    if (snapshot.contextLimit) {
        const bar = document.createElement('div');
        bar.className = 'agzh-bar';
        const fill = document.createElement('div');
        fill.className = 'agzh-bar-fill';
        fill.setAttribute('data-level', ctxLevel(snapshot.contextPct));
        fill.style.width = `${Math.max(2, Math.min(100, snapshot.contextPct || 0))}%`;
        bar.appendChild(fill);
        ctxSec.appendChild(bar);
    }
    card.appendChild(ctxSec);

    // 2. 本轮生成
    const lc = snapshot.lastCall;
    if (lc) {
        const turnSec = document.createElement('div');
        turnSec.className = 'agzh-section';
        turnSec.appendChild(makeSpan('本轮调用', 'agzh-sec-label'));
        turnSec.appendChild(makeRow('端到端速率', fmtRate(lc.tokPerSec)));
        turnSec.appendChild(makeRow('纯流式速率', fmtRate(lc.streamTokPerSec)));
        turnSec.appendChild(makeRow('首字延迟 (TTFT)', fmtMs(lc.ttftMs)));
        const splitStr = `思考 ${lc.thinkingTokens !== null ? fmtExact(lc.thinkingTokens) : '—'} / 正文 ${fmtExact(lc.responseTokens)}`;
        turnSec.appendChild(makeRow('输出拆分', splitStr));
        turnSec.appendChild(makeRow('本轮缓存命中', fmtPct(lc.cacheHitRate)));
        card.appendChild(turnSec);
    }

    // 3. 会话累计
    const ses = snapshot.session;
    if (ses && ses.calls > 0) {
        const sesSec = document.createElement('div');
        sesSec.className = 'agzh-section';
        sesSec.appendChild(makeSpan('会话累计（附着起）', 'agzh-sec-label'));
        const outStr = ses.thinkingTokens !== null
            ? `${fmtExact(ses.outputTokens)} (思考 ${fmtExact(ses.thinkingTokens)} / 正文 ${fmtExact(ses.responseTokens)})`
            : fmtExact(ses.outputTokens);
        sesSec.appendChild(makeRow('累计输出', outStr));
        sesSec.appendChild(makeRow('加权缓存命中', fmtPct(snapshot.sessionCacheHitRate)));
        sesSec.appendChild(makeRow('累计总输入', fmtExact(ses.totalInputTokens)));
        card.appendChild(sesSec);
    }
}

function renderAll() {
    renderPill();
    if (card.getAttribute('data-visible') === 'true') {
        renderCard();
    }
    schedulePosition();
}

const onPillEnter = () => {
    hovering = true;
    showCard();
};
const onPillLeave = () => {
    hovering = false;
    scheduleClose();
};
const onCardEnter = () => {
    hovering = true;
    if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
    }
};
const onCardLeave = () => {
    hovering = false;
    scheduleClose();
};
const onPillClick = (e) => {
    e.stopPropagation();
    pinned = !pinned;
    if (pinned) showCard();
    else hideCard();
};
const onDocClick = (e) => {
    if (!pinned) return;
    if (e.composedPath && e.composedPath().includes(host)) return;
    hideCard();
};
const onKeyDown = (e) => {
    if (e.key === 'Escape' && (pinned || card.getAttribute('data-visible') === 'true')) {
        hideCard();
    }
};

pill.addEventListener('mouseenter', onPillEnter);
pill.addEventListener('mouseleave', onPillLeave);
pill.addEventListener('focus', onPillEnter);
pill.addEventListener('blur', onPillLeave);
pill.addEventListener('click', onPillClick);
card.addEventListener('mouseenter', onCardEnter);
card.addEventListener('mouseleave', onCardLeave);
document.addEventListener('click', onDocClick, true);
document.addEventListener('keydown', onKeyDown, true);
window.addEventListener('resize', schedulePosition);
document.addEventListener('scroll', schedulePosition, true);
document.addEventListener('visibilitychange', schedulePosition);

pollTimer = setInterval(() => {
    if (!document.hidden && (!anchor || !anchor.isConnected)) {
        schedulePosition();
    }
}, 800);

if (typeof AGZH_METRICS_REGISTER === 'function') {
    AGZH_METRICS_REGISTER((next) => {
        snapshot = next || null;
        renderAll();
    });
}

renderAll();

AGZH_ONTEARDOWN(() => {
    if (rafId) cancelAnimationFrame(rafId);
    if (pollTimer) clearInterval(pollTimer);
    if (closeTimer) clearTimeout(closeTimer);
    if (resizeObserver) {
        try { resizeObserver.disconnect(); } catch {}
    }
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', schedulePosition);
    document.removeEventListener('scroll', schedulePosition, true);
    document.removeEventListener('visibilitychange', schedulePosition);
    hideCard();
    host.remove();
});
})();
