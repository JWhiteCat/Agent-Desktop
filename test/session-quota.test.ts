import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, CliProvider, Item, SendRequest } from '../src/shared/types'
import type { Store } from '../src/main/store'
import type { loadCodexAccountUsage } from '../src/main/codex-account'
import { StreamReducer } from '../src/main/reducer'
import { SessionManager } from '../src/main/sessions'

vi.mock('../src/main/codex-history', () => ({ readCodexUsage: vi.fn(() => []) }))
vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(), killTree: vi.fn()
}))
vi.mock('../src/main/codex', async (original) => ({
  ...await original<typeof import('../src/main/codex')>(),
  resolveCodexApiKey: vi.fn((configured?: string) => configured?.trim() ?? '')
}))

const managers: SessionManager[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) manager.stopAll()
  if (vi.isFakeTimers()) vi.clearAllTimers()
  vi.useRealTimers()
})

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
  const meta = { id: threadId, title: 'Task', cli: 'codex' as CliProvider, chatId: sessionId }
  const store = {
    thread: () => state.exists ? meta : undefined, items: () => state.items,
    updateThread: () => meta, markItemsDirty: vi.fn(),
    settings: { codexPath: '', codexApiKey: '' }
  }
  const events: AgentEvent[] = []
  const finished = vi.fn()
  const manager = new SessionManager(store as unknown as Store, (event) => events.push(event), vi.fn(), finished, readAccount)
  managers.push(manager)
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
  return { manager, state, meta, store, events, finished, request, run, after, readAccount, start, internal }
}

function historySetup() {
  const ctx = setup()
  ctx.internal.runs.delete('thread')
  ctx.state.items.push(
    { id: 'old-result', kind: 'result', isError: false, cli: 'codex' },
    { id: 'latest-result', kind: 'result', isError: false, cli: 'codex' }
  )
  return ctx
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

  describe('saved conversation refresh and delayed accounting', () => {
    beforeEach(() => vi.useFakeTimers())

    it('refreshes only the latest result and deduplicates pending and recent reads', async () => {
      const ctx = historySetup()
      ctx.manager.refreshCodexUsage('thread')
      ctx.manager.refreshCodexUsage('thread')
      expect(ctx.readAccount).toHaveBeenCalledExactlyOnceWith('', 'session')
      const sessionUsage = { threadId: 'session', status: 'available' as const, weekly: 0.00088829 }
      ctx.after.resolve({ sessionUsage })
      await vi.advanceTimersByTimeAsync(0)
      expect(ctx.state.items[0]).not.toHaveProperty('codexSessionUsage')
      expect(ctx.state.items[1]).toHaveProperty('codexSessionUsage', sessionUsage)
      expect(ctx.request).not.toHaveBeenCalled()
      ctx.manager.refreshCodexUsage('thread')
      await vi.advanceTimersByTimeAsync(29_999)
      ctx.manager.refreshCodexUsage('thread')
      expect(ctx.readAccount).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      ctx.manager.refreshCodexUsage('thread')
      expect(ctx.readAccount).toHaveBeenCalledTimes(2)
    })

    it('retries unavailable accounting after 30 seconds, 2 minutes, and 5 minutes, then stops', async () => {
      const ctx = historySetup()
      ctx.readAccount.mockResolvedValue({ sessionUsage: { threadId: 'session', status: 'unavailable' } })
      ctx.manager.refreshCodexUsage('thread')
      await vi.advanceTimersByTimeAsync(0)
      expect(ctx.readAccount).toHaveBeenCalledOnce()
      for (const [delay, calls] of [[30_000, 2], [120_000, 3], [300_000, 4]]) {
        await vi.advanceTimersByTimeAsync(delay - 1)
        expect(ctx.readAccount).toHaveBeenCalledTimes(calls - 1)
        await vi.advanceTimersByTimeAsync(1)
        expect(ctx.readAccount).toHaveBeenCalledTimes(calls)
      }
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(ctx.readAccount).toHaveBeenCalledTimes(4)
      expect(ctx.state.items[1]).toHaveProperty('codexSessionUsage.status', 'unavailable')
    })

    it('keeps partial data visible and stops retrying once the session becomes available', async () => {
      const ctx = historySetup()
      ctx.readAccount
        .mockResolvedValueOnce({ sessionUsage: { threadId: 'session', status: 'partial', weekly: 1 } })
        .mockResolvedValue({ sessionUsage: { threadId: 'session', status: 'available', weekly: 2 } })
      ctx.manager.refreshCodexUsage('thread')
      await vi.advanceTimersByTimeAsync(0)
      expect(ctx.state.items[1]).toMatchObject({ codexSessionUsage: { status: 'partial', weekly: 1 } })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(ctx.state.items[1]).toMatchObject({ codexSessionUsage: { status: 'available', weekly: 2 } })
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(ctx.readAccount).toHaveBeenCalledTimes(2)
    })

    it.each(['deleted', 'CLI changed', 'session changed', 'API key configured', 'new result', 'running'])
      ('does not retry when the conversation is %s', async (action) => {
        const ctx = historySetup()
        ctx.readAccount.mockResolvedValue({ sessionUsage: { threadId: 'session', status: 'unavailable' } })
        ctx.manager.refreshCodexUsage('thread')
        await vi.advanceTimersByTimeAsync(0)
        if (action === 'deleted') ctx.state.exists = false
        if (action === 'CLI changed') ctx.meta.cli = 'cursor'
        if (action === 'session changed') ctx.meta.chatId = 'different-session'
        if (action === 'API key configured') ctx.store.settings.codexApiKey = 'configured-test-key'
        if (action === 'new result') ctx.state.items.push({ id: 'new-result', kind: 'result', isError: false, cli: 'codex' })
        if (action === 'running') ctx.internal.runs.set('thread', ctx.run)
        await vi.advanceTimersByTimeAsync(3_600_000)
        expect(ctx.readAccount).toHaveBeenCalledOnce()
      })

    it.each(['disposed', 'stopped', 'session changed', 'CLI changed'])
      ('discards an in-flight response after the conversation is %s', async (action) => {
        const ctx = historySetup()
        ctx.manager.refreshCodexUsage('thread')
        if (action === 'disposed') ctx.manager.dispose('thread')
        if (action === 'stopped') ctx.manager.stopAll()
        if (action === 'session changed') ctx.meta.chatId = 'different-session'
        if (action === 'CLI changed') ctx.meta.cli = 'cursor'
        ctx.after.resolve({ sessionUsage: { threadId: 'session', status: 'partial', weekly: 3 } })
        await vi.advanceTimersByTimeAsync(3_600_000)
        expect(ctx.state.items[1]).not.toHaveProperty('codexSessionUsage')
        expect(ctx.store.markItemsDirty).not.toHaveBeenCalled()
        expect(ctx.readAccount).toHaveBeenCalledOnce()
      })

    it.each(['disposed', 'stopped'])('cancels an already scheduled retry when %s', async (action) => {
      const ctx = historySetup()
      ctx.readAccount.mockResolvedValue({ sessionUsage: { threadId: 'session', status: 'unavailable' } })
      ctx.manager.refreshCodexUsage('thread')
      await vi.advanceTimersByTimeAsync(0)
      if (action === 'disposed') ctx.manager.dispose('thread')
      else ctx.manager.stopAll()
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(ctx.readAccount).toHaveBeenCalledOnce()
    })

    it('ignores an old pending request after a newer session starts its own refresh', async () => {
      const ctx = historySetup()
      ctx.manager.refreshCodexUsage('thread')
      const next = deferred<Awaited<ReturnType<typeof loadCodexAccountUsage>>>()
      ctx.meta.chatId = 'next-session'
      ctx.readAccount.mockReturnValue(next.promise)
      ctx.manager.refreshCodexUsage('thread')
      expect(ctx.readAccount).toHaveBeenLastCalledWith('', 'next-session')
      ctx.after.resolve({ sessionUsage: { threadId: 'session', status: 'available', weekly: 99 } })
      await vi.advanceTimersByTimeAsync(0)
      expect(ctx.state.items[1]).not.toHaveProperty('codexSessionUsage')
      next.resolve({ sessionUsage: { threadId: 'next-session', status: 'available', weekly: 1 } })
      await vi.advanceTimersByTimeAsync(0)
      expect(ctx.state.items[1]).toMatchObject({ codexSessionUsage: { threadId: 'next-session', weekly: 1 } })
    })

    it('does not start a usage read when an in-flight turn completes after app shutdown', async () => {
      const ctx = setup()
      const response = deferred<{ stopReason: string }>()
      ctx.request.mockReturnValue(response.promise)
      const work = ctx.start()
      ctx.manager.stopAll()
      response.resolve({ stopReason: 'end_turn' })
      await work
      ctx.manager.refreshCodexUsage('thread')
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(ctx.readAccount).not.toHaveBeenCalled()
    })
  })
})
