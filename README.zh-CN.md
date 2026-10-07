# Agent Desktop

[English](README.md)

面向 [Cursor CLI](https://cursor.com/cli)（`agent`）、[Codex CLI](https://github.com/openai/codex)（`codex`）和 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（`claude`）的桌面客户端。对话按项目分组，窗口流式展示思考、工具调用和回复，并保留本地历史。界面支持简体中文和英文。

应用本身不调用模型，而是在本机启动 CLI，通过 [Agent Client Protocol](https://agentclientprotocol.com)（ACP）与之通信。

## 核心功能

- 多项目对话：搜索、置顶、归档、分叉，并导入和续接 CLI 历史。
- 三种模式：Agent 执行任务、Plan 制定并执行方案、Ask 只读问答。
- 模型选择：分别保存各 CLI 的常用模型、上下文长度、思考强度和 Fast 偏好。
- 附件输入：选择或拖拽文件、粘贴截图，桌面端与远程页面均可使用。
- 变更查看：显示本轮修改的文件、git 状态和 diff，支持隔离的 git worktree。
- MCP 与 Skill：配置本应用集成，或管理各 CLI 的本机原生配置。
- 用量统计：查看账号额度、本机 token 和费用估算，以及每轮任务的耗时。
- 桌面与远程体验：系统通知、未读状态、中英文和主题切换，支持局域网与 SSH 公网访问。

完整行为和使用细节见 [使用指南](docs/user-guide.zh-CN.md)。

## 环境要求

- 推荐 [Node.js 24 LTS](https://nodejs.org/en/download)；Node 22.12+（22.x）或 Node 26+ 也满足当前 Electron 和测试工具链要求。
- 至少一种已配置 API Key 或已登录的 CLI：Cursor CLI、Codex CLI 或 Claude Code；找不到本机 Codex / Claude 时可使用适配器自带版本。
- 变更面板的 Git 页签需要本机可执行 `git`。

CLI 安装、自动检测和认证优先级见 [CLI 安装与配置](docs/cli-setup.zh-CN.md)。

## 快速开始

在项目目录安装依赖并启动：

```bash
npm ci --include=dev --include=optional
npm run dev
```

首次使用：

1. 打开 **设置 → CLI**，确认 CLI 路径，然后登录或填写 API Key。Cursor 默认优先使用 API Key，也可读取 `CURSOR_API_KEY`。
2. 添加项目文件夹，在首页选择 CLI、模型和模式，然后输入任务并发送。
3. 在变更面板查看文件改动；后续可从侧边栏继续、分叉或同步对话。

也可以使用项目根目录的一键启动脚本：

- Windows：双击 `start-dev.bat` 启动开发模式，或 `start-preview.bat` 构建后启动生产预览。
- Linux：执行 `./start-dev.sh` 或 `./start-preview.sh`；没有执行权限时使用 `bash start-dev.sh` 或 `bash start-preview.sh`。

脚本会检查并补齐依赖与 Electron 运行时。首次运行需要联网；Linux 桌面环境、运行库与安装包说明见 [开发指南](docs/development.zh-CN.md)。

## 文档

[文档目录](docs/README.zh-CN.md) 提供主题索引和建议阅读路径。

| 主题 | 说明 |
| --- | --- |
| [CLI 安装与配置](docs/cli-setup.zh-CN.md) | 安装、认证、检测与更新 |
| [使用指南](docs/user-guide.zh-CN.md) | 功能细节、附件、快捷键、语言与 Plan 模式 |
| [MCP 与 Skill](docs/integrations.zh-CN.md) | 本应用集成与本机原生配置 |
| [用量统计](docs/usage-stats.zh-CN.md) | 账号额度、token 与费用估算 |
| [远程控制](docs/remote-control.zh-CN.md) | 局域网、公网隧道与服务器搭建 |
| [数据存储](docs/data-storage.zh-CN.md) | 本地数据、CLI 历史与 worktree |
| [开发指南](docs/development.zh-CN.md) | 启动、测试、打包与模块结构 |

## 参与贡献

修改后运行离线测试和类型检查：

```bash
npm test
npm run typecheck
```

开发命令、在线冒烟测试、打包方式和模块边界见 [开发指南](docs/development.zh-CN.md)。
