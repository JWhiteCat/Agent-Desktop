import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type AgentEvent, type CliProvider, type Item, type ResultItem, type SendRequest, type ThreadMeta } from '../src/shared/types'
import type { Store } from '../src/main/store'
import type { loadCodexAccountUsage } from '../src/main/codex-account'
import type { loadCodexQuota } from '../src/main/quota'
import { readCodexUsage } from '../src/main/codex-history'
import { spawnCodexAcp } from '../src/main/codex'
import { StreamReducer } from '../src/main/reducer'
import { SessionManager } from '../src/main/sessions'

vi.mock('../src/main/skills', () => ({ syncAllManagedSkills: vi.fn() }))
vi.mock('../src/main/codex-history', () => ({ readCodexUsage: vi.fn(() => []) }))
vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(),
  killTree: vi.fn((child: ChildProcess) => {
    if (typeof child.emit === 'function') {
      Object.assign(child, { exitCode: 0 })
      child.emit('close', 0)
    }
  })
}))
vi.mock('../src/main/codex', async (original) => ({
  ...await original<typeof import('../src/main/codex')>(),
  resolveCodexApiKey: vi.fn((configured?: string) => configured?.trim() ?? ''),
  resolveCodex: vi.fn(() => ({ bundled: true, display: 'Codex', acpEntry: '/mock/codex.js' })),
  spawnCodexAcp: vi.fn()
}))

const managers: SessionManager[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(readCodexUsage).mockReset().mockReturnValue([])
  vi.mocked(spawnCodexAcp).mockReset()
})
afterEach(async () => {
  try {
    for (const manager of managers.splice(0)) manager.stopAll()
    // Drain the bounded rollout reader polls instead of leaking them into another test.
    await vi.runAllTimersAsync()
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
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

function quotaUsed(usedPercent: number) {
  return { ...weeklyQuota, windows: [{ ...weeklyQuota.windows[0], usedPercent }] }
}

function setup(threadId = 'thread', sessionId = 'session') {
  const after = deferred<Awaited<ReturnType<typeof loadCodexAccountUsage>>>()
  const readAccount = vi.fn(() => after.promise)
  const readQuota = vi.fn<typeof loadCodexQuota>().mockResolvedValue(weeklyQuota)
  const state = { exists: true, items: [] as Item[] }
  const meta = { id: threadId, projectId: 'project', title: 'Task', cli: 'codex' as CliProvider, chatId: sessionId }
  const store = {
    thread: () => state.exists ? meta : undefined, items: () => state.items,
    updateThread: (_id: string, patch: Partial<ThreadMeta>) => Object.assign(meta, patch), markItemsDirty: vi.fn(),
    project: () => ({ id: 'project', path: os.tmpdir() }),
    settings: { ...DEFAULT_SETTINGS, codexPath: '', codexApiKey: '' }
  }
  const events: AgentEvent[] = []
  const finished = vi.fn()
  const manager = new SessionManager(store as unknown as Store, (event) => events.push(event), vi.fn(), finished, readAccount, readQuota)
  managers.push(manager)
  const request = vi.fn().mockResolvedValue({ stopReason: 'end_turn' })
  const run = {
    proc: { provider: 'codex', acp: { request, notify: vi.fn() }, child: { exitCode: null }, ready: true, sessionId, dying: false, stderr: '' },
    reducer: new StreamReducer(state.items), stopped: false, pending: new Map(), acceptUpdates: true,
    force: false, mode: 'agent', switchCalls: new Set(), settled: false, codexAccountPath: '' as string | undefined
  }
  const internal = manager as any
  internal.runs.set(threadId, run)
  const req = { threadId, prompt: 'Hello', mode: 'agent', model: 'gpt-6-sol', force: false } as SendRequest
  const start = () => internal.runPrompt(threadId, run, req) as Promise<void>
  return { manager, state, meta, store, events, finished, request, run, after, readAccount, readQuota, start, internal }
}

/** Exercise send/drive through ACP without replacing the cancellation under test. */
function nextAgent(rejectMode = false) {
  const calls: string[] = []
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdout, stderr: new PassThrough(), exitCode: null,
    stdin: new Writable({ write(chunk, _encoding, callback) {
      const message = JSON.parse(chunk.toString())
      calls.push(message.method)
      const response = rejectMode && message.method === 'session/set_mode'
        ? { error: { code: -32603, message: 'Permission mode rejected' } }
        : { result: message.method === 'session/prompt' ? { stopReason: 'end_turn' } : {} }
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...response })}\n`)
      callback()
    } })
  }) as unknown as ChildProcess
  vi.mocked(spawnCodexAcp).mockReturnValue(child)
  return calls
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
  it('samples the quota before sending and refreshes session usage after completion', async () => {
    const ctx = setup()
    const work = ctx.start()
    expect(ctx.request).not.toHaveBeenCalled()
    expect(ctx.readQuota).toHaveBeenCalledExactlyOnceWith('', 3_000)
    await work
    expect(ctx.request).toHaveBeenCalledWith('session/prompt', expect.anything())
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
    await vi.advanceTimersByTimeAsync(0)
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
    expect(ctx.readQuota).not.toHaveBeenCalled()
    expect(ctx.state.items[0]).not.toHaveProperty('weeklyQuotaEstimate')
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
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.state.items[0]).not.toHaveProperty('quotaSnapshot')
    expect(ctx.state.items[0]).not.toHaveProperty('codexThreadUsage')
    expect(ctx.finished).toHaveBeenCalledOnce()
  })

  describe('fixed weekly estimate for one turn', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(quotaReading.quotaSampledAt)
    })

    it('waits for the start reading but finishes before the end reading', async () => {
      const ctx = setup()
      const before = deferred<Awaited<ReturnType<typeof loadCodexQuota>>>()
      const after = deferred<Awaited<ReturnType<typeof loadCodexQuota>>>()
      ctx.readQuota.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise)
      const work = ctx.start()
      await vi.advanceTimersByTimeAsync(500)
      expect(ctx.request).not.toHaveBeenCalled()
      before.resolve(weeklyQuota)
      await work
      expect(ctx.finished).toHaveBeenCalledOnce()
      expect(ctx.manager.isRunning('thread')).toBe(false)
      expect(ctx.state.items[0]).toMatchObject({
        durationMs: 0,
        weeklyQuotaEstimate: { start: { sampledAt: quotaReading.quotaSampledAt + 500, weekly: { usedPercent: 37 } } }
      })
      expect(ctx.state.items[0]).not.toHaveProperty('weeklyQuotaEstimate.usedPercent')
      await vi.advanceTimersByTimeAsync(1_000)
      after.resolve(quotaUsed(37.5))
      await vi.advanceTimersByTimeAsync(0)
      expect(ctx.state.items[0]).toMatchObject({ weeklyQuotaEstimate: {
        usedPercent: 0.5,
        end: { sampledAt: quotaReading.quotaSampledAt + 1_500, weekly: { usedPercent: 37.5 } }
      } })
      expect(ctx.readQuota).toHaveBeenCalledTimes(2)
      expect(ctx.readQuota).toHaveBeenLastCalledWith('', 3_000)
      expect(ctx.finished).toHaveBeenCalledOnce()
    })

    it.each([-1_000, 1_000])('saves the estimate after an asynchronous end reading with %i ms of reset drift', async (drift) => {
      const ctx = setup()
      const endReading = deferred<Awaited<ReturnType<typeof loadCodexQuota>>>()
      const startQuota = quotaUsed(74)
      const endQuota = quotaUsed(79)
      endQuota.windows[0].resetsAt += drift
      ctx.readQuota.mockResolvedValueOnce(startQuota).mockReturnValueOnce(endReading.promise)

      await ctx.start()
      expect(ctx.request).toHaveBeenCalledOnce()
      expect(ctx.finished).toHaveBeenCalledOnce()
      expect(ctx.manager.isRunning('thread')).toBe(false)
      const result = ctx.state.items[0] as ResultItem
      const savedStart = result.weeklyQuotaEstimate?.start
      expect(savedStart).toEqual({
        sampledAt: quotaReading.quotaSampledAt,
        weekly: { usedPercent: 74, resetsAt: startQuota.windows[0].resetsAt }
      })
      expect(result.weeklyQuotaEstimate).not.toHaveProperty('end')
      expect(result.weeklyQuotaEstimate).not.toHaveProperty('usedPercent')
      ctx.store.markItemsDirty.mockClear()

      await vi.advanceTimersByTimeAsync(1_000)
      endReading.resolve(endQuota)
      await vi.advanceTimersByTimeAsync(0)
      expect(ctx.state.items[0]).toBe(result)
      expect(result.weeklyQuotaEstimate).toEqual({
        start: savedStart,
        end: {
          sampledAt: quotaReading.quotaSampledAt + 1_000,
          weekly: { usedPercent: 79, resetsAt: endQuota.windows[0].resetsAt }
        },
        usedPercent: 5
      })
      expect(result.weeklyQuotaEstimate?.start).toBe(savedStart)
      expect(ctx.store.markItemsDirty).toHaveBeenCalledWith('thread')
      expect(ctx.events.at(-1)).toEqual({ type: 'items', threadId: 'thread', items: [result] })
      expect(ctx.readQuota).toHaveBeenCalledTimes(2)
      expect(ctx.finished).toHaveBeenCalledOnce()
    })

    it('continues after the start deadline and never adopts the late baseline', async () => {
      const ctx = setup()
      const before = deferred<Awaited<ReturnType<typeof loadCodexQuota>>>()
      ctx.readQuota.mockReturnValueOnce(before.promise).mockResolvedValue(quotaUsed(38))
      const work = ctx.start()
      await vi.advanceTimersByTimeAsync(2_999)
      expect(ctx.request).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await work
      expect(ctx.request).toHaveBeenCalledOnce()
      expect(ctx.state.items[0]).toMatchObject({ weeklyQuotaEstimate: { end: { weekly: { usedPercent: 38 } } } })
      before.resolve(weeklyQuota)
      await vi.advanceTimersByTimeAsync(0)
      expect(ctx.state.items[0]).toHaveProperty('weeklyQuotaEstimate.start', undefined)
      expect(ctx.state.items[0]).not.toHaveProperty('weeklyQuotaEstimate.usedPercent')
    })

    it('leaves the estimate unavailable after the end deadline without retrying it', async () => {
      const ctx = setup()
      const after = deferred<Awaited<ReturnType<typeof loadCodexQuota>>>()
      ctx.readQuota.mockReturnValueOnce(Promise.resolve(weeklyQuota)).mockReturnValueOnce(after.promise)
      await ctx.start()
      await vi.advanceTimersByTimeAsync(3_000)
      after.resolve(quotaUsed(38))
      await vi.advanceTimersByTimeAsync(0)
      ctx.after.resolve({ sessionUsage: { threadId: 'session', status: 'unavailable' } })
      await vi.advanceTimersByTimeAsync(600_000)
      ctx.manager.refreshCodexUsage('thread')
      await vi.advanceTimersByTimeAsync(0)
      expect(ctx.state.items[0]).not.toHaveProperty('weeklyQuotaEstimate.end')
      expect(ctx.state.items[0]).not.toHaveProperty('weeklyQuotaEstimate.usedPercent')
      expect(ctx.readQuota).toHaveBeenCalledTimes(2)
    })

    it('does not send the prompt when stopped while sampling the start', async () => {
      const ctx = setup()
      const before = deferred<Awaited<ReturnType<typeof loadCodexQuota>>>()
      ctx.readQuota.mockReturnValue(before.promise)
      const work = ctx.start()
      ctx.manager.stop('thread')
      before.resolve(weeklyQuota)
      await work
      expect(ctx.request).not.toHaveBeenCalled()
      expect(ctx.readQuota).toHaveBeenCalledOnce()
      expect(ctx.state.items.some((item) => item.kind === 'result')).toBe(false)
      expect(ctx.manager.isRunning('thread')).toBe(false)
    })

    it.each(['start', 'end'])('keeps the task usable if the %s read fails', async (boundary) => {
      const ctx = setup()
      if (boundary === 'start') ctx.readQuota.mockRejectedValueOnce(new Error('offline'))
      else ctx.readQuota.mockResolvedValueOnce(weeklyQuota).mockRejectedValueOnce(new Error('offline'))
      await ctx.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(ctx.request).toHaveBeenCalledOnce()
      expect(ctx.finished).toHaveBeenCalledOnce()
      expect(ctx.state.items[0]).not.toHaveProperty('weeklyQuotaEstimate.usedPercent')
    })

    it('discards an old end reading even after a quick next turn has already finished', async () => {
      const ctx = setup()
      const oldEnd = deferred<Awaited<ReturnType<typeof loadCodexQuota>>>()
      ctx.readQuota.mockResolvedValueOnce(weeklyQuota).mockReturnValueOnce(oldEnd.promise)
        .mockResolvedValueOnce(quotaUsed(38)).mockResolvedValueOnce(quotaUsed(38.25))
      await ctx.start()
      const calls = nextAgent()
      await ctx.manager.send({ threadId: 'thread', prompt: 'Next', mode: 'agent', model: 'gpt-6-sol', force: false })
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toContain('session/prompt')
      expect(ctx.finished).toHaveBeenCalledTimes(2)
      expect(ctx.manager.isRunning('thread')).toBe(false)
      oldEnd.resolve(quotaUsed(99))
      await vi.advanceTimersByTimeAsync(0)
      const results = ctx.state.items.filter((item) => item.kind === 'result')
      expect(results).toHaveLength(2)
      expect(results[0]).not.toHaveProperty('weeklyQuotaEstimate.usedPercent')
      expect(results[1]).toMatchObject({ weeklyQuotaEstimate: { usedPercent: 0.25, start: { weekly: { usedPercent: 38 } } } })
    })

    it('discards the old end reading even if the next send fails before producing a result', async () => {
      const ctx = setup()
      const oldEnd = deferred<Awaited<ReturnType<typeof loadCodexQuota>>>()
      ctx.readQuota.mockResolvedValueOnce(weeklyQuota).mockReturnValueOnce(oldEnd.promise)
      await ctx.start()
      expect(ctx.readQuota).toHaveBeenCalledTimes(2)
      const originalResult = ctx.state.items[0]
      expect(originalResult).toHaveProperty('weeklyQuotaEstimate.start.weekly.usedPercent', 37)
      const calls = nextAgent(true)

      await ctx.manager.send({ threadId: 'thread', prompt: 'Next', mode: 'agent', model: 'gpt-6-sol', force: false })
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toContain('session/set_mode')
      expect(calls).not.toContain('session/prompt')
      expect(ctx.finished).toHaveBeenCalledTimes(2)
      expect(ctx.finished.mock.calls[1][0]).toMatchObject({ failed: true })
      expect(ctx.manager.isRunning('thread')).toBe(false)
      expect(ctx.state.items.filter((item) => item.kind === 'result')).toEqual([originalResult])
      const eventCount = ctx.events.length
      ctx.store.markItemsDirty.mockClear()

      oldEnd.resolve(quotaUsed(99))
      await vi.advanceTimersByTimeAsync(0)
      expect(originalResult).not.toHaveProperty('weeklyQuotaEstimate.end')
      expect(ctx.events).toHaveLength(eventCount)
      expect(ctx.store.markItemsDirty).not.toHaveBeenCalled()
      expect(ctx.readQuota).toHaveBeenCalledTimes(2)
    })

    it.each(['deleted', 'reimported', 'session changed', 'CLI changed', 'API key configured', 'disposed', 'shutdown'])
      ('discards an end reading when %s', async (action) => {
        const ctx = setup()
        const after = deferred<Awaited<ReturnType<typeof loadCodexQuota>>>()
        ctx.readQuota.mockResolvedValueOnce(weeklyQuota).mockReturnValueOnce(after.promise)
        await ctx.start()
        const savedItems = ctx.state.items
        if (action === 'deleted') ctx.state.exists = false
        if (action === 'reimported') ctx.state.items = structuredClone(savedItems)
        if (action === 'session changed') ctx.meta.chatId = 'new-session'
        if (action === 'CLI changed') ctx.meta.cli = 'cursor'
        if (action === 'API key configured') ctx.store.settings.codexApiKey = 'configured-test-key'
        if (action === 'disposed') ctx.manager.dispose('thread')
        if (action === 'shutdown') ctx.manager.stopAll()
        const count = ctx.events.length
        after.resolve(quotaUsed(38))
        await vi.advanceTimersByTimeAsync(0)
        expect(ctx.events).toHaveLength(count)
        expect(savedItems[0]).not.toHaveProperty('weeklyQuotaEstimate.usedPercent')
        expect(ctx.state.items[0]).not.toHaveProperty('weeklyQuotaEstimate.usedPercent')
      })

    it('freezes the estimate while late session records and history refreshes update', async () => {
      const ctx = setup()
      ctx.readQuota.mockResolvedValueOnce(weeklyQuota).mockResolvedValueOnce(quotaUsed(37.5))
      await ctx.start()
      await vi.advanceTimersByTimeAsync(0)
      const estimate = (ctx.state.items[0] as ResultItem).weeklyQuotaEstimate
      expect(estimate?.usedPercent).toBe(0.5)
      ctx.after.resolve({ ...quotaReading, sessionUsage: { threadId: 'session', status: 'partial', weekly: 9 } })
      await vi.advanceTimersByTimeAsync(0)
      ctx.readAccount.mockResolvedValue({ quota: quotaUsed(90), quotaSampledAt: Date.now() + 60_000,
        sessionUsage: { threadId: 'session', status: 'available', weekly: 10 } })
      await vi.advanceTimersByTimeAsync(30_000)
      ctx.manager.refreshCodexUsage('thread')
      await vi.advanceTimersByTimeAsync(0)
      expect(ctx.state.items[0]).toMatchObject({ quotaSnapshot: { weekly: { usedPercent: 90 } }, codexSessionUsage: { weekly: 10 } })
      expect((ctx.state.items[0] as ResultItem).weeklyQuotaEstimate).toBe(estimate)
      expect(ctx.readQuota).toHaveBeenCalledTimes(2)
    })

    it.each([false, true])('samples an interrupted turn that has recorded usage (stopped=%s)', async (stopped) => {
      const ctx = setup()
      const response = deferred<{ stopReason: string }>()
      ctx.request.mockReturnValue(response.promise)
      ctx.readQuota.mockResolvedValueOnce(weeklyQuota).mockResolvedValueOnce(quotaUsed(37.5))
      const work = ctx.start()
      await vi.advanceTimersByTimeAsync(0)
      vi.mocked(readCodexUsage).mockReturnValueOnce([{
        usageId: 'interrupted-turn', startedAt: Date.now(), createdAt: Date.now(), isError: !stopped,
        usage: { inputTokens: 10, outputTokens: 2 }, completed: false, endLine: 1
      }])
      ctx.run.stopped = stopped
      ctx.internal.endRun('thread', ctx.run, 1)
      await vi.advanceTimersByTimeAsync(0)
      expect(ctx.state.items.find((item) => item.kind === 'result')).toMatchObject({
        isError: !stopped, weeklyQuotaEstimate: { usedPercent: 0.5 }
      })
      response.resolve({ stopReason: 'cancelled' })
      await work
    })
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
      await vi.advanceTimersByTimeAsync(0)
      expect(ctx.request).toHaveBeenCalledOnce()
      ctx.manager.stopAll()
      response.resolve({ stopReason: 'end_turn' })
      await work
      ctx.manager.refreshCodexUsage('thread')
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(ctx.readAccount).not.toHaveBeenCalled()
      expect(ctx.readQuota).toHaveBeenCalledOnce()
    })
  })
})
