# 数据存储

[文档目录](README.zh-CN.md) · [项目首页](../README.zh-CN.md) · [English](data-storage.md)

项目、对话元数据和设置保存在 Electron userData 目录下的 `data/`：

| 系统 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\Agent Desktop\data` |
| macOS | `~/Library/Application Support/Agent Desktop/data` |
| Linux | `~/.config/Agent Desktop/data` |

`state.json` 保存项目、对话列表和设置，包括 MCP 服务器、Skill 正文、默认 CLI、手动添加的 Grok Bot 名称和可调面板的宽度。Grok Bot 的文件不会复制到这里：显示时从 Grok Bot 桌面端自己的缓存读取，只在你另存为时写到你选的位置。`grokbot-cache.json` 保存最近的 Grok Bot 消息，让重启后打开 Bot 更快：每个 Bot 名称对应它的 API 会话 id、读取位置和最近的消息（只有文件名和哈希，没有文件内容）。它通过 API Key 的 SHA-256 前 16 位与 Key 绑定（不保存 Key 本身），最多保存 20 个 Bot，每个 Bot 约 256 KiB 消息，超出时先丢弃较早的消息。删除它只会让下次打开时重新加载完整历史。每段对话记住自己用的是 Cursor、Codex 还是 Claude。每段对话的消息在 `threads/` 里。Cursor 的会话记录仍在 `~/.cursor/chats`，Codex 的在 `~/.codex/sessions`，Claude 的在 `~/.claude/projects`。本应用读取和续接这些记录，并在分叉时创建独立副本。启用的 Skill 写到 `~/.cursor/skills`、`~/.agents/skills`、`~/.codex/skills` 和 `~/.claude/skills`。「本地所有」分区停用的 MCP 服务器和 Skill 暂存在数据目录的 `local-config/` 下。Codex 和 Claude 对话的 worktree 放在数据目录的 `worktrees/<仓库名>/<分支>-<随机后缀>` 下，分支名为 `agent-desktop/<分支>-<随机后缀>`。删除对话或项目时，如果没有其他对话或项目还在使用这个 worktree 或其子目录，会执行 `git worktree remove`；worktree 里有未提交或未跟踪的文件时会保留。分支用 `git branch -d` 删除，含未合并提交的分支会留下。已保存的 worktree 目录缺失时，会话会报错，不会悄悄回到主项目继续执行。

## 分叉对话

完整分叉会复制出独立的 CLI 会话：Cursor 复制一致的数据库快照，Codex 和 Claude 使用适配器的原生分叉接口。从某条消息分叉时，只保留到该消息为止的历史。如果 CLI 无法精确复制到这个位置，或原生复制失败，应用会保存所选历史，并在下次发送时连同新消息一起传给模型，包括之前的回复和工具结果。这份待发送上下文会保留到首次回复成功，重启或发送失败不会丢失。从 CLI 同步时也能还原这些历史消息；尚未传入上下文的分叉需要先成功发送一条消息再同步。原对话保留。

## 开发配置与多窗口

开发时，`AGENT_DESKTOP_USER_DATA` 把 userData 指到另一个目录。

可以同时开多个窗口。每个进程把自己的 Chromium 缓存（GPU 缓存、HTTP 缓存、localStorage）写到各自用户配置下的私有 `userData/session-cache/<pid>` 目录，这样进程之间不会锁同一批文件。项目和对话仍然共用上面的 `data/`。两个窗口写同一份数据时，后写入的为准。退出时进程会删掉自己的缓存目录。崩溃留下的目录在下次启动时清掉。
