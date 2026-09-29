import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent, Item, SendRequest } from '../src/shared/types'
import type { TurnQuotaUsage } from '../src/shared/turn-quota'
import type { Store } from '../src/main/store'
import type { CodexTurnQuotaTracker } from '../src/main/turn-quota'
import { StreamReducer } from '../src/main/reducer'
import { SessionManager } from '../src/main/sessions'

vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(),
  killTree: vi.fn()
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function setup() {
  const before = deferred<undefined>()
  const after = deferred<TurnQuotaUsage | undefined>()
  const handle = { before: before.promise }
  const tracker = {
    markPromptStarted: vi.fn(),
    finish: vi.fn(() => after.promise),
    cancel: vi.fn()
  }
  const state = { exists: true, items: [] as Item[] }
  const meta = { id: 'thread', title: 'Task' }
  const store = {
    thread: () => state.exists ? meta : undefined,
    items: () => state.items,
    updateThread: () => meta,
    markItemsDirty: vi.fn()
  }
  const events: AgentEvent[] = []
  const finished = vi.fn()
  const manager = new SessionManager(store as unknown as Store, (event) => events.push(event), vi.fn(), finished, tracker as unknown as CodexTurnQuotaTracker)
  const request = vi.fn().mockResolvedValue({ stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } })
  const run = {
    proc: { provider: 'codex', acp: { request, notify: vi.fn() }, child: { exitCode: null }, ready: true, sessionId: 'session', dying: false },
    reducer: new StreamReducer(state.items), stopped: false, pending: new Map(), acceptUpdates: true,
    force: false, mode: 'agent', switchCalls: new Set(), settled: false, quotaTurn: handle
  }
  const internal = manager as any
  internal.runs.set('thread', run)
  const req = { threadId: 'thread', prompt: 'Hello', mode: 'agent', model: 'gpt-6-sol', force: false } as SendRequest
  const start = () => internal.runPrompt('thread', run, req) as Promise<void>
  return { manager, state, store, events, finished, request, run, before, after, handle, tracker, start }
}

describe('per-turn quota lifecycle', () => {
  it('captures the baseline before the prompt and publishes quota without delaying completion', async () => {
    const ctx = setup()
    const work = ctx.start()
    expect(ctx.request).not.toHaveBeenCalled()
    ctx.before.resolve(undefined)
    await work
    expect(ctx.tracker.markPromptStarted).toHaveBeenCalledWith(ctx.handle)
    expect(ctx.request).toHaveBeenCalledWith('session/prompt', expect.anything())
    expect(ctx.finished).toHaveBeenCalledOnce()
    expect(ctx.manager.isRunning('thread')).toBe(false)
    expect(ctx.state.items[0]).not.toHaveProperty('quotaUsage')

    ctx.after.resolve({ weekly: 0.5, fiveHour: 1.5 })
    await vi.waitFor(() => expect(ctx.state.items[0]).toHaveProperty('quotaUsage', { weekly: 0.5, fiveHour: 1.5 }))
    expect(ctx.events.at(-1)).toMatchObject({ type: 'items', threadId: 'thread', items: [{ quotaUsage: { weekly: 0.5, fiveHour: 1.5 } }] })
    expect(ctx.store.markItemsDirty).toHaveBeenCalledWith('thread')
    expect(ctx.finished).toHaveBeenCalledOnce()
  })

  it.each(['deleted', 'reimported'])('does not restore a result whose transcript was %s during refresh', async (action) => {
    const ctx = setup()
    ctx.before.resolve(undefined)
    await ctx.start()
    if (action === 'deleted') ctx.state.exists = false
    else ctx.state.items = []
    const eventCount = ctx.events.length
    ctx.after.resolve({ weekly: 1 })
    await Promise.resolve()
    await Promise.resolve()
    expect(ctx.events).toHaveLength(eventCount)
    expect(ctx.state.items.some((item) => item.kind === 'result' && item.quotaUsage)).toBe(false)
  })

  it('keeps a delayed quota update attached to its original result', async () => {
    const ctx = setup()
    ctx.before.resolve(undefined)
    await ctx.start()
    ctx.state.items.push({ id: 'next-result', kind: 'result', isError: false })
    ctx.after.resolve({ fiveHour: 2 })
    await vi.waitFor(() => expect(ctx.state.items[0]).toHaveProperty('quotaUsage', { fiveHour: 2 }))
    expect(ctx.state.items[1]).not.toHaveProperty('quotaUsage')
  })

  it('does not send a prompt after cancellation while the baseline is loading', async () => {
    const ctx = setup()
    const work = ctx.start()
    ctx.manager.stop('thread')
    ctx.before.resolve(undefined)
    await work
    expect(ctx.request).not.toHaveBeenCalled()
    expect(ctx.tracker.cancel).toHaveBeenCalledWith(ctx.handle)
    expect(ctx.tracker.finish).not.toHaveBeenCalled()
    expect(ctx.manager.isRunning('thread')).toBe(false)
  })

  it('leaves completed results unchanged when quota is unavailable', async () => {
    const ctx = setup()
    ctx.before.resolve(undefined)
    await ctx.start()
    ctx.after.resolve(undefined)
    await Promise.resolve()
    expect(ctx.state.items[0]).not.toHaveProperty('quotaUsage')
    expect(ctx.finished).toHaveBeenCalledOnce()
  })
})
