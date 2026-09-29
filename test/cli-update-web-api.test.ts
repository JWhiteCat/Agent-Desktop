import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebApi } from '../src/renderer/src/lib/web-api'

describe('CLI update browser API', () => {
  const fetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('location', new URL('https://example.com/c/aaaaaaaaaaaaaaaa/'))
    vi.stubGlobal('localStorage', { getItem: () => 'remote-token' })
    vi.stubGlobal('EventSource', class { onopen = null; onmessage = null })
    vi.stubGlobal('fetch', fetch)
    fetch.mockReset().mockResolvedValue({ json: async () => ({ ok: true, result: 'CLI updated' }) })
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each(['cursor', 'codex', 'claude'] as const)('sends the selected %s provider to the desktop', async (provider) => {
    await expect(createWebApi().updateCli(provider)).resolves.toBe('CLI updated')

    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/c/aaaaaaaaaaaaaaaa/api/rpc/cli%3Aupdate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-token': 'remote-token' },
        body: JSON.stringify([provider])
      }
    )
  })

  it('propagates update failures to the settings UI', async () => {
    fetch.mockResolvedValueOnce({ json: async () => ({ ok: false, error: 'CLI update failed' }) })

    await expect(createWebApi().updateCli('cursor')).rejects.toThrow('CLI update failed')
  })
})
