# Antigravity 汉化

Antigravity 简体中文本地化与字体增强工具。

---

## 核心特性

- **零侵入**：基于 Chrome DevTools Protocol 运行时注入，不修改 `Antigravity.app`，官方签名完整，应用内更新照常可用。
- **开机即用**：后台服务随登录启动，新窗口、刷新、页面跳转自动汉化，注入丢失自动恢复。
- **热更新**：配置与自定义词条保存后数秒生效，无需重启应用。
- **精准隔离**：代码编辑器、终端、对话正文与文件路径保持原样。
- **字体覆盖与保护**：默认 [JKaiMono](https://github.com/onenora/JKaiMono)，覆盖 UI、编辑器与终端并保护图标字体；字体未安装时保持系统字体。

---

## 测试环境

- **系统**：macOS 27.2（Apple Silicon M1）
- **Node.js**：`v26.13.0`（最低 `>= 22`）
- **应用**：Antigravity `2.30.0` 官方版（`/Applications/Antigravity.app`）

---

## 使用方法

```bash
# 1. 安装简体中文汉化（默认字体 JKaiMono）
node bin/cli.js install

# 2. 指定自定义字体（例如 JetBrains Mono）
node bin/cli.js install --font "JetBrains Mono"

# 3. 纯净汉化（不注入字体）
node bin/cli.js install --font none

# 4. 查看服务与窗口状态
node bin/cli.js status

# 5. 卸载，恢复官方英文界面
node bin/cli.js uninstall
```

也可以通过 npm scripts 快速执行：

```bash
npm run setup    # 安装
npm run status   # 状态
npm run remove   # 卸载
```

#### CLI 参数说明

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `--font <字体名>` | `JKaiMono` | 自定义字体；`none` 禁用字体注入 |
| `--brand-title <模式>` | `english` | 品牌名：`english`（保持英文）/ `hidden`（隐藏）/ `translated`（翻译） |
| `-h`, `--help` | - | 查看命令行帮助 |

#### 用户文件

| 路径 | 说明 |
| :--- | :--- |
| `~/.antigravity-zh/config.json` | 配置；`"enabled": false` 暂停汉化 |
| `~/.antigravity-zh/messages.json` | 自定义词条，优先级最高，如 `{ "Settings": "偏好设置" }` |
| `~/Library/Logs/antigravity-zh.log` | 后台服务日志 |

---

## 目录结构

```
antigravity-zh/
├── bin/
│   └── cli.js          # 命令行入口
├── lib/
│   ├── daemon.js       # 后台服务（窗口发现、注入、热更新、自愈）
│   ├── service.js      # 运行时部署与 LaunchAgent
│   ├── bundle.js       # 注入载荷构建
│   ├── cdp.js          # DevTools 端口发现与 CDP 会话
│   └── i18n/           # 词库工具（原文提取、校验整理）
├── runtime/            # 注入页面的汉化引擎与字体样式
└── locale/             # 简体中文词库、术语表
```

---

## 常见问题

### 1. 系统设置「登录项与扩展」中的 `antigravity-zh` 是什么？

汉化后台服务。关闭后停止汉化，`uninstall` 会将其移除。

### 2. Antigravity 官方推送新版本后如何升级？

无需任何操作，汉化自动跟随。更新汉化本身：`git pull` 后重新运行 `node bin/cli.js install`。

### 3. 为什么部分界面仍是英文？

原生菜单栏、托盘与系统对话框由主进程创建，无法注入；应用启动后首屏约 1–2 秒为英文。词库维护见 [AGENTS.md](AGENTS.md)。

---

## Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=onenora/antigravity-zh&type=Date)](https://star-history.com/#onenora/antigravity-zh&Date)

---

## 许可

[MIT](LICENSE)
