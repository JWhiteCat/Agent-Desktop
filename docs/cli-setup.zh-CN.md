# CLI 安装与配置

[文档目录](README.zh-CN.md) · [项目首页](../README.zh-CN.md) · [English](cli-setup.md)

## 环境要求

- 推荐 [Node.js 24 LTS](https://nodejs.org/en/download)；Node 22.12+（22.x）或 Node 26+ 也满足当前 Electron 和测试工具链要求
- 至少一种 CLI：已配置 API Key 或已登录的 Cursor CLI，Codex CLI（找不到本机 `codex` 时使用应用内置的 Codex），或 Claude Code（找不到本机 `claude` 时使用适配器自带的 Claude）
- 变更面板的 Git 页签需要本机可执行 `git`

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

也可以不单独安装。应用通过 `@agentclientprotocol/codex-acp` 驱动 Codex。设置里的路径为空、且 PATH 上没有 `codex` 时，使用适配器自带的 Codex。设置里会写明正在使用内置 Codex。

### 安装 Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

也可以不单独安装。应用通过 `@agentclientprotocol/claude-agent-acp` 驱动 Claude Code。设置里的路径为空、且 PATH 上没有 `claude` 时，使用适配器自带的 Claude。设置里会写明正在使用内置 Claude。Windows 上会跳过 `.cmd` 跳转，以便适配器启动原生程序。

### CLI 检测

应用会自动查找 CLI：

| 系统 | Cursor | Codex | Claude |
| --- | --- | --- | --- |
| Windows | `%LOCALAPPDATA%\cursor-agent` | PATH 上的 `codex` | PATH 上的 `claude.exe`，或 `%USERPROFILE%\.local\bin\claude.exe` |
| macOS / Linux | `~/.local/bin/agent`、`/usr/local/bin/agent`、`/opt/homebrew/bin/agent` | `~/.local/bin/codex`、`/usr/local/bin/codex`、`/opt/homebrew/bin/codex`，以及 PATH | `~/.local/bin/claude`、`/usr/local/bin/claude`、`/opt/homebrew/bin/claude`，以及 PATH |

找不到时，在设置里填写可执行文件或安装目录。

### 认证

Cursor 认证优先使用 [Cursor API Key](https://cursor.com/dashboard/api)。设置中的 Key 优先于环境变量 `CURSOR_API_KEY`。没有 Key 时，使用 `agent login` 保存的浏览器登录。

Codex 认证优先使用设置中的 Key，其次是 `CODEX_API_KEY`，再次是 `OPENAI_API_KEY`。都没有时使用 ChatGPT 登录。

Claude 认证优先使用设置中的 Key，其次是 `ANTHROPIC_API_KEY`。只要其中有一个，就按 API 计费，不会使用 Claude 订阅。都没有时使用 `~/.claude` 里的登录。登录按钮走适配器的 Claude.ai 登录。

## 更新 CLI

打开「设置 → CLI」，点击对应 CLI 登录按钮右侧的「更新」。通过远程页面点击时，也在桌面应用所在电脑执行。执行期间按钮显示「更新中…」，卡片保留执行结果或错误信息；成功后刷新该 CLI 的版本与模型列表。

Cursor 和原生安装的 Claude Code 使用各自的 `update` 命令。通过 npm 安装的 Codex 在原有安装位置更新，通过 Homebrew 安装的版本由 Homebrew 更新。不支持的安装方式会提示处理方法。内置 Codex 和 Claude 随 Agent Desktop 更新，因此其更新按钮不可用；需要单独更新时，先安装独立 CLI 并在设置中选择。
