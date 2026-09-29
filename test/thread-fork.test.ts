import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliProvider, Item } from '../src/shared/types'
import { Store } from '../src/main/store'
import { forkThread, syncFromCli, type HistoryDeps } from '../src/main/thread-history'
import { findChatDir, readCliTranscript } from '../src/main/history'
import { materializeCliFork, planCliFork } from '../src/main/fork'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electron.userData } }))
vi.mock('../src/main/history', () => ({ findChatDir: vi.fn(), readCliTranscript: vi.fn(), UNTITLED: 'Untitled' }))
vi.mock('../src/main/fork', () => ({ materializeCliFork: vi.fn(), planCliFork: vi.fn() }))

describe('conversation forks', () => {
  let store: Store
  let deps: HistoryDeps
  let projectId: string
  const transcript: Item[] = [
    { id: 'u1', kind: 'user', text: 'Remember violet-42', createdAt: 10 },
    { id: 'a1', kind: 'assistant', text: 'I will remember violet-42.' },
    { id: 'r1', kind: 'result', isError: false, usageId: 'original-usage', usage: { inputTokens: 12 } },
    { id: 'u2', kind: 'user', text: 'Replace it with green-7', createdAt: 20 },
    { id: 'a2', kind: 'assistant', text: 'Now green-7.' }
  ]

  beforeEach(() => {
    vi.resetAllMocks()
    electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-fork-'))
    store = new Store()
    projectId = store.addProject(electron.userData).id
    deps = { store, isRunning: () => false, forkSession: vi.fn().mockResolvedValue({ chatId: 'fork-chat', cwd: electron.userData }), broadcast: vi.fn() }
  })

  afterEach(() => {
    store.flush()
    const dir = path.resolve(electron.userData)
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('agent-desktop-fork-')) {
      throw new Error(`Unexpected test directory: ${dir}`)
    }
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function source(cli: CliProvider, chatId: string | undefined = 'original-chat') {
    const thread = store.createThread({ projectId, cli, chatId, title: 'Memory', mode: 'ask', force: false, model: 'composer-2.5[fast=true]', source: 'app' })
    store.setItems(thread.id, structuredClone(transcript))
    return thread
  }

  it.each(['codex', 'claude'] as const)('creates an independent native %s session for a whole conversation', async (cli) => {
    const original = source(cli)
    const result = await forkThread(deps, original.id)
    expect(deps.forkSession).toHaveBeenCalledExactlyOnceWith(original.id)
    expect(result.thread).toMatchObject({ cli, chatId: 'fork-chat', force: false, title: '(1) Memory' })
    expect(result.thread.forkContextThroughItemId).toBeUndefined()
    expect(result.items).toHaveLength(transcript.length)
    expect(result.items[2]).toMatchObject({ usageId: 'original-usage' })
    expect(original.chatId).toBe('original-chat')
    expect(store.items(original.id)).toEqual(transcript)
    expect(new Set([...result.items, ...transcript].map((item) => item.id)).size).toBe(10)
  })

  it.each(['cursor', 'codex', 'claude'] as const)('persists the exact selected prefix for a %s fallback', async (cli) => {
    const original = source(cli)
    const result = await forkThread(deps, original.id, 'a1')
    expect(result.thread.chatId).toBeUndefined()
    expect(result.items.slice(0, 2).map((item) => 'text' in item ? item.text : '')).toEqual(['Remember violet-42', 'I will remember violet-42.'])
    expect(result.items).toHaveLength(3)
    expect(result.thread.forkContextThroughItemId).toBe(result.items[1].id)
    expect(deps.forkSession).not.toHaveBeenCalled()
    store.flush()
    const reloaded = new Store()
    expect(reloaded.thread(result.thread.id)?.forkContextThroughItemId).toBe(result.items[1].id)
    expect(reloaded.items(result.thread.id)).toEqual(result.items)
    expect(store.items(original.id)).toEqual(transcript)
  })

  it('uses the Cursor CLI copy when the selected history can be represented', async () => {
    const original = source('cursor')
    vi.mocked(findChatDir).mockReturnValue('cursor-dir')
    vi.mocked(planCliFork).mockReturnValue({ linked: true, extraBlobs: [] })
    vi.mocked(materializeCliFork).mockReturnValue({ chatId: 'cursor-copy' })
    const result = await forkThread(deps, original.id)
    expect(result.thread.chatId).toBe('cursor-copy')
    expect(result.thread.forkContextThroughItemId).toBeUndefined()
  })

  it('retains context if native copying fails', async () => {
    const original = source('codex')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(deps.forkSession).mockRejectedValue(new Error('unsupported'))
    const result = await forkThread(deps, original.id)
    expect(result.thread.chatId).toBeUndefined()
    expect(result.thread.forkContextThroughItemId).toBe(result.items[4].id)
  })

  it('uses the frozen prefix when the source advances during native copying', async () => {
    const original = source('claude')
    vi.mocked(deps.forkSession).mockImplementation(async () => {
      store.items(original.id).push({ id: 'later', kind: 'assistant', text: 'Later content' })
      return { chatId: 'newer-copy', cwd: electron.userData }
    })
    const result = await forkThread(deps, original.id)
    expect(result.thread.chatId).toBeUndefined()
    expect(result.thread.forkContextThroughItemId).toBeTruthy()
    expect(JSON.stringify(result.items)).not.toContain('Later content')
  })

  it('keeps pending history when forking again or trying to sync an unseeded session', async () => {
    const original = source('codex')
    const first = await forkThread(deps, original.id, 'a1')
    store.updateThread(first.thread.id, { chatId: 'empty-after-failed-send' })
    const second = await forkThread(deps, first.thread.id)
    expect(deps.forkSession).not.toHaveBeenCalled()
    expect(second.thread.forkContextThroughItemId).toBeTruthy()
    expect(() => syncFromCli(deps, first.thread.id)).toThrow('分叉上下文尚未写入')
    expect(store.items(first.thread.id)).toEqual(first.items)
  })

  it('rejects running or invalid cuts before creating another conversation', async () => {
    const original = source('cursor')
    await expect(forkThread({ ...deps, isRunning: () => true }, original.id)).rejects.toThrow('正在运行')
    await expect(forkThread(deps, original.id, 'missing')).rejects.toThrow('找不到')
    expect(store.threads).toHaveLength(1)
  })

  it('preserves saved history when the CLI returns an empty transcript', () => {
    const original = source('cursor')
    vi.mocked(readCliTranscript).mockReturnValue([])

    expect(syncFromCli(deps, original.id)).toBeUndefined()
    expect(store.items(original.id)).toEqual(transcript)
    expect(store.thread(original.id)?.syncedAt).toBeUndefined()
    store.flush()
    const reloaded = new Store()
    expect(reloaded.items(original.id)).toEqual(transcript)
  })
})
