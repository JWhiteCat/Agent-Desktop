import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentMode, ModelInfo } from '@shared/types'
import { AcpConnection, MethodNotFound, permissionResult } from './acp'
import { killTree, type ResolvedCli } from './cli'

const isWin = process.platform === 'win32'

export interface ResolvedCodex {
  /** Set only when a user-installed `codex` binary was found. */
  codexPath?: string
  bundled: boolean
  display: string
  acpEntry: string
}

export function codexModeId(mode: AgentMode, force: boolean, sandbox: 'default' | 'enabled' | 'disabled'): string {
  if (mode === 'ask' || mode === 'plan') return 'read-only'
  if (force && sandbox !== 'enabled') return 'agent-full-access'
  return 'agent'
}

/** Settings value, then CODEX_API_KEY, then OPENAI_API_KEY. */
export function resolveCodexApiKey(configured: string | undefined): string {
  const fromSettings = configured?.trim() ?? ''
  if (fromSettings) return fromSettings
  return process.env.CODEX_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || ''
}

export function resolveCodexAcpEntry(): string | undefined {
  const candidates: string[] = []
  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js')
    )
  }
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(dir, 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js'))
    dir = path.dirname(dir)
  }
  const hit = candidates.find((file) => fs.existsSync(file))
  return hit ? preferUnpacked(hit) : undefined
}

export function resolveCodex(customPath: string): ResolvedCodex | undefined {
  const acpEntry = resolveCodexAcpEntry()
  if (!acpEntry) return undefined
  const custom = customPath.trim()
  if (custom) {
    const user = findCodexFile(custom)
    if (!user) return undefined
    return { codexPath: user, bundled: false, display: user, acpEntry }
  }
  const user = findCodexOnPath()
  if (user) return { codexPath: user, bundled: false, display: user, acpEntry }
  return { codexPath: undefined, bundled: true, display: '内置 Codex', acpEntry }
}

export function spawnCodexAcp(codex: ResolvedCodex, cwd: string, apiKey: string): ChildProcess {
  return spawn(process.execPath, [codex.acpEntry], {
    cwd,
    env: codexEnv(codex, apiKey),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
}

export async function codexVersion(codex: ResolvedCodex): Promise<string> {
  const script = codexBinary(codex)
  if (!script) return ''
  const res = await runCodex(script.command, script.args.concat(['--version']), 20_000)
  return (res.stdout || res.stderr).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
}

export async function codexStatus(codex: ResolvedCodex): Promise<string> {
  const script = codexBinary(codex)
  if (!script) return ''
  const res = await runCodex(script.command, script.args.concat(['login', 'status']), 20_000)
  return (res.stdout + '\n' + res.stderr).trim()
}

/** Opens ChatGPT login. Uses the user binary when present, otherwise the bundled CLI. */
export function codexLogin(codex: ResolvedCodex): Promise<string> {
  const script = codexBinary(codex)
  if (!script) return Promise.resolve('未找到 Codex CLI')
  return new Promise((resolve) => {
    const child = spawn(script.command, script.args.concat(['login']), {
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

export interface CodexModelList {
  models: ModelInfo[]
  recommended?: string
}

/** Reads the model select (and reasoning efforts) from a short-lived ACP session. */
export async function listCodexModels(customPath: string, apiKey: string): Promise<CodexModelList> {
  const codex = resolveCodex(customPath)
  if (!codex) return { models: [] }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-codex-'))
  const child = spawnCodexAcp(codex, cwd, apiKey)
  const acp = new AcpConnection(child)
  let sessionId = ''
  try {
    return await new Promise<CodexModelList>((resolve, reject) => {
      const timer = setTimeout(() => {
        killTree(child)
        reject(new Error('Codex 模型列表超时'))
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
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, plan: {} },
            clientInfo: { name: 'agent-desktop', version: '0.1.0' }
          })
          if (apiKey) await acp.request('authenticate', { methodId: 'api-key' })
          const created = await acp.request('session/new', { cwd, mcpServers: [] })
          sessionId = String(created?.sessionId ?? '')
          clearTimeout(timer)
          resolve(modelsFromConfig(created?.configOptions))
        } catch (err) {
          clearTimeout(timer)
          reject(err)
        }
      })()
    })
  } finally {
    killTree(child)
    if (sessionId) forgetRollout(sessionId)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

interface ConfigOption {
  id?: string
  currentValue?: string
  options?: { value?: string; name?: string }[]
  _meta?: { jetbrains?: { air?: { recommendedValue?: string } } }
}

/** Expands Codex model and reasoning-effort selects into picker ids like `gpt-5.4[high]`. */
export function modelsFromConfig(raw: unknown): CodexModelList {
  if (!Array.isArray(raw)) return { models: [] }
  const options = raw as ConfigOption[]
  const model = options.find((option) => option?.id === 'model')
  const effort = options.find((option) => option?.id === 'reasoning_effort')
  const modelOptions = (model?.options ?? []).filter((option) => option?.value)
  const efforts = (effort?.options ?? []).map((option) => option.value).filter((value): value is string => !!value)
  const recommendedBase = model?._meta?.jetbrains?.air?.recommendedValue || model?.currentValue
  const effortDefault = (typeof effort?.currentValue === 'string' && effort.currentValue) || efforts[0]
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
  const recommended = recommendedBase ? (effortDefault && efforts.length ? `${recommendedBase}[${effortDefault}]` : recommendedBase) : undefined
  if (recommended) models.sort((a, b) => Number(b.id === recommended) - Number(a.id === recommended))
  return { models, recommended }
}

function codexEnv(codex: ResolvedCodex, apiKey: string): NodeJS.ProcessEnv {
  const env = nodeEnv()
  if (codex.codexPath) env.CODEX_PATH = codex.codexPath
  else delete env.CODEX_PATH
  if (apiKey) {
    env.CODEX_API_KEY = apiKey
  }
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

function codexBinary(codex: ResolvedCodex): { command: string; args: string[] } | undefined {
  if (codex.codexPath) return { command: codex.codexPath, args: [] }
  const bundled = bundledCodexScript(codex.acpEntry)
  if (!bundled) return undefined
  return { command: process.execPath, args: [bundled] }
}

function bundledCodexScript(acpEntry: string): string | undefined {
  const script = path.join(acpEntry, '..', '..', '..', '..', '@openai', 'codex', 'bin', 'codex.js')
  return fs.existsSync(script) ? script : undefined
}

function runCodex(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env: nodeEnv(),
      shell: isWin && !command.toLowerCase().endsWith('.exe')
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => (stdout += chunk.toString()))
    child.stderr?.on('data', (chunk) => (stderr += chunk.toString()))
    const timer = setTimeout(() => killTree(child), timeoutMs)
    const finish = () => {
      clearTimeout(timer)
      resolve({ stdout, stderr })
    }
    child.on('error', finish)
    child.on('close', finish)
  })
}

function findCodexOnPath(): string | undefined {
  const names = isWin ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex']
  for (const name of names) {
    const found = whichSync(name)
    if (found) return found
  }
  if (isWin) return undefined
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex'
  ]
  return candidates.find((file) => fs.existsSync(file))
}

function findCodexFile(custom: string): string | undefined {
  if (!fs.existsSync(custom)) return undefined
  const stat = fs.statSync(custom)
  if (!stat.isDirectory()) return custom
  const names = isWin ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex']
  return names.map((name) => path.join(custom, name)).find((file) => fs.existsSync(file))
}

function whichSync(name: string): string | undefined {
  const r = spawnSync(isWin ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) return undefined
  return r.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
}

function preferUnpacked(file: string): string {
  if (!file.includes('app.asar') || file.includes('app.asar.unpacked')) return file
  const unpacked = file.replace('app.asar', 'app.asar.unpacked')
  return fs.existsSync(unpacked) ? unpacked : file
}

function forgetRollout(sessionId: string): void {
  const root = path.join(os.homedir(), '.codex', 'sessions')
  if (!fs.existsSync(root)) return
  for (const file of walkJsonl(root)) {
    if (path.basename(file).includes(sessionId) || headContains(file, sessionId)) {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* the probe session can stay; import skips empty transcripts */
      }
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
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkJsonl(full))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

function headContains(file: string, needle: string): boolean {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(8192)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      return buf.subarray(0, n).toString('utf8').includes(needle)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
}

/** Cursor's ResolvedCli shape, so a Codex launch can share the process fingerprint. */
export function codexAsCli(codex: ResolvedCodex): ResolvedCli {
  return { command: process.execPath, prefixArgs: [codex.acpEntry, codex.codexPath ?? ''], display: codex.display }
}
