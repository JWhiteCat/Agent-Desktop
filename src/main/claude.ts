import { t as translate } from '@shared/i18n'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentMode, ModelInfo } from '@shared/types'
import { AcpConnection, MethodNotFound, permissionResult } from './acp'
import { killTree, type ResolvedCli } from './cli'
import { cliEnvironment, cliSearchDirectories, findCliExecutable, normalizeCliPath, spawnCliProcess } from './cli-runtime'

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
  const custom = normalizeCliPath(customPath)
  if (custom) {
    const user = findClaudeFile(custom)
    if (!user) return undefined
    return { claudePath: user, bundled: false, display: user, acpEntry }
  }
  const user = findClaudeOnPath()
  if (user) return { claudePath: user, bundled: false, display: user, acpEntry }
  return { claudePath: undefined, bundled: true, display: translate('内置 Claude'), acpEntry }
}

export function spawnClaudeAcp(claude: ResolvedClaude, cwd: string, apiKey: string): ChildProcess {
  return spawnCliProcess(process.execPath, [claude.acpEntry], {
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
    const child = spawnCliProcess(process.execPath, [claude.acpEntry, '--cli', 'auth', 'login', '--claudeai'], {
      env: claudeEnv(claude, ''),
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
      resolve(out.trim() || translate('登录流程已结束'))
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
  if (!claude) throw new Error(translate('未找到 Claude Code'))
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
        reject(new Error(translate('Claude 模型列表超时')))
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
          const effortsByModel: Record<string, string[]> = {}
          for (const value of modelValues(created)) {
            try {
              const switched = await acp.request('session/set_config_option', { sessionId, configId: CLAUDE_MODEL_CONFIG_ID, value })
              if (Array.isArray(switched?.configOptions)) effortsByModel[value] = effortLevels(switched.configOptions as ConfigOption[])
            } catch {
              /* a model this account cannot validate keeps the session's effort list */
            }
          }
          clearTimeout(timer)
          const listed = modelsFromClaudeSession(created, effortsByModel)
          if (!listed.models.length) throw new Error(translate('Claude 没有返回模型'))
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

const CONTEXT_HINT = /\[(\d+[km])\]$/i

function modelValues(created: { configOptions?: unknown } | null | undefined): string[] {
  if (!Array.isArray(created?.configOptions)) return []
  const model = (created.configOptions as ConfigOption[]).find((option) => option?.id === CLAUDE_MODEL_CONFIG_ID)
  return (model?.options ?? []).map((option) => String(option?.value ?? '')).filter((value) => value && value !== 'default')
}

function effortLevels(options: ConfigOption[]): string[] {
  const effort = options.find((option) => option?.id === CLAUDE_EFFORT_CONFIG_ID)
  return (effort?.options ?? []).map((option) => option.value).filter((value): value is string => !!value && value !== 'default')
}

/** `opus[1m]` with effort `high` becomes `opus[context=1m,effort=high]`, the Cursor-style id the picker splits into context and effort. */
export function claudeModelId(value: string, effort?: string): string {
  const hint = value.match(CONTEXT_HINT)
  const base = hint ? value.slice(0, hint.index) : value
  const params = [hint ? `context=${hint[1].toLowerCase()}` : '', effort && effort !== 'default' ? `effort=${effort}` : ''].filter(Boolean)
  return params.length ? `${base}[${params.join(',')}]` : base
}

/** Reverses `claudeModelId`. Also reads the `sonnet[high]` and `opus[1m][high]` ids saved by older builds. */
export function parseClaudeModelId(id: string): { model: string; effort?: string } {
  const named = id.match(/^([^[]+)\[([^\]]*=[^\]]*)\]$/)
  if (named) {
    const params = new Map<string, string>()
    for (const part of named[2].split(',')) {
      const eq = part.indexOf('=')
      if (eq > 0) params.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
    }
    const context = params.get('context')
    const effort = params.get('effort')
    return { model: context ? `${named[1]}[${context}]` : named[1], effort: effort && effort !== 'default' ? effort : undefined }
  }
  const legacy = id.match(/^(.+)\[([^[\]]+)\]$/)
  if (legacy && !CONTEXT_HINT.test(id)) return { model: legacy[1], effort: legacy[2] !== 'default' ? legacy[2] : undefined }
  return { model: id }
}

function legacyClaudeId(value: string, effort?: string): string {
  return effort ? `${value}[${effort}]` : value
}

/**
 * Expands the model select into one id per effort level. `effortsByModel` holds each model's own levels,
 * since Haiku has none and Opus adds `xhigh`; a model missing from it uses the session's current levels.
 * A bare alias whose `[1m]` sibling is listed is labeled 200K so the two land in one group with a context choice.
 */
export function modelsFromClaudeSession(
  created: { configOptions?: unknown } | null | undefined,
  effortsByModel: Record<string, string[]> = {}
): ClaudeModelList {
  if (!Array.isArray(created?.configOptions)) return { models: [] }
  const options = created.configOptions as ConfigOption[]
  const model = options.find((option) => option?.id === CLAUDE_MODEL_CONFIG_ID)
  const effort = options.find((option) => option?.id === CLAUDE_EFFORT_CONFIG_ID)
  const modelOptions = (model?.options ?? []).filter((option) => option?.value && option.value !== 'default')
  const sessionEfforts = effortLevels(options)
  const effortsFor = (value: string) => effortsByModel[value] ?? sessionEfforts
  const hinted = new Set(modelOptions.map((option) => String(option.value)).filter((value) => CONTEXT_HINT.test(value)).map((value) => value.replace(CONTEXT_HINT, '')))
  const recommendedBase = model?._meta?.jetbrains?.air?.recommendedValue || (typeof model?.currentValue === 'string' ? model.currentValue : '')
  const effortDefault = typeof effort?.currentValue === 'string' && effort.currentValue !== 'default' ? effort.currentValue : ''
  const models: ModelInfo[] = []
  for (const option of modelOptions) {
    const value = String(option.value)
    const name = String(option.name || value)
    const label = !CONTEXT_HINT.test(value) && hinted.has(value) ? `${name} 200K` : name
    const efforts = effortsFor(value)
    if (!efforts.length) {
      models.push({ id: claudeModelId(value), label, legacySlug: legacyClaudeId(value) })
      continue
    }
    for (const level of efforts) {
      models.push({ id: claudeModelId(value, level), label: `${label} ${level}`, legacySlug: legacyClaudeId(value, level) })
    }
  }
  let recommended: string | undefined
  if (recommendedBase && recommendedBase !== 'default') {
    const efforts = effortsFor(recommendedBase)
    const level = [effortDefault, 'medium'].find((candidate) => candidate && efforts.includes(candidate)) ?? efforts[0]
    recommended = claudeModelId(recommendedBase, level)
  }
  if (recommended) models.sort((a, b) => Number(b.id === recommended) - Number(a.id === recommended))
  return recommended ? { models, recommended } : { models }
}

function claudeEnv(claude: ResolvedClaude, apiKey: string): NodeJS.ProcessEnv {
  const env = nodeEnv(claude.claudePath)
  const executable = claude.claudePath && !isClaudeShellShim(claude.claudePath) ? claude.claudePath : ''
  if (executable) env.CLAUDE_CODE_EXECUTABLE = executable
  else delete env.CLAUDE_CODE_EXECUTABLE
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey
  else delete env.ANTHROPIC_API_KEY
  return env
}

function nodeEnv(executable?: string): NodeJS.ProcessEnv {
  return cliEnvironment({ ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', FORCE_COLOR: '0' }, executable ? path.dirname(executable) : undefined)
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
    const child = spawnCliProcess(command, args, {
      windowsHide: true,
      env: nodeEnv(command),
      shell: isWin && isClaudeShellShim(command)
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
  // Windows `where claude` hits npm's extensionless shell script before any native binary.
  const names = isWin ? ['claude.exe'] : ['claude']
  for (const directory of cliSearchDirectories()) {
    for (const name of names) {
      const found = findClaudeFile(path.join(directory, name))
      if (found && !isClaudeShellShim(found)) return found
    }
  }
  const home = os.homedir()
  const candidates = isWin
    ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(home, '.claude', 'local', 'claude.exe')]
    : []
  return candidates.map(findClaudeFile).find((file) => !!file && !isClaudeShellShim(file))
}

function findClaudeFile(custom: string): string | undefined {
  const names = isWin ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude']
  return findCliExecutable(custom, names)
}

/**
 * npm's global install publishes `claude.cmd`, `claude.ps1`, and an extensionless
 * shell script also named `claude`. The adapter spawns `CLAUDE_CODE_EXECUTABLE`
 * directly, and spawning that script on Windows fails with `EINVAL`.
 */
export function isClaudeShellShim(file: string, platform: NodeJS.Platform = process.platform): boolean {
  if (/\.(cmd|bat|ps1)$/i.test(file)) return true
  return platform === 'win32' && !/\.exe$/i.test(file)
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
