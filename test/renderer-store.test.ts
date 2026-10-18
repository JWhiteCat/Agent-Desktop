import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type AgentEvent, type AppState, type Item, type Project, type ThreadMeta } from '../src/shared/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('renderer store', () => {
  let store: typeof import('../src/renderer/src/store')
  let onEvent: (event: AgentEvent) => void
  let onState: (state: AppState) => void
  let onFocusThread: (id: string) => void
  let onReconnect: () => void
  let windowEvents: EventTarget
  let documentEvents: EventTarget
  let focused: boolean
  let visible: boolean
  const api = {
    getState: vi.fn(),
    getItems: vi.fn(),
    onState: vi.fn(),
    onReconnect: vi.fn(),
    onEvent: vi.fn(),
    onFocusThread: vi.fn(),
    listModels: vi.fn(),
    prepareCommands: vi.fn(),
    updateProject: vi.fn(),
    collapseAllProjects: vi.fn(),
    updateSettings: vi.fn(),
    updateThread: vi.fn(),
    send: vi.fn()
  }
  const project: Project = {
    id: 'project', name: 'Example', path: '/example', createdAt: 1,
    model: 'composer-2.5[fast=true]', codexModel: 'codex-model', claudeModel: 'claude-model'
  }
  const thread: ThreadMeta = {
    id: 'thread', projectId: project.id, title: 'Example', mode: 'agent',
    model: 'composer-2.5[fast=true]', createdAt: 1, updatedAt: 1, source: 'app'
  }
  const history: Item[] = [
    { id: 'user', kind: 'user', text: 'Hello', createdAt: 1 },
    { id: 'answer', kind: 'assistant', text: 'Partial' }
  ]
  const latest: Item[] = [
    { id: 'answer', kind: 'assistant', text: 'Completed answer' },
    { id: 'result', kind: 'result', isError: false }
  ]

  beforeEach(async () => {
    vi.resetModules()
    vi.resetAllMocks()
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key)
    })
    focused = false
    visible = true
    windowEvents = new EventTarget()
    documentEvents = new EventTarget()
    vi.stubGlobal('window', Object.assign(windowEvents, { api }))
    vi.stubGlobal('document', Object.assign(documentEvents, {
      hasFocus: () => focused
    }))
    Object.defineProperty(document, 'visibilityState', { get: () => visible ? 'visible' : 'hidden' })
    api.getState.mockResolvedValue({
      projects: [{ ...project }], threads: [{ ...thread }],
      settings: { ...DEFAULT_SETTINGS }, running: []
    } satisfies AppState)
    api.onEvent.mockImplementation((listener) => { onEvent = listener; return () => {} })
    api.onState.mockImplementation((listener) => { onState = listener; return () => {} })
    api.onFocusThread.mockImplementation((listener) => { onFocusThread = listener; return () => {} })
    api.onReconnect.mockImplementation((listener) => { onReconnect = listener; return () => {} })
    api.updateThread.mockResolvedValue(undefined)
    api.listModels.mockResolvedValue([])
    store = await import('../src/renderer/src/store')
    await store.initStore()
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each(['cursor', 'codex', 'claude'] as const)('preserves the %s command cache on empty preparation but clears it on a live announcement', async (cli) => {
    const commands = [{ name: 'help', description: 'List commands' }]
    store.setState((s) => ({ app: { ...s.app, threads: [{ ...thread, cli }] } }))
    onEvent({ type: 'commands', threadId: thread.id, commands })

    expect(store.cliCommands(store.getState(), cli)).toEqual(commands)
    expect(JSON.parse(localStorage.getItem('agent-desktop:slash-commands')!)).toEqual({ [cli]: commands })

    api.prepareCommands.mockResolvedValueOnce([])
    await store.prepareCommands(thread.id, { model: 'composer-2.5[fast=true]', mode: 'agent', force: false })

    expect(store.getState().commandsByThread[thread.id]).toEqual([])
    expect(store.cliCommands(store.getState(), cli)).toEqual(commands)
    expect(JSON.parse(localStorage.getItem('agent-desktop:slash-commands')!)).toEqual({ [cli]: commands })

    onEvent({ type: 'commands', threadId: thread.id, commands: [] })

    expect(store.cliCommands(store.getState(), cli)).toEqual([])
    expect(JSON.parse(localStorage.getItem('agent-desktop:slash-commands')!)).toEqual({ [cli]: [] })
  })

  it.each([
    ['cursor', 'model'], ['codex', 'codexModel'], ['claude', 'claudeModel']
  ] as const)('preserves other providers when remembering a %s project model', (cli, key) => {
    store.rememberModel(project.id, 'new-model', undefined, cli)

    expect(store.getState().app.projects[0]).toEqual({ ...project, [key]: 'new-model' })
    expect(api.updateProject).toHaveBeenCalledWith(project.id, { [key]: 'new-model' })
  })

  it('preserves other providers when favorites change a project model', () => {
    store.setState({ modelsByCli: {
      cursor: [{ id: project.model!, label: 'Composer' }, { id: 'other', label: 'Other' }],
      codex: [], claude: []
    } })

    store.setFavoriteModels(['other'], 'cursor')

    expect(store.getState().app.projects[0]).toEqual({ ...project, model: 'other' })
  })

  it('still clears the legacy shared field when migrating a Codex model', () => {
    store.setState((s) => ({
      app: { ...s.app, projects: [{ ...project, model: 'codex-model' }] },
      modelsByCli: {
        cursor: [{ id: 'composer-2.5[fast=true]', label: 'Composer' }],
        codex: [{ id: 'codex-model', label: 'Codex' }, { id: 'next-codex', label: 'Next' }],
        claude: []
      }
    }))

    store.rememberModel(project.id, 'next-codex', undefined, 'codex')

    expect(store.getState().app.projects[0]).toEqual({
      id: project.id, name: project.name, path: project.path, createdAt: project.createdAt,
      codexModel: 'next-codex', claudeModel: 'claude-model'
    })
    expect(api.updateProject).toHaveBeenCalledWith(project.id, { codexModel: 'next-codex', model: undefined })
  })

  it('keeps streamed updates that arrive while an uncached history is loading', async () => {
    const request = deferred<Item[]>()
    api.getItems.mockReturnValueOnce(request.promise)
    store.setState((s) => ({ app: { ...s.app, running: [thread.id] } }))

    const opening = store.openThread(thread.id)
    onEvent({ type: 'items', threadId: thread.id, items: latest })
    request.resolve(history)
    await opening

    expect(store.getState().items[thread.id]).toEqual([history[0], ...latest])
  })

  it('merges live updates into a CLI refresh without retaining obsolete cached items', async () => {
    const request = deferred<Item[]>()
    api.getItems.mockReturnValueOnce(request.promise)
    store.setState((s) => ({
      app: { ...s.app, threads: [{ ...thread, source: 'cli' }] },
      items: { [thread.id]: [{ id: 'obsolete', kind: 'assistant', text: 'Old CLI snapshot' }] }
    }))

    const opening = store.openThread(thread.id)
    onEvent({ type: 'items', threadId: thread.id, items: latest })
    request.resolve(history)
    await opening

    expect(store.getState().items[thread.id]).toEqual([history[0], ...latest])
  })

  it('shares a pending history request between opening and sending to a thread', async () => {
    const request = deferred<Item[]>()
    api.getItems.mockReturnValue(request.promise)
    const opening = store.openThread(thread.id)
    const sending = store.sendMessage(thread.id, 'Next', { model: 'composer-2.5[fast=true]', mode: 'agent', force: false })

    expect(api.getItems).toHaveBeenCalledTimes(1)
    expect(api.send).not.toHaveBeenCalled()
    onEvent({ type: 'items', threadId: thread.id, items: latest })
    request.resolve(history)
    await Promise.all([opening, sending])

    expect(store.getState().items[thread.id]).toEqual([history[0], ...latest])
    expect(api.send).toHaveBeenCalledTimes(1)
  })

  it('allows retrying a failed history request', async () => {
    api.getItems.mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValueOnce(history)

    await expect(store.openThread(thread.id)).rejects.toThrow('Disconnected')
    await store.openThread(thread.id)

    expect(api.getItems).toHaveBeenCalledTimes(2)
    expect(store.getState().items[thread.id]).toEqual(history)
  })

  it('refreshes cached background threads and the uncached active thread on reconnect', async () => {
    const background = { ...thread, id: 'background' }
    const unopened = { ...thread, id: 'unopened' }
    store.setState((s) => ({
      app: { ...s.app, threads: [thread, background, unopened] },
      view: { kind: 'thread', id: thread.id },
      items: { [background.id]: history }
    }))
    api.getItems.mockResolvedValue([history[0], ...latest])

    onReconnect()

    await vi.waitFor(() => expect(store.getState().items[thread.id]).toEqual([history[0], ...latest]))
    expect(store.getState().items[background.id]).toEqual([history[0], ...latest])
    expect(api.getItems.mock.calls.map(([id]) => id)).toEqual([thread.id, background.id])
  })

  it.each(['before', 'after'])('keeps new history and live events when an old request resolves %s the reconnect request', async (order) => {
    const oldRequest = deferred<Item[]>()
    const refreshed = deferred<Item[]>()
    api.getItems.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(refreshed.promise)
    const opening = store.openThread(thread.id)
    onReconnect()
    expect(api.getItems).toHaveBeenCalledTimes(2)

    if (order === 'before') {
      oldRequest.resolve([{ id: 'obsolete', kind: 'assistant', text: 'Old snapshot' }])
      await opening
      expect(store.getState().items[thread.id]).toBeUndefined()
    }
    onEvent({ type: 'items', threadId: thread.id, items: latest })
    refreshed.resolve(history)
    await vi.waitFor(() => expect(store.getState().items[thread.id]).toEqual([history[0], ...latest]))
    if (order === 'after') {
      oldRequest.resolve([{ id: 'obsolete', kind: 'assistant', text: 'Old snapshot' }])
      await opening
    }
    expect(store.getState().items[thread.id]).toEqual([history[0], ...latest])
  })

  it('keeps streamed changes received while a cached app conversation is refreshing', async () => {
    store.setState({ items: { [thread.id]: history } })
    const refreshed = deferred<Item[]>()
    api.getItems.mockReturnValueOnce(refreshed.promise)
    onReconnect()
    onEvent({ type: 'items', threadId: thread.id, items: latest })
    refreshed.resolve(history)

    await vi.waitFor(() => expect(store.getState().items[thread.id]).toEqual([history[0], ...latest]))
  })

  it('retries stale cached history when reopening after a failed reconnect refresh', async () => {
    store.setState({ items: { [thread.id]: history } })
    api.getItems.mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValueOnce([history[0], ...latest])
    onReconnect()
    await vi.waitFor(() => expect(store.getState().toast?.text).toBe('Disconnected'))

    await store.openThread(thread.id)

    expect(api.getItems).toHaveBeenCalledTimes(2)
    expect(store.getState().items[thread.id]).toEqual([history[0], ...latest])
  })

  it('marks an opened ended conversation read only after its history is loaded', async () => {
    focused = true
    const request = deferred<Item[]>()
    api.getItems.mockReturnValueOnce(request.promise)
    store.setState((s) => ({ app: { ...s.app, threads: [{ ...thread, unread: true }] } }))

    const opening = store.openThread(thread.id)
    windowEvents.dispatchEvent(new Event('focus'))
    expect(api.updateThread).not.toHaveBeenCalled()
    request.resolve(history)
    await opening

    expect(api.updateThread).toHaveBeenCalledExactlyOnceWith(thread.id, { unread: false })
  })

  it.each(['unfocused', 'hidden', 'running'] as const)('preserves unread when opening a %s conversation', async (condition) => {
    focused = condition !== 'unfocused'
    visible = condition !== 'hidden'
    api.getItems.mockResolvedValue(history)
    store.setState((s) => ({
      app: { ...s.app, threads: [{ ...thread, unread: true }], running: condition === 'running' ? [thread.id] : [] }
    }))

    await store.openThread(thread.id)

    expect(api.updateThread).not.toHaveBeenCalled()
  })

  it('opens a waiting conversation from unread and marks it read after loading without answering', async () => {
    focused = true
    const request = deferred<Item[]>()
    api.getItems.mockReturnValueOnce(request.promise)
    store.setState((s) => ({ app: {
      ...s.app, threads: [{ ...thread, unread: true, archived: true }],
      running: [thread.id], waitingForInput: [thread.id]
    } }))
    const opening = store.openNextUnreadThread()
    expect(api.updateThread).not.toHaveBeenCalled()
    request.resolve([...history, { id: 'question', kind: 'question', toolCallId: 'ask', status: 'pending', questions: [] }])
    await opening
    expect(store.getState().view).toEqual({ kind: 'thread', id: thread.id })
    expect(api.updateThread).toHaveBeenCalledExactlyOnceWith(thread.id, { unread: false })
    expect(store.getState().app.running).toEqual([thread.id])
    expect(store.getState().items[thread.id]!.at(-1)).toMatchObject({ status: 'pending' })
  })

  it.each(['unfocused', 'hidden', 'failed-load'] as const)('preserves waiting question unread on %s', async (condition) => {
    focused = condition !== 'unfocused'
    visible = condition !== 'hidden'
    store.setState((s) => ({ app: {
      ...s.app, threads: [{ ...thread, unread: true }], running: [thread.id], waitingForInput: [thread.id]
    } }))
    if (condition === 'failed-load') api.getItems.mockRejectedValueOnce(new Error('offline'))
    else api.getItems.mockResolvedValueOnce([...history, { id: 'question', kind: 'question', toolCallId: 'ask', status: 'pending', questions: [] }])
    await store.openThread(thread.id).catch(() => {})
    windowEvents.dispatchEvent(new Event('focus'))
    expect(api.updateThread).not.toHaveBeenCalled()
  })

  it('keeps waiting unread until its card arrives when state precedes content', async () => {
    focused = true
    api.getItems.mockResolvedValueOnce(history)
    await store.openThread(thread.id)
    onState({ ...store.getState().app, running: [thread.id], waitingForInput: [thread.id], threads: [{ ...thread, unread: true }] })
    expect(api.updateThread).not.toHaveBeenCalled()
    onEvent({ type: 'items', threadId: thread.id, items: [{ id: 'question', kind: 'question', toolCallId: 'ask', status: 'pending', questions: [] }] })
    await vi.waitFor(() => expect(api.updateThread).toHaveBeenCalledExactlyOnceWith(thread.id, { unread: false }))
  })

  it('reads waiting question state received remotely and clears again when a new question arrives', async () => {
    focused = true
    api.getItems.mockResolvedValueOnce(history)
    await store.openThread(thread.id)
    const waiting = { ...store.getState().app, running: [thread.id], waitingForInput: [thread.id], threads: [{ ...thread, unread: true }] }
    onEvent({ type: 'items', threadId: thread.id, items: [{ id: 'q1', kind: 'question', toolCallId: 'ask', status: 'pending', questions: [] }] })
    onState(waiting)
    await vi.waitFor(() => expect(api.updateThread).toHaveBeenCalledTimes(1))
    onState({ ...waiting, threads: [{ ...thread, unread: false }] })
    documentEvents.dispatchEvent(new Event('visibilitychange'))
    expect(api.updateThread).toHaveBeenCalledTimes(1)
    focused = false
    onEvent({ type: 'items', threadId: thread.id, items: [{ id: 'q2', kind: 'question', toolCallId: 'ask2', status: 'pending', questions: [] }] })
    onState(waiting)
    expect(api.updateThread).toHaveBeenCalledTimes(1)
    focused = true
    windowEvents.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(api.updateThread).toHaveBeenCalledTimes(2))
  })

  it('does not mark an unread conversation after its delayed opening has been replaced', async () => {
    focused = true
    const request = deferred<Item[]>()
    api.getItems.mockReturnValueOnce(request.promise)
    store.setState((s) => ({ app: { ...s.app, threads: [{ ...thread, unread: true }] } }))
    const opening = store.openThread(thread.id)

    store.goHome(project.id)
    request.resolve(history)
    await opening

    expect(store.getState().view.kind).toBe('home')
    expect(api.updateThread).not.toHaveBeenCalled()
  })

  it('preserves unread if fresh CLI history fails to load', async () => {
    focused = true
    api.getItems.mockRejectedValueOnce(new Error('Disconnected'))
    store.setState((s) => ({
      app: { ...s.app, threads: [{ ...thread, source: 'cli', unread: true }] },
      items: { [thread.id]: history }
    }))

    await expect(store.openThread(thread.id)).rejects.toThrow('Disconnected')
    windowEvents.dispatchEvent(new Event('focus'))

    expect(api.updateThread).not.toHaveBeenCalled()
  })

  it('marks only the displayed ended conversation when focus returns', async () => {
    const other = { ...thread, id: 'other', unread: true }
    store.setState((s) => ({
      app: { ...s.app, threads: [{ ...thread, unread: true }, other] },
      items: { [thread.id]: history, [other.id]: latest },
      view: { kind: 'thread', id: thread.id }
    }))

    windowEvents.dispatchEvent(new Event('focus'))
    expect(api.updateThread).not.toHaveBeenCalled()
    focused = true
    windowEvents.dispatchEvent(new Event('focus'))

    await vi.waitFor(() => expect(api.updateThread).toHaveBeenCalledExactlyOnceWith(thread.id, { unread: false }))
  })

  it('marks the current conversation on visibility restore only while focused', async () => {
    visible = false
    store.setState((s) => ({
      app: { ...s.app, threads: [{ ...thread, unread: true }] },
      items: { [thread.id]: history }, view: { kind: 'thread', id: thread.id }
    }))
    focused = true
    windowEvents.dispatchEvent(new Event('focus'))
    expect(api.updateThread).not.toHaveBeenCalled()

    visible = true
    focused = false
    documentEvents.dispatchEvent(new Event('visibilitychange'))
    expect(api.updateThread).not.toHaveBeenCalled()

    focused = true
    documentEvents.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(api.updateThread).toHaveBeenCalledExactlyOnceWith(thread.id, { unread: false }))
  })

  it('marks foreground completion after the state update has ended its run', async () => {
    focused = true
    store.setState((s) => ({
      app: { ...s.app, running: [thread.id] },
      items: { [thread.id]: history }, view: { kind: 'thread', id: thread.id }
    }))

    onEvent({ type: 'running', threadId: thread.id, running: false })
    expect(api.updateThread).not.toHaveBeenCalled()
    onState({ ...store.getState().app, running: [], threads: [{ ...thread, unread: true }] })

    await vi.waitFor(() => expect(api.updateThread).toHaveBeenCalledExactlyOnceWith(thread.id, { unread: false }))
  })

  it.each(['unfocused', 'hidden', 'background'] as const)('preserves %s completion unread until it is viewed', (condition) => {
    focused = condition !== 'unfocused'
    visible = condition !== 'hidden'
    store.setState({
      items: { [thread.id]: history },
      view: condition === 'background' ? { kind: 'home', projectId: project.id } : { kind: 'thread', id: thread.id }
    })

    onState({ ...store.getState().app, threads: [{ ...thread, unread: true }] })
    onEvent({ type: 'running', threadId: thread.id, running: false })

    expect(api.updateThread).not.toHaveBeenCalled()
  })

  it('handles notification opening with the same foreground and loaded-history guards', async () => {
    focused = true
    api.getItems.mockResolvedValue(history)
    onState({ ...store.getState().app, threads: [{ ...thread, unread: true }] })

    onFocusThread(thread.id)

    await vi.waitFor(() => expect(api.updateThread).toHaveBeenCalledExactlyOnceWith(thread.id, { unread: false }))
  })

  it('reports a failed notification history load without clearing unread', async () => {
    focused = true
    api.getItems.mockRejectedValueOnce(new Error('Disconnected'))
    onState({ ...store.getState().app, threads: [{ ...thread, unread: true }] })

    onFocusThread(thread.id)

    await vi.waitFor(() => expect(store.getState().toast?.text).toBe('Disconnected'))
    expect(api.updateThread).not.toHaveBeenCalled()
  })

  it('does not clear running unread when a remote state arrives, then reads its ended state', async () => {
    focused = true
    store.setState({ items: { [thread.id]: history }, view: { kind: 'thread', id: thread.id } })
    onState({ ...store.getState().app, threads: [{ ...thread, unread: true }], running: [thread.id] })
    windowEvents.dispatchEvent(new Event('focus'))
    expect(api.updateThread).not.toHaveBeenCalled()

    onState({ ...store.getState().app, running: [] })
    await vi.waitFor(() => expect(api.updateThread).toHaveBeenCalledExactlyOnceWith(thread.id, { unread: false }))
  })

  it('deduplicates pending read requests and allows retrying a failed update', async () => {
    focused = true
    const request = deferred<void>()
    api.updateThread.mockReturnValueOnce(request.promise)
    store.setState({ items: { [thread.id]: history }, view: { kind: 'thread', id: thread.id } })
    const unreadState = { ...store.getState().app, threads: [{ ...thread, unread: true }] }
    onState(unreadState)
    windowEvents.dispatchEvent(new Event('focus'))
    documentEvents.dispatchEvent(new Event('visibilitychange'))
    onState(unreadState)
    expect(api.updateThread).toHaveBeenCalledTimes(1)

    request.reject(new Error('Disconnected'))
    await vi.waitFor(() => expect(store.getState().toast?.text).toBe('Disconnected'))
    windowEvents.dispatchEvent(new Event('focus'))

    await vi.waitFor(() => expect(api.updateThread).toHaveBeenCalledTimes(2))
  })

  it('reads the successfully refreshed active thread even when background history fails', async () => {
    focused = true
    const background = { ...thread, id: 'background', unread: true }
    const current = deferred<Item[]>()
    api.getItems.mockReturnValueOnce(current.promise).mockRejectedValueOnce(new Error('Background disconnected'))
    store.setState((s) => ({
      app: { ...s.app, threads: [{ ...thread, unread: true }, background] },
      items: { [thread.id]: history, [background.id]: history },
      view: { kind: 'thread', id: thread.id }
    }))

    onReconnect()
    await vi.waitFor(() => expect(store.getState().toast?.text).toBe('Background disconnected'))
    expect(api.updateThread).not.toHaveBeenCalled()
    current.resolve([history[0], ...latest])

    await vi.waitFor(() => expect(api.updateThread).toHaveBeenCalledExactlyOnceWith(thread.id, { unread: false }))
  })

  it('opens and reveals the latest global unread, including a collapsed archived target', async () => {
    focused = true
    const archived = { ...thread, id: 'archived', archived: true, unread: true, updatedAt: 3 }
    const old = { ...thread, id: 'old', pinned: true, unread: true, updatedAt: 1 }
    const running = { ...thread, id: 'running', unread: true, updatedAt: 4 }
    api.getItems.mockResolvedValue(history)
    store.setState((s) => ({
      app: { ...s.app, projects: [{ ...project, collapsed: true }], threads: [old, archived, running], running: [running.id] }
    }))

    await store.openNextUnreadThread()

    expect(store.getState().view).toEqual({ kind: 'thread', id: archived.id })
    expect(store.getState().sidebarReveal).toMatchObject({ threadId: archived.id })
    expect(api.updateProject).toHaveBeenCalledExactlyOnceWith(project.id, { collapsed: false })
    expect(api.updateThread).toHaveBeenCalledExactlyOnceWith(archived.id, { unread: false })
    expect(store.getState().taskNavigationPending).toBe(false)
  })

  it('guards repeated unread clicks while history loads and survives sidebar remounts in store state', async () => {
    const request = deferred<Item[]>()
    api.getItems.mockReturnValueOnce(request.promise)
    store.setState((s) => ({ app: { ...s.app, threads: [{ ...thread, unread: true }] } }))

    const opening = store.openNextUnreadThread()
    expect(store.getState().taskNavigationPending).toBe(true)
    await store.openNextUnreadThread()
    expect(api.getItems).toHaveBeenCalledExactlyOnceWith(thread.id)
    request.resolve(history)
    await opening

    expect(store.getState().taskNavigationPending).toBe(false)
    expect(store.getState().sidebarReveal?.threadId).toBe(thread.id)
    store.goHome(project.id)
    expect(store.getState().sidebarReveal).toBeUndefined()
  })

  it('continues through unread targets after load failures and retries the sole remaining target', async () => {
    const unread = [3, 2, 1].map((updatedAt) => ({ ...thread, id: `unread-${updatedAt}`, unread: true, updatedAt }))
    api.getItems.mockRejectedValue(new Error('History unavailable'))
    store.setState((s) => ({ app: { ...s.app, threads: unread } }))

    for (const target of [...unread, unread[0]]) {
      await store.openNextUnreadThread()
      expect(store.getState().view).toEqual({ kind: 'thread', id: target.id })
      expect(store.getState().taskNavigationPending).toBe(false)
      expect(store.getState().toast?.text).toBe('History unavailable')
    }
    expect(api.updateThread).not.toHaveBeenCalled()
    store.setState((s) => ({ app: { ...s.app, threads: [unread[0]] } }))
    await store.openNextUnreadThread()
    expect(api.getItems).toHaveBeenLastCalledWith(unread[0].id)
  })

  it('advances while read broadcasts are delayed or read marking fails', async () => {
    focused = true
    api.getItems.mockResolvedValue(history)
    api.updateThread.mockRejectedValueOnce(new Error('Read update failed')).mockResolvedValue(undefined)
    const other = { ...thread, id: 'other', unread: true, updatedAt: 2 }
    store.setState((s) => ({ app: { ...s.app, threads: [other, { ...thread, unread: true }] } }))

    await store.openNextUnreadThread()
    expect(store.getState().toast?.text).toBe('Read update failed')
    await store.openNextUnreadThread()

    expect(store.getState().view).toEqual({ kind: 'thread', id: thread.id })
    expect(api.updateThread.mock.calls).toEqual([[other.id, { unread: false }], [thread.id, { unread: false }]])
  })

  it('opens a running archived conversation in another collapsed project without marking it read', async () => {
    focused = true
    const otherProject = { ...project, id: 'other', collapsed: true }
    const archived = { ...thread, id: 'archived', projectId: otherProject.id, archived: true, unread: true, updatedAt: 3 }
    api.getItems.mockResolvedValue(history)
    store.setState((s) => ({ app: {
      ...s.app, projects: [project, otherProject], threads: [thread, archived], running: [thread.id, archived.id]
    } }))

    await store.openNextRunningThread()

    expect(store.getState().view).toEqual({ kind: 'thread', id: archived.id })
    expect(store.getState().sidebarReveal).toMatchObject({ threadId: archived.id })
    expect(store.getState().lastProjectId).toBe(otherProject.id)
    expect(api.updateProject).toHaveBeenCalledExactlyOnceWith(otherProject.id, { collapsed: false })
    expect(api.updateThread).not.toHaveBeenCalled()
    expect(store.getState().app.settings.showArchived).toBe(false)
    expect(store.getState().taskNavigationPending).toBe(false)
  })

  it.each(['running', 'unread'] as const)('blocks both kinds of jump while a %s navigation is loading', async (kind) => {
    const request = deferred<Item[]>()
    api.getItems.mockReturnValueOnce(request.promise)
    const running = { ...thread, id: 'running', unread: true, updatedAt: 2 }
    store.setState((s) => ({ app: {
      ...s.app, threads: [{ ...thread, unread: true }, running], running: [running.id]
    } }))

    const opening = kind === 'running' ? store.openNextRunningThread() : store.openNextUnreadThread()
    expect(store.getState().taskNavigationPending).toBe(true)
    await store.openNextRunningThread()
    await store.openNextUnreadThread()
    const targetId = kind === 'running' ? running.id : thread.id
    expect(api.getItems).toHaveBeenCalledExactlyOnceWith(targetId)
    expect(store.getState().view).toEqual({ kind: 'thread', id: targetId })
    request.resolve(history)
    await opening

    expect(store.getState().taskNavigationPending).toBe(false)
    expect(store.getState().sidebarReveal?.threadId).toBe(targetId)
  })

  it('cycles running targets after load failures and retries the sole remaining target', async () => {
    const running = [3, 2, 1].map((updatedAt) => ({ ...thread, id: `running-${updatedAt}`, unread: true, updatedAt }))
    api.getItems.mockRejectedValue(new Error('History unavailable'))
    store.setState((s) => ({ app: { ...s.app, threads: running, running: running.map((item) => item.id) } }))

    for (const target of [...running, running[0]]) {
      await store.openNextRunningThread()
      expect(store.getState().view).toEqual({ kind: 'thread', id: target.id })
      expect(store.getState().taskNavigationPending).toBe(false)
      expect(store.getState().toast?.text).toBe('History unavailable')
    }
    store.setState((s) => ({ app: { ...s.app, running: [running[0].id] } }))
    api.getItems.mockResolvedValueOnce(history)
    await store.openNextRunningThread()
    expect(api.getItems).toHaveBeenLastCalledWith(running[0].id)
    expect(store.getState().items[running[0].id]).toEqual(history)
    expect(api.updateThread).not.toHaveBeenCalled()
  })

  it('releases task navigation after a project expansion fails', async () => {
    api.getItems.mockResolvedValue(history)
    api.updateProject.mockRejectedValueOnce(new Error('Expansion failed'))
    store.setState((s) => ({ app: { ...s.app, projects: [{ ...project, collapsed: true }], running: [thread.id] } }))

    await store.openNextRunningThread()

    expect(store.getState().view).toEqual({ kind: 'thread', id: thread.id })
    expect(store.getState().toast?.text).toBe('Expansion failed')
    expect(store.getState().taskNavigationPending).toBe(false)
    await store.openNextRunningThread()
    expect(api.updateProject).toHaveBeenCalledTimes(2)
  })

  it('marks a running jump target read only after it ends and its foreground history finishes loading', async () => {
    focused = true
    const request = deferred<Item[]>()
    api.getItems.mockReturnValueOnce(request.promise)
    store.setState((s) => ({ app: { ...s.app, threads: [{ ...thread, unread: true }], running: [thread.id] } }))

    const opening = store.openNextRunningThread()
    onState({ ...store.getState().app, running: [] })
    expect(api.updateThread).not.toHaveBeenCalled()
    request.resolve(history)
    await opening

    expect(api.updateThread).toHaveBeenCalledExactlyOnceWith(thread.id, { unread: false })
    expect(store.getState().taskNavigationPending).toBe(false)
  })

  it('does nothing when no existing running conversations remain', async () => {
    store.setState((s) => ({ app: { ...s.app, running: ['deleted'] } }))

    await store.openNextRunningThread()

    expect(api.getItems).not.toHaveBeenCalled()
    expect(store.getState().view.kind).toBe('home')
    expect(store.getState().sidebarReveal).toBeUndefined()
    expect(store.getState().taskNavigationPending).toBeFalsy()
  })

  it('collapses projects through one API call without navigating and clears the last reveal', async () => {
    api.collapseAllProjects.mockResolvedValue(undefined)
    store.setState({ view: { kind: 'thread', id: thread.id }, sidebarReveal: { threadId: thread.id, token: 1 } })

    await store.collapseAllProjects()

    expect(api.collapseAllProjects).toHaveBeenCalledTimes(1)
    expect(api.updateProject).not.toHaveBeenCalled()
    expect(store.getState().view).toEqual({ kind: 'thread', id: thread.id })
    expect(store.getState().sidebarReveal).toBeUndefined()
  })

  it('does nothing when no ended unread conversations remain', async () => {
    store.setState((s) => ({ app: { ...s.app, threads: [{ ...thread, unread: true }], running: [thread.id] } }))

    await store.openNextUnreadThread()

    expect(api.getItems).not.toHaveBeenCalled()
    expect(store.getState().view.kind).toBe('home')
    expect(store.getState().sidebarReveal).toBeUndefined()
  })
})
