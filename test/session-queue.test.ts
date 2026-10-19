import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Item, type SendRequest, type ThreadMeta } from '../src/shared/types'
import { spawnProvider } from '../src/main/session/provider'
import { SessionManager } from '../src/main/sessions'
import type { Store } from '../src/main/store'

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

interface RpcMessage {
  id?: number | string
  method?: string
  params?: any
  result?: any
}

const managers: SessionManager[] = []
let workspace: string

function setup() {
  const stdout = new PassThrough()
  const calls: RpcMessage[] = []
  const prompts: Array<{ id: number | string; text: string }> = []
  let open: number | string | undefined
  const reply = (message: RpcMessage) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const child = Object.assign(new EventEmitter(), {
    stdout, stderr: new PassThrough(), exitCode: null,
    stdin: new Writable({ write(chunk, _encoding, callback) {
      const message: RpcMessage = JSON.parse(chunk.toString())
      calls.push(message)
      if (message.method === 'session/prompt') {
        open = message.id
        prompts.push({ id: message.id!, text: message.params.prompt[0].text })
      } else if (message.method === 'session/cancel') {
        if (open !== undefined) reply({ id: open, result: { stopReason: 'cancelled' } })
        open = undefined
      } else if (message.method && message.id !== undefined) {
        reply({ id: message.id, result: message.method === 'session/new' ? { sessionId: 'test-session' } : {} })
      }
      callback()
    } })
  }) as unknown as ChildProcess
  vi.mocked(spawnProvider).mockReturnValue(child)
  const thread = { id: 'thread', projectId: 'project', cli: 'cursor', mode: 'agent' } as ThreadMeta
  const items: Item[] = []
  let exists = true
  const store = {
    dataDir: os.tmpdir(), settings: { ...DEFAULT_SETTINGS },
    thread: (id: string) => exists && id === thread.id ? thread : undefined,
    project: () => ({ id: 'project', path: workspace }),
    items: () => items, markItemsDirty: vi.fn(),
    updateThread: vi.fn((_id: string, patch: Partial<ThreadMeta>) => Object.assign(thread, patch))
  }
  const finished = vi.fn()
  const stateChanged = vi.fn()
  const manager = new SessionManager(store as unknown as Store, vi.fn(), stateChanged, finished)
  managers.push(manager)
  const req = (prompt: string, extra: Partial<SendRequest> = {}): SendRequest =>
    ({ threadId: thread.id, prompt, model: 'auto', mode: 'agent', force: false, ...extra })
  const queuedPrompts = () => manager.queued().thread?.items.map((item) => item.prompt) ?? []
  return {
    manager, req, thread, calls, prompts, finished, stateChanged, queuedPrompts,
    remove: () => { exists = false },
    notify: (update: object) => reply({ method: 'session/update', params: { sessionId: 'test-session', update } }),
    waitForPrompts: (count: number) => vi.waitFor(() => expect(prompts).toHaveLength(count)),
    complete: () => {
      const id = open
      open = undefined
      reply({ id, result: { stopReason: 'end_turn' } })
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-queue-'))
})
afterEach(async () => {
  const current = managers.splice(0)
  for (const manager of current) manager.stopAll()
  await vi.waitFor(() => expect(current.every((manager) => !manager.active().length)).toBe(true))
  const resolved = path.resolve(workspace)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-queue-')) throw new Error('Unexpected test directory')
  fs.rmSync(resolved, { recursive: true, force: true })
})

describe('message queue', () => {
  it('sends an idle conversation right away even when a delivery is requested', async () => {
    const ctx = setup()
    await ctx.manager.send(ctx.req('first', { delivery: 'queue' }))
    await ctx.waitForPrompts(1)
    expect(ctx.manager.queued()).toEqual({})
  })

  it('queues follow-ups while running and sends them in order after each turn', async () => {
    const ctx = setup()
    await ctx.manager.send(ctx.req('first'))
    await ctx.waitForPrompts(1)
    await ctx.manager.send(ctx.req('second', { delivery: 'queue' }))
    await ctx.manager.send(ctx.req('third', { delivery: 'queue' }))
    expect(ctx.queuedPrompts()).toEqual(['second', 'third'])
    expect(ctx.prompts).toHaveLength(1)

    ctx.complete()
    await ctx.waitForPrompts(2)
    expect(ctx.prompts[1].text).toContain('second')
    expect(ctx.queuedPrompts()).toEqual(['third'])
    ctx.complete()
    await ctx.waitForPrompts(3)
    expect(ctx.prompts[2].text).toContain('third')
    expect(ctx.manager.queued()).toEqual({})
    ctx.complete()
    await vi.waitFor(() => expect(ctx.manager.active()).toEqual([]))
  })

  it('reorders and removes queued messages', async () => {
    const ctx = setup()
    await ctx.manager.send(ctx.req('first'))
    await ctx.waitForPrompts(1)
    for (const prompt of ['a', 'b', 'c']) await ctx.manager.send(ctx.req(prompt, { delivery: 'queue' }))
    const ids = Object.fromEntries(ctx.manager.queued().thread.items.map((item) => [item.prompt, item.id]))
    ctx.manager.reorderQueued('thread', [ids.c, ids.a])
    expect(ctx.queuedPrompts()).toEqual(['c', 'a', 'b'])
    ctx.manager.removeQueued('thread', ids.a)
    expect(ctx.queuedPrompts()).toEqual(['c', 'b'])
    ctx.complete()
    await ctx.waitForPrompts(2)
    expect(ctx.prompts[1].text).toContain('c')
  })

  it('stops the running turn and sends "now" ahead of the queue, then resumes the queue', async () => {
    const ctx = setup()
    await ctx.manager.send(ctx.req('first'))
    await ctx.waitForPrompts(1)
    await ctx.manager.send(ctx.req('later', { delivery: 'queue' }))
    await ctx.manager.send(ctx.req('urgent', { delivery: 'now' }))
    expect(ctx.calls.some((call) => call.method === 'session/cancel')).toBe(true)
    await ctx.waitForPrompts(2)
    expect(ctx.prompts[1].text).toContain('urgent')
    expect(ctx.queuedPrompts()).toEqual(['later'])
    ctx.complete()
    await ctx.waitForPrompts(3)
    expect(ctx.prompts[2].text).toContain('later')
  })

  it('pauses after a user stop until a queued message is sent now', async () => {
    const ctx = setup()
    await ctx.manager.send(ctx.req('first'))
    await ctx.waitForPrompts(1)
    await ctx.manager.send(ctx.req('second', { delivery: 'queue' }))
    await ctx.manager.send(ctx.req('third', { delivery: 'queue' }))
    ctx.manager.stop('thread')
    await vi.waitFor(() => expect(ctx.manager.queued().thread?.paused).toBe(true))
    expect(ctx.manager.active()).toEqual([])
    expect(ctx.prompts).toHaveLength(1)

    const third = ctx.manager.queued().thread.items.find((item) => item.prompt === 'third')!
    ctx.manager.sendQueuedNow('thread', third.id)
    await ctx.waitForPrompts(2)
    expect(ctx.prompts[1].text).toContain('third')
    ctx.complete()
    await ctx.waitForPrompts(3)
    expect(ctx.prompts[2].text).toContain('second')
  })

  it('puts a message back with the error when its dispatch fails', async () => {
    const ctx = setup()
    await ctx.manager.send(ctx.req('first'))
    await ctx.waitForPrompts(1)
    await ctx.manager.send(ctx.req('second', { delivery: 'queue' }))
    ctx.thread.cwd = path.join(workspace, 'missing')
    ctx.thread.worktree = true
    ctx.complete()
    await vi.waitFor(() => expect(ctx.manager.queued().thread?.error).toBeTruthy())
    expect(ctx.manager.queued().thread).toMatchObject({ paused: true, items: [expect.objectContaining({ prompt: 'second' })] })
    expect(ctx.prompts).toHaveLength(1)
  })

  const planTurn = async (ctx: ReturnType<typeof setup>, count: number) => {
    await ctx.waitForPrompts(count)
    ctx.notify({ sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: `p${count}`, content: '# Plan\n\nSteps' } })
    await vi.waitFor(() => expect(ctx.manager.queued().thread).toBeDefined())
    ctx.complete()
    await vi.waitFor(() => expect(ctx.manager.queued().thread?.waitingForPlan).toBe(true))
    expect(ctx.manager.active()).toEqual([])
  }

  it('holds the queue after a Plan turn produces a plan until an Agent turn carries it out', async () => {
    const ctx = setup()
    await ctx.manager.send(ctx.req('design', { mode: 'plan' }))
    await ctx.waitForPrompts(1)
    await ctx.manager.send(ctx.req('next', { delivery: 'queue' }))
    await planTurn(ctx, 1)
    expect(ctx.prompts).toHaveLength(1)

    await ctx.manager.send(ctx.req('why step 2?', { mode: 'ask' }))
    await ctx.waitForPrompts(2)
    ctx.complete()
    await vi.waitFor(() => expect(ctx.manager.active()).toEqual([]))
    await new Promise((resolve) => setImmediate(resolve))
    expect(ctx.prompts).toHaveLength(2)
    expect(ctx.manager.queued().thread).toMatchObject({ waitingForPlan: true })

    await ctx.manager.send(ctx.req('execute the plan'))
    await ctx.waitForPrompts(3)
    ctx.complete()
    await ctx.waitForPrompts(4)
    expect(ctx.prompts[3].text).toContain('next')
    expect(ctx.manager.queued()).toEqual({})
  })

  it('pauses instead of continuing when the plan execution is stopped', async () => {
    const ctx = setup()
    await ctx.manager.send(ctx.req('design', { mode: 'plan' }))
    await ctx.waitForPrompts(1)
    await ctx.manager.send(ctx.req('next', { delivery: 'queue' }))
    await planTurn(ctx, 1)
    await ctx.manager.send(ctx.req('execute the plan'))
    await ctx.waitForPrompts(2)
    ctx.manager.stop('thread')
    await vi.waitFor(() => expect(ctx.manager.queued().thread?.paused).toBe(true))
    expect(ctx.prompts).toHaveLength(2)
  })

  it('skips the plan wait with send now', async () => {
    const ctx = setup()
    await ctx.manager.send(ctx.req('design', { mode: 'plan' }))
    await ctx.waitForPrompts(1)
    await ctx.manager.send(ctx.req('next', { delivery: 'queue' }))
    await ctx.manager.send(ctx.req('after', { delivery: 'queue' }))
    await planTurn(ctx, 1)
    ctx.manager.sendQueuedNow('thread', ctx.manager.queued().thread.items[0].id)
    await ctx.waitForPrompts(2)
    expect(ctx.manager.queued().thread).toEqual({ items: [expect.objectContaining({ prompt: 'after' })] })
    ctx.complete()
    await ctx.waitForPrompts(3)
  })

  it('does not hold the queue for an Agent turn that only reports a todo list', async () => {
    const ctx = setup()
    await ctx.manager.send(ctx.req('first'))
    await ctx.waitForPrompts(1)
    await ctx.manager.send(ctx.req('next', { delivery: 'queue' }))
    ctx.notify({ sessionUpdate: 'plan', entries: [{ content: 'Read code', status: 'pending' }] })
    ctx.complete()
    await ctx.waitForPrompts(2)
  })

  it('rejects an empty queued message and clears the queue of a deleted conversation', async () => {
    const ctx = setup()
    await ctx.manager.send(ctx.req('first'))
    await ctx.waitForPrompts(1)
    await expect(ctx.manager.send(ctx.req('  ', { delivery: 'queue' }))).rejects.toThrow('请输入消息或添加附件')
    await ctx.manager.send(ctx.req('second', { delivery: 'queue' }))
    ctx.manager.dispose('thread')
    ctx.manager.clearQueue('thread')
    ctx.remove()
    await vi.waitFor(() => expect(ctx.manager.active()).toEqual([]))
    expect(ctx.manager.queued()).toEqual({})
    expect(ctx.prompts).toHaveLength(1)
  })
})
