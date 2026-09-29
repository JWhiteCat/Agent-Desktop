import { describe, expect, it } from 'vitest'
import { parseCodexQuota, type ProviderQuota, type QuotaWindow } from '../src/shared/quota'
import { quotaDelta } from '../src/shared/turn-quota'

const startedAt = 1_800_000_000_000
const finishedAt = startedAt + 60_000
const resetsAt = startedAt + 3_600_000

function quota(fiveHour: number, weekly: number): ProviderQuota {
  return parseCodexQuota({
    rate_limit: {
      primary_window: { used_percent: fiveHour, limit_window_seconds: 18_000, reset_at: resetsAt },
      secondary_window: { used_percent: weekly, limit_window_seconds: 604_800, reset_at: resetsAt + 604_800_000 }
    }
  })
}

function delta(before: ProviderQuota, after: ProviderQuota) {
  return quotaDelta(before, after, startedAt, finishedAt)
}

describe('Codex turn quota', () => {
  it('records percentage point increases from the primary and secondary windows', () => {
    const result = delta(quota(25, 50), quota(26, 50.2))
    expect(result?.fiveHour).toBe(1)
    expect(result?.weekly).toBeCloseTo(0.2)
  })

  it('preserves a reported zero delta and supports one known window', () => {
    const before = quota(25, 50)
    const after = quota(25, 50)
    after.windows.pop()
    expect(delta(before, after)).toEqual({ fiveHour: 0 })
  })

  it('ignores additional pools even when their periods match', () => {
    const extra: QuotaWindow = { id: 'extra-model-primary', label: '5小时', usedPercent: 10, resetsAt }
    const before: ProviderQuota = { provider: 'codex', windows: [extra] }
    const after: ProviderQuota = { provider: 'codex', windows: [{ ...extra, usedPercent: 20 }] }
    expect(delta(before, after)).toBeUndefined()
  })

  it('omits a window if it reset, moved, expired, or has no reset timestamp', () => {
    for (const reset of [undefined, NaN, Infinity, resetsAt + 1, finishedAt, startedAt - 1]) {
      const before = quota(25, 50)
      const after = quota(26, 51)
      after.windows[0].resetsAt = reset
      expect(delta(before, after)).toEqual({ weekly: 1 })
    }
    const before = quota(0, 50)
    const after = quota(1, 51)
    before.windows[0].resetsAt = undefined
    after.windows[0].resetsAt = undefined
    expect(delta(before, after)).toEqual({ weekly: 1 })
    before.windows[0].resetsAt = finishedAt
    after.windows[0].resetsAt = finishedAt
    expect(delta(before, after)).toEqual({ weekly: 1 })
  })

  it('omits a window with decreased or invalid percentages', () => {
    for (const percent of [null, -1, NaN, Infinity, 24]) {
      const after = quota(26, 51)
      after.windows[0].usedPercent = percent
      expect(delta(quota(25, 50), after)).toEqual({ weekly: 1 })
    }
    for (const percent of [null, -1, NaN, Infinity]) {
      const before = quota(25, 50)
      before.windows[0].usedPercent = percent
      expect(delta(before, quota(26, 51))).toEqual({ weekly: 1 })
    }
  })

  it('does not compare changed window identities or ambiguous periods', () => {
    const before = quota(25, 50)
    const after = quota(26, 51)
    after.windows[0].id = 'secondary'
    expect(delta(before, after)).toEqual({ weekly: 1 })
    before.windows.push({ ...before.windows[0], id: 'secondary' })
    expect(delta(before, quota(26, 51))).toEqual({ weekly: 1 })
  })

  it('returns no data for empty windows, other providers, and invalid intervals', () => {
    expect(delta(quota(1, 1), { provider: 'codex', windows: [] })).toBeUndefined()
    expect(delta({ ...quota(1, 1), provider: 'cursor' }, quota(2, 2))).toBeUndefined()
    for (const [start, end] of [[NaN, finishedAt], [startedAt, Infinity], [finishedAt, startedAt]]) {
      expect(quotaDelta(quota(1, 1), quota(2, 2), start, end)).toBeUndefined()
    }
  })
})
