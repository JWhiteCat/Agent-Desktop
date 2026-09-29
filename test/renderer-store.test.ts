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
  const api = {
    getState: vi.fn(),
    getItems: vi.fn(),
    onState: vi.fn(),
    onEvent: vi.fn(),
    onFocusThread: vi.fn(),
    listModels: vi.fn(),
    prepareCommands: vi.fn(),
    updateProject: vi.fn(),
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
    vi.stubGlobal('window', { api })
    vi.stubGlobal('document', { hasFocus: () => false })
    api.getState.mockResolvedValue({
      projects: [{ ...project }], threads: [{ ...thread }],
      settings: { ...DEFAULT_SETTINGS }, running: []
    } satisfies AppState)
    api.onEvent.mockImplementation((listener) => { onEvent = listener; return () => {} })
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
})
