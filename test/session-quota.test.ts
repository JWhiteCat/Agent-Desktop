import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent, Item, SendRequest } from '../src/shared/types'
import type { Store } from '../src/main/store'
import type { loadCodexAccountUsage } from '../src/main/codex-account'
import { StreamReducer } from '../src/main/reducer'
import { SessionManager } from '../src/main/sessions'

vi.mock('../src/main/codex-history', () => ({ readCodexUsage: vi.fn(() => []) }))
vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(), killTree: vi.fn()
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const weeklyQuota = {
  provider: 'codex' as const,
  windows: [{ id: 'primary', label: '每周', usedPercent: 37, resetsAt: 1_900_000_000_000 }]
}
const quotaReading = { quota: weeklyQuota, quotaSampledAt: 1_800_000_000_000 }

function setup(threadId = 'thread', sessionId = 'session') {
  const after = deferred<Awaited<ReturnType<typeof loadCodexAccountUsage>>>()
  const readAccount = vi.fn(() => after.promise)
  const state = { exists: true, items: [] as Item[] }
  const meta = { id: threadId, title: 'Task' }
  const store = {
    thread: () => state.exists ? meta : undefined, items: () => state.items,
    updateThread: () => meta, markItemsDirty: vi.fn()
  }
  const events: AgentEvent[] = []
  const finished = vi.fn()
  const manager = new SessionManager(store as unknown as Store, (event) => events.push(event), vi.fn(), finished, readAccount)
  const request = vi.fn().mockResolvedValue({ stopReason: 'end_turn' })
  const run = {
    proc: { provider: 'codex', acp: { request, notify: vi.fn() }, child: { exitCode: null }, ready: true, sessionId, dying: false },
    reducer: new StreamReducer(state.items), stopped: false, pending: new Map(), acceptUpdates: true,
    force: false, mode: 'agent', switchCalls: new Set(), settled: false, codexAccountPath: '' as string | undefined
  }
  const internal = manager as any
  internal.runs.set(threadId, run)
  const req = { threadId, prompt: 'Hello', mode: 'agent', model: 'gpt-6-sol', force: false } as SendRequest
  const start = () => internal.runPrompt(threadId, run, req) as Promise<void>
  return { manager, state, store, events, finished, request, run, after, readAccount, start }
}

describe('Codex account and session usage lifecycle', () => {
  it('sends the prompt without an account baseline and refreshes usage after completion', async () => {
    const ctx = setup()
    const work = ctx.start()
    expect(ctx.request).toHaveBeenCalledWith('session/prompt', expect.anything())
    await work
    expect(ctx.finished).toHaveBeenCalledOnce()
    expect(ctx.manager.isRunning('thread')).toBe(false)
    expect(ctx.readAccount).toHaveBeenCalledExactlyOnceWith('', 'session')
    const threadUsage = { threadId: 'session', credits: 1.25, costUsd: 0.04 }
    ctx.after.resolve({ ...quotaReading, threadUsage })
    await vi.waitFor(() => expect(ctx.state.items[0]).toHaveProperty('codexThreadUsage', threadUsage))
    expect(ctx.state.items[0]).toMatchObject({ quotaSnapshot: { weekly: { usedPercent: 37 } } })
    expect(ctx.state.items[0]).not.toHaveProperty('quotaUsage')
    expect(ctx.events.at(-1)).toMatchObject({ type: 'items', threadId: 'thread' })
    expect(ctx.finished).toHaveBeenCalledOnce()
  })

  it.each(['deleted', 'reimported'])('does not restore a result whose transcript was %s during refresh', async (action) => {
    const ctx = setup()
    await ctx.start()
    if (action === 'deleted') ctx.state.exists = false
    else ctx.state.items = []
    const eventCount = ctx.events.length
    ctx.after.resolve(quotaReading)
    await Promise.resolve()
    await Promise.resolve()
    expect(ctx.events).toHaveLength(eventCount)
  })

  it('keeps delayed usage attached to its original result', async () => {
    const ctx = setup()
    await ctx.start()
    ctx.state.items.push({ id: 'next-result', kind: 'result', isError: false })
    ctx.after.resolve(quotaReading)
    await vi.waitFor(() => expect(ctx.state.items[0]).toHaveProperty('quotaSnapshot'))
    expect(ctx.state.items[1]).not.toHaveProperty('quotaSnapshot')
  })

  it('keeps concurrent sessions independent while both show account windows', async () => {
    const first = setup('first', 'session-1')
    const second = setup('second', 'session-2')
    await Promise.all([first.start(), second.start()])
    first.after.resolve({ ...quotaReading, threadUsage: { threadId: 'session-1', credits: 1 } })
    second.after.resolve({ ...quotaReading, threadUsage: { threadId: 'session-2', credits: 9 } })
    await vi.waitFor(() => {
      expect(first.state.items[0]).toMatchObject({ codexThreadUsage: { credits: 1 }, quotaSnapshot: { weekly: { usedPercent: 37 } } })
      expect(second.state.items[0]).toMatchObject({ codexThreadUsage: { credits: 9 }, quotaSnapshot: { weekly: { usedPercent: 37 } } })
    })
  })

  it('does not query subscription usage for API-key sessions', async () => {
    const ctx = setup()
    ctx.run.codexAccountPath = undefined
    await ctx.start()
    expect(ctx.readAccount).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer rollout snapshot when thread credits arrive late', async () => {
    const ctx = setup()
    await ctx.start()
    const newer = { sampledAt: quotaReading.quotaSampledAt + 1_000, weekly: { usedPercent: 38 } }
    Object.assign(ctx.state.items[0], { quotaSnapshot: newer })
    ctx.after.resolve({ ...quotaReading, threadUsage: { threadId: 'session', credits: 1 } })
    await vi.waitFor(() => expect(ctx.state.items[0]).toHaveProperty('codexThreadUsage'))
    expect(ctx.state.items[0]).toHaveProperty('quotaSnapshot', newer)
  })

  it('leaves completed results usable when the account returns no data', async () => {
    const ctx = setup()
    await ctx.start()
    ctx.after.resolve({})
    await Promise.resolve()
    expect(ctx.state.items[0]).not.toHaveProperty('quotaSnapshot')
    expect(ctx.state.items[0]).not.toHaveProperty('codexThreadUsage')
    expect(ctx.finished).toHaveBeenCalledOnce()
  })
})
