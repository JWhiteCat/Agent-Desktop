# Changelog

Write upcoming changes under `## [Unreleased]`. `release.bat X.Y.Z` or `npm run release -- X.Y.Z` moves those notes into the version section and publishes them as the GitHub Release notes.

## [Unreleased]

## [1.1.0] - 2026-10-23

### macOS 支持

- 支持 macOS 13 Ventura 及更新版本，分别提供 Apple Silicon（M 系列，arm64）和 Intel（x64）DMG 安装包；安装包自带运行时和 Codex/Claude，无需另装 Node.js。
- 补齐编辑器应用回退、Terminal 自动化权限错误提示、命令 PATH 传递、⌘ 快捷键提示和 Dock 未读数；关闭窗口后可通过 Dock 或完成通知恢复会话。Finder 启动时按芯片架构优先检测对应 Homebrew 路径。
- 提供 macOS 本机开发启动和打包命令，以及两个架构各自的 CI 构建和离线安装包验证。

### 安装与首次打开

- Apple Silicon 下载 `agent-desktop-1.1.0-mac-arm64.dmg`，Intel 下载 `agent-desktop-1.1.0-mac-x64.dmg`，将应用拖入 Applications 后启动。
- macOS 应用使用无需开发者账号的 ad-hoc 临时签名，未接入 Apple Developer 签名或公证。确认下载来源和 SHA256 后，首次打开若被拦截，可到「系统设置 → 隐私与安全性」选择「仍要打开」。顶部命令请求控制 Terminal 时允许授权；拒绝后可在「自动化」中重新允许。
- 保留 Windows x64 便携版/安装版和 Linux x64 AppImage/Debian 包；发布要求六个安装包齐全，`SHA256SUMS.txt` 覆盖全部安装包。

中英文说明见[开发指南](https://github.com/JWhiteCat/Agent-Desktop/blob/v1.1.0/docs/development.zh-CN.md)和[使用指南](https://github.com/JWhiteCat/Agent-Desktop/blob/v1.1.0/docs/user-guide.zh-CN.md)。自动检查不调用模型；首次打开、权限和真实 CLI 交互等实机人工验收尚未完成。

## [1.0.0] - 2026-10-23

Agent Desktop 首个正式版本，将 Cursor CLI、Codex CLI 和 Claude Code 集成到一个桌面工作台，提供多项目对话、代码协作、扩展管理和手机远程访问。

### 统一的 AI 编码工作台

- 在同一界面使用 Cursor CLI、Codex CLI 和 Claude Code，支持本机 CLI 自动检测、登录及 API Key 配置；未安装本机 Codex 或 Claude 时可使用内置版本。
- 提供 Agent、Plan、Ask 三种模式：执行任务、制定和实施计划、只读问答。Plan 支持审阅方案、提交修改意见，以及确认后继续实施；工具权限和代理提问通过交互卡片处理。
- 流式展示思考、工具调用与回复。分别保存各 CLI 的常用模型、上下文长度、思考强度及 Fast 偏好；切换 CLI 时保留已有对话并传递上下文。

### 多项目与会话管理

- 按项目组织对话，支持搜索、置顶、归档、重命名和删除，项目折叠状态自动保存。
- 导入、同步和续接 Cursor、Codex、Claude 的 CLI 历史；支持完整分叉或从指定消息分叉，保留原对话。
- 切换会话时保留未发送的文字、附件、CLI/模型/模式选择，以及问答卡片和计划卡片的状态。
- 从侧边栏的运行中和未读计数快速跳转跨项目会话，并支持会话内全文查找及匹配高亮。

### 任务执行与代码协作

- 任务运行中可将后续指令和附件加入消息队列，支持拖动排序、编辑、删除和立即发送；每条消息记住模式、模型和权限，计划审阅期间可等待实施后再继续队列。
- 支持在隔离的 Git worktree 中执行任务，并从会话实际工作目录打开文件管理器、VS Code 或 Cursor。
- 通过「本对话编辑」「快照差异」「Git 差异」分别查看工具修改、每轮工作区快照和当前 Git 改动；非 Git 目录也可记录快照。
- 回复下方展示本轮修改文件，支持展开 diff、二进制文件分组、完整路径提示及复制文件路径；已保存的工具补丁和快照可在历史中查看。

### 附件与内容展示

- 支持选择、拖拽文件和粘贴截图。Cursor、Codex、Claude 均可接收原生图片输入，其他文档和代码文件通过本地附件原件读取；历史中支持图片预览、原件下载和桌面打开。
- 渲染 Markdown、代码块、表格和 Mermaid 图表，支持查看和复制图表源码；桌面端提供文字复制、粘贴及链接地址查看和复制。
- 本地保存项目、消息、附件和设置，保留 CLI 自己的历史存储；分叉会保留仍在使用的附件引用。

### MCP、Skill 与 Grok Bot

- 在设置中配置应用使用的 MCP 服务器和 Skill，并在会话启动或续接时应用；斜杠菜单支持 CLI 命令、Skill 和本地分叉命令。
- 管理 Cursor、Codex、Claude 的用户级和项目级原生 MCP/Skill 配置，支持新增、编辑、启用、停用和删除，并在首次修改原生配置前备份。
- 直接与 Grok Bot 对话，支持手动添加或按名称新建 Bot、查看历史、中断回复、消息缓存、聊天内搜索，以及查看 Grok Bot 桌面端已缓存的文件；认证使用 Cursor API Key。

### 用量统计与运行反馈

- 查看 Cursor、Codex 的账号额度和重置时间，以及本机对话的 token、按模型计算的 API 费用估算和每轮耗时；模型选择器可查看公开 API 标价。
- 支持 Codex 日志用量恢复、会话额度及本轮预估周额度；费用和额度估算与实际订阅账单分别展示。
- 提供完成通知、未读提示、Windows 任务栏计数和有任务运行时的退出确认。Cursor 连接中断或 Codex 模型满载时自动继续一次，继续指令跟随界面语言；Codex 可继承系统代理。

### 远程访问与桌面个性化

- 在局域网通过二维码从手机或其他电脑访问同一工作台；支持带访问令牌的 SSH 公网反向隧道、自建入口服务器和断线重连。
- 远程界面适配手机屏幕，支持发送任务和附件、回复权限及问题卡片、查看历史和改动；刷新或重连后恢复当前页面并补齐消息。
- 提供简体中文、英文、浅色、深色和跟随系统选项，可调整字体与字号；支持自定义皮肤配色、透明度、模糊和图片、视频、Web 动态背景，以及本机 Wallpaper Engine 视频/Web 壁纸。
- 可拖动调整侧边栏、变更面板和 Grok Bot 列表宽度；桌面顶部按钮支持显隐、排序，并可在新终端运行自定义命令。

### 安装包与使用说明

- Windows x64：提供免安装便携版和 NSIS 安装版；Linux x64：提供 AppImage 和 Debian 安装包。附件中的 `SHA256SUMS.txt` 可用于校验四个安装包。
- 首次使用请在设置中登录 CLI 或配置 API Key，再添加项目文件夹并发送任务。Git 差异和 worktree 功能需要本机安装 Git。
- Windows 程序未签名；本次未提供 macOS 或 ARM64 构建。Linux 安装包已通过构建验证，未进行桌面运行验证。
- 详细操作见[使用指南](https://github.com/JWhiteCat/Agent-Desktop/blob/v1.0.0/docs/user-guide.zh-CN.md)、[CLI 安装与配置](https://github.com/JWhiteCat/Agent-Desktop/blob/v1.0.0/docs/cli-setup.zh-CN.md)和[远程控制](https://github.com/JWhiteCat/Agent-Desktop/blob/v1.0.0/docs/remote-control.zh-CN.md)。
