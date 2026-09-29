import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMode, ThreadMeta } from '../src/shared/types'
import type { IpcDeps } from '../src/main/ipc/deps'
import { threadHandlers } from '../src/main/ipc/threads'
import { Store } from '../src/main/store'
import { getState, setState, startThread } from '../src/renderer/src/store'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData' || !electron.userData) throw new Error(`Unexpected app path: ${name}`)
      return electron.userData
    }
  }
}))

describe('thread permission persistence', () => {
  let store: Store
  let projectId: string
  let handlers: ReturnType<typeof threadHandlers>
  let send: ReturnType<typeof vi.fn>
  let broadcast: ReturnType<typeof vi.fn>

  beforeEach(() => {
    electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-permissions-'))
    store = new Store()
    store.updateSettings({ cliProvider: 'codex' })
    projectId = store.addProject(electron.userData, 'Permission regression').id
    send = vi.fn(async () => undefined)
    broadcast = vi.fn()
    handlers = threadHandlers({ store, sessions: { send, isRunning: () => false }, broadcast } as unknown as IpcDeps)
    vi.stubGlobal('localStorage', { setItem: vi.fn() })
    vi.stubGlobal('window', {
      api: {
        createThread: async (id: string, mode: AgentMode, model: string, force?: boolean) =>
          handlers['thread:create'](id, mode, model, force),
        send: async (req: unknown) => handlers['agent:send'](req)
      }
    })
    setState({
      app: { projects: store.projects, threads: [], settings: store.settings, running: [] },
      items: {},
      view: { kind: 'home', projectId }
    })
  })

  afterEach(() => {
    store?.flush()
    vi.unstubAllGlobals()
    const dir = path.resolve(electron.userData)
    const tempRoot = path.resolve(os.tmpdir())
    if (path.dirname(dir) !== tempRoot || !path.basename(dir).startsWith('agent-desktop-permissions-')) {
      throw new Error(`Refusing to remove unexpected test directory: ${dir}`)
    }
    fs.rmSync(dir, { recursive: true, force: true })
    electron.userData = ''
  })

  function reload(): Store {
    store.flush()
    return new Store()
  }

  it.each([true, false])('keeps the home composer choice force=%s across navigation and restart', async (force) => {
    store.updateSettings({ force: !force })
    const options = { mode: 'agent' as const, model: 'gpt-5.4', force }

    const thread = await startThread(projectId, 'Continue this project', options)

    expect(send).toHaveBeenCalledExactlyOnceWith({ threadId: thread.id, prompt: 'Continue this project', ...options })
    expect(getState().view).toEqual({ kind: 'thread', id: thread.id })
    expect(getState().app.threads.find((item) => item.id === thread.id)?.force).toBe(force)
    expect(reload().thread(thread.id)).toMatchObject({ cli: 'codex', force })
    expect(broadcast).toHaveBeenCalledOnce()
  })

  it.each([true, false])('uses the global force=%s default when older clients omit it', (force) => {
    store.updateSettings({ force })

    const thread = handlers['thread:create'](projectId, 'agent', 'gpt-5.4') as ThreadMeta

    expect(thread.force).toBe(force)
    // A later global setting change must not overwrite this thread's saved selection.
    store.updateSettings({ force: !force })
    expect(reload().thread(thread.id)?.force).toBe(force)
  })

  it.each([true, false])('saves a permission toggle to force=%s before another message is sent', (force) => {
    const thread = handlers['thread:create'](projectId, 'agent', 'gpt-5.4', !force) as ThreadMeta

    handlers['thread:update'](thread.id, { force })

    expect(send).not.toHaveBeenCalled()
    expect(reload().thread(thread.id)?.force).toBe(force)
  })

  it.each([true, false])('preserves force=%s when forking a conversation', (force) => {
    store.updateSettings({ force: !force })
    const thread = handlers['thread:create'](projectId, 'agent', 'gpt-5.4', force) as ThreadMeta
    store.setItems(thread.id, [{ id: 'user-1', kind: 'user', text: 'Start here', createdAt: Date.now() }])

    const result = handlers['thread:fork'](thread.id) as { thread: ThreadMeta }

    expect(result.thread.id).not.toBe(thread.id)
    expect(reload().thread(result.thread.id)?.force).toBe(force)
  })
})
