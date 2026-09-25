# Agent Desktop

面向 [Cursor CLI](https://cursor.com/cli)（`agent`）的桌面客户端。按项目组织多段对话，流式展示思考、工具调用和回复，并保留本地历史。

应用本身不调用模型。它启动本机已安装的 Cursor CLI，把提示词交给 CLI，再把 `stream-json` 输出画成对话界面。

## 功能

- 多项目侧边栏：添加、重命名、排序、搜索对话
- 分叉对话：整段复制，或从某条消息截断后另开一支，原对话保持不变
- 三种模式：Agent（可改文件、执行命令）、Plan（只读方案）、Ask（只读问答）
- 模型选择：常用模型、上下文长度、思考强度、Fast
- 新对话可在隔离的 git worktree 中运行
- 变更面板：查看当前工作目录的分支、状态和 diff
- 从 `~/.cursor/chats` 导入 CLI 历史，并按工作目录归入项目
- 已有会话用 `--resume` 续聊；也可从 CLI 存储同步回本地
- 任务结束时发送系统通知，点击通知回到该对话
- 主题：跟随系统、深色、浅色

## 环境要求

- Node.js 22.12 或更高版本
- 已配置 API Key，或已通过浏览器登录的 Cursor CLI
- 变更面板需要本机可执行 `git`

安装 Cursor CLI：

```powershell
# Windows (PowerShell)
irm 'https://cursor.com/install?win32=true' | iex
```

```bash
# macOS / Linux
curl https://cursor.com/install -fsS | bash
```

应用会自动查找 CLI：

| 系统 | 默认位置 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\cursor-agent` |
| macOS / Linux | `~/.local/bin/agent`、`/usr/local/bin/agent`、`/opt/homebrew/bin/agent` |

找不到时，在设置里填可执行文件或安装目录。

认证优先使用 [Cursor API Key](https://cursor.com/dashboard/api)（设置中的 Key 优先于环境变量 `CURSOR_API_KEY`）。没有 Key 时使用 `agent login` 保存的浏览器登录。

## 开发

```bash
npm install
npm run dev
```

Windows 也可以双击 `start.bat`，效果相同。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动开发窗口 |
| `npm run typecheck` | 类型检查 |
| `npm run build` | 编译到 `out/` |
| `npm run preview` | 预览编译结果 |
| `npm run dist` | 打包安装包到 `release/` |

打包目标：Windows NSIS、macOS DMG、Linux AppImage。

开发时按 `F12` 打开开发者工具。

## 使用

1. 添加一个项目文件夹。Agent 在该目录（或对话自己的 worktree）里工作。
2. 在首页输入任务，选择模型和模式后发送。
3. 侧边栏管理对话：置顶、归档、重命名、删除。
4. 需要看改动时打开变更面板，或在 Cursor / 文件管理器中打开工作目录。

常用快捷键（macOS 上把 Ctrl 换成 ⌘）：

| 快捷键 | 作用 |
| --- | --- |
| Ctrl+N | 回到首页，开始新对话 |
| Ctrl+K | 聚焦侧边栏搜索 |
| Ctrl+B | 显示或隐藏侧边栏 |
| Ctrl+Shift+D | 显示或隐藏变更面板 |
| Ctrl+, | 打开设置 |
| Enter | 发送 |
| Shift+Enter | 换行 |
| Esc | 停止当前运行 |

输入框里还可以切换完全访问（`--force`）和沙箱（`--sandbox`）。完全访问会让 CLI 在不逐条确认的情况下执行命令。

## 数据

项目、对话元数据和设置写在 Electron 的 userData 目录下的 `data/`：

| 系统 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\Agent Desktop\data` |
| macOS | `~/Library/Application Support/Agent Desktop/data` |
| Linux | `~/.config/Agent Desktop/data` |

`state.json` 保存项目、对话列表和设置；每段对话的消息在 `threads/` 里。CLI 自己的会话记录仍在 `~/.cursor/chats`，本应用只读取和续接，不改写那份存储。

开发时可用环境变量 `AGENT_DESKTOP_USER_DATA` 指定另一份 userData 目录。

可以同时开多个窗口。每个进程的 Chromium 缓存（GPU 缓存、HTTP 缓存、localStorage）写在系统临时目录的 `agent-desktop-sessions/<pid>`，避免互相锁文件。项目和对话仍共用上面的 `data/`；两个窗口同时改同一份数据时，后写入的会覆盖先写入的。退出时会删掉本进程的缓存目录，上次异常退出留下的目录会在下次启动时清掉。

## 目录

```
src/main      Electron 主进程：窗口、CLI 进程、持久化、git diff
src/preload   渲染进程可用的安全 API
src/renderer  React 界面
src/shared    主进程与界面共用的类型
```
