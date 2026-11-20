import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebApi, remoteUrl } from '../src/renderer/src/lib/web-api'
import { DEFAULT_SETTINGS, type AppState, type Item, type ThreadMeta } from '../src/shared/types'

describe('remote page URLs', () => {
  it('keeps API calls on the LAN origin root', () => {
    expect(remoteUrl('http://192.168.1.8:8765/?token=abc', 'api/rpc/state:get')).toBe(
      'http://192.168.1.8:8765/api/rpc/state:get'
    )
  })

  it('keeps API calls under the public computer prefix', () => {
    const page = 'http://43.167.166.239:8765/c/aaaaaaaaaaaaaaaa/?token=abc#thread=1'
    expect(remoteUrl(page, 'api/events?token=abc')).toBe(
      'http://43.167.166.239:8765/c/aaaaaaaaaaaaaaaa/api/events?token=abc'
    )
  })
})

describe('remote reconnects', () => {
  let events: {
    onopen?: () => void
    onmessage?: (event: { data: string }) => void
    onerror?: () => void
    readyState?: number
    closed?: boolean
    close?: () => void
  }
  let sources: typeof events[] = []
  const fetch = vi.fn()
  const state: AppState = { projects: [], threads: [], settings: DEFAULT_SETTINGS, running: [] }

  function response(result: unknown) {
    return { json: async () => ({ ok: true, result }) }
  }

  beforeEach(() => {
    vi.resetModules()
    sources = []
    vi.stubGlobal('location', new URL('http://192.168.1.8:8765/'))
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hasFocus: () => false, visibilityState: 'visible' }))
    vi.stubGlobal('EventSource', class {
      closed = false
      constructor() {
        events = this
        sources.push(this)
      }
      close() { this.closed = true }
    })
    vi.stubGlobal('fetch', fetch)
    fetch.mockReset().mockResolvedValue(response(state))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps heartbeat frames away from listeners', () => {
    const api = createWebApi()
    const onEvent = vi.fn()
    api.onEvent(onEvent)
    events.onmessage!({ data: JSON.stringify({ channel: 'transport:ping', payload: null }) })
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('replaces a stream that delivers nothing after a send', async () => {
    vi.useFakeTimers()
    const api = createWebApi()
    const first = events
    first.onopen!()
    await api.send({ threadId: 'thread', prompt: 'hi', mode: 'agent', model: 'composer-2.5[fast=true]', force: false })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(first.closed).toBe(true)
    expect(sources).toHaveLength(2)
  })

  it('keeps a stream that delivered the state change of a send', async () => {
    vi.useFakeTimers()
    const api = createWebApi()
    events.onopen!()
    await api.send({ threadId: 'thread', prompt: 'hi', mode: 'agent', model: 'composer-2.5[fast=true]', force: false })
    events.onmessage!({ data: JSON.stringify({ channel: 'state:changed', payload: state }) })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sources).toHaveLength(1)
  })

  it('reconnects a silent stream and one closed by a gateway error', async () => {
    vi.useFakeTimers()
    createWebApi()
    events.onopen!()
    await vi.advanceTimersByTimeAsync(40_000)
    expect(sources).toHaveLength(2)
    events.readyState = 2
    events.onerror!()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sources).toHaveLength(3)
  })

  it('requests one provider quota without waiting for a combined report', async () => {
    const api = createWebApi()
    const quota = { provider: 'codex', windows: [] }
    fetch.mockResolvedValueOnce(response(quota))
    expect(await api.usageQuota('codex')).toEqual(quota)
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('api/rpc/usage%3Aquota'), expect.objectContaining({
      method: 'POST', body: JSON.stringify(['codex'])
    }))
  })

  it('requests a usage report for the selected period and CLI', async () => {
    const api = createWebApi()
    await api.usageSummary('30d', 'antigravity')
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('api/rpc/usage%3Asummary'), expect.objectContaining({
      method: 'POST', body: JSON.stringify(['30d', 'antigravity'])
    }))
  })

  it('announces reconnects and refreshes metadata after the initial connection', async () => {
    const api = createWebApi()
    const onState = vi.fn()
    const onReconnect = vi.fn()
    api.onState(onState)
    const unsubscribe = api.onReconnect!(onReconnect)

    events.onopen!()
    expect(fetch).not.toHaveBeenCalled()
    expect(onReconnect).not.toHaveBeenCalled()
    events.onopen!()

    await vi.waitFor(() => expect(onState).toHaveBeenCalledExactlyOnceWith(state))
    expect(onReconnect).toHaveBeenCalledTimes(1)
    unsubscribe()
    events.onopen!()
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('does not let a reconnect snapshot overwrite a newer live state', async () => {
    let finish!: (value: ReturnType<typeof response>) => void
    fetch.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const api = createWebApi()
    const onState = vi.fn()
    api.onState(onState)
    events.onopen!()
    events.onopen!()
    const current = { ...state, running: ['thread'] }
    events.onmessage!({ data: JSON.stringify({ channel: 'state:changed', payload: current }) })
    finish(response(state))
    await new Promise((resolve) => setImmediate(resolve))

    expect(onState).toHaveBeenCalledExactlyOnceWith(current)
  })

  it('ignores a late snapshot from a superseded reconnect', async () => {
    let finishOld!: (value: ReturnType<typeof response>) => void
    fetch.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve }))
    const current = { ...state, running: ['thread'] }
    fetch.mockResolvedValueOnce(response(current))
    const api = createWebApi()
    const onState = vi.fn()
    api.onState(onState)
    events.onopen!()
    events.onopen!()
    events.onopen!()
    await vi.waitFor(() => expect(onState).toHaveBeenCalledExactlyOnceWith(current))
    finishOld(response(state))
    await new Promise((resolve) => setImmediate(resolve))

    expect(onState).toHaveBeenCalledExactlyOnceWith(current)
  })

  it('recovers an app conversation completed while its browser was disconnected', async () => {
    const project = { id: 'project', name: 'Project', path: '/project', createdAt: 1 }
    const thread: ThreadMeta = {
      id: 'thread', projectId: project.id, title: 'Chat', source: 'app',
      mode: 'agent', model: 'composer-2.5[fast=true]', createdAt: 1, updatedAt: 1
    }
    let snapshot: AppState = { ...state, projects: [project], threads: [thread], running: [thread.id] }
    let items: Item[] = [{ id: 'answer', kind: 'assistant', text: 'Partial' }]
    fetch.mockImplementation(async (url: string) => {
      const name = decodeURIComponent(new URL(url).pathname.split('/').pop()!)
      return response(structuredClone(name === 'state:get' ? snapshot : name === 'thread:items' ? items : []))
    })
    vi.stubGlobal('window', Object.assign(new EventTarget(), { api: createWebApi() }))
    events.onopen!()
    const store = await import('../src/renderer/src/store')
    await store.initStore()
    await store.openThread(thread.id)

    snapshot = { ...snapshot, running: [] }
    items = [
      { id: 'answer', kind: 'assistant', text: 'Completed answer' },
      { id: 'result', kind: 'result', isError: false }
    ]
    events.onopen!()

    await vi.waitFor(() => {
      expect(store.getState().app.running).toEqual([])
      expect(store.getState().items[thread.id]).toEqual(items)
    })
    await store.openThread(thread.id)
    expect(store.getState().items[thread.id]).toEqual(items)
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('thread%3Aitems'))).toHaveLength(2)
  })
})
