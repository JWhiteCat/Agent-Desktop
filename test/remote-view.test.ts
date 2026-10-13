import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type AppState, type Project, type ThreadMeta } from '../src/shared/types'
import { viewFromHash, viewHash } from '../src/renderer/src/lib/view-route'

const project: Project = { id: 'project', name: 'Example', path: '/example', createdAt: 1 }
const thread: ThreadMeta = {
  id: 'thread', projectId: project.id, title: 'Example', mode: 'agent',
  model: 'composer-2.5[fast=true]', createdAt: 1, updatedAt: 1, source: 'app'
}
const app = { threads: [thread], projects: [project] }

describe('remote view hash', () => {
  it('encodes the open page and ignores an unknown conversation', () => {
    expect(viewHash({ kind: 'thread', id: 'thread' })).toBe('thread=thread')
    expect(viewHash({ kind: 'home', projectId: 'project' })).toBe('project=project')
    expect(viewHash({ kind: 'grokbot', botId: 'bot' })).toBe('grokbot=bot')
    expect(viewHash({ kind: 'grokbot' })).toBe('grokbot')
    expect(viewFromHash('#thread=thread', app)).toEqual({ kind: 'thread', id: 'thread' })
    expect(viewFromHash('#thread=missing', app)).toBeNull()
    expect(viewFromHash('#project=project', app)).toEqual({ kind: 'home', projectId: 'project' })
    expect(viewFromHash('#grokbot=bot', app)).toEqual({ kind: 'grokbot', botId: 'bot' })
    expect(viewFromHash('grokbot', app)).toEqual({ kind: 'grokbot' })
  })
})

describe('remote page refresh', () => {
  let store: typeof import('../src/renderer/src/store')
  const location = { pathname: '/c/aaaaaaaaaaaaaaaa/', search: '?kept=1', hash: '' }
  const replaceState = vi.fn((_state: unknown, _title: string, url: string) => {
    const hashAt = url.indexOf('#')
    location.hash = hashAt >= 0 ? url.slice(hashAt) : ''
  })
  const api = {
    isRemote: true,
    getState: vi.fn(),
    getItems: vi.fn(),
    onState: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
    onEvent: vi.fn(() => () => {}),
    onFocusThread: vi.fn(() => () => {}),
    listModels: vi.fn(async () => []),
    updateSettings: vi.fn(),
    updateThread: vi.fn()
  }

  beforeEach(async () => {
    vi.resetModules()
    location.hash = ''
    replaceState.mockClear()
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key)
    })
    vi.stubGlobal('location', location)
    vi.stubGlobal('history', { replaceState })
    vi.stubGlobal('window', Object.assign(new EventTarget(), { api }))
    vi.stubGlobal('document', Object.assign(new EventTarget(), {
      hasFocus: () => false,
      visibilityState: 'visible'
    }))
    api.isRemote = true
    api.getItems.mockReset().mockResolvedValue([])
    api.getState.mockReset().mockResolvedValue({
      projects: [{ ...project }], threads: [{ ...thread }],
      settings: { ...DEFAULT_SETTINGS }, running: []
    } satisfies AppState)
    store = await import('../src/renderer/src/store')
  })

  afterEach(() => vi.unstubAllGlobals())

  it('reopens the conversation named in the address bar', async () => {
    location.hash = '#thread=thread'
    await store.initStore()

    expect(store.getState().view).toEqual({ kind: 'thread', id: 'thread' })
    expect(location.hash).toBe('#thread=thread')
    expect(localStorage.getItem('agent-desktop:remoteView')).toBe('thread=thread')
    expect(api.getItems).toHaveBeenCalledWith('thread')
  })

  it('reopens the conversation this browser last showed when the address has no mark', async () => {
    localStorage.setItem('agent-desktop:remoteView', 'thread=thread')
    await store.initStore()

    expect(store.getState().view).toEqual({ kind: 'thread', id: 'thread' })
    expect(location.hash).toBe('#thread=thread')
  })

  it('keeps a scanned link ahead of the page remembered in this browser', async () => {
    location.hash = '#project=project'
    localStorage.setItem('agent-desktop:remoteView', 'thread=thread')
    await store.initStore()

    expect(store.getState().view).toEqual({ kind: 'home', projectId: 'project' })
    expect(localStorage.getItem('agent-desktop:remoteView')).toBe('project=project')
  })

  it('does not substitute another page when the linked conversation is gone', async () => {
    location.hash = '#thread=missing'
    localStorage.setItem('agent-desktop:remoteView', 'thread=thread')
    await store.initStore()

    expect(store.getState().view).toEqual({ kind: 'home', projectId: 'project' })
  })

  it('updates the address when the open conversation changes', async () => {
    await store.initStore()
    await store.openThread(thread.id)

    expect(location.hash).toBe('#thread=thread')
    expect(location.pathname).toBe('/c/aaaaaaaaaaaaaaaa/')
    expect(location.search).toBe('?kept=1')

    store.goHome()
    expect(location.hash).toBe('#project=project')
  })

  it('leaves the desktop window on its own start page', async () => {
    api.isRemote = false
    location.hash = '#thread=thread'
    localStorage.setItem('agent-desktop:remoteView', 'thread=thread')
    await store.initStore()

    expect(store.getState().view).toEqual({ kind: 'home', projectId: 'project' })
    expect(replaceState).not.toHaveBeenCalled()
    expect(location.hash).toBe('#thread=thread')
  })
})
