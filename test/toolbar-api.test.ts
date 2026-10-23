import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebApi } from '../src/renderer/src/lib/web-api'
import type { DesktopApi } from '../src/shared/api'

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), api: undefined as DesktopApi | undefined }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: DesktopApi) => { ipc.api = api } },
  ipcRenderer: { invoke: ipc.invoke, on: vi.fn() }
}))

describe('toolbar and project API transports', () => {
  const fetch = vi.fn()
  beforeEach(() => {
    Object.defineProperty(process, 'isMainFrame', { configurable: true, value: true })
    vi.stubGlobal('location', new URL('https://example.com/'))
    vi.stubGlobal('localStorage', { getItem: () => 'remote-token' })
    vi.stubGlobal('EventSource', class {})
    vi.stubGlobal('fetch', fetch)
    fetch.mockReset().mockResolvedValue({ json: async () => ({ ok: true, result: true }) })
    ipc.invoke.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(process, 'isMainFrame') })

  it('forwards desktop editor selection and saved command identities', async () => {
    await import('../src/preload/index')
    const api = ipc.api!
    await api.openInEditor('/project')
    await api.openInEditor('/worktree', 'vscode')
    await api.runToolbarCommand('custom', 'thread')
    await api.collapseAllProjects()
    expect(ipc.invoke.mock.calls).toEqual([
      ['shell:openInEditor', '/project'], ['shell:openInEditor', '/worktree', 'vscode'],
      ['shell:runToolbarCommand', 'custom', 'thread'], ['project:collapseAll']
    ])
  })

  it('uses the project RPC remotely and blocks custom commands without a network request', async () => {
    const api = createWebApi()
    await api.collapseAllProjects()
    expect(fetch).toHaveBeenCalledOnce()
    expect(String(fetch.mock.calls[0][0])).toContain('project%3AcollapseAll')
    expect(fetch.mock.calls[0][1].body).toBe('[]')
    await expect(api.runToolbarCommand('custom', 'thread')).rejects.toThrow()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('never exposes the application bridge inside wallpaper subframes', async () => {
    vi.resetModules()
    ipc.api = undefined
    Object.defineProperty(process, 'isMainFrame', { configurable: true, value: false })
    await import('../src/preload/index')
    expect(ipc.api).toBeUndefined()
  })

  it('rejects all remote wallpaper operations without making a request', async () => {
    const api = createWebApi()
    await expect(api.skinPickSource()).rejects.toThrow()
    await expect(api.skinScanWallpapers()).rejects.toThrow()
    await expect(api.skinSource('id')).rejects.toThrow()
    await expect(api.skinDelete('id')).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})
