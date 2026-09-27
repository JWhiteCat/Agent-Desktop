# Agent Desktop

面向 [Cursor CLI](https://cursor.com/cli)（`agent`）和 [Codex CLI](https://github.com/openai/codex)（`codex`）的桌面客户端。按项目组织多段对话，流式展示思考、工具调用和回复，并保留本地历史。

应用本身不调用模型。它启动本机的 Cursor CLI 或 Codex CLI，把提示词交给 CLI，再把协议输出画成对话界面。新建对话用设置里选中的 CLI，并记住这个选择；已有对话继续用创建时的 CLI。

## 功能

- 多项目侧边栏：添加、重命名、排序、搜索对话
- 分叉对话：整段复制，或从某条消息截断后另开一支，原对话保持不变
- 三种模式：Agent（可改文件、执行命令）、Plan（只读方案，可点选回答提问、一键执行计划）、Ask（只读问答）
- 模型选择：Cursor 与 Codex 各自记住常用模型和默认模型，并可选上下文长度、思考强度、Fast。Codex 按每个模型自己的档位列出思考强度，例如 Astra 的 Ultra
- 新对话可在隔离的 git worktree 中运行
- 变更面板：查看当前工作目录的分支、状态和 diff
- 一轮任务结束后，在回复下方列出本轮修改的文件，点开可看 diff
- 任务结束时，回复下方显示本轮耗时、token、使用的模型，以及按公开标价估算的费用
- 从 `~/.cursor/chats` 和 `~/.codex/sessions` 导入 CLI 历史，并按工作目录归入项目
- 已有会话用 `--resume` 续聊；也可从 CLI 存储同步回本地
- 任务结束时发送系统通知，点击通知回到该对话
- 主题：跟随系统、深色、浅色
- 设置按左侧分类切换：CLI、MCP、Skill、模型、用量、默认值、通知、远程控制、外观与历史。CLI 页可分别检测 Cursor 与 Codex、填写路径和 API Key、登录。模型页顶部用 Cursor / Codex 页签分别配置常用模型和默认模型
- 用量：按最近 1 天、7 天、30 天汇总 token，并分页列出全部历史会话的模型和累计消耗。费用用 [Cursor 公开标价](https://cursor.com/docs/models-and-pricing) 估算。Auto 和价目表没有的模型显示为未定价
- 远程控制：局域网扫码，或经 SSH 反向隧道从公网打开同一页面

## 环境要求

- Node.js 22.12 或更高版本
- 至少一种 CLI：已配置 API Key 或已登录的 Cursor CLI，或 Codex CLI（找不到本机 `codex` 时使用应用内置的 Codex）
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

安装 Codex CLI：

```bash
npm install -g @openai/codex
```

也可以不单独安装。应用通过 `@agentclientprotocol/codex-acp` 驱动 Codex；设置里的路径为空且 PATH 上没有 `codex` 时，使用适配器自带的 Codex，设置里会写明「使用内置 Codex」。

应用会自动查找 CLI：

| 系统 | Cursor | Codex |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\cursor-agent` | PATH 上的 `codex` |
| macOS / Linux | `~/.local/bin/agent`、`/usr/local/bin/agent`、`/opt/homebrew/bin/agent` | `~/.local/bin/codex`、`/usr/local/bin/codex`、`/opt/homebrew/bin/codex`，以及 PATH |

找不到时，在设置里填可执行文件或安装目录。

Cursor 认证优先使用 [Cursor API Key](https://cursor.com/dashboard/api)（设置中的 Key 优先于环境变量 `CURSOR_API_KEY`）。没有 Key 时使用 `agent login` 保存的浏览器登录。

Codex 认证优先使用设置中的 Key，其次是 `CODEX_API_KEY`，再次是 `OPENAI_API_KEY`。都没有时使用 ChatGPT 登录。

## 开发

```bash
npm install
npm run dev
```

Windows 也可以双击 `start.bat`，效果相同。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动开发窗口 |
| `npm test` | 离线单元测试，不调用模型 |
| `npm run test:live` | 用 Grok 4.7 500K High Fast 发一次极短提问 |
| `npm run typecheck` | 类型检查 |
| `npm run build` | 编译到 `out/` |
| `npm run preview` | 预览编译结果 |
| `npm run dist` | 打包安装包到 `release/` |

`npm test` 不访问 Cursor CLI，也不访问 Codex。`npm run test:live` 才会在临时空目录里用 Ask 模式调用 `grok-4.7[context=500k,reasoning_effort=high,fast=true]`，提示只有一句 `Reply with exactly ok`。需要本机已登录或已设置 `CURSOR_API_KEY`。High 仍会有少量思考 token。

打包目标：Windows NSIS、macOS DMG、Linux AppImage。

开发时按 `F12` 打开开发者工具。

## 使用

1. 添加一个项目文件夹。Agent 在该目录（或对话自己的 worktree）里工作。
2. 在首页输入任务，选择模型和模式后发送。
3. 侧边栏管理对话：置顶、归档、重命名、删除。
4. 需要看改动时打开变更面板，或在 Cursor / 文件管理器中打开工作目录。任务结束后，对话里会列出这一轮改过的文件，点击文件名展开 diff。

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

## Plan 模式

Cursor 不给 ACP 客户端提供 AskQuestion 工具。Codex 的 Plan 是协作模式（`collaboration_mode=plan`），审批模式仍是只读，不是 Cursor 的 `modeId: plan`。两种 CLI 的 Plan 消息前都会附一段说明（用 `<agent_desktop_client>` 标签包住，导入 CLI 历史时会去掉），让模型这样工作：

- 需要你做选择时，模型输出一个 ```` ```questions ```` 代码块（JSON）。界面把它画成选项卡片，点选后按“继续”，选择结果会作为下一条消息发出；“跳过”则让模型按自己的判断继续。只有最新一轮的卡片可以提交。
- 需求清楚后，Cursor 用 CreatePlan 生成计划，Codex 用计划工具给出名称、概要和 Markdown 正文。界面显示计划卡片：名称、概要、待办和可展开的完整计划。Cursor 还会提供“打开计划文件”（`~/.cursor/plans/*.plan.md`）；Codex 没有这份文件时不显示该按钮。
- 点“执行计划”会把输入框切到 Agent 模式，并发送一条按计划实施的消息。只有最新的计划显示这个按钮。

ACP 下 CLI 会自动批准模型发起的 SwitchMode，且不通知客户端。Plan 模式的一轮里如果模型自己切了模式，应用会立刻把会话模式设回 Plan，避免它直接开始改文件。

## MCP 与 Skill

在设置中添加 MCP 服务器。启用后，新建或恢复会话时会把它们放进 ACP 的 `mcpServers`（stdio、HTTP 或 SSE）。这份列表存在应用自己的 `state.json` 里，不会改写 `~/.cursor/mcp.json`。

启用的 Skill 会写成 `~/.cursor/skills/<名称>/SKILL.md`，并同时写到 Codex 的 `~/.agents/skills/<名称>/SKILL.md` 和 `~/.codex/skills/<名称>/SKILL.md`。名称只能是小写字母、数字和连字符，并且需要一段描述，CLI 会按描述决定是否使用。停用或删除时，只移除本应用创建的目录。同名且不是本应用创建的目录会保留，保存时会提示无法覆盖。

修改 MCP 或 Skill 后，空闲的 CLI 进程会退出。下一条消息才会用上新配置。

## 用量

设置里的「用量」按最近 1 天、7 天和 30 天汇总本机对话的 token，并按模型列出估算费用。模型名用短名称，例如「Grok 4.7 500K High Fast」，不显示完整参数串。下方的会话列表包含全部历史对话，每行显示用过的模型、累计 token 和费用，不受上面的天数限制；超过 20 条时翻页。没有 token 记录的对话也会列出，费用留空。每一轮结束时，回复下方也会显示该轮的耗时、token、使用的模型和估算费用。Token 来自 CLI 在回合结束时给出的用量：输入里已经扣除缓存，缓存读写单独计数。Cursor 模型用 Cursor 公开标价，Codex 的 GPT 模型用同一份已收录的公开 token 标价（美元 / 百万 token）。这不是套餐里还剩多少，也不含 Teams 的 Token Rate。不足 1 美分时显示到小数点后四位。Auto 和价目表没有的模型只显示 token，费用写为「未定价」。上方合计里，分叉复制的同一轮只计一次；会话列表按各对话自己的记录累计，所以同一轮会同时出现在原对话和分叉里。

## 远程控制

在设置的“远程控制”里打开开关后，应用会在局域网监听一个端口（默认 `8765`），提供与桌面端相同的界面。手机和电脑连同一个网络，扫描二维码即可打开。二维码会带上电脑当前正在查看的项目或对话。电脑有多个网卡时，可以在下拉框里换一个地址。

再打开“公网访问”后，应用用本机 OpenSSH 建立反向隧道。服务器上的入口程序独占公网端口（默认 `8765`），按链接里的电脑标识把请求转到对应电脑。多台电脑可以同时开着公网，共用这一个端口；每台链接不同，例如 `http://43.167.166.239:8765/c/<电脑标识>/?token=...`。标识在第一次使用时生成并保存在本机，重置链接不会更换它。默认服务器是 `root@43.167.166.239`。SSH 用户、服务器地址和公网端口都可以改。隧道连上后，公网链接会出现在地址下拉和二维码里。地址或端口改完会重新连接；断线后按 1 秒、2 秒、5 秒、10 秒重试。

- 链接里带有访问令牌，手机首次打开后会记住它。同一浏览器里，不同电脑的公网令牌分开保存。拿到链接的人可以完全控制本应用（发任务、改设置），请勿外传。“重置链接”会换一个新令牌，旧的局域网和公网链接、已连接的手机都会立即失效。
- 手机端看不到 API Key 和令牌，也不能修改远程控制设置。“在 Cursor 中打开”“在文件管理器中打开”等只对电脑有意义的按钮会隐藏；添加项目时需要手动输入电脑上的路径。
- 只提供 HTTP，没有加密。局域网只适合在可信网络使用。公网链接在传输路径和这台服务器上都是明文，请只在你自己的服务器上开启。首次启用时 Windows 防火墙可能弹出提示，需要允许“专用网络”访问。
- 公网隧道使用本机默认 SSH 密钥，并且 `BatchMode` 登录，不会弹出密码。每台电脑把隧道接到服务器上的 Unix 套接字 `/run/agent-desktop/<电脑标识>`，不直接占用公网端口。服务器需要允许套接字转发（`AllowStreamLocalForwarding yes`），并设置 `StreamLocalBindUnlink yes`，否则断线后留下的套接字文件会挡住下一次连接。入口程序监听公网端口并转发网页。云安全组要放行所填的公网端口。应用运行时不会改服务器；可以用仓库里的脚本一次性配好。

在项目目录执行 `npm run setup:public-server`，会用本机默认密钥以 `root` 登录 `43.167.166.239`，把 sshd 配成允许 Unix 套接字反向隧道，并安装公网入口（服务器需要 `python3`）。有 systemd 时入口作为服务监听 TCP `8765`，没有时在后台运行。脚本会在 firewalld 或 ufw 正在运行时放行该端口。换服务器或端口时加上参数，例如 `npm run setup:public-server -- --user root --host 43.167.166.239 --port 8765`。脚本会先备份 `sshd_config`，`sshd -t` 失败则恢复备份，然后 `reload` sshd，不断开当前登录。旧版本会自己占用公网端口，升级后需要先关掉那些客户端上的公网访问，再执行本脚本。云安全组仍需在控制台放行该端口。已经登录服务器并且仓库在本机时，也可以 `bash scripts/setup-public-server.sh 8765`。
- 屏幕宽度不超过 720px 时，侧边栏改为抽屉，变更面板和设置改为全屏。设置分类在窄屏上改为顶部横向切换。
- 开发模式下，页面请求会转发到 Vite 开发服务器。热更新不经过转发，改动后需要在手机上手动刷新。

## 数据

项目、对话元数据和设置写在 Electron 的 userData 目录下的 `data/`：

| 系统 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\Agent Desktop\data` |
| macOS | `~/Library/Application Support/Agent Desktop/data` |
| Linux | `~/.config/Agent Desktop/data` |

`state.json` 保存项目、对话列表和设置（含 MCP 服务器、Skill 正文，以及默认 CLI）。每段对话记住自己用的是 Cursor 还是 Codex。每段对话的消息在 `threads/` 里。Cursor 的会话记录仍在 `~/.cursor/chats`，Codex 的在 `~/.codex/sessions`。本应用只读取和续接，不改写那份存储。启用的 Skill 写在 `~/.cursor/skills`，以及 `~/.agents/skills` 和 `~/.codex/skills`。Codex 对话不使用 git worktree；分叉只复制本机消息，之后的发送从新的 Codex 会话开始。

开发时可用环境变量 `AGENT_DESKTOP_USER_DATA` 指定另一份 userData 目录。

可以同时开多个窗口。每个进程的 Chromium 缓存（GPU 缓存、HTTP 缓存、localStorage）写在系统临时目录的 `agent-desktop-sessions/<pid>`，避免互相锁文件。项目和对话仍共用上面的 `data/`；两个窗口同时改同一份数据时，后写入的会覆盖先写入的。退出时会删掉本进程的缓存目录，上次异常退出留下的目录会在下次启动时清掉。

## 目录

```
src/main      Electron 主进程：窗口、CLI 进程、持久化、git diff、局域网远程服务（remote.ts）、公网 SSH 隧道（public-tunnel.ts）
scripts       公网入口（public-gateway.py）和服务器安装脚本（setup-public-server.sh）
src/preload   渲染进程可用的安全 API
src/renderer  React 界面
src/shared    主进程与界面共用的类型和解析（如 Plan 模式的提问块）
```
