# 词库维护指南

面向任何 AI 助手（含 Antigravity 自身）与人工维护者。项目通过 CDP 在运行时把 Antigravity 界面翻译为简体中文，不修改 `.app`。

## 基线

- 以本机安装的 Antigravity 为准，当前基线 **2.30.0**，只向后兼容新版本。
- 原文不在当前版本中的词条视为历史包袱，由 `i18n fmt` 自动移除；不要为旧版本保留词条。

## 文件

| 文件 | 内容 | 维护方式 |
| :--- | :--- | :--- |
| `locale/messages.json` | `{ "英文原文": "中文译文" }`，唯一译文来源 | 手工 / AI 编辑 |
| `locale/glossary.json` | `{ "术语": { "zh": 译名, "avoid": [禁用译名] } }` | 手工 / AI 编辑 |
| `locale/ignore.json` | 确认无需翻译的原文（品牌、按键名、第三方库报错、Google 内部功能、日期格式等） | 手工 / AI 编辑 |
| `locale/catalog.json` | `{ app, strings[] }`，当前版本的英文原文清单 | 仅由 `i18n extract` 生成 |
| `~/.antigravity-zh/messages.json` | 用户本地覆盖，优先级最高 | 用户自行编辑 |

所有文件按键排序、两空格缩进；`i18n fmt` 负责统一格式，提交前务必运行。

## 词条语法

```json
{
  "Settings": "设置",
  "Show {#count} more": "显示另外 {count} 项",
  "Worktree from {branch}": "基于 {branch} 的工作树",
  "Search conversations with {0} in the top left.": "使用左上角的 {0} 搜索对话。"
}
```

| 占位符 | 匹配 | 说明 |
| :--- | :--- | :--- |
| `{#name}` | 数字 `\d[\d,.]*` | 计数、时长、版本号 |
| `{name}` | 任意文本（可为空） | 捕获内容会再次查词条翻译 |
| `{0}` `{1}` … | 内联元素 | 富文本中夹带的图标、链接、按钮；译文必须保留全部编号且顺序不变 |

运行时匹配顺序：精确 → 忽略大小写（多词） → 占位符模式（字面量越长越优先） → 快捷键后缀 `(⌘K)` / 结尾冒号 → 列表拆分（`, `、` and `） → 省略号截断前缀。已能被这些规则推导出的词条会被判为冗余并移除，例如有了 `Settings` 就无需 `Settings:`。

## 流程

```bash
node bin/cli.js i18n extract    # 应用运行中：下载前端 bundle 并扫描 language_server，生成 catalog.json
node bin/cli.js i18n fmt        # 规范化、排序，移除冗余与过期词条，清理 ignore 中已失效的项
node bin/cli.js i18n missing    # 列出待翻译原文（--json 便于程序处理）
# 逐条处理：写入 messages.json，或确认无需翻译后写入 ignore.json
node bin/cli.js i18n check      # 校验，存在 error 时退出码为 1
```

应用升级后按此流程走一遍即可：`extract` 刷新清单，`fmt` 清掉已删除的文案，`missing` 给出新增文案。

## 校验规则

| 规则 | 级别 | 含义 |
| :--- | :--- | :--- |
| normalize | error | 键需规范化（多余空白、弯引号、`…`） |
| empty | error | 译文为空（品牌名 `Antigravity` 除外） |
| placeholder | error | 译文含原文没有的占位符，或 `{0}` `{1}` 缺失、顺序变化 |
| generic | error | 仅含文本占位且字面量少于 8 个字母，会误配任意文本；改用精确词条或 `{#n}` |
| number | warn | 原文中的数字未出现在译文 |
| glossary | warn | 使用了术语表 `avoid` 中的译名 |
| noop / whitespace / redundant / stale | warn | 由 `i18n fmt` 自动修复 |

## 翻译约定

- 术语以 `glossary.json` 为准：Agent 智能体、Artifact 工件、Conversation 对话、Workspace 工作区、Credit 额度、Token 保持英文等。
- 中英文、中文与数字之间加空格；句末使用中文标点，原文 `...` 保留为 `...`。
- 产品名、模型名、模型推理档位（Low、Medium、High、Extra、Max）、主题预设名（Default Light、Gruvbox Material 等）、快捷键、文件名、命令保持英文。
- 发送给模型的提示词、协议字段、日志与第三方库内部报错不翻译，写入 `ignore.json`。
- 不确定的文案先在 bundle 中查看上下文：`i18n extract --bundle <main.js>` 可离线复用已下载的 bundle。

## 代码结构

```
runtime/translator.js   匹配引擎（纯函数，浏览器与 Node 共用，校验结果与页面行为一致）
runtime/i18n.js         DOM 层：文本 / 属性 / 富文本分组、MutationObserver、shadow root
runtime/font.js         字体样式
lib/i18n/               extract（bundle 文本提取）· catalog（清单生成）· check（校验整理）· store（读写）
lib/bundle.js           注入载荷 = 词条 + translator + i18n + 字体
lib/daemon.js           守护进程：发现窗口、注入、热更新、自愈
```
