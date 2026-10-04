import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { handlersForRemote, RemoteRuntime, remoteSafeSettings, remoteSafeState } from '../src/main/remote-runtime'
import { DEFAULT_SETTINGS, type AppState, type Settings } from '../src/shared/types'
import type { Store } from '../src/main/store'

function fixture() {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    apiKey: 'cursor-secret',
    codexApiKey: 'codex-secret',
    claudeApiKey: 'claude-secret',
    remoteToken: 'remote-secret'
  }
  const state: AppState = { projects: [], threads: [], running: [], settings }
  const update = vi.fn((patch: Partial<Settings>) => ({ ...settings, ...patch }))
  return { settings, state, update, handlers: handlersForRemote({ 'settings:update': update }, () => state) }
}

describe('remote settings', () => {
  it('redacts every CLI API key from settings, snapshots and state RPC responses', () => {
    const { settings, state, handlers } = fixture()
    for (const safe of [remoteSafeSettings(settings), remoteSafeState(state).settings, (handlers['state:get']() as AppState).settings]) {
      expect(safe.apiKey).toBe('')
      expect(safe.codexApiKey).toBe('')
      expect(safe.claudeApiKey).toBe('')
      expect(safe.remoteToken).toBe('')
    }
    expect(settings.claudeApiKey).toBe('claude-secret')
  })

  it('preserves configured secrets when a remote client saves redacted settings', async () => {
    const { settings, update, handlers } = fixture()
    const patch = { apiKey: '', codexApiKey: '', claudeApiKey: '', remoteToken: '', remoteEnabled: false, remotePublicSshPort: 2222, theme: 'dark' } as const
    const result = await handlers['settings:update'](patch) as Settings
    expect(update).toHaveBeenCalledExactlyOnceWith({ theme: 'dark' })
    expect(result.claudeApiKey).toBe('')
    expect(settings.claudeApiKey).toBe('claude-secret')
    expect(patch).toHaveProperty('claudeApiKey', '')
  })

  it('allows an explicitly supplied key without exposing it in the response', async () => {
    const { update, handlers } = fixture()
    const result = await handlers['settings:update']({ claudeApiKey: 'replacement-secret' }) as Settings
    expect(update).toHaveBeenCalledExactlyOnceWith({ claudeApiKey: 'replacement-secret' })
    expect(result.claudeApiKey).toBe('')
  })
})

describe('remote runtime lifecycle', () => {
  let runtime: RemoteRuntime | undefined
  let created: MockInstance<typeof http.createServer>
  beforeEach(() => {
    created = vi.spyOn(http, 'createServer')
  })
  afterEach(async () => {
    try {
      await runtime?.stop()
    } finally {
      const servers = created.mock.results.flatMap((result) => result.type === 'return' ? [result.value as http.Server] : [])
      vi.restoreAllMocks()
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })))
    }
  })

  function setup(patch: Partial<Settings> = {}) {
    const store = {
      settings: { ...DEFAULT_SETTINGS, remoteEnabled: true, remotePort: 0, remoteToken: 'test-token', remoteClientId: 'aaaaaaaaaaaaaaaa', ...patch },
      updateSettings(next: Partial<Settings>) { this.settings = { ...this.settings, ...next }; return this.settings }
    }
    runtime = new RemoteRuntime(() => store as unknown as Store, () => ({ projects: [], threads: [], running: [], settings: store.settings }))
    return store
  }

  it('does not keep hidden listeners after concurrent apply calls and disabling remote access', async () => {
    const store = setup()
    await Promise.all([runtime!.apply(), runtime!.apply()])
    expect(runtime!.info()).toMatchObject({ enabled: true, running: true })
    const servers = created.mock.results.map((result) => result.value as http.Server)
    expect(servers.filter((server) => server.listening)).toHaveLength(1)
    store.updateSettings({ remoteEnabled: false })
    await runtime!.apply()
    expect(runtime!.info()).toMatchObject({ enabled: false, running: false })
    expect(servers.every((server) => !server.listening)).toBe(true)
  })

  it('finishes an in-progress apply before shutdown and passes the configured SSH port', async () => {
    setup({ remotePublicEnabled: true, remotePublicSshPort: 2222 })
    let finishStart!: () => void
    let reachedStart!: () => void
    const reached = new Promise<void>((resolve) => { reachedStart = resolve })
    const start = vi.spyOn(runtime!.tunnel, 'start').mockImplementation(() => {
      reachedStart()
      return new Promise<void>((resolve) => { finishStart = resolve })
    })
    const stop = vi.spyOn(runtime!.tunnel, 'stop').mockResolvedValue()
    const applying = runtime!.apply()
    await reached
    const stopping = runtime!.stop()
    finishStart()
    await Promise.all([applying, stopping])
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sshPort: 2222, port: 8765 }))
    expect(stop).toHaveBeenCalledOnce()
    expect(runtime!.server.running).toBe(false)
  })
})
