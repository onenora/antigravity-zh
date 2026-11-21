---
name: antigravity-zh-i18n
description: Antigravity 升级或词条维护时，执行提取、去重、补全翻译与校验流程（遵循仓库 AGENTS.md 与 locale/glossary.json）。
---

# Antigravity 词库维护技能

在当前 `antigravity-zh` 仓库内维护中文词库与升级适配时，按本技能执行。所有术语约束、占位符语法与校验标准以仓库根目录的 [AGENTS.md](../../../AGENTS.md) 和 [glossary.json](../../../locale/glossary.json) 为准。

## 标准流程

1. 确保 Antigravity 正在运行，提取最新原文清单：
   ```bash
   node bin/cli.js i18n extract
   ```
   （已有本地 bundle 时可用 `node bin/cli.js i18n extract --bundle <main.js>` 离线提取。）

2. 规范化、按键排序并清理冗余/失效词条：
   ```bash
   node bin/cli.js i18n fmt
   ```

3. 导出待处理的新增原文：
   ```bash
   node bin/cli.js i18n missing --json
   ```

4. 逐条处理新增原文：
   - 需翻译的界面文案写入 `locale/messages.json`，严格遵守：
     - 术语统一使用 `locale/glossary.json` 规范译名，避免 `avoid` 禁用译名；
     - 中英文之间、中文与数字之间保留空格，句末用中文标点，`...` 保留；
     - 占位符 `{#name}`、`{name}`、`{0}` `{1}` 的编号与顺序与原文一致；
     - 产品名、模型名、快捷键、命令、模型推理档位保持英文。
   - 无需翻译的品牌、按键名、协议字段、提示词与第三方内部报错写入 `locale/ignore.json`。

5. 统一格式化并执行校验（确保 exit code 为 0）：
   ```bash
   node bin/cli.js i18n fmt
   node bin/cli.js i18n check
   ```

6. 同步项目版本号跟随 Antigravity 版本：将 `package.json` 的 `version`、`AGENTS.md` 基线版本与 `README.md` 测试环境版本号更新为当前 Antigravity 版本。
