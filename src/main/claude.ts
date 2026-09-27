import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentMode, ModelInfo } from '@shared/types'
import { AcpConnection, MethodNotFound, permissionResult } from './acp'
import { killTree, type ResolvedCli } from './cli'

const isWin = process.platform === 'win32'

/** Config option ids advertised by `@agentclientprotocol/claude-agent-acp`. */
export const CLAUDE_MODEL_CONFIG_ID = 'model'
export const CLAUDE_EFFORT_CONFIG_ID = 'effort'

export interface ResolvedClaude {
  /** Set when a user-installed `claude` binary was found. A `.cmd` shim is not passed to the adapter. */
  claudePath?: string
  bundled: boolean
  display: string
  acpEntry: string
}

/** Agent edits files without asking. Full access skips command prompts. Ask stays on the default mode and is denied in the permission handler. Plan is Claude's plan mode. */
export function claudeModeId(mode: AgentMode, force: boolean): string {
  if (mode === 'plan') return 'plan'
  if (mode === 'ask') return 'default'
  if (force) return 'bypassPermissions'
  return 'acceptEdits'
}

/** Settings value, then ANTHROPIC_API_KEY. A key bills the API and overrides a Claude subscription. */
export function resolveClaudeApiKey(configured: string | undefined): string {
  const fromSettings = configured?.trim() ?? ''
  if (fromSettings) return fromSettings
  return process.env.ANTHROPIC_API_KEY?.trim() ?? ''
}

export function resolveClaudeAcpEntry(): string | undefined {
  const candidates: string[] = []
  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js')
    )
  }
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(dir, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js'))
    dir = path.dirname(dir)
  }
  const hit = candidates.find((file) => fs.existsSync(file))
  return hit ? preferUnpacked(hit) : undefined
}

export function resolveClaude(customPath: string): ResolvedClaude | undefined {
  const acpEntry = resolveClaudeAcpEntry()
  if (!acpEntry) return undefined
  const custom = customPath.trim()
  if (custom) {
    const user = findClaudeFile(custom)
    if (!user) return undefined
    return { claudePath: user, bundled: false, display: user, acpEntry }
  }
  const user = findClaudeOnPath()
  if (user) return { claudePath: user, bundled: false, display: user, acpEntry }
  return { claudePath: undefined, bundled: true, display: '内置 Claude', acpEntry }
}

export function spawnClaudeAcp(claude: ResolvedClaude, cwd: string, apiKey: string): ChildProcess {
  return spawn(process.execPath, [claude.acpEntry], {
    cwd,
    env: claudeEnv(claude, apiKey),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
}

export async function claudeVersion(claude: ResolvedClaude): Promise<string> {
  const bin = claudeBinary(claude)
  if (!bin) return ''
  const res = await runClaude(bin, ['--version'], 20_000)
  return (res.stdout || res.stderr).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
}

/** Empty when the installed CLI has no `auth status` command. That does not block a conversation. */
export async function claudeStatus(claude: ResolvedClaude): Promise<string> {
  const bin = claudeBinary(claude)
  if (!bin) return ''
  const res = await runClaude(bin, ['auth', 'status'], 20_000)
  if (res.code !== 0) return ''
  return (res.stdout + '\n' + res.stderr).trim()
}

/** Opens Claude subscription login through the adapter, which uses the same binary as a conversation. */
export function claudeLogin(claude: ResolvedClaude): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [claude.acpEntry, '--cli', 'auth', 'login', '--claudeai'], {
      env: nodeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let out = ''
    child.stdout?.on('data', (d) => (out += d.toString()))
    child.stderr?.on('data', (d) => (out += d.toString()))
    const timer = setTimeout(() => killTree(child), 5 * 60_000)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve(out + String(err))
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out.trim() || '登录流程已结束')
    })
  })
}

export interface ClaudeModelList {
  models: ModelInfo[]
  recommended?: string
}

/** Reads the model and effort selects from a short-lived ACP session, then deletes that session file. */
export async function listClaudeModels(customPath: string, claudeApiKey: string): Promise<ClaudeModelList> {
  const claude = resolveClaude(customPath)
  if (!claude) throw new Error('未找到 Claude Code')
  const apiKey = resolveClaudeApiKey(claudeApiKey)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-claude-'))
  const child = spawnClaudeAcp(claude, cwd, apiKey)
  const acp = new AcpConnection(child)
  let sessionId = ''
  child.stderr?.resume()
  try {
    return await new Promise<ClaudeModelList>((resolve, reject) => {
      const timer = setTimeout(() => {
        killTree(child)
        reject(new Error('Claude 模型列表超时'))
      }, 60_000)
      acp.start({
        onNotification: () => undefined,
        onRequest: (method, params) => {
          if (method === 'session/request_permission') {
            const options = Array.isArray(params?.options) ? params.options : []
            return Promise.resolve(permissionResult(options, true))
          }
          return Promise.reject(new MethodNotFound(method))
        }
      })
      void (async () => {
        try {
          await acp.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: 'agent-desktop', version: '0.1.0' }
          })
          const created = await acp.request('session/new', { cwd, mcpServers: [] })
          sessionId = String(created?.sessionId ?? '')
          clearTimeout(timer)
          const listed = modelsFromClaudeSession(created)
          if (!listed.models.length) throw new Error('Claude 没有返回模型')
          resolve(listed)
        } catch (err) {
          clearTimeout(timer)
          reject(err)
        }
      })()
    })
  } finally {
    killTree(child)
    if (sessionId) forgetClaudeSession(sessionId)
    try {
      fs.rmSync(cwd, { recursive: true, force: true })
    } catch {
      /* the probe directory can be removed later */
    }
  }
}

interface ConfigOption {
  id?: string
  currentValue?: string
  options?: { value?: string; name?: string }[]
  _meta?: { jetbrains?: { air?: { recommendedValue?: string } } }
}

/** Expands the model select with that session's effort levels, as `model[effort]`. The `default` effort is the bare model id. */
export function modelsFromClaudeSession(created: { configOptions?: unknown } | null | undefined): ClaudeModelList {
  if (!Array.isArray(created?.configOptions)) return { models: [] }
  const options = created.configOptions as ConfigOption[]
  const model = options.find((option) => option?.id === CLAUDE_MODEL_CONFIG_ID)
  const effort = options.find((option) => option?.id === CLAUDE_EFFORT_CONFIG_ID)
  const modelOptions = (model?.options ?? []).filter((option) => option?.value && option.value !== 'default')
  const efforts = (effort?.options ?? [])
    .map((option) => option.value)
    .filter((value): value is string => !!value && value !== 'default')
  const recommendedBase = model?._meta?.jetbrains?.air?.recommendedValue || (typeof model?.currentValue === 'string' ? model.currentValue : '')
  const effortDefault = typeof effort?.currentValue === 'string' && effort.currentValue !== 'default' ? effort.currentValue : ''
  const models: ModelInfo[] = []
  for (const option of modelOptions) {
    const id = String(option.value)
    const name = String(option.name || id)
    if (!efforts.length) {
      models.push({ id, label: name })
      continue
    }
    for (const level of efforts) models.push({ id: `${id}[${level}]`, label: `${name} ${level}` })
  }
  const recommended =
    recommendedBase && recommendedBase !== 'default'
      ? effortDefault && efforts.includes(effortDefault)
        ? `${recommendedBase}[${effortDefault}]`
        : efforts.length
          ? `${recommendedBase}[${efforts[0]}]`
          : recommendedBase
      : undefined
  if (recommended) models.sort((a, b) => Number(b.id === recommended) - Number(a.id === recommended))
  return recommended ? { models, recommended } : { models }
}

function claudeEnv(claude: ResolvedClaude, apiKey: string): NodeJS.ProcessEnv {
  const env = nodeEnv()
  const executable = claude.claudePath && !isShellShim(claude.claudePath) ? claude.claudePath : ''
  if (executable) env.CLAUDE_CODE_EXECUTABLE = executable
  else delete env.CLAUDE_CODE_EXECUTABLE
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey
  else delete env.ANTHROPIC_API_KEY
  return env
}

function nodeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
  if (!isWin) {
    const extra = [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin']
    env.PATH = [...extra, env.PATH ?? ''].join(path.delimiter)
  }
  return env
}

function claudeBinary(claude: ResolvedClaude): string | undefined {
  if (claude.claudePath) return claude.claudePath
  return bundledClaudeBinary()
}

function bundledClaudeBinary(): string | undefined {
  const ext = isWin ? '.exe' : ''
  const spec = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${ext}`
  const roots: string[] = []
  if (process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'))
  }
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    roots.push(path.join(dir, 'node_modules'))
    dir = path.dirname(dir)
  }
  for (const root of roots) {
    const file = path.join(root, spec)
    if (fs.existsSync(file)) return preferUnpacked(file)
  }
  return undefined
}

function runClaude(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env: nodeEnv(),
      shell: isWin && isShellShim(command)
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => (stdout += chunk.toString()))
    child.stderr?.on('data', (chunk) => (stderr += chunk.toString()))
    const timer = setTimeout(() => killTree(child), timeoutMs)
    const finish = (code: number | null) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    child.on('error', () => finish(-1))
    child.on('close', (code) => finish(code))
  })
}

function findClaudeOnPath(): string | undefined {
  const names = isWin ? ['claude.exe', 'claude'] : ['claude']
  for (const name of names) {
    const found = whichSync(name)
    if (found && !isShellShim(found)) return found
  }
  const home = os.homedir()
  const candidates = isWin
    ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(home, '.claude', 'local', 'claude.exe')]
    : [path.join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude']
  return candidates.find((file) => fs.existsSync(file) && !isShellShim(file))
}

function findClaudeFile(custom: string): string | undefined {
  if (!fs.existsSync(custom)) return undefined
  const stat = fs.statSync(custom)
  if (!stat.isDirectory()) return custom
  const names = isWin ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude']
  return names.map((name) => path.join(custom, name)).find((file) => fs.existsSync(file))
}

function isShellShim(file: string): boolean {
  return /\.(cmd|bat|ps1)$/i.test(file)
}

function whichSync(name: string): string | undefined {
  const r = spawnSync(isWin ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) return undefined
  return r.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => !!line && !isShellShim(line))
}

function preferUnpacked(file: string): string {
  if (!file.includes('app.asar') || file.includes('app.asar.unpacked')) return file
  const unpacked = file.replace('app.asar', 'app.asar.unpacked')
  return fs.existsSync(unpacked) ? unpacked : file
}

function forgetClaudeSession(sessionId: string): void {
  const root = path.join(os.homedir(), '.claude', 'projects')
  if (!sessionId || !fs.existsSync(root)) return
  const target = `${sessionId}.jsonl`
  for (const file of walkJsonl(root)) {
    if (path.basename(file) !== target) continue
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* the probe session can stay; import skips empty transcripts */
    }
  }
}

function walkJsonl(dir: string): string[] {
  const out: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'subagents') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkJsonl(full))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

/** Cursor's ResolvedCli shape, so a Claude launch can share the process fingerprint. */
export function claudeAsCli(claude: ResolvedClaude): ResolvedCli {
  return { command: process.execPath, prefixArgs: [claude.acpEntry, claude.claudePath ?? ''], display: claude.display }
}
