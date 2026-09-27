# Agent Desktop

[English](README.md)

面向 [Cursor CLI](https://cursor.com/cli)（`agent`）和 [Codex CLI](https://github.com/openai/codex)（`codex`）的桌面客户端。对话按项目分组，窗口流式展示思考、工具调用和回复，并保留本地历史。界面语言是中文。

应用本身不调用模型。主进程在本机启动 Cursor CLI 或 Codex CLI，通过 [Agent Client Protocol](https://agentclientprotocol.com)（ACP）与之通信。新建对话使用设置里选中的 CLI，并记住这个选择。已有对话继续使用创建时的 CLI。侧边栏会标出每一段是 Cursor 还是 Codex。

## 功能

- 多项目侧边栏：添加、重命名、排序、折叠、搜索对话。搜索匹配标题、预览和项目名
- 分叉对话：可从标题栏、侧边栏、某条消息，或发送 `/fork` 开始。原对话保持不变
- 对话里的斜杠命令：输入 `/` 会列出 `/fork` 和 CLI 宣告的命令。`/fork` 在本应用内执行，其他命令作为下一条消息发出
- 三种模式：Agent（可改文件、执行命令）、Plan（只读方案，可点选回答提问、一键执行计划）、Ask（只读问答）
- 模型选择：Cursor 与 Codex 各自记住常用模型和默认模型，并可选上下文长度、思考强度、Fast。Codex 按每个模型自己的档位列出思考强度，例如 Astra 的 Ultra。每个项目会记住自己在该 CLI 里上次选的模型
- 新建的 Cursor 对话可以在隔离的 git worktree 中运行。Codex 没有这个开关
- 变更面板有两个页签：本对话编辑过的文件，以及当前工作目录的 git 分支、状态和 diff
- 一轮任务结束后，在回复下方列出本轮修改的文件，点开可看 diff
- 任务结束时，回复下方显示本轮耗时、token、使用的模型，以及按公开标价估算的费用
- 从 `~/.cursor/chats` 和 `~/.codex/sessions` 导入 CLI 历史，并按工作目录归入项目
- 已有会话用 ACP 的 `session/load` 续聊，也可以从 CLI 存储把记录同步回来。复制会话 ID 后，可在终端用 `agent --resume` 继续一段 Cursor 对话
- 任务结束时发送系统通知，点击通知回到该对话。不在当前画面上结束的任务会留下未读点
- 主题：跟随系统、深色、浅色
- 设置按左侧分类切换：CLI、MCP、Skill、模型、用量、默认值、通知、远程控制、外观与历史。CLI 页分别检测 Cursor 与 Codex，并填写路径、API Key 和登录。模型页用 Cursor / Codex 页签分别配置常用模型和默认模型。导入历史在「外观与历史」页
- 用量：显示 Cursor 与 Codex 的账号额度（有则显示 5 小时、每周、每月窗口和下次重置时间）。Cursor 模型和其他模型还会显示该池的实际 token 和账号返回的价格。其他模型只显示包含的 API 用量百分比。按需支出在同一行显示已用和上限，有明细时再显示 token，不重复总价。下面按最近 1 天、7 天、30 天汇总本机 token，分页列出全部历史会话的模型和累计消耗。本机费用用 [Cursor 公开标价](https://cursor.com/docs/models-and-pricing) 估算。Auto 和价目表没有的模型显示为未定价
- 远程控制：局域网扫码，或经 SSH 反向隧道从公网打开同一页面

## 环境要求

- Node.js 22.12 或更高版本
- 至少一种 CLI：已配置 API Key 或已登录的 Cursor CLI，或 Codex CLI（找不到本机 `codex` 时使用应用内置的 Codex）
- 变更面板的 Git 页签需要本机可执行 `git`

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

也可以不单独安装。应用通过 `@agentclientprotocol/codex-acp` 驱动 Codex。设置里的路径为空、且 PATH 上没有 `codex` 时，使用适配器自带的 Codex。设置里会写明正在使用内置 Codex。

应用会自动查找 CLI：

| 系统 | Cursor | Codex |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\cursor-agent` | PATH 上的 `codex` |
| macOS / Linux | `~/.local/bin/agent`、`/usr/local/bin/agent`、`/opt/homebrew/bin/agent` | `~/.local/bin/codex`、`/usr/local/bin/codex`、`/opt/homebrew/bin/codex`，以及 PATH |

找不到时，在设置里填写可执行文件或安装目录。

Cursor 认证优先使用 [Cursor API Key](https://cursor.com/dashboard/api)。设置中的 Key 优先于环境变量 `CURSOR_API_KEY`。没有 Key 时，使用 `agent login` 保存的浏览器登录。

Codex 认证优先使用设置中的 Key，其次是 `CODEX_API_KEY`，再次是 `OPENAI_API_KEY`。都没有时使用 ChatGPT 登录。

## 开发

窗口是 Electron，界面是 React，两侧都是 TypeScript，用 electron-vite 构建。

```bash
npm install
npm run dev
```

在 Windows 上，`start-dev.bat` 会执行 `npm run dev`。`start-preview.bat` 先构建，再预览生产包。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 打开开发窗口 |
| `npm test` | 离线单元测试，不调用模型 |
| `npm run test:live` | 用 Grok 4.7 500K High Fast 发一次极短提问 |
| `npm run typecheck` | 类型检查 |
| `npm run build` | 编译到 `out/` |
| `npm run preview` | 预览编译结果 |
| `npm run dist` | 打包安装包到 `release/` |

`npm test` 不访问 Cursor CLI，也不访问 Codex。`npm run test:live` 才会在临时空目录里用 Ask 模式调用 `grok-4.7[context=500k,reasoning_effort=high,fast=true]`，提示只有一句 `Reply with exactly ok`。需要本机已登录或已设置 `CURSOR_API_KEY`。High 仍会消耗少量思考 token。

打包目标：Windows NSIS、macOS DMG、Linux AppImage。

按 `F12` 打开开发者工具。离开本应用的链接会用系统浏览器打开。

## 使用

1. 添加一个项目文件夹。Agent 在该目录中工作；新建的 Cursor 对话也可以改到这段对话自己的 worktree。移除项目只从本应用删除，磁盘上的文件会留下。
2. 在首页选择项目，输入任务或点一条示例提示，选好模型和模式后发送。输入框下方列出该项目最近的三段对话。
3. 在侧边栏管理对话：置顶、归档、重命名（双击标题）、分叉、从 CLI 存储同步、复制会话 ID、删除。同步会替换这里显示的记录，本应用保存的耗时和 token 会丢掉。
4. 需要看改动时打开变更面板，或在 Cursor / 文件管理器中打开工作目录。任务结束后，对话里会列出这一轮改过的文件，点击文件名展开 diff。

常用快捷键（macOS 上把 Ctrl 换成 ⌘）：

| 快捷键 | 作用 |
| --- | --- |
| Ctrl+N | 回到首页，开始新对话 |
| Ctrl+K、Ctrl+Shift+F | 聚焦侧边栏搜索 |
| Ctrl+B | 显示或隐藏侧边栏 |
| Ctrl+Shift+D | 显示或隐藏变更面板 |
| Ctrl+, | 打开设置 |
| Enter | 发送 |
| Shift+Enter | 换行 |
| Esc | 停止当前运行 |

输入框用来选模式和模型，也可以打开完全访问（`--force`）。完全访问会让 CLI 在不逐条确认的情况下执行命令。沙箱（`--sandbox`）在设置的「默认值」里：遵循 CLI、启用或禁用，不是输入框上的开关。首页上，新建的 Cursor 对话还可以在项目目录和隔离的 git worktree（`--worktree`）之间切换。

在一段对话里输入 `/` 会打开命令菜单。方向键移动，Enter 或 Tab 选中，Esc 只关闭菜单，不会停止正在运行的回合。`/fork` 在本地分叉。需要参数的命令会填成 `/名称 `，并在输入框下方显示提示，再按 Enter 发送。没有参数的命令会立刻执行。列表里还有 CLI 通过 ACP `available_commands_update` 宣告的命令。已有 CLI 会话的对话，第一次输入 `/` 会加载该会话，以便列出这些命令。新对话和首页不启动 CLI，而是复用这个 CLI 上一次宣告的命令列表，并记在本机；还没有任何列表时不显示菜单。下一次真实会话会刷新这份列表。以 `/` 开头但没有匹配项的文本仍按普通消息发送。

## Plan 模式

Cursor 不向 ACP 客户端提供 AskQuestion 工具。Codex 的 Plan 是协作模式（`collaboration_mode=plan`），审批模式仍是只读，不是 Cursor 的 `modeId: plan`。两种 CLI 的 Plan 消息前都会附一段说明，用 `<agent_desktop_client>` 标签包住。导入 CLI 历史时会去掉这个标签。这段说明要求模型这样工作：

- 需要选择时，模型输出语言标记为 `questions` 的围栏代码块，正文是 JSON。界面把它画成选项卡片。点选并按继续后，选择作为下一条消息发出。跳过则让模型自行判断。只有最新一轮卡片可以提交。
- 需求明确后，Cursor 使用 CreatePlan，Codex 使用自己的 plan 工具，生成名称、摘要和 Markdown 正文。界面显示方案卡片：名称、摘要、待办，以及可展开的完整方案。Cursor 还会提供「打开方案文件」（`~/.cursor/plans/*.plan.md`）。没有这个文件时，Codex 会隐藏该按钮。
- 「执行计划」把输入框切到 Agent 模式，并发送一条消息去实现该方案。只有最新的方案显示这个按钮。

在 ACP 下，CLI 会自动批准模型发起的 SwitchMode，并且不通知客户端。如果模型在一轮 Plan 中切换了模式，应用会立刻把会话模式设回 Plan，避免它开始改文件。

## MCP 与 Skill

在设置里添加 MCP 服务器。启用后，新建和续接的会话会通过 ACP 的 `mcpServers` 传入（stdio、HTTP 或 SSE）。这份列表写在本应用的 `state.json` 里，不会改写 `~/.cursor/mcp.json`。

启用的 Skill 会写成 `~/.cursor/skills/<name>/SKILL.md`，同时写到 Codex 的路径 `~/.agents/skills/<name>/SKILL.md` 和 `~/.codex/skills/<name>/SKILL.md`。名称只能包含小写字母、数字和连字符，并且需要一段描述。CLI 凭这段描述决定是否使用该 Skill。停用或删除时，只移除本应用创建的目录。同名但不是本应用创建的目录会留在原地，保存时会提示无法覆盖。

MCP、Skill、CLI 路径、API Key 或沙箱设置变更后，空闲的 CLI 进程会退出。下一条消息使用新配置。

## 用量统计

用量页顶部显示账号额度。Cursor 显示当前账单周期里的 Cursor 模型和其他模型占用，以及下次重置时间；有按需上限时一并显示。Cursor 模型和其他模型还会带上该池的实际 token（输入、输出、缓存读、缓存写）和账号返回的价格，并按账号的池标记拆开。其他模型只显示包含的 API 用量百分比。套餐的包含金额会停在已购上限，不是这一池的消耗，所以不标在这行上。按需支出在进度旁显示已用和上限；账号若返回了按需明细，也会带上 token，但不再重复总价。Codex 显示接口返回的窗口，常见是 5 小时和每周，并写出下次重置时间。没有的窗口不显示。只用 API Key 登录的 Codex 没有订阅额度，卡片会说明原因。这些数字来自账号接口，不是下面的本机估算。

设置里的用量汇总本机对话最近 1 天、7 天、30 天的 token，并按模型列出估算费用。模型名是短名，例如「Grok 4.7 500K High Fast」，不带完整参数串。下面的会话列表包含全部历史对话。每一行显示用过的模型、累计 token 和费用，不受上面的天数限制。超过 20 行会分页。没有 token 记录的对话仍会列出，费用留空。一轮结束时，回复下方也会显示该轮的耗时、token、模型和估算费用。token 来自 CLI 在回合结束时报告的用量：输入已经不含缓存，缓存读取和写入分开计数。Cursor 模型使用 Cursor 的公开标价。Codex 的 GPT 模型使用已收录的同一套公开 token 价格（美元 / 百万 token）。这不是剩余额度，也不含 Teams Token Rate。不足一美分的金额显示到四位小数。Auto 和价目表里没有的模型只显示 token，费用标为未定价。上面的汇总里，分叉复制过去的一轮只计一次。会话列表按每段对话自己的记录相加，所以同一轮会同时出现在原对话和分叉里。

## 远程控制

在设置的远程控制里打开开关。应用在局域网上监听（默认端口 `8765`），提供和桌面端相同的界面。同一网络上的手机或其他电脑可以扫二维码打开。二维码带上电脑当前打开的项目或对话。电脑有多块网卡时，可从下拉列表换一个地址。

打开公网访问后，应用用本机 OpenSSH 客户端建立反向隧道。服务器上的入口程序占用公网端口（默认 `8765`），把每个请求转到链接里写明的那台电脑。多台电脑可以同时共用这一个端口。每条链接不同，例如 `http://43.167.166.239:8765/c/<电脑标识>/?token=...`。标识在第一次需要时生成，并存在本机。重置链接不会改变它。默认服务器是 `root@43.167.166.239`。SSH 用户、服务器地址和公网端口都可以改。使用自己的服务器前，先按下面的步骤配好。隧道建立后，公网链接会出现在地址下拉列表和二维码里。改地址或端口会重新连接。断开后按 1、2、5、10 秒重试。

- 链接里带有访问令牌。手机第一次打开后会记住它。同一浏览器里，不同电脑的公网令牌分开保存。拿到链接的人可以完全控制本应用（发任务、改设置），不要外传。重置链接会签发新令牌。旧的局域网链接、公网链接，以及已经连上的手机，会立刻失效。
- 手机端不显示 API Key 和令牌，也不能修改远程控制设置。只在电脑上有意义的按钮会隐藏，例如在 Cursor 中打开、在文件管理器中打开。添加项目时需要手写电脑上的路径。
- 服务只有 HTTP，没有加密。局域网只在你信任的网络上使用。公网链接在路径上和这台服务器上都是明文，只在你自己控制的服务器上开启。第一次启用时，Windows 防火墙可能会提示，允许专用网络访问即可。
- 公网隧道使用本机默认 SSH 密钥，并以 `BatchMode` 登录，不会询问密码。每台电脑把隧道接到服务器上的 Unix 套接字 `/run/agent-desktop/<电脑标识>`，自己不绑定公网端口。服务器必须允许套接字转发（`AllowStreamLocalForwarding yes`），并设置 `StreamLocalBindUnlink yes`。否则断线后留下的套接字文件会挡住下一次连接。入口程序监听公网端口并转发页面。在云安全组里放行这个公网端口。应用运行时不会改服务器。
- 屏幕宽度不超过 720px 时，侧边栏变成抽屉，变更面板和设置变成全屏。设置分类改到顶部的横条里切换。
- 开发时，页面请求会转发到 Vite 开发服务器，而且只转发到这一个地址。请求行里的绝对地址不会被跟着访问。热更新不经过这个代理，改完后在手机上手动刷新。

### 配置自己的公网服务器

在项目目录执行一条命令。它通过 SSH 登录你的 Linux 服务器，写入隧道需要的 sshd 设置，并安装共用端口的入口程序：

```bash
npm run setup:public-server -- --user root --host 你的服务器 --port 8765
```

`--user` 是 SSH 用户。`--host` 是域名或 IP。`--port` 是手机打开的公网端口。SSH 不在 22 端口时加上 `--ssh-port`。全部参数见 `npm run setup:public-server -- --help`。

脚本使用没有口令的默认密钥：`~/.ssh/id_rsa`、`id_ecdsa` 或 `id_ed25519`。都没有时会生成 `~/.ssh/id_ed25519`。这把公钥还不能登录时，终端会要求输入一次 SSH 密码，并把公钥写入该用户的 `authorized_keys`。服务器只接受另一把私钥时，用 `--identity` 指向它。脚本仍会装上默认公钥，因为应用建隧道时只用默认密钥。非 root 用户必须能 `sudo`，需要密码时按提示输入。服务器没有 `python3` 时，脚本会用 apt、dnf、yum 或 apk 安装。

脚本会先备份 `sshd_config`。如果 `sshd -t` 失败，就恢复备份，然后 `reload` sshd，不断开当前登录。有 systemd 时，入口程序作为服务监听你选的公网端口；没有时在后台运行。firewalld 或 ufw 正在运行时会放行该端口。较旧的版本会自己绑定公网端口。升级前先在那些客户端上关掉公网访问，再运行这个脚本。

命令成功后，在远程控制里填入同一个 SSH 用户、服务器地址和公网端口，然后打开远程控制和公网访问。在云安全组里放行这个公网端口。

不带参数时，脚本会在默认服务器 `root@43.167.166.239` 上配置 `8765` 端口。如果已经登录到服务器，并且 `public-gateway.py` 和脚本在同一目录，也可以执行 `sudo bash scripts/setup-public-server.sh 8765`。

## 数据

项目、对话元数据和设置保存在 Electron userData 目录下的 `data/`：

| 系统 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\Agent Desktop\data` |
| macOS | `~/Library/Application Support/Agent Desktop/data` |
| Linux | `~/.config/Agent Desktop/data` |

`state.json` 保存项目、对话列表和设置，包括 MCP 服务器、Skill 正文和默认 CLI。每段对话记住自己用的是 Cursor 还是 Codex。每段对话的消息在 `threads/` 里。Cursor 的会话记录仍在 `~/.cursor/chats`，Codex 的在 `~/.codex/sessions`。本应用只读取和续接那份存储，不改写它。启用的 Skill 写到 `~/.cursor/skills`、`~/.agents/skills` 和 `~/.codex/skills`。Codex 对话不使用 git worktree。分叉只复制本机消息，之后的发送会开始一段新的 Codex 会话。Cursor 的分叉会尝试一并复制 CLI 会话。复制失败时，之后的消息从新的 Cursor 会话开始，对话里会说明这一点。

开发时，`AGENT_DESKTOP_USER_DATA` 把 userData 指到另一个目录。

可以同时开多个窗口。每个进程把自己的 Chromium 缓存（GPU 缓存、HTTP 缓存、localStorage）写到系统临时目录的 `agent-desktop-sessions/<pid>`，这样进程之间不会锁同一批文件。项目和对话仍然共用上面的 `data/`。两个窗口写同一份数据时，后写入的为准。退出时进程会删掉自己的缓存目录。崩溃留下的目录在下次启动时清掉。

## 目录

```
src/main              Electron 主进程
  index.ts            窗口、IPC、通知和退出
  sessions.ts         每个对话一个 ACP 进程：续聊、模式、提示词
  cli.ts              查找并启动 Cursor CLI
  codex.ts            Codex 适配器：模型、登录、模式 id
  acp.ts              按行分隔的 JSON-RPC，含 Plan 模式提示
  window.ts           窗口、标题栏主题、每个进程自己的缓存目录
  store.ts            state.json 和每段对话的文件
  thread-history.ts   分叉对话，以及从 CLI 存储同步记录
  cli-catalog.ts      模型列表、CLI 检测和登录
  remote.ts           局域网 HTTP 服务
  public-tunnel.ts    公网 SSH 反向隧道
  remote-runtime.ts   按设置开关局域网服务和公网隧道
  quota.ts            Cursor 与 Codex 的账号额度
  ipc/                按项目、对话、设置、CLI、用量和本机操作拆开的 IPC
src/preload           渲染进程可以调用的 API
src/renderer          React 界面
  components/settings 设置各页
  lib/model-prefs.ts  决定选中哪个模型，不放在界面状态里
src/shared            主进程和界面共用的类型、价格、用量、额度、斜杠命令，以及 Plan 提问块
scripts               公网入口（public-gateway.py）、服务器安装脚本（setup-public-server.sh）、本机一键配置（setup-public-server.mjs）
test                  离线单元测试，以及在线冒烟测试
```
