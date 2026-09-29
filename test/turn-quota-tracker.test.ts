import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexQuotaSnapshot } from '../src/main/quota'
import { CodexTurnQuotaTracker } from '../src/main/turn-quota'

function snapshot(sampledAt: number, usedPercent: number, accountKey = 'account-a'): CodexQuotaSnapshot {
  return {
    accountKey,
    sampledAt,
    quota: {
      provider: 'codex',
      windows: [
        { id: 'primary', label: '5小时', usedPercent, resetsAt: 100_000 },
        { id: 'secondary', label: '每周', usedPercent, resetsAt: 200_000 }
      ]
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

let now = 1_000
beforeEach(() => {
  now = 1_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(() => vi.restoreAllMocks())

describe('Codex turn quota tracker', () => {
  it('compares snapshots that enclose the prompt and forwards the API key', async () => {
    const loader = vi.fn().mockResolvedValueOnce(snapshot(1_000, 10)).mockResolvedValueOnce(snapshot(2_000, 12))
    const tracker = new CodexTurnQuotaTracker(loader)
    const turn = tracker.start('configured-key')
    await turn.before
    tracker.markPromptStarted(turn)
    now = 2_000
    expect(await tracker.finish(turn)).toEqual({ weekly: 2, fiveHour: 2 })
    expect(loader.mock.calls).toEqual([['configured-key'], ['configured-key']])
  })

  it('preserves zero change as a valid measured result', async () => {
    const tracker = new CodexTurnQuotaTracker(vi.fn().mockResolvedValue(snapshot(1_000, 10)))
    const turn = tracker.start()
    await turn.before
    tracker.markPromptStarted(turn)
    expect(await tracker.finish(turn)).toEqual({ weekly: 0, fiveHour: 0 })
  })

  it('omits readings from different accounts', async () => {
    const tracker = new CodexTurnQuotaTracker(vi.fn().mockResolvedValueOnce(snapshot(1_000, 10)).mockResolvedValueOnce(snapshot(1_000, 12, 'account-b')))
    const turn = tracker.start()
    await turn.before
    tracker.markPromptStarted(turn)
    expect(await tracker.finish(turn)).toBeUndefined()
  })

  it('omits missing or rejected baseline readings without a followup request', async () => {
    for (const loader of [vi.fn().mockResolvedValue(undefined), vi.fn().mockRejectedValue(new Error('offline'))]) {
      const tracker = new CodexTurnQuotaTracker(loader)
      const turn = tracker.start()
      expect(await turn.before).toBeUndefined()
      tracker.markPromptStarted(turn)
      expect(await tracker.finish(turn)).toBeUndefined()
      expect(loader).toHaveBeenCalledTimes(1)
    }
  })

  it('contains failures from the final snapshot', async () => {
    const tracker = new CodexTurnQuotaTracker(vi.fn().mockResolvedValueOnce(snapshot(1_000, 10)).mockRejectedValueOnce(new Error('offline')))
    const turn = tracker.start()
    await turn.before
    tracker.markPromptStarted(turn)
    expect(await tracker.finish(turn)).toBeUndefined()
  })

  it('omits baselines sampled after the prompt began', async () => {
    const pending = deferred<CodexQuotaSnapshot>()
    const loader = vi.fn().mockReturnValueOnce(pending.promise)
    const tracker = new CodexTurnQuotaTracker(loader)
    const turn = tracker.start()
    tracker.markPromptStarted(turn)
    now = 1_500
    pending.resolve(snapshot(now, 10))
    await turn.before
    expect(await tracker.finish(turn)).toBeUndefined()
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('omits final snapshots sampled before prompt completion', async () => {
    const tracker = new CodexTurnQuotaTracker(vi.fn().mockResolvedValueOnce(snapshot(1_000, 10)).mockResolvedValueOnce(snapshot(1_500, 12)))
    const turn = tracker.start()
    await turn.before
    tracker.markPromptStarted(turn)
    now = 2_000
    expect(await tracker.finish(turn)).toBeUndefined()
  })

  it('omits both overlapping turns and permits the next independent turn', async () => {
    const tracker = new CodexTurnQuotaTracker(vi.fn().mockImplementation(async () => snapshot(now, 10)))
    const first = tracker.start()
    await first.before
    tracker.markPromptStarted(first)
    const second = tracker.start()
    await second.before
    tracker.markPromptStarted(second)
    expect(await tracker.finish(first)).toBeUndefined()
    expect(await tracker.finish(second)).toBeUndefined()
    const third = tracker.start()
    await third.before
    tracker.markPromptStarted(third)
    expect(await tracker.finish(third)).toEqual({ weekly: 0, fiveHour: 0 })
  })

  it('detects overlap while waiting for the final snapshot', async () => {
    const pending = deferred<CodexQuotaSnapshot>()
    const startedFetch = deferred<void>()
    const loader = vi.fn()
      .mockResolvedValueOnce(snapshot(1_000, 10))
      .mockImplementationOnce(() => { startedFetch.resolve(); return pending.promise })
      .mockResolvedValue(snapshot(1_000, 12))
    const tracker = new CodexTurnQuotaTracker(loader)
    const first = tracker.start()
    await first.before
    tracker.markPromptStarted(first)
    const result = tracker.finish(first)
    expect(tracker.finish(first)).toBe(result)
    await startedFetch.promise
    const second = tracker.start()
    await second.before
    tracker.markPromptStarted(second)
    pending.resolve(snapshot(1_000, 12))
    expect(await result).toBeUndefined()
    expect(await tracker.finish(second)).toBeUndefined()
  })

  it('releases canceled turns while their baseline request is pending', async () => {
    const pending = deferred<CodexQuotaSnapshot>()
    const loader = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(snapshot(1_000, 10))
    const tracker = new CodexTurnQuotaTracker(loader)
    const canceled = tracker.start()
    tracker.cancel(canceled)
    pending.resolve(snapshot(1_000, 10))
    expect(await tracker.finish(canceled)).toBeUndefined()
    const next = tracker.start()
    await next.before
    tracker.markPromptStarted(next)
    expect(await tracker.finish(next)).toEqual({ weekly: 0, fiveHour: 0 })
    expect(loader).toHaveBeenCalledTimes(3)
  })

  it('suppresses a canceled result while the final request is pending', async () => {
    const pending = deferred<CodexQuotaSnapshot>()
    const startedFetch = deferred<void>()
    const loader = vi.fn().mockResolvedValueOnce(snapshot(1_000, 10)).mockImplementationOnce(() => {
      startedFetch.resolve()
      return pending.promise
    })
    const tracker = new CodexTurnQuotaTracker(loader)
    const turn = tracker.start()
    await turn.before
    tracker.markPromptStarted(turn)
    const result = tracker.finish(turn)
    await startedFetch.promise
    tracker.cancel(turn)
    pending.resolve(snapshot(1_000, 12))
    expect(await result).toBeUndefined()
  })

  it('skips a final request for prompts that were never submitted', async () => {
    const loader = vi.fn().mockResolvedValue(snapshot(1_000, 10))
    const tracker = new CodexTurnQuotaTracker(loader)
    const turn = tracker.start()
    await turn.before
    expect(await tracker.finish(turn)).toBeUndefined()
    expect(loader).toHaveBeenCalledTimes(1)
  })
})
