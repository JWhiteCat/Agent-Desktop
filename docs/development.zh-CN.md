# 开发指南

[文档目录](README.zh-CN.md) · [项目首页](../README.zh-CN.md) · [English](development.md)

窗口是 Electron，界面是 React，两侧都是 TypeScript，用 electron-vite 构建。

```bash
npm ci --include=dev --include=optional
npm run dev
```

Windows 一键启动（需先安装 Node.js 22.12 或更高版本，包含 npm）：

- 双击 `start-dev.bat`：自动安装依赖、补齐 Electron 运行时，再启动开发模式（支持热更新）。
- 双击 `start-preview.bat`：自动安装依赖、补齐 Electron 运行时，构建后启动生产预览。

首次运行需要联网下载依赖和 Electron；之后会复用已安装的依赖与运行时。脚本可从任意工作目录启动，失败时会保留窗口显示错误。Electron 下载失败时，检查网络、代理或 `ELECTRON_MIRROR` 环境变量后重试。

## Linux 启动与打包

Linux 安装包面向 **x86-64 / amd64**、基于 glibc 的桌面发行版，需要已登录的 X11 或 Wayland 图形会话。请使用普通桌面用户运行应用。无头服务器、普通 SSH 会话和 Alpine/musl 不属于支持的桌面环境。应用使用 Linux 原生标题栏；桌面通知、文件及链接打开功能依赖相应桌面服务。

先按 [CLI 安装与配置](cli-setup.zh-CN.md#环境要求) 安装 Node.js。精简的 **Ubuntu 24.04** 桌面可安装以下主要运行库和集成工具：

```bash
sudo apt update
sudo apt install git openssh-client xdg-utils libgtk-3-0t64 libnss3 libgbm1 \
  libasound2t64 libsecret-1-0 libnotify4 libxss1 libxtst6
```

Ubuntu 22.04 或 Debian 12 请把两个 `t64` 包名替换为 `libgtk-3-0`、`libasound2`；其他发行版的包名可能不同。`openssh-client` 提供公网远程控制所需的 `ssh` 和 `ssh-keygen`；项目操作需要 `git`。

Linux 一键启动脚本也位于项目根目录，与 Windows 的 `.bat` 文件对应：

- `start-dev.sh`：检查并补齐依赖和 Electron，然后启动开发模式（支持热更新）。
- `start-preview.sh`：检查并补齐依赖和 Electron，构建一次后启动生产预览。

在项目目录的终端中执行：

```bash
./start-dev.sh
./start-preview.sh
```

支持运行可执行脚本的文件管理器中，可选择「在终端中运行」。部分文件管理器会将 `.sh` 作为文本打开，此时使用上面的终端命令。如果下载或解压后没有执行权限，可用 `bash start-dev.sh` / `bash start-preview.sh`，或先执行一次 `chmod +x start-dev.sh start-preview.sh`。添加 `--help` 查看用法，添加 `--install` 刷新依赖。

原有 npm 命令仍然可用：

```bash
npm run dev:linux       # 检查依赖、补齐 Electron，启动热更新开发模式
npm run preview:linux   # 检查依赖、构建并打开生产预览
```

也可以从任意工作目录执行脚本，支持路径中的空格：

```bash
bash "/path/to/Agent-Desktop/start-dev.sh"
bash "/path/to/Agent-Desktop/start-preview.sh"
```

首次运行会按锁文件下载缺少的依赖，并下载 Electron 运行时。后续启动会复用完整的本地依赖与运行时，无需再次安装或联网。拉取依赖或锁文件变更后，执行 `npm run dev:linux -- --install`（或 `npm ci --include=dev --include=optional`）刷新依赖。不要省略 optional 依赖，内置代理的原生二进制按平台分发。下载失败会在终端保留错误；检查网络、代理或 `ELECTRON_MIRROR` 后重试。

在 **Linux x64** 上安装本机依赖后打包：

```bash
npm ci --include=dev --include=optional
npm run dist:linux       # 在 release/ 生成 AppImage 和 .deb，不会发布
npm run dist:linux:dir   # 在 release/linux-unpacked/ 生成未封装应用
```

首次打包可能下载 Electron 和 electron-builder 工具。安装包包含应用图标、Development 分类的桌面入口，以及相互匹配的桌面/窗口标识。在 Debian 系桌面上安装 `.deb` 后可从应用菜单启动，也可以直接运行 AppImage（存在多个版本时，请把通配符替换为具体文件名）：

```bash
sudo apt install ./release/agent-desktop-*-linux-*.deb
# 或运行便携版 AppImage：
chmod +x release/agent-desktop-*-linux-x86_64.AppImage
./release/agent-desktop-*-linux-x86_64.AppImage
```

**AppImage 与沙箱排障：**

- 当前锁定的 electron-builder 使用 FUSE 2 AppImage 运行时。若提示缺少 `libfuse.so.2`，Ubuntu 24.04 安装 `libfuse2t64`，Ubuntu 22.04 / Debian 12 安装 `libfuse2`。安装兼容库即可，不要替换系统的 FUSE 3。无法使用 FUSE 时，可执行 `./release/agent-desktop-*-linux-x86_64.AppImage --appimage-extract-and-run`，通过解压启动而不挂载镜像。详见 [AppImage FUSE 指南](https://docs.appimage.org/user-guide/troubleshooting/fuse.html)。
- FUSE 与 Chromium 沙箱是两个独立条件。随包提供的 AppImage 启动器保留 Chromium 沙箱，不会在用户命名空间不可用时悄悄关闭它。解压也不能解决沙箱错误。若系统限制用户命名空间或有 AppArmor 策略，优先通过系统包管理器安装 `.deb`，或请管理员按发行版支持的方式配置针对该应用的策略。不要用 `sudo` 运行应用、全局关闭 AppArmor 或添加关闭沙箱的启动参数。详见 [Electron 沙箱说明](https://www.electronjs.org/docs/latest/tutorial/sandbox)。
- 若提示缺少共享库，用发行版的包管理器安装对应运行库。没有 `DISPLAY` 和 `WAYLAND_DISPLAY` 的终端无法打开桌面窗口，请在图形会话内启动。
- **ARM64 暂未作为发行目标。** 仅修改 electron-builder 架构参数不够，Electron、Codex/Claude 的 optional 原生二进制及适配器都必须匹配目标架构。ARM64 原生启动及打包仍需单独验证，提供的发行命令有意限定为 x64。

## 开发命令与测试

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 打开开发窗口 |
| `npm run dev:linux` / `npm run preview:linux` | 带依赖和运行时检查的 Linux 启动 |
| `npm test` | 离线单元测试，不调用模型 |
| `npm run test:live` | 用 Composer 2.5 Fast 检查极短文字及附件输入 |
| `npm run typecheck` | 检查应用与全部测试的类型，不执行测试 |
| `npm run typecheck:tests` | 单独检查测试 fixture、mock 与断言的类型 |
| `npm run build` | 编译到 `out/` |
| `npm run preview` | 预览编译结果 |
| `npm run dist` | 打包安装包到 `release/` |
| `npm run dist:linux` | 构建 Linux x64 AppImage 和 Debian 安装包，不会发布 |
| `npm run dist:linux:dir` | 构建 Linux x64 未封装应用 |

`npm test` 不访问 Cursor CLI、Codex 或 Claude。`npm run test:live` 在临时目录中用 Ask 模式调用 `composer-2.5[fast=true]`：文字检查只要求 `Reply with exactly ok`，附件检查验证原生图片识别及工作目录之外的受管理原文件读取。文字检查优先使用 `CURSOR_API_KEY`，未设置时使用 CLI 保存的登录；附件检查要求 `CURSOR_API_KEY`。只运行附件检查可用 `npm run test:live -- test/live/attachment-smoke.test.ts`。

可用 `npm test -- test/claude.test.ts test/turn-usage.test.ts` 定向检查。这些测试将 Claude 检测与用户主目录隔离，覆盖含空格路径下的用量 preload 加载，并清理临时夹具。仅适用于 Windows 的检查在其他平台会明确标为跳过。

打包目标：Windows NSIS、macOS DMG、Linux x64 AppImage / Debian（`.deb`）。

`npm test -- test/linux-launcher.test.ts test/linux-packaging.test.ts` 检查 Linux 启动、重复/离线启动、错误处理、打包元数据及图标、桌面标识和 AppImage 启动器，不下载安装包或启动代理。每个目标发行版仍需在真实图形会话内进行冒烟测试。

按 `F12` 打开开发者工具。离开本应用的链接会用系统浏览器打开。

## 本地化

翻译目录位于 `src/shared/locales/`，中文源文案作为回退，英文词条按核心、主界面、设置和消息展示拆分。组件使用 renderer `lib/i18n.ts` 的 `useT()`，其他模块使用 `@shared/i18n` 的 `t()`；静态菜单在渲染时翻译，动态值使用 `{count}` 等具名占位符。测试覆盖词条参数、语言回退、设置持久化及中英文展示，并检查会话内容不被翻译。

## 目录

```
src/main              Electron 主进程
  index.ts            窗口、IPC、通知和退出
  sessions.ts         对话调度、ACP 进程生命周期和流式轮次
  reducer.ts          流式 ACP 更新，并记下 Claude 用量更新上的 API 模型 id
  session/provider.ts CLI 启动、认证、会话选项和 Plan 提示词
  session/requests.ts 通过轮次接口处理 ACP 问答和权限请求
  session/usage.ts    延迟用量写回及可取消的账号用量重试
  cli.ts              查找并启动 Cursor CLI
  git.ts              为 Codex 和 Claude 对话创建和移除 worktree
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
  grokbot.ts          从 Grok Bot 桌面端读取 Bot 列表和缓存的对话记录，以及 /v0/grokbot 会话 API 客户端
  grokbot-files.ts    按 SHA-256 查找 Grok Bot 缓存的文件，通过 grokbot-file:// 协议提供
  ipc/                按项目、对话、设置、CLI、用量和本机操作拆开的 IPC
src/preload           渲染进程可以调用的 API
src/renderer/src      React 界面
  store.ts            状态和操作的公共入口
  store/              状态内核、持久化、模型、命令、对话和初始化
  components/Items.tsx 消息分派和界面状态适配
  components/items/   Markdown、消息、工具、计划、问答和结果展示
  components/settings 设置各页
  lib/model-prefs.ts  决定选中哪个模型，不放在界面状态里
src/shared            主进程和界面共用的类型、Cursor / OpenAI / Anthropic 价目、用量、额度、斜杠命令，以及 Plan 提问块
scripts               公网入口（public-gateway.py）、服务器安装脚本（setup-public-server.sh）、本机一键配置（setup-public-server.mjs）
test                  离线单元测试，以及在线冒烟测试
```

### 模块边界

`SessionManager` 负责进程生命周期和轮次调度。`main/session/` 中的模块仅接收所需依赖：模型和模式设置使用 ACP 请求接口，问答使用轮次状态与消息回调，用量刷新使用精简的存储接口，均不反向依赖会话管理器。开始新轮次、删除对话和退出时，通过用量模块取消账号用量重试。

前端保留 `store.ts` 作为公共入口。`store/` 内的功能模块直接依赖状态内核和具体辅助模块，不反向导入公共入口。初始化模块将 API 事件接入对应操作。历史加载与加载期间的流式消息缓冲放在同一个对话模块中，保持事件顺序。

`components/Items.tsx` 负责消息与状态管理的连接。`components/items/` 中的展示组件通过参数或共享的轮次 context 获取模型目录和问答操作。共享 context、基础控件位于消息视图下层，避免 Markdown、问答与计划之间循环依赖。现有 `store.ts`、`Items.tsx` 和 `main/sessions.ts` 的导入方式继续可用。
