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
    if (ms >= 1000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;
    return `${Math.round(ms)}ms`;
};

const fmtPct = (ratio) => {
    if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
    return `${(ratio * 100).toFixed(1).replace(/\.0$/, '')}%`;
};

const fmtRate = (rate) => {
    if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
    return `${rate.toFixed(1).replace(/\.0$/, '')} tok/s`;
};

function parseRgba(str) {
    if (!str || typeof str !== 'string') return null;
    const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i.exec(str);
    if (!m) return null;
    return {
        r: Number(m[1]),
        g: Number(m[2]),
        b: Number(m[3]),
        a: m[4] === undefined ? 1 : Number(m[4]),
    };
}

const DEFAULT_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

function isFontInstalled(name) {
    if (!name) return false;
    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
        if (!ctx) return true;
        const sample = 'mmmmmmmmmmlli 汉化字体 0123456789';
        return ['monospace', 'serif', 'sans-serif'].some((base) => {
            ctx.font = `72px ${base}`;
            const width = ctx.measureText(sample).width;
            ctx.font = `72px "${name}", ${base}`;
            return ctx.measureText(sample).width !== width;
        });
    } catch {
        return true;
    }
}

function resolveFontStack(target, sampleEl) {
    const configured = (typeof AGZH_METRICS_FONT === 'string') ? AGZH_METRICS_FONT.trim() : '';
    if (configured && isFontInstalled(configured)) {
        const safeName = configured.replace(/["\\]/g, '\\$&');
        return `"${safeName}", "PingFang SC", -apple-system, BlinkMacSystemFont, monospace`;
    }
    try {
        if (typeof getComputedStyle === 'function') {
            const el = sampleEl || target || document.body;
            const computed = el ? getComputedStyle(el).fontFamily : '';
            if (computed && computed.trim()) return computed;
        }
    } catch {}
    return DEFAULT_FONT_STACK;
}

function parseHex(str) {
    if (!str || typeof str !== 'string') return null;
    const hex = str.trim().replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(hex)) {
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
            a: 1,
        };
    }
    if (/^[0-9a-f]{3}$/i.test(hex)) {
        return {
            r: parseInt(hex[0] + hex[0], 16),
            g: parseInt(hex[1] + hex[1], 16),
            b: parseInt(hex[2] + hex[2], 16),
            a: 1,
        };
    }
    return null;
}

function parseColor(str) {
    return parseRgba(str) || parseHex(str);
}

function isChromatic(c) {
    if (!c || c.a < 0.25) return false;
    return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) >= 18;
}

let cachedAccent = null;

function readCssVarColor(names) {
    try {
        if (typeof getComputedStyle !== 'function' || !document.documentElement) return null;
        const rootStyle = getComputedStyle(document.documentElement);
        for (const name of names) {
            const raw = rootStyle.getPropertyValue(name);
            const c = parseColor(raw);
            if (c && c.a > 0.2) return c;
        }
    } catch {}
    return null;
}

function firstBgColor(elements, minAlpha = 0.2) {
    for (const el of elements) {
        if (!el) continue;
        try {
            const c = parseRgba(getComputedStyle(el).backgroundColor);
            if (c && c.a >= minAlpha) return c;
        } catch {}
    }
    return null;
}

function detectTheme(target, gapInfo) {
    let dark = false;
    const leftEl = gapInfo ? gapInfo.leftEl : null;
    const sendEl = gapInfo ? gapInfo.sendEl : null;
    try {
        if (typeof getComputedStyle === 'function') {
            const surfaceEl = target && target.firstElementChild ? target.firstElementChild : null;
            const ancestors = [];
            let cur = target ? target.parentElement : null;
            while (cur) {
                ancestors.push(cur);
                cur = cur.parentElement;
            }
            if (document.body) ancestors.push(document.body);
            if (document.documentElement) ancestors.push(document.documentElement);

            // 优先采纳输入框内层表面与页面背景色，跟随 Dracula / 任意主题底色
            const surfaceBg = firstBgColor([surfaceEl], 0.5);
            const pageBg = firstBgColor(ancestors, 0.35);
            const bg = surfaceBg || pageBg || firstBgColor([target], 0.35);

            if (bg) {
                const lum = (0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b) / 255;
                dark = lum < 0.5;
            } else if (typeof window.matchMedia === 'function') {
                dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            }

            // 外层 p-px bg-card-border 常为卡片描边色
            const borderC = firstBgColor([target], 0.08);
            const sampleFg = leftEl ? parseRgba(getComputedStyle(leftEl).color) : null;
            const mainFg = parseRgba(getComputedStyle(target || document.body).color)
                || (document.body ? parseRgba(getComputedStyle(document.body).color) : null);

            // 强调色：优先取发送按钮真实背景色（如 Dracula #BD93F9），其次读取常见主题 CSS 变量
            let accentC = null;
            if (sendEl) {
                const sc = parseRgba(getComputedStyle(sendEl).backgroundColor);
                if (isChromatic(sc)) accentC = sc;
            }
            if (!accentC) {
                const vc = readCssVarColor(['--primary', '--accent', '--vscode-focusBorder', '--vscode-button-background']);
                if (isChromatic(vc)) accentC = vc;
            }
            if (accentC) cachedAccent = `rgb(${accentC.r}, ${accentC.g}, ${accentC.b})`;

            const cardBg = bg
                ? `rgba(${bg.r}, ${bg.g}, ${bg.b}, 0.97)`
                : (dark ? 'rgba(24, 27, 35, 0.97)' : 'rgba(255, 255, 255, 0.98)');
            const cardBorder = borderC && borderC !== surfaceBg
                ? `rgba(${borderC.r}, ${borderC.g}, ${borderC.b}, ${Math.max(0.35, Math.min(0.9, borderC.a))})`
                : (dark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(15, 23, 42, 0.14)');

            const fgC = sampleFg || mainFg;
            const cardFgC = mainFg || sampleFg;
            return {
                dark,
                fg: fgC ? `rgba(${fgC.r}, ${fgC.g}, ${fgC.b}, 0.78)` : (dark ? 'rgba(216, 222, 234, 0.76)' : 'rgba(55, 65, 81, 0.82)'),
                fgHover: fgC ? `rgba(${fgC.r}, ${fgC.g}, ${fgC.b}, 0.98)` : (dark ? 'rgba(244, 247, 252, 0.98)' : 'rgba(17, 24, 39, 0.98)'),
                divider: fgC ? `rgba(${fgC.r}, ${fgC.g}, ${fgC.b}, 0.22)` : (dark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(15, 23, 42, 0.18)'),
                cardBg,
                cardFg: cardFgC ? `rgba(${cardFgC.r}, ${cardFgC.g}, ${cardFgC.b}, 0.95)` : (dark ? 'rgba(235, 238, 245, 0.95)' : 'rgba(20, 24, 34, 0.94)'),
                cardBorder,
                pillBg: bg ? `rgba(${bg.r}, ${bg.g}, ${bg.b}, 0.92)` : (dark ? 'rgba(24, 26, 32, 0.9)' : 'rgba(250, 251, 254, 0.94)'),
                accent: cachedAccent || '#34d399',
            };
        }
    } catch {}
    return {
        dark,
        fg: dark ? 'rgba(216, 222, 234, 0.76)' : 'rgba(55, 65, 81, 0.82)',
        fgHover: dark ? 'rgba(244, 247, 252, 0.98)' : 'rgba(17, 24, 39, 0.98)',
        divider: dark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(15, 23, 42, 0.18)',
        cardBg: dark ? 'rgba(24, 27, 35, 0.97)' : 'rgba(255, 255, 255, 0.98)',
        cardFg: dark ? 'rgba(235, 238, 245, 0.95)' : 'rgba(20, 24, 34, 0.94)',
        cardBorder: dark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(15, 23, 42, 0.14)',
        pillBg: dark ? 'rgba(24, 26, 32, 0.9)' : 'rgba(250, 251, 254, 0.94)',
        accent: cachedAccent || '#34d399',
    };
}

let snapshot = (typeof AGZH_METRICS_INIT !== 'undefined' && AGZH_METRICS_INIT) ? AGZH_METRICS_INIT : null;
let anchor = null;
let observedLeft = null;
let observedRight = null;
let resizeObserver = null;
let rafId = 0;
let pollTimer = null;
let closeTimer = null;
let pinned = false;
let hovering = false;

const host = document.createElement('div');
host.id = 'agzh-metrics-host';
host.setAttribute('translate', 'no');
host.style.cssText = 'position:fixed;inset:auto;z-index:15;pointer-events:none;display:none;margin:0;padding:0;';

const shadow = host.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = `
:host {
  all: initial;
  --agzh-font: ${DEFAULT_FONT_STACK};
  font-family: var(--agzh-font);
  --agzh-fg: rgba(216, 222, 234, 0.78);
  --agzh-fg-hover: rgba(244, 247, 252, 0.98);
  --agzh-divider: rgba(255, 255, 255, 0.18);
  --agzh-pill-bg: rgba(24, 26, 32, 0.9);
  --agzh-pill-border: rgba(255, 255, 255, 0.14);
  --agzh-card-bg: rgba(24, 27, 35, 0.97);
  --agzh-card-fg: rgba(235, 238, 245, 0.95);
  --agzh-card-border: rgba(255, 255, 255, 0.14);
  --agzh-accent: #34d399;
}
:host([data-theme="light"]) {
  --agzh-fg: rgba(55, 65, 81, 0.82);
  --agzh-fg-hover: rgba(17, 24, 39, 0.98);
  --agzh-divider: rgba(15, 23, 42, 0.18);
  --agzh-pill-bg: rgba(250, 251, 254, 0.94);
  --agzh-pill-border: rgba(15, 23, 42, 0.14);
  --agzh-card-bg: rgba(255, 255, 255, 0.98);
  --agzh-card-fg: rgba(20, 24, 34, 0.94);
  --agzh-card-border: rgba(15, 23, 42, 0.14);
}
.agzh-pill {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: inherit;
  font-size: 11.5px;
  line-height: 16px;
  font-weight: 450;
  font-variant-numeric: tabular-nums;
  cursor: default;
  user-select: none;
  box-sizing: border-box;
  border: 0;
  margin: 0;
  background: transparent;
  color: var(--agzh-fg);
  padding: 2px 6px 2px 10px;
  border-left: 1px solid var(--agzh-divider);
  border-radius: 0;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
}
.agzh-pill:hover,
.agzh-pill[data-open="true"] {
  color: var(--agzh-fg-hover);
}
.agzh-pill[data-mode="floating"] {
  padding: 3px 9px;
  height: auto;
  border-radius: 999px;
  background: var(--agzh-pill-bg);
  border: 1px solid var(--agzh-pill-border);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
}
.agzh-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--agzh-accent);
  flex-shrink: 0;
}
.agzh-pill[data-level="warn"] .agzh-dot { background: #fbbf24; }
.agzh-pill[data-level="danger"] .agzh-dot { background: #f87171; }
.agzh-pill[data-level="muted"] .agzh-dot { background: #9ca3af; }
.agzh-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agzh-card {
  position: fixed;
  margin: 0;
  padding: 10px 12px;
  width: 288px;
  border-radius: 10px;
  font-family: var(--agzh-font);
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--agzh-card-fg);
  background: var(--agzh-card-bg);
  border: 1px solid var(--agzh-card-border);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.34);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  display: none;
  box-sizing: border-box;
  pointer-events: auto;
}
.agzh-card[data-visible="true"] { display: block; }
:host([data-theme="light"]) .agzh-card {
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.14);
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
  background: var(--agzh-accent);
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

function findToolbarGap(target, ar) {
    if (!target || typeof target.querySelectorAll !== 'function') return null;
    const raw = [];
    const nodes = target.querySelectorAll('button, [role="button"], [aria-haspopup]');
    for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r.width < 12 || r.height < 14 || r.height > 46) continue;
        if (r.width >= ar.width * 0.65) continue;
        if (r.bottom < ar.bottom - 52 || r.top < ar.bottom - 56 || r.bottom > ar.bottom + 2) continue;
        raw.push({ el, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    if (raw.length < 2) return null;

    // 过滤被外层按钮包含的子元素
    const items = raw.filter((a, i) => !raw.some((b, j) => (
        i !== j &&
        b.left <= a.left + 1 &&
        b.right >= a.right - 1 &&
        b.top <= a.top + 1 &&
        b.bottom >= a.bottom - 1 &&
        (b.right - b.left) * (b.bottom - b.top) > (a.right - a.left) * (a.bottom - a.top)
    )));
    if (items.length < 2) return null;

    items.sort((a, b) => a.left - b.left);
    let bestIdx = -1;
    let maxGap = 0;
    for (let i = 0; i < items.length - 1; i++) {
        const gap = items[i + 1].left - items[i].right;
        if (gap > maxGap) {
            maxGap = gap;
            bestIdx = i;
        }
    }
    if (bestIdx < 0 || maxGap < 100) return null;

    const leftItem = items[bestIdx];
    const rightItem = items[bestIdx + 1];
    const sendItem = items[items.length - 1];
    return {
        leftEl: leftItem.el,
        rightEl: rightItem.el,
        sendEl: sendItem ? sendItem.el : rightItem.el,
        leftEdge: leftItem.right,
        rightEdge: rightItem.left,
        centerY: (leftItem.top + leftItem.bottom) / 2,
        gap: maxGap,
    };
}

function observeTargets(nextAnchor, nextLeft, nextRight) {
    if (nextAnchor === anchor && nextLeft === observedLeft && nextRight === observedRight) return;
    anchor = nextAnchor;
    observedLeft = nextLeft;
    observedRight = nextRight;
    if (typeof ResizeObserver !== 'function') return;
    if (!resizeObserver) resizeObserver = new ResizeObserver(() => schedulePosition());
    try { resizeObserver.disconnect(); } catch {}
    if (anchor) try { resizeObserver.observe(anchor); } catch {}
    if (observedLeft) try { resizeObserver.observe(observedLeft); } catch {}
    if (observedRight) try { resizeObserver.observe(observedRight); } catch {}
}

function ensureAnchor() {
    if (anchor && anchor.isConnected) {
        const r = anchor.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return anchor;
    }
    const next = findAnchor();
    observeTargets(next, null, null);
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

    const gapInfo = findToolbarGap(target, r);
    observeTargets(target, gapInfo ? gapInfo.leftEl : null, gapInfo ? gapInfo.rightEl : null);

    const theme = detectTheme(target, gapInfo);
    host.setAttribute('data-theme', theme.dark ? 'dark' : 'light');
    host.style.setProperty('--agzh-font', resolveFontStack(target, gapInfo ? gapInfo.leftEl : null));
    host.style.setProperty('--agzh-fg', theme.fg);
    host.style.setProperty('--agzh-fg-hover', theme.fgHover);
    host.style.setProperty('--agzh-divider', theme.divider);
    host.style.setProperty('--agzh-card-bg', theme.cardBg);
    host.style.setProperty('--agzh-card-fg', theme.cardFg);
    host.style.setProperty('--agzh-card-border', theme.cardBorder);
    host.style.setProperty('--agzh-pill-bg', theme.pillBg);
    host.style.setProperty('--agzh-accent', theme.accent);

    host.style.display = 'block';
    if (gapInfo) {
        pill.setAttribute('data-mode', 'inline');
        const leftPx = Math.round(gapInfo.leftEdge + 10);
        const maxWidthPx = Math.max(80, Math.floor(gapInfo.rightEdge - leftPx - 10));
        const topPx = Math.max(4, Math.round(gapInfo.centerY - 11));
        host.style.left = `${leftPx}px`;
        host.style.top = `${topPx}px`;
        host.style.right = 'auto';
        host.style.bottom = 'auto';
        host.style.maxWidth = `${maxWidthPx}px`;
    } else {
        pill.setAttribute('data-mode', 'floating');
        const rightPx = Math.max(8, Math.round(window.innerWidth - r.right + 2));
        const preferredBottom = Math.round(window.innerHeight - r.top + 6);
        const maxBottom = Math.max(8, window.innerHeight - 32);
        const bottomPx = Math.max(8, Math.min(preferredBottom, maxBottom));
        host.style.left = 'auto';
        host.style.top = 'auto';
        host.style.right = `${rightPx}px`;
        host.style.bottom = `${bottomPx}px`;
        host.style.maxWidth = `${Math.max(120, Math.round(r.width - 16))}px`;
    }

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
    let left = pr.left;
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
        pill.appendChild(makeSpan('遥测 · 等待首轮响应', 'agzh-text'));
        return;
    }
    if (snapshot.status === 'unavailable') {
        pill.setAttribute('data-level', 'muted');
        pill.appendChild(makeSpan('遥测 · SQLite 不可用', 'agzh-text'));
        return;
    }
    if (snapshot.status === 'incompatible') {
        pill.setAttribute('data-level', 'warn');
        pill.appendChild(makeSpan('遥测 · 协议不兼容', 'agzh-text'));
        return;
    }

    const level = ctxLevel(snapshot.contextPct);
    pill.setAttribute('data-level', level);

    const parts = [];
    const lc = snapshot.lastCall;
    if (lc && lc.tokPerSec !== null) {
        parts.push(fmtRate(lc.tokPerSec));
    }
    if (lc && lc.ttftMs !== null) {
        parts.push(`TTFT ${fmtMs(lc.ttftMs)}`);
    }
    if (snapshot.contextLimit) {
        parts.push(`上下文 ${fmtNum(snapshot.contextUsed)}/${fmtNum(snapshot.contextLimit)} (${Math.round(snapshot.contextPct || 0)}%)`);
    }
    if (lc && lc.cacheHitRate !== null) {
        parts.push(`缓存 ${fmtPct(lc.cacheHitRate)}`);
    }
    pill.appendChild(makeSpan(parts.length ? parts.join(' · ') : '遥测就绪', 'agzh-text'));
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
    schedulePosition();
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
