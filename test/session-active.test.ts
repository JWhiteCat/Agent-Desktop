import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type CliProvider, type Item, type SendRequest, type ThreadMeta } from '../src/shared/types'
import { createWorktree } from '../src/main/git'
import { spawnProvider } from '../src/main/session/provider'
import { SessionManager } from '../src/main/sessions'
import type { Store } from '../src/main/store'
import { isolateGitEnvironment } from './helpers/git-environment'
import { collectEditedFiles, collectSnapshotTurns } from '../src/renderer/src/lib/diff'

vi.mock('../src/main/skills', () => ({ syncAllManagedSkills: vi.fn() }))
vi.mock('../src/main/git', () => ({ createWorktree: vi.fn() }))
vi.mock('../src/main/session/provider', async (original) => ({
  ...await original<typeof import('../src/main/session/provider')>(),
  resolveLaunch: () => ({ cli: { command: 'mock-agent', prefixArgs: [] } }),
  providerApiKey: () => 'mock-key',
  spawnProvider: vi.fn()
}))
vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(),
  killTree: vi.fn((child: ChildProcess) => {
    Object.assign(child, { exitCode: 0 })
    child.emit('close', 0)
  })
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

interface RpcMessage {
  id?: number | string
  method?: string
  params?: any
  result?: any
}

const managers: SessionManager[] = []
let workspace: string

function setup(provider: CliProvider = 'cursor', initialization?: Promise<void>, cwd = workspace) {
  const stdout = new PassThrough()
  const calls: RpcMessage[] = []
  let promptId: number | string | undefined
  const reply = (message: RpcMessage) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const respond = async (message: RpcMessage) => {
    if (message.method === 'initialize') await initialization
    if (message.method === 'session/load') reply({
      method: 'session/update',
      params: { sessionId: 'test-session', update: { sessionUpdate: 'available_commands_update', availableCommands: [] } }
    })
    reply({ id: message.id, result: message.method === 'session/new' ? { sessionId: 'test-session' } : {} })
  }
  const child = Object.assign(new EventEmitter(), {
    stdout, stderr: new PassThrough(), exitCode: null,
    stdin: new Writable({ write(chunk, _encoding, callback) {
      const message: RpcMessage = JSON.parse(chunk.toString())
      calls.push(message)
      if (message.method === 'session/prompt') promptId = message.id
      else if (message.method && message.id !== undefined) void respond(message)
      callback()
    } })
  }) as unknown as ChildProcess
  vi.mocked(spawnProvider).mockReturnValue(child)
  const thread = { id: 'thread', projectId: 'project', cli: provider, mode: 'agent' } as ThreadMeta
  const items: Item[] = []
  const store = {
    dataDir: os.tmpdir(), settings: { ...DEFAULT_SETTINGS },
    thread: (id: string) => id === thread.id ? thread : undefined,
    project: () => ({ id: 'project', path: cwd }),
    items: () => items, markItemsDirty: vi.fn(),
    updateThread: vi.fn((_id: string, patch: Partial<ThreadMeta>) => Object.assign(thread, patch))
  }
  const finished = vi.fn()
  const emit = vi.fn()
  const stateChanged = vi.fn()
  const manager = new SessionManager(store as unknown as Store, emit, stateChanged, finished)
  managers.push(manager)
  const req: SendRequest = { threadId: thread.id, prompt: 'Continue', model: 'auto', mode: 'agent', force: false }
  return {
    manager, req, thread, store, items, calls, reply, finished, emit, stateChanged,
    waitForPrompt: () => vi.waitFor(() => expect(promptId).toBeDefined()),
    complete: () => reply({ id: promptId, result: { stopReason: 'end_turn' } })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-active-'))
})
afterEach(async () => {
  const current = managers.splice(0)
  for (const manager of current) manager.stopAll()
  await vi.waitFor(() => expect(current.every((manager) => !manager.active().length)).toBe(true))
  const resolved = path.resolve(workspace)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-active-')) throw new Error('Unexpected test directory')
  fs.rmSync(resolved, { recursive: true, force: true })
})

describe('unfinished session activity', () => {
  it.each([
    { ending: 'complete', repository: true }, { ending: 'exit', repository: true },
    { ending: 'complete', repository: false }, { ending: 'exit', repository: false }
  ])('persists script-only file changes on $ending (Git repository: $repository)', async ({ ending, repository }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-session-files-'))
    let ctx: ReturnType<typeof setup> | undefined
    try {
      isolateGitEnvironment(root)
      if (repository) execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true })
      fs.writeFileSync(path.join(root, 'file.txt'), 'before\n')
      ctx = setup('cursor', undefined, root)
      await ctx.manager.send({ ...ctx.req, model: 'composer-2.5[fast=true]' })
      await ctx.waitForPrompt()
      fs.writeFileSync(path.join(root, 'file.txt'), 'after\n')
      if (ending === 'complete') ctx.complete()
      else ctx.manager.dispose('thread')
      await vi.waitFor(() => expect(ctx!.finished).toHaveBeenCalledOnce())
      const reloaded = JSON.parse(JSON.stringify(ctx.items)) as Item[]
      expect(collectEditedFiles(reloaded, root)).toEqual([])
      expect(collectSnapshotTurns(reloaded, root).at(-1)?.files).toEqual([
        { path: 'file.txt', lines: ['@@ -1,1 +1,1 @@', '-before', '+after'], added: 1, removed: 1 }
      ])
      expect(ctx.manager.active()).toEqual([])
    } finally {
      ctx?.manager.stopAll()
      vi.unstubAllEnvs()
      const resolved = path.resolve(root)
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-session-files-')) throw new Error('Unexpected test directory')
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  })

  it.each(['cursor', 'codex', 'claude'] as const)('separates %s tool evidence from external writes and ignores unrelated sessions', async (provider) => {
    fs.writeFileSync(path.join(workspace, 'shared.txt'), 'before\n')
    const ctx = setup(provider)
    await ctx.manager.send(ctx.req)
    await ctx.waitForPrompt()
    const notify = (sessionId: string, update: object) => ctx.reply({ method: 'session/update', params: { sessionId, update } })
    notify('foreign-session', { sessionUpdate: 'tool_call', toolCallId: 'foreign', kind: 'edit', status: 'completed',
      content: [{ type: 'diff', path: 'foreign.txt', oldText: null, newText: 'foreign' }] })
    notify('test-session', { sessionUpdate: 'tool_call', toolCallId: 'edit', kind: 'edit', status: 'pending',
      content: [{ type: 'diff', path: 'shared.txt', oldText: 'before\n', newText: 'agent\n' }] })
    fs.writeFileSync(path.join(workspace, 'shared.txt'), 'agent\n')
    notify('test-session', { sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed' })
    fs.writeFileSync(path.join(workspace, 'shared.txt'), 'external final\n')
    fs.writeFileSync(path.join(workspace, 'outside.txt'), 'external only\n')
    ctx.complete()
    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledOnce())
    const reloaded = JSON.parse(JSON.stringify(ctx.items)) as Item[]
    expect(collectEditedFiles(reloaded, workspace)).toMatchObject([
      { path: 'shared.txt', added: 1, removed: 1, lines: ['@@ -1,1 +1,1 @@', '-before', '+agent'] }
    ])
    const snapshot = collectSnapshotTurns(reloaded, workspace).at(-1)!
    expect(snapshot.files?.map((file) => file.path).sort()).toEqual(['outside.txt', 'shared.txt'])
    expect(snapshot.files?.find((file) => file.path === 'shared.txt')?.lines).toContain('+external final')
  })

  it('keeps an empty snapshot on an interrupted turn with no result from the CLI', async () => {
    const ctx = setup()
    await ctx.manager.send(ctx.req)
    await ctx.waitForPrompt()
    ctx.manager.dispose('thread')
    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledOnce())
    expect(collectSnapshotTurns(ctx.items).at(-1)?.files).toEqual([])
  })

  it('counts a send immediately and throughout worktree startup and execution, then excludes the idle process', async () => {
    const worktree = deferred<string>()
    vi.mocked(createWorktree).mockReturnValue(worktree.promise)
    const ctx = setup('claude')
    const sending = ctx.manager.send({ ...ctx.req, worktree: true })
    expect(ctx.manager.active()).toEqual(['thread'])
    expect(ctx.manager.running()).toEqual([])
    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledOnce())
    expect(ctx.manager.active()).toEqual(['thread'])
    expect(spawnProvider).not.toHaveBeenCalled()
    worktree.resolve(workspace)
    await sending
    await ctx.waitForPrompt()
    expect(ctx.manager.running()).toEqual(['thread'])
    expect(ctx.manager.active()).toEqual(['thread'])
    ctx.complete()
    await vi.waitFor(() => expect(ctx.finished).toHaveBeenCalledOnce())
    expect(ctx.manager.active()).toEqual([])
    expect(spawnProvider).toHaveBeenCalledOnce()
  })

  it('keeps permission decisions and questions active while waiting for answers', async () => {
    const ctx = setup()
    await ctx.manager.send(ctx.req)
    await ctx.waitForPrompt()
    ctx.reply({ id: 'permission', method: 'session/request_permission', params: {
      toolCall: { toolCallId: 'shell', title: 'Run command', kind: 'execute' },
      options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }]
    } })
    ctx.reply({ id: 'question', method: 'cursor/ask_question', params: {
      toolCallId: 'ask', questions: [{ id: 'choice', prompt: 'Which approach?', options: ['Small', 'Large'] }]
    } })
    await vi.waitFor(() => expect(ctx.items.filter((item) => item.kind === 'question' && item.status === 'pending')).toHaveLength(2))
    expect(ctx.manager.active()).toEqual(['thread'])
    expect(ctx.calls.some((call) => call.id === 'permission' || call.id === 'question')).toBe(false)
    ctx.manager.stopAll()
    await vi.waitFor(() => expect(ctx.manager.active()).toEqual([]))
  })

  it.each(['cursor', 'codex', 'claude'] as const)('marks new %s questions unread and publishes cards before state', async (provider) => {
    const ctx = setup(provider)
    await ctx.manager.send({ ...ctx.req, model: 'composer-2.5[fast=true]' })
    await ctx.waitForPrompt()
    expect(ctx.manager.waitingForInput()).toEqual([])
    const ask = (id: string) => ctx.reply({ id, method: 'cursor/ask_question', params: {
      toolCallId: id, questions: [{ id: 'choice', prompt: 'Which approach?', options: ['Small', 'Large'] }]
    } })
    ask('first')
    await vi.waitFor(() => expect(ctx.manager.waitingForInput()).toEqual(['thread']))
    expect(ctx.thread.unread).toBe(true)
    expect(ctx.thread.updatedAt).toBeGreaterThan(0)
    const emitted = ctx.emit.mock.calls.at(-1)![0]
    expect(emitted).toMatchObject({ type: 'items', items: expect.arrayContaining([expect.objectContaining({ kind: 'question', status: 'pending' })]) })
    expect(ctx.emit.mock.invocationCallOrder.at(-1)!).toBeLessThan(ctx.stateChanged.mock.invocationCallOrder.at(-1)!)
    const first = ctx.items.find((item) => item.kind === 'question')!

    // Viewing clears unread even while the question is still pending.
    ctx.thread.unread = false
    ;(ctx.manager as any).queue('thread', (ctx.manager as any).runs.get('thread'), [first])
    expect(ctx.thread.unread).toBe(false)
    expect(ctx.manager.waitingForInput()).toEqual(['thread'])
    ask('second')
    await vi.waitFor(() => expect(ctx.items.filter((item) => item.kind === 'question')).toHaveLength(2))
    expect(ctx.thread.unread).toBe(true)
    expect(ctx.manager.waitingForInput()).toEqual(['thread'])
    ctx.thread.unread = false
    ctx.manager.answerQuestion('thread', first.id, [{ questionId: 'choice', selectedOptionIds: ['o0'] }])
    expect(ctx.manager.waitingForInput()).toEqual(['thread'])
    expect(ctx.thread.unread).toBe(false)
    const second = ctx.items.find((item) => item.kind === 'question' && item.id !== first.id)!
    ctx.manager.answerQuestion('thread', second.id, null)
    expect(ctx.manager.waitingForInput()).toEqual([])
    expect(ctx.manager.running()).toEqual(['thread'])
    expect(ctx.thread.unread).toBe(false)
    ctx.complete()
    await vi.waitFor(() => expect(ctx.manager.running()).toEqual([]))
    expect(ctx.thread.unread).toBe(true)
  })

  it.each(['stop', 'dispose', 'complete'] as const)('clears waiting input when a pending permission ends by %s', async (ending) => {
    const ctx = setup()
    await ctx.manager.send(ctx.req)
    await ctx.waitForPrompt()
    ctx.reply({ id: 'permission', method: 'session/request_permission', params: {
      toolCall: { toolCallId: 'shell', title: 'Run command', kind: 'execute' },
      options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }]
    } })
    await vi.waitFor(() => expect(ctx.manager.waitingForInput()).toEqual(['thread']))
    expect(ctx.thread.unread).toBe(true)
    if (ending === 'complete') ctx.complete()
    else ctx.manager[ending]('thread')
    await vi.waitFor(() => expect(ctx.manager.waitingForInput()).toEqual([]))
    expect(ctx.items.find((item) => item.kind === 'question')).toMatchObject({ status: 'skipped' })
    if (ending === 'stop') ctx.complete()
    await vi.waitFor(() => expect(ctx.manager.running()).toEqual([]))
  })

  it('does not count prepare alone, but includes sends queued behind it', async () => {
    const initialized = deferred<void>()
    const ctx = setup('cursor', initialized.promise)
    ctx.thread.chatId = 'test-session'
    const preparing = ctx.manager.prepare('thread', ctx.req)
    await vi.waitFor(() => expect(ctx.calls.some((call) => call.method === 'initialize')).toBe(true))
    expect(ctx.manager.active()).toEqual([])
    const sending = ctx.manager.send(ctx.req)
    expect(ctx.manager.active()).toEqual(['thread'])
    expect(ctx.manager.running()).toEqual([])
    initialized.resolve()
    await preparing
    await sending
    await ctx.waitForPrompt()
    expect(spawnProvider).toHaveBeenCalledOnce()
    ctx.complete()
    await vi.waitFor(() => expect(ctx.manager.active()).toEqual([]))
    await ctx.manager.prepare('thread', ctx.req)
    expect(ctx.manager.active()).toEqual([])
  })

  it('retains another queued send for the same thread after a validation failure', async () => {
    const worktree = deferred<string>()
    vi.mocked(createWorktree).mockReturnValue(worktree.promise)
    const ctx = setup('claude')
    const invalid = ctx.manager.send({ ...ctx.req, prompt: '' }).catch((error: Error) => error)
    const sending = ctx.manager.send({ ...ctx.req, worktree: true })
    expect(ctx.manager.active()).toEqual(['thread'])
    expect(await invalid).toMatchObject({ message: '请输入消息或添加附件' })
    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledOnce())
    expect(ctx.manager.active()).toEqual(['thread'])
    expect(ctx.manager.running()).toEqual([])
    worktree.reject(new Error('Cannot create worktree'))
    await expect(sending).rejects.toThrow('Cannot create worktree')
    expect(ctx.manager.active()).toEqual([])
    expect(spawnProvider).not.toHaveBeenCalled()
  })

  it('rejects in-progress startup and queued sends without starting a late process after shutdown', async () => {
    const worktree = deferred<string>()
    vi.mocked(createWorktree).mockReturnValue(worktree.promise)
    const ctx = setup('claude')
    const sending = ctx.manager.send({ ...ctx.req, worktree: true }).catch((error: Error) => error)
    const queued = ctx.manager.send(ctx.req).catch((error: Error) => error)
    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledOnce())
    ctx.manager.stopAll()
    worktree.resolve(workspace)
    expect(await sending).toMatchObject({ message: '应用正在关闭' })
    expect(await queued).toMatchObject({ message: '应用正在关闭' })
    await expect(ctx.manager.send(ctx.req)).rejects.toThrow('应用正在关闭')
    expect(ctx.manager.active()).toEqual([])
    expect(spawnProvider).not.toHaveBeenCalled()
    expect(ctx.store.updateThread).not.toHaveBeenCalled()
    expect(ctx.items).toEqual([])
  })
})
