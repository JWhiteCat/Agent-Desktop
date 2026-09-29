import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliProvider, ModelInfo } from '../src/shared/types'
import type { IpcDeps } from '../src/main/ipc/deps'
import { cliHandlers } from '../src/main/ipc/cli'

const updates = vi.hoisted(() => ({
  cursor: vi.fn<(path: string) => Promise<string>>(),
  codex: vi.fn<(path: string) => Promise<string>>(),
  claude: vi.fn<(path: string) => Promise<string>>()
}))

vi.mock('../src/main/cli-update', () => ({
  updateCursor: updates.cursor,
  updateCodex: updates.codex,
  updateClaude: updates.claude
}))
vi.mock('../src/main/cli-catalog', () => ({
  claudeCliInfo: vi.fn(), claudeModelList: vi.fn(), loginClaude: vi.fn(),
  codexCliInfo: vi.fn(), codexModelList: vi.fn(), loginCodex: vi.fn(),
  cursorCliInfo: vi.fn(), cursorModelList: vi.fn(), loginCursor: vi.fn()
}))
vi.mock('../src/main/claude-history', () => ({ scanClaudeSessions: vi.fn() }))
vi.mock('../src/main/codex-history', () => ({ scanCodexSessions: vi.fn() }))
vi.mock('../src/main/history', () => ({ scanCliSessions: vi.fn() }))
vi.mock('../src/main/thread-history', () => ({ syncFromCli: vi.fn() }))

const providers: CliProvider[] = ['cursor', 'codex', 'claude']
const paths = {
  cursor: 'C:\\CLI tools\\cursor-agent.cmd',
  codex: 'C:\\CLI tools\\codex.cmd',
  claude: 'C:\\CLI tools\\claude.exe'
}

function fixture(defaultProvider: CliProvider = 'cursor') {
  const modelsCache = new Map<CliProvider, ModelInfo[]>(providers.map((provider) => [
    provider, [{ id: `${provider}-cached`, label: 'Cached model' }]
  ]))
  const dropIdle = vi.fn()
  const handlers = cliHandlers({
    store: {
      settings: {
        cliProvider: defaultProvider,
        agentPath: paths.cursor,
        codexPath: paths.codex,
        claudePath: paths.claude
      }
    },
    sessions: { dropIdle },
    modelsCache,
    broadcast: vi.fn()
  } as unknown as IpcDeps)
  return { update: handlers['cli:update'], modelsCache, dropIdle }
}

describe('CLI update IPC', () => {
  beforeEach(() => {
    for (const provider of providers) updates[provider].mockReset().mockResolvedValue(`${provider} updated`)
  })

  it.each(providers)('updates the selected %s CLI using its configured path', async (provider) => {
    const defaultProvider = providers[(providers.indexOf(provider) + 1) % providers.length]
    const { update, modelsCache, dropIdle } = fixture(defaultProvider)
    const originalCaches = new Map(modelsCache)

    await expect(update(provider)).resolves.toBe(`${provider} updated`)

    expect(updates[provider]).toHaveBeenCalledExactlyOnceWith(paths[provider])
    expect(modelsCache.has(provider)).toBe(false)
    for (const other of providers.filter((item) => item !== provider)) {
      expect(updates[other]).not.toHaveBeenCalled()
      expect(modelsCache.get(other)).toBe(originalCaches.get(other))
    }
    expect(dropIdle).toHaveBeenCalledTimes(2)
    expect(dropIdle.mock.invocationCallOrder[0]).toBeLessThan(updates[provider].mock.invocationCallOrder[0])
    expect(dropIdle.mock.invocationCallOrder[1]).toBeGreaterThan(updates[provider].mock.invocationCallOrder[0])
  })

  it.each([undefined, null, '', 'other'])('rejects an invalid provider %s without starting an update', async (provider) => {
    const { update, modelsCache, dropIdle } = fixture('codex')

    await expect(update(provider)).rejects.toThrow('请选择要更新的 CLI')

    for (const updater of Object.values(updates)) expect(updater).not.toHaveBeenCalled()
    expect(dropIdle).not.toHaveBeenCalled()
    expect(modelsCache.size).toBe(3)
  })

  it('keeps the cached models while updating and clears them only after success', async () => {
    let finish!: (result: string) => void
    updates.cursor.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const { update, modelsCache, dropIdle } = fixture()
    const cached = modelsCache.get('cursor')

    const pending = update('cursor')
    expect(modelsCache.get('cursor')).toBe(cached)
    expect(dropIdle).toHaveBeenCalledOnce()
    finish('Current version is installed')

    await expect(pending).resolves.toBe('Current version is installed')
    expect(modelsCache.has('cursor')).toBe(false)
    expect(dropIdle).toHaveBeenCalledTimes(2)
  })

  it('rejects duplicate updates, allows other providers, and permits retry after failure', async () => {
    let fail!: (error: Error) => void
    updates.codex.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    const { update, modelsCache, dropIdle } = fixture()
    const cached = modelsCache.get('codex')

    const pending = update('codex')
    await expect(update('codex')).rejects.toThrow('此 CLI 正在更新，请稍候')
    expect(updates.codex).toHaveBeenCalledOnce()
    expect(dropIdle).toHaveBeenCalledOnce()
    await expect(update('claude')).resolves.toBe('claude updated')

    const failed = expect(pending).rejects.toThrow('Download failed')
    fail(new Error('Download failed'))
    await failed
    expect(modelsCache.get('codex')).toBe(cached)
    expect(dropIdle).toHaveBeenCalledTimes(3)

    await expect(update('codex')).resolves.toBe('codex updated')
    expect(updates.codex).toHaveBeenCalledTimes(2)
    expect(modelsCache.has('codex')).toBe(false)
    expect(dropIdle).toHaveBeenCalledTimes(5)
  })
})
