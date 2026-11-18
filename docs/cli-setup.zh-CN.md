# CLI 安装与配置

[文档目录](README.zh-CN.md) · [项目首页](../README.zh-CN.md) · [English](cli-setup.md)

## 环境要求

- 推荐 [Node.js 24 LTS](https://nodejs.org/en/download)；Node 22.12+（22.x）或 Node 26+ 也满足当前 Electron 和测试工具链要求
- 至少配置一种 CLI 的 API Key 或登录。应用支持 Cursor、Codex、Claude 和 Antigravity。
- 变更面板的 Git 页签需要本机可执行 `git`

## 在应用内安装

在聊天输入框选择 CLI，或打开 **设置 → CLI**，点击**安装**。Agent Desktop 在运行桌面应用的电脑上下载并校验发行文件，保存到应用数据目录的 `data/cli/` 下。支持 Windows x64、macOS x64 和 arm64、Linux x64。安装后可在应用内登录或填写 API Key。

应用依次使用显式配置的路径、本机已有安装、应用管理版本。Codex 和 Claude 的下载版本与随包 ACP 适配器配套。Antigravity 的**安装**会下载 Google 官方 `agy`，确认 `agy acp` 能启动后再启用。

## 可选的独立安装

### 安装 Cursor CLI

```powershell
# Windows (PowerShell)
irm 'https://cursor.com/install?win32=true' | iex
```

```bash
# macOS / Linux
curl https://cursor.com/install -fsS | bash
```

### 安装 Codex CLI

```bash
npm install -g @openai/codex
```

应用通过 `@agentclientprotocol/codex-acp` 启动检测到的 Codex 可执行文件。

### 安装 Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

应用通过 `@agentclientprotocol/claude-agent-acp` 启动检测到的 Claude 可执行文件。Windows 上会跳过 `.cmd` 跳转，以便适配器启动原生程序。

### 安装 Antigravity CLI

要在终端运行应用管理版 `agy`，可从 **设置 → CLI → Antigravity CLI** 复制可执行文件路径。应用将它保存在 `data/cli/antigravity-cli/` 下。如果经常在终端运行这份副本，可在该终端设置 `AGY_CLI_DISABLE_AUTO_UPDATE=true`，继续由 Agent Desktop 管理更新。

要在 PATH 上直接使用 `agy` 命令，请按[官方安装指南](https://antigravity.google/docs/getting-started?tab=cli)安装 1.5.0 或更高版本，打开新终端运行 `agy --version` 确认。然后在 Agent Desktop 的 Antigravity 卡片上点击**重新检测**。

### CLI 检测

应用会自动查找 CLI：

| 系统 | Cursor | Codex | Claude | Antigravity |
| --- | --- | --- | --- | --- |
| Windows | `%LOCALAPPDATA%\cursor-agent` | PATH 上的 `codex` | PATH 上的 `claude.exe`，或 `%USERPROFILE%\.local\bin\claude.exe` | PATH 上的 `agy.exe`，或 `%LOCALAPPDATA%\agy\bin\agy.exe` |
| macOS / Linux | `~/.local/bin/agent`、`/usr/local/bin/agent`、`/opt/homebrew/bin/agent` | `~/.local/bin/codex`、`/usr/local/bin/codex`、`/opt/homebrew/bin/codex`，以及 PATH | `~/.local/bin/claude`、`/usr/local/bin/claude`、`/opt/homebrew/bin/claude`，以及 PATH | PATH 或 `~/.local/bin` 等常见目录中的 `agy` |

使用自定义安装时，可在设置里填写可执行文件或安装目录。

macOS 安装包无需另装 Node.js，Codex 和 Claude 的 ACP 适配器使用应用自带运行时。Finder 启动通常不会继承终端初始化后的 PATH，应用会补充 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin` 等常见位置，并保留已继承 PATH 的优先级。通过 nvm 等工具安装在非标准目录的 CLI 若未被检测到，请在设置中选择可执行文件或安装前缀；支持 `~/`、带引号及含空格路径。应用不会执行 shell 初始化文件。

各 CLI 的检测结果分别缓存在应用数据目录的 `cli-info-cache.json`，重启后仍保留。打开设置、切换标签或切换界面语言时直接复用缓存。没有有效缓存时才自动检测，未找到 CLI 的结果也会保存。缓存不定时过期。

修改对应 CLI 的路径或 API Key、结束登录或更新后会重新检测；「重新检测」按钮可随时手动刷新。在应用外安装、更新 CLI 或改变登录状态后，请点击「重新检测」。远程页面使用桌面主进程的同一份缓存。缓存中的认证配置仅保存摘要，不额外保存 API Key 明文。

### 认证

Cursor 认证优先使用 [Cursor API Key](https://cursor.com/dashboard/api)。设置中的 Key 优先于环境变量 `CURSOR_API_KEY`。应用通过环境变量 `CURSOR_API_KEY` 把 Key 传给 CLI，不放在命令行参数里，因此不会出现在进程列表中。没有 Key 时，使用 `agent login` 保存的浏览器登录。

Codex 认证优先使用设置中的 Key，其次是 `CODEX_API_KEY`，再次是 `OPENAI_API_KEY`。都没有时使用 ChatGPT 登录。应用会把系统对 `https://chatgpt.com` 的代理解析结果传给 Codex。环境里已经设置的 `HTTP_PROXY` / `HTTPS_PROXY` 优先。

Claude 认证优先使用设置中的 Key，其次是 `ANTHROPIC_API_KEY`。只要其中有一个，就按 API 计费，不会使用 Claude 订阅。都没有时使用 `~/.claude` 里的登录。登录按钮走适配器的 Claude.ai 登录。

使用兼容 Gemini API 的服务时，在桌面应用的 **设置 → CLI → Antigravity CLI** 填写 **API Key** 和 **API 端点**，然后点击**保存 API 配置**。可以粘贴 CC Switch 的 Antigravity 供应商卡片里的地址和 Key。设置中的端点优先于 `GOOGLE_GEMINI_BASE_URL`，两者都为空时使用 Google 默认地址。

通过自定义网关使用 Gemini 4 Carbon 时，应用会按当前推理档位从网关的模型列表匹配完整 ID，例如 `agy/gemini-4-carbon-high`。列表里没有匹配项时，应用先尝试 `gemini-4-carbon-high` 这类不带命名空间的别名。只有这次尝试返回 `403` 或 `404` 时，才会用基础 ID `gemini-4-carbon` 重试一次。两次请求都失败时，会显示别名请求的错误。Google 默认端点由 CLI 直接访问。

Antigravity 优先使用设置中的 Gemini API Key，其次是 `GEMINI_API_KEY`，最后使用 `agy` 已保存的凭据。登录按钮打开 Google 个人账号登录。Gemini Enterprise 或终端登录请参阅 [Antigravity CLI 认证指南](https://antigravity.google/docs/ide/extensions/acp/#authentication)。

应用管理版和独立安装的 `agy` 共用 CLI 的登录和历史存储，均适用 CLI 沙箱设置。应用会读取当前账号可用的模型和思考级别。在 **设置 → 外观与历史 → 导入** 可以导入已有的 `agy` 会话。对话菜单可重新同步历史。分叉会新建独立会话，并在第一次发送时传入复制的历史。

Antigravity 从 `~/.gemini/config/mcp_config.json` 和 `.agents/mcp_config.json` 读取 MCP 配置。本地 Skill 路径包括 `~/.gemini/antigravity-cli/skills`、`~/.gemini/skills` 和项目的 `.agents/skills`。

## 更新 CLI

打开「设置 → CLI」，点击对应 CLI 登录按钮右侧的「更新」。通过远程页面点击时，也在桌面应用所在电脑执行。执行期间按钮显示「更新中…」，卡片保留执行结果或错误信息；成功后刷新该 CLI 的版本与模型列表。

Cursor、原生安装的 Claude Code 和 Antigravity 使用各自的 `update` 命令。通过 npm 安装的 Codex 在原有安装位置更新，通过 Homebrew 安装的版本由 Homebrew 更新。不支持的安装方式会提示处理方法。应用管理版本沿用安装时的校验和下载流程。Codex 和 Claude 随各版 Agent Desktop 的适配器选择配套版本，Cursor 使用应用已校验的发行清单。
