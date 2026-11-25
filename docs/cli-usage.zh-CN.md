# 命令行工具（`agent-desktop` / `agd`）

[文档目录](README.zh-CN.md) · [项目首页](../README.zh-CN.md) · [English](cli-usage.md)

Agent Desktop 内置了官方命令行工具 `agent-desktop` 及其短别名 `agd`，无需额外安装 Node.js 运行时。

## 安装命令到 PATH

1. 打开桌面端 **设置 → CLI**，找到 **本应用命令行工具（agent-desktop / agd）** 卡片。
2. 点击 **安装命令到 PATH**，重新打开终端即可使用 `agent-desktop` 或 `agd`。
   - **Windows**：自动将应用 `bin` 目录写入当前用户环境变量 `PATH`（无需管理员权限）。便携版移动目录后在设置里重新安装即可。
   - **macOS**：优先写入 `/usr/local/bin`（可写时），否则写入 `~/.local/bin`。
   - **Linux**：写入 `~/.local/bin`；AppImage 模式下自动生成指向当前 `.AppImage` 的包装脚本，移动 AppImage 路径后重新安装即可。
3. 如使用源码开发态，构建后也可直接运行：
   ```bash
   npm run build
   npm run cli -- status
   ```

## 双模式运行机制

- **Attached 模式（默认优先）**：当本机 Agent Desktop 桌面端正在运行时，CLI 会通过本机 IPC（Windows Named Pipe / macOS 与 Linux Unix Domain Socket，并附带 `0600` 权限随机令牌校验）直接控制桌面端进程。你在终端创建、发送、停止的会话都会实时同步显示在桌面界面中，同时复用已预热的底层 ACP 进程，避免 `state.json` 双写冲突。
- **Headless 模式（自动回退）**：当桌面端未运行时，CLI 自动在当前进程内无头加载应用数据目录并直接驱动底层 CLI（Cursor / Codex / Claude / Antigravity），共享相同的项目、设置、Skill 与历史记录。为防止多进程同时写入 `state.json`，Headless 模式会持有 `data/cli-headless.lock` 互斥锁。

可使用以下全局参数控制连接策略：

- `--attach-only`：仅连接运行中的桌面端，未运行时退出码 `4`。
- `--headless`：强制无头运行；若桌面端正在运行则退出码 `5`（防止数据冲突）。
- `--user-data <dir>`：覆盖数据目录（等价于环境变量 `AGENT_DESKTOP_USER_DATA`）。

## 常用命令

```bash
# 查看当前运行模式（attached / headless）、数据目录和各底层 CLI 状态
agd status
agd status --json

# 查看底层 CLI 与可用模型
agd cli list
agd cli models codex

# 管理项目
agd projects list
agd projects add .

# 查询与管理会话
agd threads list
agd threads list --project . --running
agd threads show <threadId> --tail 20
agd threads create --project . --cli codex --mode agent
agd threads fork <threadId>
agd threads sync <threadId>
agd threads delete <threadId>

# 发送任务并实时流式输出（支持管道输入）
agd run "修复登录页竞态问题" --cli codex --mode agent
git diff | agd run --mode ask "帮我审查这份改动"

# 续接已有会话、附带文件/截图、启用隔离 worktree
agd run "补充单元测试" --thread <threadId> --file ./error.png --worktree

# 异步投递任务并立即返回 threadId（需桌面端运行中）
agd run "生成变更日志" --detach --json
agd watch <threadId>
agd stop <threadId>

# 脚本消费结构化输出（json / jsonl）
agd run "列出所有 TODO" --mode ask --format jsonl
agd run "总结架构" --mode ask --json
```

## 交互式提问与脚本编排

当 Agent / Plan 模式发起阻塞提问时：

- **终端 TTY 环境**：默认进入交互式问答，直接按提示输入选项编号或自定义文本即可。
- **非交互脚本 / 管道环境**：默认 `--on-question fail`，以退出码 `3` 退出并输出 `questionId` 和选项列表，避免脚本永久阻塞；随后可通过以下命令继续回答或跳过：
  ```bash
  agd answer <threadId> <questionId> --answers '[{"questionId":"...","selectedOptionIds":["..."]}]'
  agd answer <threadId> <questionId> --skip
  ```

## 退出码

| 退出码 | 说明 |
| --- | --- |
| `0` | 执行成功 |
| `1` | 运行错误或 Agent 回合失败 |
| `2` | 命令参数错误 |
| `3` | Agent 发起提问且当前策略为 `--on-question fail` |
| `4` | 指定了 `--attach-only` 但桌面端未运行 |
| `5` | 存在数据并发冲突（桌面端运行中强行 `--headless` 或另一无头任务持有锁） |
| `130` | 被 `Ctrl+C`（SIGINT）中断 |
