# Changelog

Write upcoming changes under `## [Unreleased]`. `release.bat X.Y.Z` or `npm run release -- X.Y.Z` moves those notes into the version section and publishes them as the GitHub Release notes.

## [Unreleased]

## [1.0.0] - 2026-10-23

### 新增

- 支持会话内搜索、后续消息队列与模式显示；生成计划后，可等待计划实施再继续处理队列。
- 新增 Grok Bot 对话、Bot 管理及本地缓存。
- 外观设置支持字体、字号、皮肤和本地 Wallpaper Engine 背景；工具栏与侧栏面板可调整。
- 支持 Codex Fast 选项、模型 API 价格提示，以及更完整的 Skill 菜单。
- 新增一键发版脚本与 GitHub Actions：自动维护版本号、归档 Changelog，并构建 Windows x64 便携版、安装版及 Linux x64 AppImage、Debian 包。

### 改进与修复

- Codex 启动、登录、模型列表及用量查询会继承系统代理；代理变化会刷新会话进程，路由超时提供明确提示。
- Cursor HTTP 502、503 或连接取消，以及 Codex 模型满载时自动继续一次；发送的继续指令跟随界面语言。
- 切换对话时保留输入草稿和卡片选择；改进 CLI 切换后的上下文延续与进程状态显示。
- 修复工作区快照导致 ASAR 文件被占用的问题，改进非 Git 项目和工具修改的文件记录。
- 改进 Markdown、Mermaid、二进制文件分组、文件路径操作、未读提示与 Windows 任务栏图标。
- 改进移动端布局、远程页面刷新后的会话恢复，以及中英文文档组织。

### 发布说明

- 本次使用新发布流程重新发布 1.0.0，替换旧的 `Agent Desktop v1.0.0` Release 与标签，发布源码为新的 `release/1.0.0` 分支。
- GitHub Release 正文来自本版本 Changelog；全部安装包上传完成后才公开，附带 `SHA256SUMS.txt` 校验文件。
- Windows 程序未签名；本次不提供 macOS 或 ARM64 构建。

