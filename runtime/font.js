/**
 * 自定义字体样式注入：全局设定目标字体，并 revert 复位图标字体。
 * 可用作用域变量：AGZH_FONT（字体名）、AGZH_ONTEARDOWN。
 */
(() => {
  const FONT_FAMILY = AGZH_FONT;

  // 字体未安装时不注入，界面保持应用默认的系统字体（等宽区域不受影响）。
  // 以字体名 + 通用族测宽，与仅通用族时宽度全部相同即视为未安装。
  const installed = (() => {
    try {
      const ctx = document.createElement('canvas').getContext('2d');
      const sample = 'mmmmmmmmmmlli 汉化字体 0123456789';
      return ['monospace', 'serif', 'sans-serif'].some((base) => {
        ctx.font = `72px ${base}`;
        const width = ctx.measureText(sample).width;
        ctx.font = `72px "${FONT_FAMILY}", ${base}`;
        return ctx.measureText(sample).width !== width;
      });
    } catch (e) {
      return true;
    }
  })();
  if (!installed) return;

  const CSS = `
    /* 全局 UI、Monaco 编辑器、终端与代码块统一应用字体 */
    body, html,
    .monaco-editor, .monaco-editor .view-lines, .monaco-editor .view-line,
    .cm-editor, .cm-editor *,
    .terminal, .terminal *,
    .xterm, .xterm *,
    pre, code, kbd,
    .font-mono, [class*="mtk"] {
      font-family: "${FONT_FAMILY}", "PingFang SC", -apple-system, BlinkMacSystemFont, monospace !important;
    }

    /* 精准复位图标字体，杜绝图标变方块或缺失 */
    [class*="codicon"], [class*="codicon"]::before, [class*="codicon"]::after,
    .monaco-editor [class*="codicon"], .monaco-editor [class*="codicon"]::before, .monaco-editor [class*="codicon"]::after,
    [class*="icon-"], [class*="icon-"]::before, [class*="icon-"]::after,
    [class*="symbol"], [class*="symbol"]::before, [class*="symbol"]::after {
      font-family: revert !important;
    }
  `;

  const inject = () => {
    try {
      if (document.getElementById('antigravity-mac-custom-font')) return;
      const target = document.head || document.documentElement;
      if (!target) return;
      const style = document.createElement('style');
      style.id = 'antigravity-mac-custom-font';
      style.textContent = CSS;
      target.appendChild(style);
    } catch (e) {}
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
  window.addEventListener('load', inject);
  const timers = [200, 1000].map((ms) => setTimeout(inject, ms));

  if (typeof AGZH_ONTEARDOWN === 'function') {
    AGZH_ONTEARDOWN(() => {
      timers.forEach(clearTimeout);
      document.removeEventListener('DOMContentLoaded', inject);
      window.removeEventListener('load', inject);
      const el = document.getElementById('antigravity-mac-custom-font');
      if (el) el.remove();
    });
  }
})();
