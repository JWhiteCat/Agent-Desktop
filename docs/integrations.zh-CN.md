# MCP 与 Skill

[文档目录](README.zh-CN.md) · [项目首页](../README.zh-CN.md) · [English](integrations.md)

在设置里添加 MCP 服务器。启用后，新建和续接的会话会通过 ACP 的 `mcpServers` 传入（stdio、HTTP 或 SSE）。这份列表写在本应用的 `state.json` 里，不会改写 `~/.cursor/mcp.json`。

启用的 Skill 会写成 `~/.cursor/skills/<name>/SKILL.md`，同时写到 Codex 的路径 `~/.agents/skills/<name>/SKILL.md` 和 `~/.codex/skills/<name>/SKILL.md`，以及 `~/.claude/skills/<name>/SKILL.md`。名称只能包含小写字母、数字和连字符，并且需要一段描述。CLI 凭这段描述决定是否使用该 Skill。停用或删除时，只移除本应用创建的目录。同名但不是本应用创建的目录会留在原地，保存时会提示无法覆盖。

## 本地所有

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
