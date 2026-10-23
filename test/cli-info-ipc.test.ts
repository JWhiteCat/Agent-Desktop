import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cliHandlers } from '../src/main/ipc/cli'
import { settingsHandlers } from '../src/main/ipc/settings'
import { Store } from '../src/main/store'
import type { IpcDeps } from '../src/main/ipc/deps'
import type { CliProvider, Settings } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  directory: '',
  cursor: { info: vi.fn(), login: vi.fn(), update: vi.fn() },
  codex: { info: vi.fn(), login: vi.fn(), update: vi.fn() },
  claude: { info: vi.fn(), login: vi.fn(), update: vi.fn() }
}))
vi.mock('electron', () => ({ app: { getPath: () => mocks.directory } }))
vi.mock('../src/main/cli-catalog', () => ({
  cursorCliInfo: mocks.cursor.info, loginCursor: mocks.cursor.login, cursorModelList: vi.fn(),
  codexCliInfo: mocks.codex.info, loginCodex: mocks.codex.login, codexModelList: vi.fn(),
  claudeCliInfo: mocks.claude.info, loginClaude: mocks.claude.login, claudeModelList: vi.fn()
}))
vi.mock('../src/main/cli-update', () => ({
  updateCursor: mocks.cursor.update, updateCodex: mocks.codex.update, updateClaude: mocks.claude.update
}))
vi.mock('../src/main/claude-history', () => ({ scanClaudeSessions: vi.fn() }))
vi.mock('../src/main/history', () => ({ scanCliSessions: vi.fn() }))
vi.mock('../src/main/thread-history', () => ({ syncFromCli: vi.fn() }))

const providers: CliProvider[] = ['cursor', 'codex', 'claude']

describe('CLI info IPC and settings invalidation', () => {
  let store: Store
  let deps: IpcDeps
  let handlers: ReturnType<typeof cliHandlers>

  beforeEach(() => {
    mocks.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-cli-info-ipc-'))
    store = new Store()
    deps = { store, modelsCache: new Map(), sessions: { dropIdle: vi.fn(), isRunning: vi.fn() }, broadcast: vi.fn() } as unknown as IpcDeps
    handlers = cliHandlers(deps)
    for (const provider of providers) {
      mocks[provider].info.mockReset().mockResolvedValue({ found: true, version: provider, status: 'Signed in' })
      mocks[provider].login.mockReset().mockResolvedValue('Logged in')
      mocks[provider].update.mockReset().mockResolvedValue('Updated')
    }
  })

  afterEach(() => {
    store.flush()
    const directory = path.resolve(mocks.directory)
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('agent-desktop-cli-info-ipc-')) throw new Error('Unexpected fixture directory')
    fs.rmSync(directory, { recursive: true, force: true })
  })

  async function populate() {
    for (const provider of providers) await handlers['cli:info'](provider)
  }

  it.each(providers)('uses cached %s info unless forced, including after restart', async (provider) => {
    await handlers['cli:info'](provider)
    await handlers['cli:info'](provider)
    store.flush()
    store = new Store()
    handlers = cliHandlers({ ...deps, store })
    await handlers['cli:info'](provider)
    expect(mocks[provider].info).toHaveBeenCalledOnce()
    await handlers['cli:info'](provider, true)
    expect(mocks[provider].info).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['cursor', 'agentPath'], ['cursor', 'apiKey'],
    ['codex', 'codexPath'], ['codex', 'codexApiKey'],
    ['claude', 'claudePath'], ['claude', 'claudeApiKey']
  ] as const)('invalidates only %s when %s changes', async (provider, key) => {
    await populate()
    await settingsHandlers(deps)['settings:update']({ [key]: 'new-value' } as Partial<Settings>)
    await populate()
    for (const other of providers) expect(mocks[other].info).toHaveBeenCalledTimes(other === provider ? 2 : 1)
  })

  it('keeps cached info for language, default CLI, and unchanged credential settings', async () => {
    await populate()
    await settingsHandlers(deps)['settings:update']({ language: 'en', cliProvider: 'codex', agentPath: store.settings.agentPath })
    await populate()
    await expect(handlers['cli:info']()).resolves.toHaveProperty('version', 'codex')
    for (const provider of providers) expect(mocks[provider].info).toHaveBeenCalledOnce()
  })

  it.each(providers)('detects %s with the saved path and API key', async (provider) => {
    store.updateSettings({ agentPath: '/cursor', apiKey: 'cursor-key', codexPath: '/codex', codexApiKey: 'codex-key', claudePath: '/claude', claudeApiKey: 'claude-key' })
    await handlers['cli:info'](provider)
    expect(mocks[provider].info).toHaveBeenCalledExactlyOnceWith(`/${provider}`, `${provider}-key`)
  })

  it.each(providers.flatMap((provider) => ['login', 'update'].flatMap((operation) => [false, true].map((fails) => ({ provider, operation: operation as 'login' | 'update', fails })))))
   ('invalidates $provider after $operation finishes (failure=$fails)', async ({ provider, operation, fails }) => {
      await populate()
      if (fails) mocks[provider][operation].mockRejectedValueOnce(new Error('operation failed'))
      const result = handlers[`cli:${operation}`](provider)
      if (fails) await expect(result).rejects.toThrow('operation failed')
      else await result
      // Simulate reopening settings after the action's initiating card unmounted.
      store.flush()
      store = new Store()
      handlers = cliHandlers({ ...deps, store })
      await populate()
      for (const other of providers) expect(mocks[other].info).toHaveBeenCalledTimes(other === provider ? 2 : 1)
    })

  it('cannot persist an old detection after a settings change', async () => {
    let finish!: (info: { found: boolean; version: string }) => void
    mocks.cursor.info.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const old = handlers['cli:info']('cursor')
    await vi.waitFor(() => expect(mocks.cursor.info).toHaveBeenCalledOnce())
    await settingsHandlers(deps)['settings:update']({ agentPath: '/new-cursor' })
    await handlers['cli:info']('cursor')
    finish({ found: true, version: 'old' })
    await old
    await expect(handlers['cli:info']('cursor')).resolves.toHaveProperty('version', 'cursor')
    expect(mocks.cursor.info).toHaveBeenCalledTimes(2)
  })
})
