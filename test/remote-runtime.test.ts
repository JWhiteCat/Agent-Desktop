import { describe, expect, it, vi } from 'vitest'
import { handlersForRemote, remoteSafeSettings, remoteSafeState } from '../src/main/remote-runtime'
import { DEFAULT_SETTINGS, type AppState, type Settings } from '../src/shared/types'

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
    const patch = { apiKey: '', codexApiKey: '', claudeApiKey: '', remoteToken: '', remoteEnabled: false, theme: 'dark' } as const
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
