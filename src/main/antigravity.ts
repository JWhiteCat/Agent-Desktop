import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { t as translate } from '@shared/i18n'
import type { CliInfo, ModelInfo } from '@shared/types'
import { AcpConnection, MethodNotFound } from './acp'
import type { ResolvedCli } from './cli'
import { cliEnvironment, cliSearchDirectories, findCliExecutable, killCliProcessTree, normalizeCliPath, spawnCliProcess } from './cli-runtime'

export function resolveAntigravity(customPath: string): ResolvedCli | undefined {
  const name = process.platform === 'win32' ? 'agy.exe' : 'agy'
  const custom = normalizeCliPath(customPath)
  const locations = custom ? [custom] : cliSearchDirectories().map((dir) => path.join(dir, name))
  if (!custom && process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    locations.push(path.join(local, 'agy', 'bin', name))
  }
  for (const location of locations) {
    const command = findCliExecutable(location, [name])
    if (command && (process.platform !== 'win32' || /\.exe$/i.test(command))) {
      return { command, prefixArgs: [], display: command }
    }
  }
  return undefined
}

export function resolveAntigravityApiKey(configured: string): string {
  return configured.trim() || process.env.GEMINI_API_KEY?.trim() || ''
}

export function spawnAntigravity(cli: ResolvedCli, args: string[], cwd: string, apiKey: string) {
  const env = cliEnvironment({ NO_COLOR: '1', GEMINI_API_KEY: apiKey }, path.dirname(cli.command))
  return spawnCliProcess(cli.command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
}

export function requireAntigravity(customPath: string): ResolvedCli {
  const cli = resolveAntigravity(customPath)
  if (!cli) throw new Error(translate('未找到 Antigravity CLI'))
  return cli
}

export async function antigravityCliInfo(customPath: string, apiKey: string): Promise<CliInfo> {
  const cli = resolveAntigravity(customPath)
  if (!cli) return { found: false }
  const child = spawnAntigravity(cli, ['--version'], os.homedir(), '')
  let version = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { version += chunk })
  child.stderr?.resume()
  child.stdin?.end()
  const timer = setTimeout(() => killCliProcessTree(child), 10_000)
  try {
    const code = await new Promise<number | null>((resolve) => {
      child.once('error', () => resolve(-1))
      child.once('close', resolve)
    })
    if (code !== 0) return { found: false }
    const [major, minor] = (version.match(/\d+\.\d+/)?.[0] ?? '').split('.').map(Number)
    return {
      found: true, path: cli.display, version: version.trim(), hasApiKey: !!apiKey,
      ...(major === 1 && minor < 5 ? { status: translate('请将 Antigravity CLI 更新到 1.5.0 或更高版本。') } : {})
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function withAntigravityAcp<T>(
  cli: ResolvedCli, cwd: string, apiKey: string,
  run: (acp: AcpConnection) => Promise<T>,
  onNotification: (method: string, params: any) => void = () => undefined,
  timeout = 60_000
): Promise<T> {
  const child = spawnAntigravity(cli, ['acp'], cwd, apiKey)
  const acp = new AcpConnection(child)
  let stderr = ''
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000) })
  let timer: ReturnType<typeof setTimeout> | undefined
  const failure = new Promise<never>((_, reject) => {
    child.once('error', reject)
    timer = setTimeout(() => reject(new Error(translate('Antigravity CLI 请求超时'))), timeout)
  })
  acp.start({
    onNotification,
    onRequest: async (method) => {
      if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } }
      throw new MethodNotFound(method)
    }
  })
  try {
    return await Promise.race([failure, (async () => {
      await acp.request('initialize', {
        protocolVersion: 1, clientCapabilities: {},
        clientInfo: { name: 'agent-desktop', version: '0.1.0' }
      })
      if (apiKey) await acp.request('authenticate', { methodId: 'gemini-api-key' })
      return run(acp)
    })()])
  } catch (error) {
    if (child.exitCode !== null && stderr.trim()) throw new Error(stderr.trim(), { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
    killCliProcessTree(child)
  }
}

interface Choice { value: string; name?: string }
interface SelectOption {
  id: string
  category?: string
  currentValue?: string
  options: Choice[]
}

export function antigravityConfig(options: unknown, category: 'model' | 'thought_level'): SelectOption | undefined {
  if (!Array.isArray(options)) return undefined
  return options.find((option) => option?.type === 'select' && typeof option.id === 'string'
    && Array.isArray(option.options) && (option.category === category || option.id === category))
}

function choices(option: SelectOption | undefined): Choice[] {
  return (option?.options ?? []).flatMap((choice) => {
    if (choice && typeof choice === 'object' && 'options' in choice && Array.isArray(choice.options)) return choice.options as Choice[]
    return [choice]
  }).filter((choice) => typeof choice?.value === 'string' && !!choice.value)
}

export async function listAntigravityModels(customPath: string, apiKey: string): Promise<ModelInfo[]> {
  const cli = requireAntigravity(customPath)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-agy-'))
  try {
    return await withAntigravityAcp(cli, cwd, apiKey, async (acp) => {
      const created = await acp.request('session/new', { cwd, mcpServers: [] })
      const model = antigravityConfig(created?.configOptions, 'model')
      const available = choices(model)
      if (!model || !available.length) return []
      available.sort((a, b) => Number(b.value === model.currentValue) - Number(a.value === model.currentValue))
      // The adapter can offer different thinking levels after a model change.
      const models: ModelInfo[] = []
      for (const option of available) {
        const base = { id: option.value, label: option.name || option.value }
        let state = created
        if (option.value !== model.currentValue) {
          try {
            state = await acp.request('session/set_config_option', { sessionId: created.sessionId, configId: model.id, value: option.value })
          } catch {
            models.push(base)
            continue
          }
        }
        const effort = antigravityConfig(state?.configOptions, 'thought_level')
        const levels = choices(effort)
        levels.sort((a, b) => Number(b.value === effort?.currentValue) - Number(a.value === effort?.currentValue))
        if (!levels.length) models.push(base)
        for (const level of levels) {
          models.push({ ...base, id: `${base.id}[effort=${level.value}]` })
        }
      }
      return models
    })
  } finally {
    try { fs.rmdirSync(cwd) } catch { /* The CLI may still be releasing the directory. */ }
  }
}

export async function loginAntigravity(customPath: string): Promise<string> {
  return withAntigravityAcp(requireAntigravity(customPath), os.homedir(), '', async (acp) => {
    await acp.request('authenticate', { methodId: 'oauth-personal' })
    return translate('Antigravity CLI 登录成功')
  }, undefined, 5 * 60_000)
}
