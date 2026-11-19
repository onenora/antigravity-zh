# Antigravity 汉化

Antigravity 简体中文本地化与字体增强工具。

---

## 核心特性

- **双引擎零侵入**：不修改 `Antigravity.app`，官方签名完整，应用内更新照常可用。
  - **主引擎（主进程 Hook）**：启动时通过临时 `--inspect-brk` 一次性加载主进程 Hook 并随即关闭调试端口，运行期零开放端口、零首屏英文闪烁，支持原生菜单栏 / Dock / 托盘 / 对话框汉化，无需后台常驻轮询。
  - **降级引擎（事件驱动 Browser CDP）**：当未来上游版本关闭 `EnableNodeCliInspectArguments` Fuse 时自动降级，单连接 `Target.setAutoAttach` + `fs.watch` 替代高频轮询。
- **独立原生启动器（可选）**：运行 `node bin/cli.js launcher` 可用原生 Swift 编译生成 `~/Applications/Antigravity-zh.app`（复用官方图标，零 Node.js 运行时依赖，不留双 Dock 图标），构建后也可直接通过启动台、Spotlight 或 Dock 点击启动。
- **热更新**：配置与自定义词条保存后数秒生效，无需重启应用。
- **精准隔离**：代码编辑器、终端、对话正文与文件路径保持原样。
- **实时遥测胶囊（可选，默认关闭）**：通过 `metrics on` 或 Sidecar 面板一键开启，在输入框旁悬浮展示本轮与累计上下文水位线、端到端/纯流式速率、TTFT、思考与正文拆分、缓存命中率；与汉化载荷完全解耦，开关不触发界面重注闪烁。
- **配套 Sidecar 控制面板（可选）**：运行 `node bin/cli.js plugin` 安装侧边辅助面板，可在 Antigravity 内直接查看状态/日志、开关汉化与遥测、调整字体/品牌模式并编辑用户覆盖词条。
- **字体覆盖与保护**：默认 [JKaiMono](https://github.com/onenora/JKaiMono)，覆盖 UI、编辑器与终端并保护图标字体；字体未安装时保持系统字体。

---

## 测试环境

- **系统**：macOS 27.2（Apple Silicon M1）
- **Node.js**：`v26.13.0`（最低 `>= 22`）
- **应用**：Antigravity `2.33.0` 官方版（`/Applications/Antigravity.app`）

---

## 使用方法

```bash
# 1. 安装运行时与配置（默认字体 JKaiMono）
node bin/cli.js install

# 2. 指定自定义字体（例如 JetBrains Mono）
node bin/cli.js install --font "JetBrains Mono"

# 3. 纯净汉化（不注入字体）
node bin/cli.js install --font none

# 4. 默认通过 CLI 启动 Antigravity
node bin/cli.js launch

# 5. （可选）单独编译原生 Swift 启动器 ~/Applications/Antigravity-zh.app
node bin/cli.js launcher
# 构建后点击该 .app 亦可启动汉化版；移除启动器：node bin/cli.js launcher remove

# 6. （可选）开启实时遥测胶囊 / 安装配套侧边控制面板插件
node bin/cli.js metrics on
node bin/cli.js plugin

# 7. 查看服务、Fuse、启动器、遥测、插件与窗口状态
node bin/cli.js status

# 8. 卸载，恢复官方英文界面
node bin/cli.js uninstall
```

也可以通过 npm scripts 快速执行：

```bash
npm run setup     # 安装
npm run launch    # CLI 启动
npm run launcher  # 构建原生 Swift 启动器（可选）
npm run status    # 状态
npm run remove    # 卸载
```

#### CLI 参数说明

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `--font <字体名>` | `JKaiMono` | 自定义字体；`none` 禁用字体注入 |
| `--brand-title <模式>` | `english` | 品牌名：`english`（保持英文）/ `hidden`（隐藏）/ `translated`（翻译） |
| `--engine <模式>` | `auto` | 引擎：`auto`（Hook 优先，自动降级）/ `hook`（仅主进程 Hook）/ `cdp`（仅事件驱动 CDP） |
| `--metrics` / `--no-metrics` | `false` | 开启或关闭实时遥测胶囊（亦可运行 `metrics on\|off`） |
| `--restart` | `false` | `launch` 时若应用正以英文运行，先退出再重启 |
| `-h`, `--help` | - | 查看命令行帮助 |

#### 用户文件

| 路径 | 说明 |
| :--- | :--- |
| `~/Applications/Antigravity-zh.app` | 原生 Swift 启动器（可选，由 `launcher` 命令单独构建） |
| `~/.gemini/config/plugins/antigravity-zh/` | 配套 Antigravity 侧边控制面板插件（由 `plugin` 命令安装） |
| `~/.antigravity-zh/config.json` | 配置；`"enabled": false` 暂停汉化，`"metrics": true` 开启遥测胶囊 |
| `~/.antigravity-zh/messages.json` | 自定义词条，优先级最高，如 `{ "Settings": "偏好设置" }` |
| `~/Library/Logs/antigravity-zh.log` | 运行日志（超过 1 MB 自动轮转截断） |

---

## 目录结构

```
antigravity-zh/
├── bin/
│   └── cli.js          # 命令行入口
├── launcher/
│   └── main.swift      # 原生 Swift 启动器源码（零运行时依赖）
├── lib/
│   ├── app.js          # 应用检查、Electron Fuse 读取与双引擎启动
│   ├── launcher.js     # 原生 Swift 启动器编译与 .app 打包
│   ├── daemon.js       # 事件驱动守护进程（降级 CDP 兜底）
│   ├── service.js      # 运行时部署与 LaunchAgent
│   ├── bundle.js       # 注入载荷构建
│   ├── cdp.js          # Browser-level CDP（autoAttach）与目标发现
│   ├── log.js          # 日志轮转写入
│   ├── metrics/        # 遥测解码、会话指标计算与 SQLite WAL 增量监听
│   └── i18n/           # 词库工具（原文提取、校验整理）
├── plugin/             # 配套 Antigravity 插件与 Sidecar 控制面板
├── runtime/            # 注入引擎（main-hook、translator、i18n、font、metrics）
├── .agents/skills/     # 仓库级词库维护 Skill
└── locale/             # 简体中文词库、原生菜单词表、术语表
```

---

## 常见问题

### 1. 系统设置「登录项与扩展」中的 `antigravity-zh` 是什么？

降级用后台服务（仅当 `--engine` 为 `auto` 或 `cdp` 时启用，事件驱动无高频轮询；使用 `--engine hook` 时无任何后台常驻服务）。`uninstall` 会将其移除。

### 2. Antigravity 官方推送新版本后如何升级？

应用内更新不受影响，更新汉化本身：`git pull` 后重新运行 `node bin/cli.js install`（如已构建启动器可再运行 `node bin/cli.js launcher` 同步更新）。

> **说明**：默认通过 `node bin/cli.js launch` 启动；若执行了 `node bin/cli.js launcher` 构建 `~/Applications/Antigravity-zh.app`，点击该启动器也可直接启动汉化版（已汉化运行时切至前台；若误从官方图标以英文启动，点击启动器会弹窗询问是否一键重启切换中文）。

### 3. 为什么部分界面仍是英文？

主进程 Hook 模式下已覆盖主窗口、原生菜单栏、Dock 菜单、系统托盘与常见原生弹窗；系统级右键输入法菜单等由 macOS 托管的内容遵循系统语言。词库维护见 [AGENTS.md](AGENTS.md)。

---

## Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=onenora/antigravity-zh&type=Date)](https://star-history.com/#onenora/antigravity-zh&Date)

---

## 许可

[MIT](LICENSE)
