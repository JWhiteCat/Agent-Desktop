import { app } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { t } from '@shared/i18n'
import { cliEnvironment, cliSearchDirectories, isExecutableFile, normalizeCliPath } from './cli-runtime'
import type { ToolbarCommandPayload, ToolbarCommandStatus } from './toolbar-command-payload'

export interface TerminalLaunch {
  command: string
  args: string[]
}

/** Resolve executable names without invoking a shell, including Windows npm .cmd launchers. */
export function findTerminalExecutable(command: string, env = cliEnvironment()): string | undefined {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path')
  const pathExtKey = Object.keys(env).find((key) => key.toLowerCase() === 'pathext')
  const extensions = process.platform === 'win32' ? ((pathExtKey && env[pathExtKey]) || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  const candidates = (file: string) => [file, ...extensions.filter((ext) => ext && !file.toLowerCase().endsWith(ext.toLowerCase())).map((ext) => file + ext)]
  const directories = cliSearchDirectories({ ...env, PATH: pathKey ? env[pathKey] : '' })
  for (const candidate of path.isAbsolute(command) || /[/\\]/.test(command)
    ? candidates(command)
    : directories.flatMap((directory) => candidates(path.join(directory, command)))) {
    if (isExecutableFile(candidate)) return path.resolve(candidate)
  }
  return undefined
}

export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/** Only trusted executable/runner/payload paths enter launcher syntax; command arguments stay in JSON. */
export function terminalLaunch(
  platform: NodeJS.Platform,
  executable: string,
  runner: string,
  payload: string,
  find: (name: string) => string | undefined = findTerminalExecutable
): TerminalLaunch {
  if (platform === 'win32') {
    const data = Buffer.from(JSON.stringify({ executable, runner, payload })).toString('base64')
    const script = `$ErrorActionPreference = 'Stop'; try { $d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json; $env:ELECTRON_RUN_AS_NODE = '1'; $env:AGENT_DESKTOP_TOOLBAR_CONSOLE = '1'; $arguments = '"' + $d.runner + '" "' + $d.payload + '"'; $p = Start-Process -FilePath $d.executable -ArgumentList $arguments -NoNewWindow -Wait -PassThru; exit $p.ExitCode } catch { Write-Host $_; Read-Host 'Press Enter to close' }`
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    // libuv's detached Windows processes have no usable console. Let Windows create one explicitly.
    const bootstrap = `$p = Start-Process -FilePath '${powershell.replace(/'/g, "''")}' -ArgumentList '-NoLogo -NoProfile -EncodedCommand ${encoded}' -WindowStyle Normal -Wait -PassThru -ErrorAction Stop; exit $p.ExitCode`
    return { command: powershell, args: ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')] }
  }
  const args = ['ELECTRON_RUN_AS_NODE=1', executable, runner, payload]
  if (platform === 'darwin') {
    const command = `exec env ${args.map(quotePosix).join(' ')}`
    const appleString = JSON.stringify(command)
    return { command: '/usr/bin/osascript', args: ['-e', `tell application "Terminal"\nactivate\ndo script ${appleString}\nend tell`] }
  }
  for (const [name, prefix] of [
    ['x-terminal-emulator', ['-e']],
    ['gnome-terminal', ['--wait', '--']],
    ['konsole', ['--separate', '-e']],
    ['xterm', ['-e']]
  ] as const) {
    const command = find(name)
    if (command) return { command, args: [...prefix, '/usr/bin/env', ...args] }
  }
  throw new Error(t('未找到可用终端，请安装 x-terminal-emulator、GNOME Terminal、Konsole 或 xterm。'))
}

export async function waitForTerminalStatus(directory: string, timeout = 10_000, interval = 50): Promise<ToolbarCommandStatus> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await fs.promises.readFile(path.join(directory, 'status.json'), 'utf8')) as ToolbarCommandStatus
      if (value.kind === 'started' || (value.kind === 'error' && typeof value.message === 'string')) return value
    } catch { /* The runner has not acknowledged the launch yet. */ }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(t('终端启动确认超时；终端可能仍会稍后打开，请检查后再试。'))
}

export async function launchToolbarCommand(command: { program: string; args: string[]; cwd: string }): Promise<void> {
  if (!path.isAbsolute(command.cwd) || !fs.statSync(command.cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(t('工作目录不存在：{path}', { path: command.cwd }))
  }
  const env = cliEnvironment()
  const requested = normalizeCliPath(command.program)
  const program = findTerminalExecutable(/[/\\]/.test(requested) ? path.resolve(command.cwd, requested) : requested, env)
  if (!program) throw new Error(t('未找到程序：{program}', { program: command.program }))
  const runner = app.isPackaged ? path.join(process.resourcesPath, 'toolbar-runner.cjs') : path.join(__dirname, 'toolbar-runner.cjs')
  if (!fs.existsSync(runner)) throw new Error(t('终端启动程序缺失，请重新构建或安装应用。'))
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-toolbar-'))
  fs.chmodSync(directory, 0o700)
  const payloadFile = path.join(directory, 'payload.json')
  const payload: ToolbarCommandPayload = {
    ...command, program,
    messages: { finished: t('命令已结束，退出码'), failed: t('命令启动失败'), close: t('按 Enter 关闭终端。') }
  }
  fs.writeFileSync(payloadFile, JSON.stringify(payload), { mode: 0o600, flag: 'wx' })
  const cleanup = () => { try { fs.rmSync(directory, { recursive: true, force: true }) } catch { /* best effort private-directory cleanup */ } }
  let timedOut = false
  try {
    const launch = terminalLaunch(process.platform, process.execPath, runner, payloadFile)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, { cwd: command.cwd, env, detached: process.platform !== 'win32', windowsHide: process.platform === 'win32', stdio: 'ignore', shell: false })
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolve() })
    })
    let status: ToolbarCommandStatus
    try { status = await waitForTerminalStatus(directory) } catch (error) { timedOut = true; throw error }
    if (status.kind === 'error') throw new Error(t('命令启动失败：{message}', { message: status.message }))
  } finally {
    if (timedOut) {
      // A slow terminal may still start. Keep its payload briefly without ever retrying the command.
      setTimeout(cleanup, 10 * 60_000).unref()
    } else cleanup()
  }
}
