import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item, SendRequest } from '../src/shared/types'
import type { Store } from '../src/main/store'
import type { CodexUsageTurn } from '../src/main/codex-usage'
import { readCodexUsage } from '../src/main/codex-history'
import { CodexTurnUsageReader } from '../src/main/codex-turn-usage'
import { SessionManager } from '../src/main/sessions'
import { StreamReducer } from '../src/main/reducer'

vi.mock('../src/main/codex-history', () => ({ readCodexUsage: vi.fn() }))
vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(), killTree: vi.fn()
}))

const now = Date.parse('2026-09-29T12:00:00Z')
const requests = [
  { inputTokens: 120, cacheReadTokens: 800, outputTokens: 20 },
  { inputTokens: 80, cacheReadTokens: 1000, outputTokens: 50 }
]

function turn(overrides: Partial<CodexUsageTurn> = {}): CodexUsageTurn {
  return {
    usageId: 'codex:turn-1', turnId: 'turn-1', startedAt: now, createdAt: now + 1000,
    usage: { inputTokens: 200, cacheReadTokens: 1800, outputTokens: 70, cacheWriteTokens: 0, requests },
    isError: false, completed: true, endLine: 10, ...overrides
  }
}

function setup() {
  const items: Item[] = []
  const store = { thread: () => ({ id: 'thread', title: 'Task' }), items: () => items, updateThread: vi.fn(), markItemsDirty: vi.fn() }
  const manager = new SessionManager(store as unknown as Store, vi.fn(), vi.fn(), vi.fn())
  const request = vi.fn().mockResolvedValue({ stopReason: 'end_turn', usage: requests[1] })
  const run = {
    proc: { provider: 'codex', sessionId: 'session', stderr: '', acp: { request }, child: { exitCode: null }, ready: true },
    reducer: new StreamReducer(items), stopped: false, pending: new Map(), acceptUpdates: true,
    force: false, mode: 'agent', switchCalls: new Set(), settled: false
  }
  const internal = manager as any
  internal.runs.set('thread', run)
  const req = { threadId: 'thread', prompt: 'Task', model: 'gpt-5.4', mode: 'agent', force: false } as SendRequest
  return { items, run, internal, start: () => internal.runPrompt('thread', run, req) as Promise<void> }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.mocked(readCodexUsage).mockReset() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('Codex usage collection during a prompt', () => {
  it('stores all requests from the new turn instead of the adapter last request', async () => {
    const old = turn({ usageId: 'codex:old', startedAt: now - 10000 })
    vi.mocked(readCodexUsage).mockReturnValueOnce([old]).mockReturnValue([old, turn()])
    const ctx = setup()
    await ctx.start()
    expect(ctx.items).toEqual([expect.objectContaining({ kind: 'result', cli: 'codex', usageId: 'codex:turn-1', usage: turn().usage })])
  })

  it('stores rollout quota even when account requests are unavailable', async () => {
    const quotaSnapshot = { sampledAt: now + 500, weekly: { usedPercent: 37 } }
    vi.mocked(readCodexUsage).mockReturnValueOnce([]).mockReturnValue([turn({ quotaSnapshot })])
    const ctx = setup()
    await ctx.start()
    expect(ctx.items[0]).toMatchObject({ usage: turn().usage, quotaSnapshot })
  })

  it('keeps a newer account snapshot when an older rollout write arrives late', async () => {
    const quotaSnapshot = { sampledAt: now + 500, weekly: { usedPercent: 37 } }
    vi.mocked(readCodexUsage).mockReturnValueOnce([]).mockReturnValue([turn({ completed: false })])
    const ctx = setup()
    await ctx.start()
    const weeklyQuotaEstimate = {
      start: { sampledAt: now, weekly: { usedPercent: 36.5, resetsAt: now + 604_800_000 } },
      end: { sampledAt: now + 1000, weekly: { usedPercent: 37, resetsAt: now + 604_800_000 } },
      usedPercent: 0.5
    }
    Object.assign(ctx.items[0], { weeklyQuotaEstimate, quotaSnapshot: { sampledAt: now + 1000, weekly: { usedPercent: 38 } } })
    vi.mocked(readCodexUsage).mockReturnValue([turn({ quotaSnapshot })])
    await vi.advanceTimersByTimeAsync(100)
    expect(ctx.items[0]).toMatchObject({ usageComplete: true, quotaSnapshot: { weekly: { usedPercent: 38 } } })
    expect(ctx.items[0]).toHaveProperty('weeklyQuotaEstimate', weeklyQuotaEstimate)
  })

  it('waits briefly for a completed rollout snapshot', async () => {
    vi.mocked(readCodexUsage).mockReturnValueOnce([]).mockReturnValueOnce([turn({ completed: false, usage: requests[0] })]).mockReturnValue([turn()])
    const ctx = setup()
    const work = ctx.start()
    await vi.advanceTimersByTimeAsync(100)
    await work
    expect(ctx.items[0]).toHaveProperty('usage', turn().usage)
  })

  it('finishes the task before late usage and ignores a subsequent process close', async () => {
    const partial = turn({ completed: false, usage: requests[0] })
    vi.mocked(readCodexUsage).mockReturnValueOnce([]).mockReturnValue([partial])
    const ctx = setup()
    await ctx.start()
    expect(ctx.run.settled).toBe(true)
    expect(ctx.run.reducer.gotResult).toBe(true)
    ctx.internal.endRun('thread', ctx.run, 0)
    expect(ctx.items.filter((item) => item.kind === 'result')).toHaveLength(1)
    expect(ctx.items.some((item) => item.kind === 'notice')).toBe(false)
    vi.mocked(readCodexUsage).mockReturnValue([turn()])
    await vi.advanceTimersByTimeAsync(100)
    expect(ctx.items[0]).toMatchObject({ usage: turn().usage, usageComplete: true })
  })

  it('does not label the last request as full usage when the rollout is unavailable', async () => {
    vi.mocked(readCodexUsage).mockReturnValue(undefined)
    const ctx = setup()
    const work = ctx.start()
    await vi.advanceTimersByTimeAsync(400)
    await work
    expect(ctx.items[0]).toMatchObject({ kind: 'result', cli: 'codex' })
    expect(ctx.items[0]).toHaveProperty('usage', undefined)
  })

  it('keeps late usage attached to its original turn when the next turn has already started', async () => {
    vi.mocked(readCodexUsage).mockReturnValueOnce([]).mockReturnValue([turn({ completed: false })])
    const reader = new CodexTurnUsageReader('session')
    expect(reader.read()?.usageId).toBe('codex:turn-1')
    const pending = reader.finish()
    vi.mocked(readCodexUsage).mockReturnValue([turn(), turn({ usageId: 'codex:turn-2', startedAt: now + 50 })])
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toMatchObject({ usageId: 'codex:turn-1', completed: true })
  })

  it('retains recorded tokens when the process exits before a prompt result', () => {
    vi.mocked(readCodexUsage).mockReturnValueOnce([]).mockReturnValue([turn({ completed: false })])
    const ctx = setup()
    Object.assign(ctx.run, { codexUsage: new CodexTurnUsageReader('session') })
    ctx.internal.endRun('thread', ctx.run, 1)
    expect(ctx.items.find((item) => item.kind === 'result')).toMatchObject({ isError: true, usage: turn().usage })
  })

  it('does not reuse previous turn usage for a slash command with no requests', async () => {
    vi.mocked(readCodexUsage).mockReturnValue([turn({ startedAt: now - 10000 })])
    const ctx = setup()
    const work = ctx.start()
    await vi.advanceTimersByTimeAsync(400)
    await work
    expect(ctx.items[0]).toHaveProperty('usage', undefined)
  })

  it('ignores ambiguous turns and replayed older sessions', () => {
    vi.mocked(readCodexUsage).mockReturnValueOnce([]).mockReturnValue([
      turn(), turn({ usageId: 'codex:other' })
    ])
    expect(new CodexTurnUsageReader('session').read()).toBeUndefined()
    vi.mocked(readCodexUsage).mockReturnValueOnce([]).mockReturnValue([turn({ startedAt: now - 60000 })])
    expect(new CodexTurnUsageReader('session').read()).toBeUndefined()
  })
})
