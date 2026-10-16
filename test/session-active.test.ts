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
import { collectEditedFiles } from '../src/renderer/src/lib/diff'

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
  const manager = new SessionManager(store as unknown as Store, vi.fn(), vi.fn(), finished)
  managers.push(manager)
  const req: SendRequest = { threadId: thread.id, prompt: 'Continue', model: 'auto', mode: 'agent', force: false }
  return {
    manager, req, thread, store, items, calls, reply, finished,
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
      expect(collectEditedFiles(reloaded, root)).toEqual([
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
