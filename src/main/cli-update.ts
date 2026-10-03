import { t as translate } from '@shared/i18n'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { killTree, resolveCli, stripAnsi } from './cli'
import { resolveCodex } from './codex'
import { resolveClaude } from './claude'
import { cliEnvironment, cliSearchDirectories, spawnCliProcess } from './cli-runtime'

const isWin = process.platform === 'win32'
const UPDATE_TIMEOUT = 10 * 60_000
const OUTPUT_LIMIT = 64 * 1024

export async function updateCursor(agentPath: string): Promise<string> {
  const cli = resolveCli(agentPath)
  if (!cli) throw new Error(translate('未找到 Cursor CLI，请先检查 CLI 路径。'))
  return runUpdate('Cursor CLI', cli.command, [...cli.prefixArgs, 'update'], { CURSOR_INVOKED_AS: 'agent' })
}

export async function updateCodex(codexPath: string): Promise<string> {
  const cli = resolveCodex(codexPath)
  if (!cli) throw new Error(translate('未找到 Codex CLI，请先检查 CLI 路径。'))
  requireExternal('Codex', cli.codexPath, cli.acpEntry)
  const executable = cli.codexPath!
  const npmPrefix = findNpmPrefix(executable, '@openai/codex', 'codex')
  if (npmPrefix) return updateNpm('Codex', '@openai/codex', npmPrefix)
  const brew = findHomebrew(executable, ['codex'])
  if (brew) return runUpdate('Codex', brew.command, brew.args)
  throw new Error(translate('无法识别此 Codex CLI 的安装方式。请使用原安装工具更新，或在 CLI 路径中选择 npm / Homebrew 安装的 Codex。'))
}

export async function updateClaude(claudePath: string): Promise<string> {
  const cli = resolveClaude(claudePath)
  if (!cli) throw new Error(translate('未找到 Claude Code，请先检查 CLI 路径。'))
  requireExternal('Claude Code', cli.claudePath, cli.acpEntry)
  const executable = cli.claudePath!
  const npmPrefix = findNpmPrefix(executable, '@anthropic-ai/claude-code', 'claude')
  if (npmPrefix) return updateNpm('Claude Code', '@anthropic-ai/claude-code', npmPrefix)
  const brew = findHomebrew(executable, ['claude-code', 'claude-code@latest'])
  if (brew) return runUpdate('Claude Code', brew.command, brew.args)
  const real = realPath(executable)
  if (/[/\\]Microsoft[/\\]WinGet[/\\]/i.test(real)) {
    throw new Error(translate('此 Claude Code 由 WinGet 管理，请运行 winget upgrade Anthropic.ClaudeCode 更新。'))
  }
  if (!isWin && ['/usr/bin/claude', '/bin/claude'].includes(real)) {
    throw new Error(translate('此 Claude Code 由系统软件包管理器安装，请使用原安装工具更新。'))
  }
  if (isWin && !/\.exe$/i.test(executable)) {
    throw new Error(translate('无法识别此 Claude Code 启动脚本的安装方式，请选择原生可执行文件或 npm 安装目录。'))
  }
  return runUpdate('Claude Code', executable, ['update'])
}

function requireExternal(label: string, executable: string | undefined, acpEntry: string): void {
  // Explicit custom paths must not turn the app's bundled fallback into an update target.
  const modules = path.resolve(acpEntry, '..', '..', '..', '..')
  if (!executable || isWithin(modules, executable) || /[/\\]app\.asar(?:\.unpacked)?[/\\]/i.test(executable)) {
    throw new Error(translate('内置 {label} 随 Agent Desktop 更新。请安装独立 CLI 并在设置中选择其路径后再更新。', { label }))
  }
}

function realPath(file: string): string {
  try { return fs.realpathSync(file) } catch { return path.resolve(file) }
}

function isWithin(directory: string, file: string): boolean {
  const relative = path.relative(realPath(directory), realPath(file))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function packageMatches(directory: string, packageName: string): boolean {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name === packageName
  } catch { return false }
}

/** Follow the selected binary, including native packages nested under or beside the npm launcher. */
function findNpmPrefix(executable: string, packageName: string, launcher: string): string | undefined {
  const real = realPath(executable)
  const candidates: string[] = []
  // Windows shims are ordinary files; only recognize the package's own launcher names.
  const isLauncher = [launcher, `${launcher}.cmd`, `${launcher}.ps1`].includes(path.basename(real).toLowerCase())
  if (isLauncher) {
    candidates.push(path.join(path.dirname(real), 'node_modules'))
  }
  for (let dir = path.dirname(real); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (path.basename(dir) === 'node_modules') candidates.push(dir)
  }
  for (const modules of candidates) {
    const mainPackage = path.join(modules, packageName)
    if (!packageMatches(mainPackage, packageName)) continue
    const parent = path.dirname(modules)
    const platformPackage = path.join(modules, `${packageName}-${process.platform}-${process.arch}`)
    if (!isWithin(mainPackage, real) && !isWithin(platformPackage, real) && !(isLauncher && path.dirname(real) === parent)) continue
    // npm global layouts: <prefix>/node_modules on Windows; <prefix>/lib/node_modules on POSIX.
    if (isWin) return parent
    if (path.basename(parent) === 'lib') return path.dirname(parent)
  }
  return undefined
}

function findNpmScript(prefix: string): string | undefined {
  const directories = [
    // The selected CLI may belong to a Node installation absent from a desktop's PATH.
    isWin ? prefix : path.join(prefix, 'bin'),
    ...cliSearchDirectories(),
    path.dirname(process.execPath)
  ]
  for (const dir of new Set(directories)) {
    const candidates = [
      path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      realPath(path.join(dir, 'npm'))
    ]
    const hit = candidates.find((file) => path.basename(file) === 'npm-cli.js' && fs.existsSync(file))
    if (hit) return hit
  }
  return undefined
}

function updateNpm(label: string, packageName: string, prefix: string): Promise<string> {
  const script = findNpmScript(prefix)
  if (!script) throw new Error(translate('未找到 npm，请安装 Node.js / npm 后重试。'))
  // Calling npm's JS entry avoids cmd.exe interpolation and also works in packaged Electron.
  return runUpdate(label, process.execPath, [script, 'install', '--global', '--prefix', prefix, `${packageName}@latest`], {}, isWin ? prefix : path.join(prefix, 'bin'))
}

function findHomebrew(executable: string, packages: string[]): { command: string; args: string[] } | undefined {
  if (isWin) return undefined
  const parts = realPath(executable).split(path.sep)
  for (const store of ['Caskroom', 'Cellar']) {
    const index = parts.indexOf(store)
    const name = parts[index + 1]
    if (index < 0 || !packages.includes(name)) continue
    const command = path.join(parts.slice(0, index).join(path.sep), 'bin', 'brew')
    if (fs.existsSync(command)) return { command, args: ['upgrade', ...(store === 'Caskroom' ? ['--cask'] : []), name] }
  }
  return undefined
}

function runUpdate(label: string, command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, executableDirectory = path.dirname(command)): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = cliEnvironment({ ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', FORCE_COLOR: '0', ...extraEnv }, executableDirectory)
    const child = spawnCliProcess(command, args, { cwd: os.homedir(), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false })
    let output = ''
    let finished = false
    let timedOut = false
    let terminationTimer: ReturnType<typeof setTimeout> | undefined
    const timeoutMessage = translate('{label} 更新超时，请检查网络后重试。', { label })
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-OUTPUT_LIMIT) }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const finish = (error?: string) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(terminationTimer)
      const details = stripAnsi(output).trim()
      if (error) reject(new Error([error, details].filter(Boolean).join('\n')))
      else resolve([translate('{label} 更新完成。', { label }), details].filter(Boolean).join('\n'))
    }
    const timer = setTimeout(() => {
      timedOut = true
      // Keep the IPC update guard held until termination is observed. A fallback prevents
      // a lost close event from leaving the Settings button disabled indefinitely.
      terminationTimer = setTimeout(() => finish(timeoutMessage), 5_000)
      killTree(child)
    }, UPDATE_TIMEOUT)
    child.once('error', (error) => finish(timedOut ? timeoutMessage : translate('{label} 更新失败：{error}', { label, error: error.message })))
    child.once('close', (code) => finish(timedOut ? timeoutMessage : code === 0 ? undefined : translate('{label} 更新失败（退出码 {code}）。', { label, code: code ?? translate('未知') })))
  })
}
