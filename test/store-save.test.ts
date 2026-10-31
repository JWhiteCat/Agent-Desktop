import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/main/store'
import { writeTextSafely } from '../src/main/local-files'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electron.userData } }))
vi.mock('../src/main/local-files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/local-files')>()
  return { ...actual, writeTextSafely: vi.fn(actual.writeTextSafely) }
})

describe('store saves', () => {
  let store: Store
  const stateFile = () => path.join(electron.userData, 'data', 'state.json')
  const threadFile = (id: string) => path.join(electron.userData, 'data', 'threads', `${id}.json`)
  const savedItems = (id: string) => fs.existsSync(threadFile(id)) ? JSON.parse(fs.readFileSync(threadFile(id), 'utf8')) : undefined

  beforeEach(() => {
    vi.useFakeTimers()
    electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-store-save-'))
    store = new Store()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.mocked(writeTextSafely).mockClear()
    const dir = path.resolve(electron.userData)
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('agent-desktop-store-save-')) {
      throw new Error(`Unexpected test directory: ${dir}`)
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const newThread = () => {
    const project = store.addProject(electron.userData, 'project')
    const thread = store.createThread({ projectId: project.id, title: 'Task', mode: 'agent', source: 'app' })
    store.flush()
    return thread
  }

  it('batches streamed item changes without rewriting the state file', () => {
    const thread = newThread()
    const state = fs.readFileSync(stateFile(), 'utf8')
    vi.mocked(writeTextSafely).mockClear()

    store.items(thread.id).push({ id: 'a', kind: 'assistant', text: 'hello' })
    store.markItemsDirty(thread.id)
    vi.advanceTimersByTime(400)
    expect(savedItems(thread.id)).toBeUndefined()
    vi.advanceTimersByTime(1600)
    expect(savedItems(thread.id)).toEqual([{ id: 'a', kind: 'assistant', text: 'hello' }])
    expect(vi.mocked(writeTextSafely).mock.calls.map(([file]) => file)).toEqual([threadFile(thread.id)])
    expect(fs.readFileSync(stateFile(), 'utf8')).toBe(state)
  })

  it('saves pending items with the next metadata change, on the shorter deadline', () => {
    const thread = newThread()
    store.items(thread.id).push({ id: 'a', kind: 'assistant', text: 'done' })
    store.markItemsDirty(thread.id)
    store.updateThread(thread.id, { unread: true })
    vi.advanceTimersByTime(400)
    expect(savedItems(thread.id)).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).threads[0].unread).toBe(true)
  })

  it('retries a failed save instead of keeping changes only in memory', () => {
    const thread = newThread()
    vi.mocked(writeTextSafely).mockImplementationOnce(() => { throw Object.assign(new Error('locked'), { code: 'EPERM' }) })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    store.updateThread(thread.id, { title: 'Renamed' })
    vi.advanceTimersByTime(400)
    expect(error).toHaveBeenCalled()
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).threads[0].title).toBe('Task')
    vi.advanceTimersByTime(5000)
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).threads[0].title).toBe('Renamed')
    error.mockRestore()
  })
})
