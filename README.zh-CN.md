# Agent Desktop

[English](README.md)

面向 [Cursor CLI](https://cursor.com/cli)（`agent`）、[Codex CLI](https://github.com/openai/codex)（`codex`）和 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（`claude`）的桌面客户端。对话按项目分组，窗口流式展示思考、工具调用和回复，并保留本地历史。界面支持简体中文和英文。

应用本身不调用模型。主进程在本机启动 Cursor CLI、Codex CLI 或 Claude Code 适配器，通过 [Agent Client Protocol](https://agentclientprotocol.com)（ACP）与之通信。输入框可以直接选择 Cursor、Codex 或 Claude。新建对话使用这个选择，并把它记住。已有对话里切换 CLI 时，屏幕上已有的消息保留，下一条消息会用所选 CLI 新开一段会话。侧边栏会标出每一段是 Cursor、Codex 还是 Claude。

## 功能

- 多项目侧边栏：添加、重命名、排序、折叠、搜索对话。搜索匹配标题、预览和项目名
- 分叉对话：可从标题栏、侧边栏、某条消息，或发送 `/fork` 开始，复制的历史会作为后续续聊的上下文
- 对话里的斜杠命令：输入 `/` 会列出 `/fork` 和 CLI 宣告的命令。`/fork` 在本应用内执行，其他命令作为下一条消息发出
- 三种模式：Agent（可改文件、执行命令）、Plan（只读方案，可点选回答提问、一键执行计划）、Ask（只读问答）
- 模型选择：Cursor、Codex 与 Claude 各自记住常用模型、默认模型，以及每个模型的上下文长度、思考强度和 Fast。Codex 按每个模型自己的档位列出思考强度，例如 Astra 的 Ultra。Claude 列出适配器为当前模型宣告的思考档位。每个项目会记住自己在该 CLI 里上次选的模型
- 新建的对话可以在隔离的 git worktree 中运行。Cursor 使用 CLI 自带的 `--worktree`；Codex 和 Claude 由本应用在项目 HEAD 上创建 worktree 和新分支 `agent-desktop/<名称>`，未提交的改动不会带过去
- 变更面板有两个页签：本对话编辑过的文件，以及当前工作目录的 git 分支、状态和 diff
- 一轮任务结束后，在回复下方列出本轮修改的文件，点开可看 diff
- 任务结束时，回复下方显示本轮耗时、token、使用的模型，以及按公开标价估算的费用。Codex 的“本轮周额度”使用服务端归属于当前会话的累计额度统计，悬浮说明展示周额度、5 小时额度等读数及统计口径。通过 ChatGPT 登录的新回合还会显示“本轮预估周额度”，取本轮前后账号周额度已用百分比之差；数据缺失或统计未完成时会明确标注
- 从 `~/.cursor/chats`、`~/.codex/sessions` 和 `~/.claude/projects` 导入 CLI 历史，并按工作目录归入项目
- 已有会话用 ACP 的 `session/load` 续聊，也可以从 CLI 存储把记录同步回来。复制会话 ID 后，可在终端用 `agent --resume` 继续一段 Cursor 对话
- 任务结束时发送系统通知，点击通知回到该对话。不在当前画面上结束的任务会留下未读点
- 主题：跟随系统、深色、浅色
- 语言：跟随系统、简体中文、English，即时切换并在重启后保留选择
- 设置按左侧分类切换：CLI、MCP、Skill、模型、用量、默认值、通知、远程控制、外观与历史。CLI 页分别检测 Cursor、Codex 与 Claude，并填写路径、API Key 和登录；登录右侧的「更新」按钮可更新对应的独立 CLI，显示进度和执行结果，完成后刷新版本与模型列表。模型页用 Cursor / Codex / Claude 页签分别配置常用模型和默认模型。MCP 和 Skill 页可在「本应用」与「本地所有」之间切换，后者直接管理各 CLI 在本机的原生配置。导入历史在「外观与历史」页
- 用量：显示 Cursor 与 Codex 的账号额度（有则显示 5 小时、每周、每月窗口和下次重置时间）。Claude 的账号额度尚未接入。Cursor 模型和其他模型还会显示该池的实际 token 和账号返回的价格。其他模型只显示包含的 API 用量百分比。按需支出在同一行显示已用和上限，有明细时再显示 token，不重复总价。下面按最近 1 天、7 天、30 天汇总本机 token，分页列出全部历史会话的模型和累计消耗。本机费用中，Cursor 用 [Cursor 公开标价](https://cursor.com/docs/models-and-pricing)，Codex 用 [OpenAI API 公开标价](https://developers.openai.com/api/docs/pricing) 估算。估算金额不代表订阅账单。Auto 和价目表没有的模型显示为未定价
- 远程控制：局域网扫码，或经 SSH 反向隧道从公网打开同一页面

## 界面语言

打开 **设置 → 外观与历史 → 语言**（英文界面为 **Settings → Appearance and history → Language**），选择 **跟随系统**、**简体中文** 或 **English**。默认跟随系统：桌面端操作系统语言为中文时使用简体中文，其他语言使用英文。选择保存在 `state.json` 中，桌面端与远程页面共用该设置；跟随系统时也统一使用桌面端的系统语言。切换立即生效，无需重启应用或中断正在运行的会话。

导航、设置、弹窗、工具摘要、用量说明、日期、相对时间和应用系统通知均支持中英文。新生成的应用提示和自动会话标题保留文案标识，之后切换语言也会更新；用户自定义名称、消息、模型回复、CLI 原始输出，以及没有文案标识的旧历史文字保留原文。

翻译目录位于 `src/shared/locales/`，中文源文案作为回退，英文词条按核心、主界面、设置和消息展示拆分。组件使用 renderer `lib/i18n.ts` 的 `useT()`，其他模块使用 `@shared/i18n` 的 `t()`；静态菜单在渲染时翻译，动态值使用 `{count}` 等具名占位符。测试覆盖词条参数、语言回退、设置持久化及中英文展示，并检查会话内容不被翻译。

## 环境要求

- Node.js 22.12 或更高版本
- 至少一种 CLI：已配置 API Key 或已登录的 Cursor CLI，Codex CLI（找不到本机 `codex` 时使用应用内置的 Codex），或 Claude Code（找不到本机 `claude` 时使用适配器自带的 Claude）
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

安装 Claude Code：

```bash
npm install -g @anthropic-ai/claude-code
```

也可以不单独安装。应用通过 `@agentclientprotocol/claude-agent-acp` 驱动 Claude Code。设置里的路径为空、且 PATH 上没有 `claude` 时，使用适配器自带的 Claude。设置里会写明正在使用内置 Claude。Windows 上会跳过 `.cmd` 跳转，以便适配器启动原生程序。

应用会自动查找 CLI：

| 系统 | Cursor | Codex | Claude |
| --- | --- | --- | --- |
| Windows | `%LOCALAPPDATA%\cursor-agent` | PATH 上的 `codex` | PATH 上的 `claude.exe`，或 `%USERPROFILE%\.local\bin\claude.exe` |
| macOS / Linux | `~/.local/bin/agent`、`/usr/local/bin/agent`、`/opt/homebrew/bin/agent` | `~/.local/bin/codex`、`/usr/local/bin/codex`、`/opt/homebrew/bin/codex`，以及 PATH | `~/.local/bin/claude`、`/usr/local/bin/claude`、`/opt/homebrew/bin/claude`，以及 PATH |

找不到时，在设置里填写可执行文件或安装目录。

Cursor 认证优先使用 [Cursor API Key](https://cursor.com/dashboard/api)。设置中的 Key 优先于环境变量 `CURSOR_API_KEY`。没有 Key 时，使用 `agent login` 保存的浏览器登录。

Codex 认证优先使用设置中的 Key，其次是 `CODEX_API_KEY`，再次是 `OPENAI_API_KEY`。都没有时使用 ChatGPT 登录。

Claude 认证优先使用设置中的 Key，其次是 `ANTHROPIC_API_KEY`。只要其中有一个，就按 API 计费，不会使用 Claude 订阅。都没有时使用 `~/.claude` 里的登录。登录按钮走适配器的 Claude.ai 登录。

### 更新 CLI

打开「设置 → CLI」，点击对应 CLI 登录按钮右侧的「更新」。通过远程页面点击时，也在桌面应用所在电脑执行。执行期间按钮显示「更新中…」，卡片保留执行结果或错误信息；成功后刷新该 CLI 的版本与模型列表。

Cursor 和原生安装的 Claude Code 使用各自的 `update` 命令。通过 npm 安装的 Codex 在原有安装位置更新，通过 Homebrew 安装的版本由 Homebrew 更新。不支持的安装方式会提示处理方法。内置 Codex 和 Claude 随 Agent Desktop 更新，因此其更新按钮不可用；需要单独更新时，先安装独立 CLI 并在设置中选择。

## 开发

窗口是 Electron，界面是 React，两侧都是 TypeScript，用 electron-vite 构建。

```bash
npm install
npm run dev
```

Windows 一键启动（需先安装 Node.js 22.12 或更高版本，包含 npm）：

- 双击 `start-dev.bat`：自动安装依赖、补齐 Electron 运行时，再启动开发模式（支持热更新）。
- 双击 `start-preview.bat`：自动安装依赖、补齐 Electron 运行时，构建后启动生产预览。

首次运行需要联网下载依赖和 Electron；之后会复用已安装的依赖与运行时。脚本可从任意工作目录启动，失败时会保留窗口显示错误。Electron 下载失败时，检查网络、代理或 `ELECTRON_MIRROR` 环境变量后重试。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 打开开发窗口 |
| `npm test` | 离线单元测试，不调用模型 |
| `npm run test:live` | 用 Grok 4.7 500K High Fast 发一次极短提问 |
| `npm run typecheck` | 类型检查 |
| `npm run build` | 编译到 `out/` |
| `npm run preview` | 预览编译结果 |
| `npm run dist` | 打包安装包到 `release/` |

`npm test` 不访问 Cursor CLI、Codex 或 Claude。`npm run test:live` 才会在临时空目录里用 Ask 模式调用 `grok-4.7[context=500k,reasoning_effort=high,fast=true]`，提示只有一句 `Reply with exactly ok`。需要本机已登录或已设置 `CURSOR_API_KEY`。High 仍会消耗少量思考 token。

打包目标：Windows NSIS、macOS DMG、Linux AppImage。

按 `F12` 打开开发者工具。离开本应用的链接会用系统浏览器打开。

## 使用

1. 添加一个项目文件夹。Agent 在该目录中工作；新建的对话也可以改到这段对话自己的 worktree。移除项目只从本应用删除，磁盘上的文件会留下。
2. 在首页选择项目，输入任务或点一条示例提示，选好 CLI、模型和模式后发送。输入框下方列出该项目最近的三段对话。
3. 在侧边栏管理对话：置顶、归档、重命名（双击标题）、分叉、从 CLI 存储同步、复制会话 ID、删除。同步会替换这里显示的记录。Codex 会从日志恢复每轮 token 和可用的耗时；其他 CLI 可能丢失仅由本应用保存的耗时和 token。
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

输入框用来选 CLI、模式和模型，也可以打开完全访问（`--force`）。首页上的 CLI 用于新建对话。对话里切换 CLI 时，已经显示的记录保留，下一条消息会用所选 CLI 新开一段会话。这个选择会记成设置里 CLI 页的默认值。完全访问会让 CLI 在不逐条确认的情况下执行命令。对 Claude 来说，完全访问是 `bypassPermissions`；不开完全访问的 Agent 是 `acceptEdits`，改文件会自动通过，命令仍会询问。Ask 保持 Claude 的默认权限模式，应用会拒绝改文件和执行命令的请求。沙箱（`--sandbox`）在设置的「默认值」里：遵循 CLI、启用或禁用，只作用于 Cursor，不是输入框上的开关，Claude 不使用它。首页上，新建的对话还可以在项目目录和隔离的 git worktree 之间切换。Cursor 用 `--worktree`；Codex 和 Claude 的 worktree 由本应用创建，项目必须是有提交的 git 仓库。

在一段对话里输入 `/` 会打开命令菜单。方向键移动，Enter 或 Tab 选中，Esc 只关闭菜单，不会停止正在运行的回合。`/fork` 在本地分叉。需要参数的命令会填成 `/名称 `，并在输入框下方显示提示，再按 Enter 发送。没有参数的命令会立刻执行。列表里还有 CLI 通过 ACP `available_commands_update` 宣告的命令。已有 CLI 会话的对话，第一次输入 `/` 会加载该会话，以便列出这些命令。新对话和首页不启动 CLI，而是复用这个 CLI 上一次宣告的命令列表，并记在本机；还没有任何列表时不显示菜单。下一次真实会话会刷新这份列表。以 `/` 开头但没有匹配项的文本仍按普通消息发送。

项目分别记住 Cursor、Codex 和 Claude 的模型。修改其中一个 CLI 的模型或常用模型列表，会保留另外两个 CLI 的选择。

模型选择器还会按 CLI 和模型分别记住上下文长度、思考强度（含 Thinking）及 Fast 开关。选择后立即保存，无需发送消息；切换回该模型或重启应用后再次选择时，会恢复它上次的配置。切换到常用模型、新建对话、切换项目或 CLI，以及设置页的默认模型，都会以该模型最新保存的配置为准，而不是项目或默认模型上次记录的旧档位。这些偏好保存在 `state.json` 中，桌面端与远程页面共享。已有对话保留自己的模型配置，打开旧对话不会覆盖这些偏好。如果 CLI 不再提供某个配置组合，选择器会使用当前可用的变体。

打开或刷新对话时，历史加载期间收到的流式消息会合并保留。CLI 返回空历史时不会覆盖本地对话。删除对话、修改 CLI 配置或退出应用，也会停止尚在预加载会话的 CLI 进程。

Git 页签显示工作区的实际内容；仓库尚无提交时，也会包含暂存后继续修改的内容。

## Plan 模式

Cursor 不向 ACP 客户端提供 AskQuestion 工具。Codex 的 Plan 是协作模式（`collaboration_mode=plan`），审批模式仍是只读，不是 Cursor 的 `modeId: plan`。Claude 的 Plan 是适配器的 `plan` 权限模式。三种 CLI 的 Plan 消息前都会附一段说明，用 `<agent_desktop_client>` 标签包住。导入 CLI 历史时会去掉这个标签。这段说明要求模型这样工作：

- 需要选择时，模型输出语言标记为 `questions` 的围栏代码块，正文是 JSON。界面把它画成选项卡片。点选并按继续后，选择作为下一条消息发出。跳过则让模型自行判断。只有最新一轮卡片可以提交。
- 需求明确后，Cursor 使用 CreatePlan，Codex 和 Claude 各自给出方案，生成名称、摘要和 Markdown 正文。界面显示方案卡片：名称、摘要、待办，以及可展开的完整方案。Cursor 还会提供「打开方案文件」（`~/.cursor/plans/*.plan.md`）。没有这个文件时，Codex 和 Claude 会隐藏该按钮。
- 「执行计划」把输入框切到 Agent 模式，并发送一条消息去实现该方案。只有最新的方案显示这个按钮。

在 ACP 下，CLI 会自动批准模型发起的 SwitchMode，并且不通知客户端。如果 Cursor 或 Claude 在一轮 Plan 中切换了模式，应用会立刻把会话模式设回 Plan，避免它开始改文件。

## MCP 与 Skill

在设置里添加 MCP 服务器。启用后，新建和续接的会话会通过 ACP 的 `mcpServers` 传入（stdio、HTTP 或 SSE）。这份列表写在本应用的 `state.json` 里，不会改写 `~/.cursor/mcp.json`。

启用的 Skill 会写成 `~/.cursor/skills/<name>/SKILL.md`，同时写到 Codex 的路径 `~/.agents/skills/<name>/SKILL.md` 和 `~/.codex/skills/<name>/SKILL.md`，以及 `~/.claude/skills/<name>/SKILL.md`。名称只能包含小写字母、数字和连字符，并且需要一段描述。CLI 凭这段描述决定是否使用该 Skill。停用或删除时，只移除本应用创建的目录。同名但不是本应用创建的目录会留在原地，保存时会提示无法覆盖。

### 本地所有

MCP 和 Skill 页的「本地所有」分区扫描本机上各 CLI 自己的配置，并在原生文件里直接新增、编辑、启用/停用和删除：

| CLI | 用户级 MCP | 项目级 MCP | Skill 目录 |
| --- | --- | --- | --- |
| Cursor | `~/.cursor/mcp.json` | `<项目>/.cursor/mcp.json` | `~/.cursor/skills`、`<项目>/.cursor/skills` |
| Codex | `~/.codex/config.toml` 的 `[mcp_servers.*]` | `<项目>/.codex/config.toml` | `~/.agents/skills`、`~/.codex/skills`、`<项目>/.agents/skills`、`<项目>/.codex/skills` |
| Claude | `~/.claude.json` 的 `mcpServers`，以及 `projects[<路径>].mcpServers`（本地级） | `<项目>/.mcp.json` | `~/.claude/skills`、`<项目>/.claude/skills` |

项目指已添加到侧边栏的项目。新增条目时选择 CLI 和作用域（用户或某个项目）。

- MCP：Codex 使用原生的 `enabled = false`。修改 `config.toml` 时只替换该服务器的 `[mcp_servers.<名称>]` 及其子表，文件其余部分和注释保持不变。Cursor 和 Claude 没有停用开关，停用的服务器从原文件移到本应用数据目录的 `local-config/disabled-mcp.json`，启用时写回。在 `[mcp_servers]` 里以内联表定义的 Codex 服务器只读。Codex 不支持 SSE 传输。
- Skill：停用会把目录移到 `local-config/disabled-skills/`，启用时移回；删除会把目录移到回收站。编辑只重写 `SKILL.md` 的 `name`、`description` 和正文，其他 frontmatter 字段与目录里的其他文件保留；目录名与原名称一致时，改名会一并重命名目录。
- 只读来源：CLI 内置 Skill（`~/.cursor/skills-cursor`、`~/.codex/skills/.system`）和插件 Skill（`~/.cursor/plugins`、`~/.codex/plugins`、`~/.claude/plugins`）会在 CLI 更新时被覆盖，只能查看和打开目录。本应用创建的 Skill 目录标为「本应用」，在「本应用」分区修改。
- 安全：每个配置文件第一次被本应用修改前，会备份为同目录下的 `<文件名>.agent-desktop.bak`。写入前会比对列表时的文件内容，文件已被其他程序改过时拒绝写入，需要刷新后再试。
- 远程页面也能使用这些功能，只是不显示「打开文件」和「打开目录」。

MCP、Skill、CLI 路径、API Key 或沙箱设置变更后，空闲的 CLI 进程会退出。下一条消息使用新配置。

## 用量统计

用量页顶部显示 Cursor 与 Codex 的账号额度。Claude 的账号额度尚未接入。Cursor 显示当前账单周期里的 Cursor 模型和其他模型占用，以及下次重置时间；有按需上限时一并显示。Cursor 模型和其他模型还会带上该池的实际 token（输入、输出、缓存读、缓存写）和账号返回的价格，并按账号的池标记拆开。其他模型只显示包含的 API 用量百分比。套餐的包含金额会停在已购上限，不是这一池的消耗，所以不标在这行上。按需支出在进度旁显示已用和上限；账号若返回了按需明细，也会带上 token，但不再重复总价。Codex 显示接口返回的窗口，常见是 5 小时和每周，并写出下次重置时间。没有的窗口不显示。只用 API Key 登录的 Codex 没有订阅额度，卡片会说明原因。这些数字来自账号接口，不是下面的本机估算。

设置里的用量汇总本机对话最近 1 天、7 天、30 天的 token，并按模型列出估算费用。模型名是短名，例如「Grok 4.7 500K High Fast」，不带完整参数串。下面的会话列表包含全部历史对话。每一行显示用过的模型、累计 token 和费用，不受上面的天数限制。超过 20 行会分页。没有 token 记录的对话仍会列出，费用留空。一轮结束时，回复下方也会显示该轮的耗时、token、模型和估算费用。Codex token 根据本机日志的累计用量差统计，包含一轮内的所有模型请求，重复快照只计一次。输入排除缓存，推理 token 已包含在输出中。Codex 逐请求计价，避免多次短请求的累计输入误触发长上下文价格。其他 CLI 使用其报告的回合用量，缓存读取和写入分开计数。Cursor 使用 [Cursor 公开标价](https://cursor.com/docs/models-and-pricing)，Codex 使用 [OpenAI API 公开标价](https://developers.openai.com/api/docs/pricing)，单位为美元 / 百万 token。同一模型在不同 CLI 中按各自的价格分别统计。估算金额不代表订阅账单或剩余额度；Cursor 估算不含 Teams Token Rate。不足一美分的金额显示到四位小数。Auto 和价目表里没有的模型只显示 token，费用标为未定价。上面的汇总里，分叉复制过去的一轮只计一次。会话列表按每段对话自己的记录相加，所以同一轮会同时出现在原对话和分叉里。

通过 ChatGPT 登录 Codex 时，回复在价格右侧显示“本轮周额度”。服务端按当前 Codex 会话 ID 归属周额度、5 小时额度和余额 credits，读数表示该会话在当前额度周期内的累计消耗，不受其他独立会话影响，不能把各轮页脚相加；悬浮说明会注明这一累计统计口径。已返回的有效零值显示为 0，极小正数保留精度，超过 100% 的有效读数也会保留。缺少的额度窗口不显示；部分结果标为“统计中”，服务未返回有效结果时显示“服务未返回”，尚无读数时显示“暂无数据”。任务结束和打开历史时会刷新该会话最新的结果；缺失或不完整时，最多在 30 秒、2 分钟和 5 分钟后重试。这些会话统计读取不发送模型请求，不延迟发送或完成，每次最多等待 8 秒。部分会话即使已有本机 token 记录，服务仍可能不返回额度归属数据；不能据此认定没有消耗或保证稍后一定可用。旧接口返回的会话 credits 和金额可作为后备显示，但不会换算成额度百分比。API Key 会话不查询订阅用量。

新回合还会在旁边显示“本轮预估周额度 …%”。范围是本条用户消息及其回复，计算方法为本轮结束后的周额度**已用百分比减去开始前的已用百分比**；例如从 30% 到 30.5%，显示“本轮预估周额度 0.5%”。模型请求发送前的额度读取最多等待 3 秒，失败或超时仍继续发送，等待时停止任务则不再发送。正常结束，以及产生结果记录的停止或失败回合，都会异步读取结束额度，最多等待 3 秒，不延迟完成通知。两次读数的重置时间允许相差不超过 1 秒，但都必须有效且晚于结束采样时间。缺少有效读数、无法确认同一周额度周期、期间发生重置或差值为负时，显示“本轮预估周额度 暂无数据”。有效差值为零时显示 0%，极小正值显示 <0.0001%，其他数值最多显示四位小数。悬浮说明展示开始值、结束值和公式。其他会话、其他客户端的使用和统计延迟可能影响这个账号估算；0% 只表示报告的读数未变化。

本轮估算及开始、结束快照会随对应回复保存。历史刷新、token 修复、会话统计重试和重启都不会重新采样。已有有效预估值（包括零值）会保留；历史记录缺少有效预估值且有完整起止快照时，页脚按同一规则重新计算，无需网络请求或存档迁移。若结束采样返回前已开始下一轮、会话被删除或重新导入、CLI 会话已切换，则丢弃迟到的数据。旧回复缺少开始快照，不补算。API Key 回合没有订阅额度预估。

Codex 历史导入和同步也会从日志恢复用量。旧结果能与日志中的轮次唯一对应时，打开对话或用量页会修正 token，保留原消息、耗时和额度记录，并同步修正分叉副本。日志缺失时，用量留空或保留旧记录，不把适配器的最后一次请求当成整轮。设置了 `CODEX_HOME` 时从该目录读取日志，否则使用 `~/.codex`。每条新结果会记录使用的 CLI，后续切换 CLI 仍按原来的来源计价。

## 远程控制

在设置的远程控制里打开开关。应用在局域网上监听（默认端口 `8765`），提供和桌面端相同的界面。同一网络上的手机或其他电脑可以扫二维码打开。二维码带上电脑当前打开的项目或对话。电脑有多块网卡时，可从下拉列表换一个地址。

打开公网访问后，应用用本机 OpenSSH 客户端建立反向隧道。服务器上的入口程序占用公网端口（默认 `8765`），把每个请求转到链接里写明的那台电脑。多台电脑可以同时共用这一个端口。每条链接不同，例如 `http://43.167.166.239:8765/c/<电脑标识>/?token=...`。标识在第一次需要时生成，并存在本机。重置链接不会改变它。默认服务器是 `root@43.167.166.239`。SSH 用户、服务器地址和公网端口都可以改。使用自己的服务器前，先按下面的步骤配好。隧道建立后，公网链接会出现在地址下拉列表和二维码里。改地址或端口会重新连接。断开后按 1、2、5、10 秒重试。

- 链接里带有访问令牌。手机第一次打开后会记住它。同一浏览器里，不同电脑的公网令牌分开保存。拿到链接的人可以完全控制本应用（发任务、改设置），不要外传。重置链接会签发新令牌。旧的局域网链接、公网链接，以及已经连上的手机，会立刻失效。
- 手机端不显示 API Key 和令牌，也不能修改远程控制设置。只在电脑上有意义的按钮会隐藏，例如在 Cursor 中打开、在文件管理器中打开。添加项目时需要手写电脑上的路径。
- 服务只有 HTTP，没有加密。局域网只在你信任的网络上使用。公网链接在路径上和这台服务器上都是明文，只在你自己控制的服务器上开启。第一次启用时，Windows 防火墙可能会提示，允许专用网络访问即可。
- 公网隧道使用本机默认 SSH 密钥，并以 `BatchMode` 登录，不会询问密码。每台电脑把隧道接到服务器上的 Unix 套接字 `/run/agent-desktop/<电脑标识>`，自己不绑定公网端口。服务器必须允许套接字转发（`AllowStreamLocalForwarding yes`），并设置 `StreamLocalBindUnlink yes`。否则断线后留下的套接字文件会挡住下一次连接。入口程序监听公网端口并转发页面。在云安全组里放行这个公网端口。应用运行时不会改服务器。
- 屏幕宽度不超过 720px 时，侧边栏变成抽屉，变更面板和设置变成全屏。设置分类改到顶部的横条里切换。
- 开发时，页面请求会转发到 Vite 开发服务器，而且只转发到这一个地址。请求行里的绝对地址不会被跟着访问。热更新不经过这个代理，改完后在手机上手动刷新。

远程设置响应和状态更新会隐藏 Cursor、Codex、Claude 的 API Key 及访问令牌。手机保存空白密钥字段时，会保留桌面端已配置的密钥。

SSH 仍连接但公网入口暂时不可达时，应用会持续退避重试健康检查，入口恢复后自动显示公网链接。重连后会忽略旧 SSH 连接的迟到探测结果；关闭公网访问会取消后续重试。

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

`state.json` 保存项目、对话列表和设置，包括 MCP 服务器、Skill 正文和默认 CLI。每段对话记住自己用的是 Cursor、Codex 还是 Claude。每段对话的消息在 `threads/` 里。Cursor 的会话记录仍在 `~/.cursor/chats`，Codex 的在 `~/.codex/sessions`，Claude 的在 `~/.claude/projects`。本应用读取和续接这些记录，并在分叉时创建独立副本。启用的 Skill 写到 `~/.cursor/skills`、`~/.agents/skills`、`~/.codex/skills` 和 `~/.claude/skills`。「本地所有」分区停用的 MCP 服务器和 Skill 暂存在数据目录的 `local-config/` 下。Codex 和 Claude 对话的 worktree 放在数据目录的 `worktrees/<仓库名>/<分支>-<随机后缀>` 下，分支名为 `agent-desktop/<分支>-<随机后缀>`。删除对话或项目时，如果没有其他对话还在用这个 worktree，会执行 `git worktree remove`；worktree 里有未提交或未跟踪的文件时会保留。分支用 `git branch -d` 删除，含未合并提交的分支会留下。

完整分叉会复制出独立的 CLI 会话：Cursor 复制一致的数据库快照，Codex 和 Claude 使用适配器的原生分叉接口。从某条消息分叉时，只保留到该消息为止的历史。如果 CLI 无法精确复制到这个位置，或原生复制失败，应用会保存所选历史，并在下次发送时连同新消息一起传给模型，包括之前的回复和工具结果。这份待发送上下文会保留到首次回复成功，重启或发送失败不会丢失。从 CLI 同步时也能还原这些历史消息；尚未传入上下文的分叉需要先成功发送一条消息再同步。原对话保留。

开发时，`AGENT_DESKTOP_USER_DATA` 把 userData 指到另一个目录。

可以同时开多个窗口。每个进程把自己的 Chromium 缓存（GPU 缓存、HTTP 缓存、localStorage）写到系统临时目录的 `agent-desktop-sessions/<pid>`，这样进程之间不会锁同一批文件。项目和对话仍然共用上面的 `data/`。两个窗口写同一份数据时，后写入的为准。退出时进程会删掉自己的缓存目录。崩溃留下的目录在下次启动时清掉。

## 目录

```
src/main              Electron 主进程
  index.ts            窗口、IPC、通知和退出
  sessions.ts         对话调度、ACP 进程生命周期和流式轮次
  session/provider.ts CLI 启动、认证、会话选项和 Plan 提示词
  session/requests.ts 通过轮次接口处理 ACP 问答和权限请求
  session/usage.ts    延迟用量写回及可取消的账号用量重试
  cli.ts              查找并启动 Cursor CLI
  codex.ts            Codex 适配器：模型、登录、模式 id
  claude.ts           Claude 适配器：模型、登录、模式 id
  claude-history.ts   从 ~/.claude/projects 导入记录
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
src/renderer/src      React 界面
  store.ts            状态和操作的公共入口
  store/              状态内核、持久化、模型、命令、对话和初始化
  components/Items.tsx 消息分派和界面状态适配
  components/items/   Markdown、消息、工具、计划、问答和结果展示
  components/settings 设置各页
  lib/model-prefs.ts  决定选中哪个模型，不放在界面状态里
src/shared            主进程和界面共用的类型、价格、用量、额度、斜杠命令，以及 Plan 提问块
scripts               公网入口（public-gateway.py）、服务器安装脚本（setup-public-server.sh）、本机一键配置（setup-public-server.mjs）
test                  离线单元测试，以及在线冒烟测试
```

### 模块边界

`SessionManager` 负责进程生命周期和轮次调度。`main/session/` 中的模块仅接收所需依赖：模型和模式设置使用 ACP 请求接口，问答使用轮次状态与消息回调，用量刷新使用精简的存储接口，均不反向依赖会话管理器。开始新轮次、删除对话和退出时，通过用量模块取消账号用量重试。

前端保留 `store.ts` 作为公共入口。`store/` 内的功能模块直接依赖状态内核和具体辅助模块，不反向导入公共入口。初始化模块将 API 事件接入对应操作。历史加载与加载期间的流式消息缓冲放在同一个对话模块中，保持事件顺序。

`components/Items.tsx` 负责消息与状态管理的连接。`components/items/` 中的展示组件通过参数或共享的轮次 context 获取模型目录和问答操作。共享 context、基础控件位于消息视图下层，避免 Markdown、问答与计划之间循环依赖。现有 `store.ts`、`Items.tsx` 和 `main/sessions.ts` 的导入方式继续可用。
