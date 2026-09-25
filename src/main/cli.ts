import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ModelInfo } from '@shared/types'

export interface ResolvedCli {
  command: string
  prefixArgs: string[]
  display: string
}

const isWin = process.platform === 'win32'

/**
 * On Windows the CLI ships as `agent.cmd` -> PowerShell -> `node.exe index.js`.
 * Spawning the bundled node directly keeps prompt arguments (quotes, newlines, `&`, `|`) intact.
 */
function resolveWindowsInstall(installDir: string): ResolvedCli | undefined {
  const direct = path.join(installDir, 'index.js')
  const directNode = path.join(installDir, 'node.exe')
  if (fs.existsSync(direct) && fs.existsSync(directNode)) {
    return { command: directNode, prefixArgs: [direct], display: direct }
  }
  const versionsDir = path.join(installDir, 'versions')
  if (!fs.existsSync(versionsDir)) return undefined
  const versions = fs
    .readdirSync(versionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}\.\d{1,2}\.\d{1,2}/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const v of versions) {
    const node = path.join(versionsDir, v, 'node.exe')
    const index = path.join(versionsDir, v, 'index.js')
    if (fs.existsSync(node) && fs.existsSync(index)) {
      return { command: node, prefixArgs: [index], display: `${installDir} (${v})` }
    }
  }
  return undefined
}

function whichSync(name: string): string | undefined {
  const r = spawnSync(isWin ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) return undefined
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
}

export function resolveCli(customPath: string): ResolvedCli | undefined {
  const custom = customPath.trim()
  if (custom) {
    if (isWin) {
      const stat = fs.existsSync(custom) ? fs.statSync(custom) : undefined
      const dir = stat?.isDirectory() ? custom : path.dirname(custom)
      const win = resolveWindowsInstall(dir)
      if (win) return win
      if (/\.(cmd|bat|ps1)$/i.test(custom)) return undefined
    }
    return { command: custom, prefixArgs: [], display: custom }
  }

  if (isWin) {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    const win = resolveWindowsInstall(path.join(local, 'cursor-agent'))
    if (win) return win
    const found = whichSync('agent.cmd') ?? whichSync('cursor-agent.cmd')
    if (found) return resolveWindowsInstall(path.dirname(found))
    return undefined
  }

  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'agent'),
    path.join(os.homedir(), '.local', 'bin', 'cursor-agent'),
    '/usr/local/bin/agent',
    '/opt/homebrew/bin/agent'
  ]
  const hit = candidates.find((c) => fs.existsSync(c)) ?? whichSync('agent') ?? whichSync('cursor-agent')
  return hit ? { command: hit, prefixArgs: [], display: hit } : undefined
}

/** Settings value wins. Otherwise the process environment. */
export function resolveApiKey(configured: string | undefined): string {
  const fromSettings = configured?.trim() ?? ''
  if (fromSettings) return fromSettings
  return process.env.CURSOR_API_KEY?.trim() ?? ''
}

function cliEnv(apiKey?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CURSOR_INVOKED_AS: 'agent', NO_COLOR: '1', FORCE_COLOR: '0' }
  const key = apiKey?.trim()
  if (key) env.CURSOR_API_KEY = key
  if (!env.NODE_COMPILE_CACHE && isWin && env.LOCALAPPDATA) {
    env.NODE_COMPILE_CACHE = path.join(env.LOCALAPPDATA, 'cursor-compile-cache')
  }
  if (!isWin) {
    const extra = [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin']
    env.PATH = [...extra, env.PATH ?? ''].join(path.delimiter)
  }
  return env
}

export function spawnCli(
  cli: ResolvedCli,
  args: string[],
  cwd: string,
  stdin: 'ignore' | 'pipe' = 'ignore',
  apiKey?: string
): ChildProcess {
  const key = apiKey?.trim()
  return spawn(cli.command, [...cli.prefixArgs, ...(key ? ['--api-key', key] : []), ...args], {
    cwd,
    env: cliEnv(key),
    stdio: [stdin, 'pipe', 'pipe'],
    windowsHide: true
  })
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

export function runCliOnce(
  cli: ResolvedCli,
  args: string[],
  timeoutMs = 60_000,
  apiKey?: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnCli(cli, args, os.homedir(), 'ignore', apiKey)
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    const timer = setTimeout(() => killTree(child), timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) })
    })
  })
}

export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  if (isWin) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    child.kill('SIGTERM')
    setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000)
  }
}

export function parseModels(output: string): ModelInfo[] {
  const models: ModelInfo[] = []
  for (const raw of output.split(/\r?\n/)) {
    const m = raw.trim().match(/^([A-Za-z0-9][\w.\-[\]=,]*)\s+-\s+(.+)$/)
    if (!m) continue
    const label = m[2].replace(/\s*\((current|default)\)\s*/gi, ' ').replace(/[\u200b-\u200d]/g, '').trim()
    models.push({ id: m[1], label })
  }
  return models
}
