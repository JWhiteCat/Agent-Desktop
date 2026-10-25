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

## macOS 启动与打包

支持 macOS 13 Ventura 或更新版本，分别构建 Apple Silicon（arm64）和 Intel（x64）应用。安装包包含 Electron 和内置 Codex/Claude，无需另装 Node.js；源码开发和打包需要上述 Node.js 环境，Git 功能还需要本机 `git`。

在已登录桌面的终端中运行，兼容系统自带 Bash 3.2：

```bash
bash start-dev.sh
bash start-preview.sh
# 或使用平台专用入口：
npm run dev:mac
npm run preview:mac
```

入口按系统自动分流，macOS 不检查 Linux 的 DISPLAY/Wayland 环境。首次启动补齐依赖和 Electron，后续可离线复用；传入 `--install` 刷新锁文件依赖。预览会先构建，构建失败不会打开旧版本。支持从其他工作目录启动及含空格路径。

请在对应架构的 Mac 上安装依赖并打包，不要从 Windows/Linux 复制 node_modules，也不要在单一架构的依赖目录内交叉打包：

```bash
npm ci --include=dev --include=optional
node node_modules/electron/install.js
npm run dist:mac          # 当前架构的 DMG
npm run dist:mac:arm64    # 在 Apple Silicon 上构建
npm run dist:mac:x64      # 在 Intel 上构建
npm run dist:mac:dir      # 当前架构的未封装应用
# 用实际版本号和本机架构替换示例：
npm run verify:mac -- release/agent-desktop-0.1.0-mac-arm64.dmg arm64
```

产物为 `agent-desktop-<version>-mac-<arch>.dmg`，命令均不发布。应用使用无需 Apple Developer 账号的 ad-hoc 临时签名，未使用 Developer ID、未公证。按当前 electron-builder v26 接口设置 `identity: "-"`、`hardenedRuntime: false`、`notarize: false`，并提供 Terminal 自动化用途说明。[签名配置参考](https://www.electron.build/v26/docs/mac/)

下载对应芯片的 DMG，拖入 Applications 并退出磁盘镜像，再从 Finder 启动应用。首次打开被 Gatekeeper 拦截时，先确认下载来源和 SHA256，然后到「系统设置 → 隐私与安全性」找到该应用并选择「仍要打开」。这只是当前应用的例外，不需要全局关闭 Gatekeeper。[Apple 首次打开说明](https://support.apple.com/zh-cn/102445)

顶部命令首次运行可能请求控制 Terminal，请允许；拒绝后可在「隐私与安全性 → 自动化」重新允许 Agent Desktop 控制 Terminal，开发模式对应的名称可能是 Electron。没有安装 `code` / `cursor` 命令时，编辑器按钮会尝试打开已安装的 VS Code / Cursor 应用。应用关闭窗口后继续运行，点击 Dock 可重开窗口，点击完成通知会打开对应会话；⌘Q 退出时保留任务确认。

`verify:mac` 在临时目录挂载并复制 DMG 内的应用，检查签名、三种可执行文件的架构、内置 CLI 版本、两个 ACP initialize 握手、runner 参数，以及真实窗口、preload IPC 和模拟 CLI 检测；不调用模型或读取用户登录，检查后清理进程和挂载。该检查需要 Mac 图形会话。

macOS 的 `/var` 是 `/private/var` 的目录别名。离线测试使用真实临时目录，避免把两种路径拼写当成不同目录；单独的目录别名回归覆盖 worktree 子目录、尚不存在的共享子路径及快照显示路径，确保测试环境统一不会掩盖应用中的别名问题。

验证记录：本次修改在 Windows 环境实施；macOS 原生打包及自动冒烟须由新增 CI 执行，此处不表示 CI 已通过。Apple Silicon 与 Intel 的以下人工验收均待完成：从浏览器下载后的首次打开、Terminal 允许/拒绝、编辑器打开、附件和剪贴板、Git 差异、三种真实 CLI 登录/发送/停止、Dock/通知和退出行为。最低系统 macOS 13 也需单独实机验收。

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
- **Linux ARM64 暂未作为发行目标。** Electron、Codex/Claude 的 optional 原生二进制及适配器都必须匹配目标架构；Linux 发行命令仍限定为 x64。macOS ARM64 使用上面的独立原生构建流程。

## Windows 便携包

请在 **Windows x64** 上打包。内置代理的原生二进制按执行打包的机器安装，在其他架构上打包不会得到匹配的便携程序。

双击项目根目录的 `build-portable.bat`。脚本会检查 Node.js 22.12 或更高版本，安装依赖和 Electron 运行时，然后打包。在项目目录的终端中也可以执行：

```bash
npm ci --include=dev --include=optional
npm run dist:win:portable
```

产物是 `release/agent-desktop-<version>-win-x64-portable.exe`。它不需要安装：启动时会把应用解压到临时目录再运行。设置和历史仍保存在 `%APPDATA%\Agent Desktop`，与 NSIS 安装版相同。Windows 上的 `npm run dist` 仍然构建 NSIS 安装包。

首次打包可能下载 Electron，以及 electron-builder 使用的 NSIS 和 7-Zip 工具。该程序未签名，Windows SmartScreen 第一次运行时可能会要求确认。

## GitHub 发布

把本次变更写在 [`CHANGELOG.md`](../CHANGELOG.md) 的 `## [Unreleased]` 下面。工作区里其他文件必须已经提交。`master` 不能落后于 `origin/master`，也不能和它分叉。然后用一条命令发布 `0.2.0`：

```bat
release.bat 0.2.0
```

```bash
npm run release -- 0.2.0
```

脚本会把这些说明移到 `## [0.2.0] - YYYY-MM-DD`，并在 `master` 上提交。接着创建 `release/0.2.0`，只在那条分支上把 `package.json` 和 `package-lock.json` 的版本号改为 `0.2.0`，然后推送 `master`、release 分支和附注 tag `v0.2.0`。版本号提交留在 release 分支上。

[`.github/workflows/release.yml`](../.github/workflows/release.yml) 会在 `v*` tag 和 `release/*` 分支的推送上运行。推送分支时，只检查分支名是否为规范的稳定版 `MAJOR.MINOR.PATCH`（不允许前导零、预发布/构建后缀，各段不超过 JavaScript 安全整数上限），并且与 `package.json` 一致。推送 tag 时还会确认 `release/X.Y.Z` 已存在且指向该 tag 的提交。`v1` 或 `release/next` 等名称通不过检查。只有 tag 会继续构建 Windows x64 便携包/NSIS、Linux x64 AppImage/Debian，以及 macOS arm64/x64 DMG。macOS 矩阵分别在 `macos-15`（arm64）和 `macos-15-intel`（x64）安装本机 optional 依赖，运行类型检查、离线测试、打包和 `verify:mac`。Release 说明来自对应版本的 Changelog。electron-builder 使用 `--publish never`，再由 `gh` 上传文件。

工作流在构建前拒绝缺失或为空的版本说明，显式安装并检查 Electron，确认六个安装包齐全，并生成 `SHA256SUMS.txt`。Windows 附件名为 `agent-desktop-<version>-win-x64-portable.exe` 和 `agent-desktop-<version>-win-x64-setup.exe`；macOS 为 `agent-desktop-<version>-mac-arm64.dmg` 和 `agent-desktop-<version>-mac-x64.dmg`。任一平台失败、缺包或空包都会阻止公开发布。全部附件上传前 Release 保持草稿，上传完成后才公开为正式版。只有不低于任何已发布稳定版的版本才设为 Latest，补发旧版明确保持 Latest 不变。重试可以继续草稿，不覆盖已经公开的版本。

Linux 作业在打包前还会运行发版策略和隔离伪 `gh` 发布脚本回归。各平台构建仍可并行，最终 publish 作业使用仓库级共享锁。`queue: max` 最多保留 100 个等待发布的作业，避免替换先前的等待者；`cancel-in-progress: false` 不取消正在发布的作业。持锁期间、正式发布前查询所有分页的已发布版本；API 或元数据错误会保留草稿。新版本和旧版补发都必须包含此工作流修复；旧工作流重跑以及网页/API 手动发布不参与该锁，不应同时进行。等待队列满时新增作业会被拒绝，需另行重试。

工作流成功后，不要再向 `release/X.Y.Z` 提交，也不要移动该 tag。脚本若在推送中途失败，先检查已存在的分支和 tag，再补齐剩余推送；脚本不会删除或回滚已经完成的操作。准备完成后，脚本会返回 `master`。

若终端从桌面启动器继承了 `NODE_ENV=production`，测试前请设为 `NODE_ENV=test`（PowerShell：`$env:NODE_ENV = 'test'`）。组件测试需要 React 的开发版 JSX 运行时。

## 开发命令与测试

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 打开开发窗口 |
| `npm run dev:linux` / `npm run preview:linux` | 带依赖和运行时检查的 Linux 启动 |
| `npm run dev:mac` / `npm run preview:mac` | 带依赖和运行时检查的 macOS 启动 |
| `npm test` | 离线单元测试，不调用模型 |
| `npm run test:live` | 用 Composer 2.5 Fast 检查极短文字及附件输入 |
| `npm run typecheck` | 检查应用与全部测试的类型，不执行测试 |
| `npm run typecheck:tests` | 单独检查测试 fixture、mock 与断言的类型 |
| `npm run build` | 编译到 `out/` |
| `npm run preview` | 预览编译结果 |
| `npm run dist` | 打包安装包到 `release/` |
| `npm run dist:win:portable` | 构建 Windows x64 免安装便携程序，不会发布 |
| `npm run dist:linux` | 构建 Linux x64 AppImage 和 Debian 安装包，不会发布 |
| `npm run dist:linux:dir` | 构建 Linux x64 未封装应用 |
| `npm run dist:mac` / `npm run dist:mac:dir` | 构建本机架构的 DMG / 未封装应用，不发布 |
| `npm run dist:mac:arm64` / `npm run dist:mac:x64` | 在对应架构的 Mac 上原生打包 |
| `npm run verify:mac -- DMG ARCH` | 在与 ARCH 匹配的 Mac 上离线验证安装包 |
| `release.bat 0.2.0` / `npm run release -- 0.2.0` | 用 Unreleased 中的变更说明发布该版本 |
| `npm run icons` | 由 `resources/icons/icon.svg` 生成 PNG、Windows `icon.ico` 和 macOS `icon.icns` |

应用图标的源文件是 `resources/icons/icon.svg`；备选方案位于 `docs/icons/`，对比图见 `docs/icons/preview.png`。换用其他方案可运行 `npm run icons -- docs/icons/agent-hub.svg`（复制为 `icon.svg` 后重新生成），修改备选 SVG 后用 `npm run icons -- --preview` 刷新对比图。脚本使用项目自带的 Electron 渲染，无需额外依赖。

`npm test` 不访问 Cursor CLI、Codex 或 Claude。`npm run test:live` 在临时目录中用 Ask 模式调用 `composer-2.5[fast=true]`：文字检查只要求 `Reply with exactly ok`，附件检查验证原生图片识别及工作目录之外的受管理原文件读取。文字检查优先使用 `CURSOR_API_KEY`，未设置时使用 CLI 保存的登录；附件检查要求 `CURSOR_API_KEY`。只运行附件检查可用 `npm run test:live -- test/live/attachment-smoke.test.ts`。

可用 `npm test -- test/claude.test.ts test/turn-usage.test.ts` 定向检查。这些测试将 Claude 检测与用户主目录隔离，覆盖含空格路径下的用量 preload 加载，并清理临时夹具。仅适用于 Windows 的检查在其他平台会明确标为跳过。

工作文件快照在桌面进程中使用 Electron 的 `original-fs`，在 Node 测试中使用普通 Node 文件接口。工作区内的 `.asar` 归档按物理文件及原有大小上限处理；扫描不得将其作为虚拟目录打开并缓存句柄，以免阻止游戏或应用更新。运行 `npm test -- test/turn-files.test.ts test/turn-files-electron.test.ts` 验证快照功能。Windows Electron 回归测试覆盖普通目录、Git 仓库及含子仓库的项目容器，确认扫描进程仍存活时归档也能替换。构建这项主进程修复后，需重启桌面客户端，释放旧实例缓存的归档句柄。

顶部命令的测试位于 `test/toolbar-terminal.test.ts` 和 `test/toolbar-runner.test.ts`：在临时目录构建独立 runner，验证参数原文、Windows `.cmd` 启动器、启动失败、输出与退出码。Windows 下设置 `AGENT_DESKTOP_CONSOLE_SMOKE=1` 可额外开启真实新终端检查，读取控制台缓冲区并发送 Enter 正常关闭。将 `AGENT_DESKTOP_CONSOLE_EXECUTABLE` 和 `AGENT_DESKTOP_CONSOLE_RUNNER` 分别设为打包后的程序和 `resources/toolbar-runner.cjs` 路径，可对未封装构建重复该检查。普通测试不会弹出终端窗口。

打包目标：Windows NSIS、Windows x64 免安装便携程序、macOS DMG、Linux x64 AppImage / Debian（`.deb`）。

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
  grokbot-cache.ts    磁盘上有上限的 Grok Bot 最近消息、读取位置和会话 id 缓存
  ipc/                按项目、对话、设置、CLI、用量和本机操作拆开的 IPC
src/preload           渲染进程可以调用的 API
src/renderer/src      React 界面
  store.ts            状态和操作的公共入口
  store/              状态内核、持久化、模型、命令、对话和初始化
  components/Items.tsx 消息分派和界面状态适配
  components/items/   Markdown、消息、工具、计划、问答和结果展示
  components/settings 设置各页
  lib/model-prefs.ts  决定选中哪个模型，不放在界面状态里
  lib/find.ts         对话内查找：文字匹配、用于高亮范围的文本索引和查找快捷键
  lib/panel-layout.ts 可调面板宽度，写入 CSS 变量，保存在设置里（远程页面保存在浏览器）
src/shared            主进程和界面共用的类型、Cursor / OpenAI / Anthropic 价目、用量、额度、斜杠命令，以及 Plan 提问块
scripts               公网入口（public-gateway.py）、服务器安装脚本（setup-public-server.sh）、本机一键配置（setup-public-server.mjs）
test                  离线单元测试，以及在线冒烟测试
```

### 模块边界

`SessionManager` 负责进程生命周期和轮次调度。`main/session/` 中的模块仅接收所需依赖：模型和模式设置使用 ACP 请求接口，问答使用轮次状态与消息回调，用量刷新使用精简的存储接口，均不反向依赖会话管理器。开始新轮次、删除对话和退出时，通过用量模块取消账号用量重试。

前端保留 `store.ts` 作为公共入口。`store/` 内的功能模块直接依赖状态内核和具体辅助模块，不反向导入公共入口。初始化模块将 API 事件接入对应操作。历史加载与加载期间的流式消息缓冲放在同一个对话模块中，保持事件顺序。

`components/Items.tsx` 负责消息与状态管理的连接。`components/items/` 中的展示组件通过参数或共享的轮次 context 获取模型目录和问答操作。共享 context、基础控件位于消息视图下层，避免 Markdown、问答与计划之间循环依赖。现有 `store.ts`、`Items.tsx` 和 `main/sessions.ts` 的导入方式继续可用。
