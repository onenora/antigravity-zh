/**
 * DOM 汉化层（运行于 Antigravity 主窗口页面主世界）。
 * 由 lib/bundle.js 拼接在 translator.js 之后注入，可用作用域变量：
 *   AGZH_MESSAGES    { 英文: 中文 } 词条
 *   AGZH_ONTEARDOWN  注册卸载回调
 */
(() => {
    const { translate } = createTranslator(AGZH_MESSAGES);

    const ATTRS = ['placeholder', 'title', 'aria-label'];
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'PRE', 'CODE', 'svg']);
    const MAX_INLINE = 4;
    // 不翻译的区域：代码与编辑器、输入框、终端、文件路径、用户消息与模型回复正文
    const ISOLATE = [
        'pre', 'code', '[contenteditable]:not([contenteditable="false"])', '[data-lexical-editor]',
        '.monaco-editor', '.cm-editor', '.terminal', '.xterm', '.code-line', '.code-block', '.line-content',
        '.token', '.hljs', '[class*="mtk"]', '[class*="diffEditor"]', '.font-mono',
        '[translate="no"]', '.notranslate',
        '[aria-label="File Viewer"]', '[data-file-uri]', '[data-uri]', '[data-testid="file-title-name"]',
        '[data-testid="entity-pill"]', '[data-project-card="true"]', '.context-scope-mention',
        '[data-quotable-inline="true"]', '.md-divider-spacing', '.cursor-edit',
        '[data-testid="conversation-row-sidebar"] span.truncate',
        '[data-testid="user-input-step"] [data-quotable="true"]', '[data-testid="user-input-step"] .whitespace-pre-wrap',
        '[data-testid="planner-response-text"]', '[data-testid="progress-update-response-text"]',
        '[data-testid="agent-response"] [data-markdown-root]', '[data-testid="thinking-collapsible-trigger"] ~ div',
        '[data-testid="side-question-followup-user"]', '[data-testid="side-question-answer"] [data-markdown-root]',
        '[data-testid="automation-instructions-markdown"]', '[data-testid="lsp-symbol-hover-card"]',
        '[data-testid="webview-download-filename"]', '[data-testid="live-user-turn"]', '[data-testid="live-agent-turn"]'
    ].join(',');

    const isPath = (s) => /^(?:[~/]|\.\.?\/|file:\/\/).*\//.test(s) || /\/\.gemini\/|\/SKILL\.md/i.test(s);
    const hasWords = (s) => /[A-Za-z]{2,}/.test(s);

    /** 文本节点状态：src 为原文，out 为写入的译文；节点值等于 out 时视为已处理 */
    const state = new WeakMap();
    const groups = new WeakSet();
    const roots = new WeakSet();

    const sourceOf = (node) => {
        const s = state.get(node);
        return s && s.out === node.nodeValue ? s.src : node.nodeValue;
    };

    function write(node, src, out) {
        state.set(node, { src, out });
        if (node.nodeValue !== out) node.nodeValue = out;
    }

    /** 翻译并保留原文首尾空白；无译文返回 null */
    function translateRaw(raw) {
        const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
        if (!hasWords(core) || isPath(core)) return null;
        const t = translate(core);
        if (t == null || t === core) return null;
        return t && lead + t + trail;
    }

    function visitText(node) {
        const src = sourceOf(node);
        const out = translateRaw(src);
        if (out != null) write(node, src, out);
        else if (src !== node.nodeValue) node.nodeValue = src;
    }

    function visitAttrs(el) {
        for (const name of ATTRS) {
            const v = el.getAttribute(name);
            if (!v) continue;
            const t = translateRaw(v);
            if (t != null && t !== v) el.setAttribute(name, t);
        }
    }

    /**
     * 整体翻译被拆分的句子：
     * - 多个相邻文本节点（React 插值 "Show ", 5, " more..."）
     * - 文本夹带少量内联元素（"Search conversations with", <icon>, "in the top left."），元素记为 {0} {1}…
     * 成功返回 true，子文本节点不再单独翻译。
     */
    function visitGroup(el) {
        const slots = [[]];
        let texts = 0;
        for (const child of el.childNodes) {
            if (child.nodeType === 3) { slots[slots.length - 1].push(child); texts++; }
            else if (child.nodeType === 1) { if (slots.push([]) > MAX_INLINE + 1) return false; }
            else if (child.nodeType !== 8) return false;
        }
        const inline = slots.length - 1;
        if (texts < (inline ? 1 : 2)) return false;

        const sources = slots.map((nodes) => nodes.map(sourceOf));
        const key = sources.map((s) => s.join('')).reduce((acc, s, i) => `${acc}{${i - 1}}${s}`);
        if (!hasWords(key) || isPath(key.trim())) return false;
        const t = translate(key);
        if (t == null) {
            if (inline) return false;
            // 若各子节点均为独立完整句子（如 model unavailable + " Pick a model to change it."），交由 visitText 逐句翻译
            if (sources[0].every((s) => !s.trim() || /[.!?]$/.test(s.trim()))) return false;
            // 纯文本拼接（"No ", plural, " yet"）整句无译文时保持原文，避免逐段翻译出「否 automations yet」
            slots[0].forEach((node, j) => write(node, sources[0][j], sources[0][j]));
            groups.add(el);
            return true;
        }

        // 译文按 {i} 切回各段，占位必须完整且保持顺序
        const segments = t.split(/\{(\d+)\}/);
        if (segments.length !== inline * 2 + 1) return false;
        for (let i = 1; i < segments.length; i += 2) if (Number(segments[i]) !== (i - 1) / 2) return false;
        const parts = segments.filter((_, i) => i % 2 === 0);
        if (parts.some((p, i) => p.trim() && !slots[i].length)) return false;

        slots.forEach((nodes, i) => nodes.forEach((node, j) => write(node, sources[i][j], j === 0 ? parts[i] : '')));
        groups.add(el);
        return true;
    }

    function isolated(node) {
        let el = node.nodeType === 1 ? node : node.parentElement || node.host;
        while (el) {
            if (el.isContentEditable || el.closest(ISOLATE)) return true;
            const root = el.getRootNode();
            el = root && root.host;
        }
        return false;
    }

    function visitElement(el) {
        visitAttrs(el);
        if (SKIP_TAGS.has(el.tagName)) return;
        if (el.isContentEditable || el.matches(ISOLATE)) return;
        if (el.shadowRoot) observeRoot(el.shadowRoot);
        if (visitGroup(el)) {
            for (const child of el.children) visitElement(child);
            return;
        }
        for (const child of el.childNodes) {
            if (child.nodeType === 3) visitText(child);
            else if (child.nodeType === 1) visitElement(child);
        }
    }

    function visit(node) {
        if (node.nodeType === 1) {
            if (!isolated(node)) visitElement(node);
        } else if (node.nodeType === 3) {
            const parent = node.parentElement;
            if (!parent || SKIP_TAGS.has(parent.tagName) || isolated(parent)) return;
            // 新增或被框架更新的文本先按所在分组整体翻译；原为分组但已不成句时拆回逐节点翻译
            if (visitGroup(parent)) return;
            if (!groups.has(parent)) return visitText(node);
            groups.delete(parent);
            for (const child of parent.childNodes) if (child.nodeType === 3) visitText(child);
        } else if (node.nodeType === 11) {
            for (const child of node.childNodes) visit(child);
        }
    }

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type === 'childList') m.addedNodes.forEach(visit);
            else if (m.type === 'characterData') visit(m.target);
            else if (m.type === 'attributes' && !isolated(m.target)) visitAttrs(m.target);
        }
    });
    const OBSERVE = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS };

    function observeRoot(root) {
        if (roots.has(root)) return;
        roots.add(root);
        observer.observe(root, OBSERVE);
        for (const child of root.childNodes) visit(child);
    }

    // 新建的 shadow root 不在 document 观察范围内，需单独挂载
    const attachShadow = Element.prototype.attachShadow;
    const patchedAttachShadow = function (...args) {
        const root = attachShadow.apply(this, args);
        try { observeRoot(root); } catch (e) {}
        return root;
    };
    Element.prototype.attachShadow = patchedAttachShadow;

    observer.observe(document, OBSERVE);
    if (document.documentElement) visit(document.documentElement);

    AGZH_ONTEARDOWN(() => {
        observer.disconnect();
        if (Element.prototype.attachShadow === patchedAttachShadow) Element.prototype.attachShadow = attachShadow;
    });
})();
