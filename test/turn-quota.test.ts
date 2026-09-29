import { describe, expect, it } from 'vitest'
import { parseCodexQuota, type ProviderQuota } from '../src/shared/quota'
import { quotaSnapshot, weeklyQuotaEstimate, type TurnQuotaSnapshot } from '../src/shared/turn-quota'

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

describe('Codex turn quota snapshots', () => {
  it('records observed account windows without calculating turn consumption', () => {
    expect(quotaSnapshot(quota(25, 50), finishedAt)).toEqual({
      sampledAt: finishedAt,
      fiveHour: { usedPercent: 25, resetsAt },
      weekly: { usedPercent: 50, resetsAt: resetsAt + 604_800_000 }
    })
  })

  it('supports a weekly primary window without assuming that primary is five hours', () => {
    expect(quotaSnapshot(parseCodexQuota({
      limit_id: 'codex',
      primary: { used_percent: 37, window_minutes: 10_080, resets_at: resetsAt },
      secondary: null
    }), finishedAt)).toEqual({ sampledAt: finishedAt, weekly: { usedPercent: 37, resetsAt } })
  })

  it('omits invalid and ambiguous snapshot windows without requiring reset timestamps', () => {
    const current = quota(0, 50)
    current.windows[0].resetsAt = undefined
    current.windows[1].usedPercent = NaN
    expect(quotaSnapshot(current, finishedAt)).toEqual({ sampledAt: finishedAt, fiveHour: { usedPercent: 0 } })
    current.windows.push({ ...current.windows[0], id: 'secondary' })
    expect(quotaSnapshot(current, finishedAt)).toBeUndefined()
  })

  it('rejects snapshots without main windows, a valid sample time, or the Codex provider', () => {
    expect(quotaSnapshot({ provider: 'codex', windows: [{ id: 'extra', label: '每周', usedPercent: 10 }] }, finishedAt)).toBeUndefined()
    expect(quotaSnapshot({ ...quota(1, 1), provider: 'cursor' }, finishedAt)).toBeUndefined()
    expect(quotaSnapshot(quota(1, 1), NaN)).toBeUndefined()
  })

})

describe('weekly account quota estimate for a single turn', () => {
  function snapshot(usedPercent: number, sampledAt = startedAt, reset: number | undefined = resetsAt): TurnQuotaSnapshot {
    return { sampledAt, weekly: { usedPercent, resetsAt: reset }, fiveHour: { usedPercent: 90, resetsAt } }
  }

  it('retains both observations and estimates the weekly increase only', () => {
    const start = snapshot(30)
    const end = snapshot(30.5, finishedAt)
    end.fiveHour!.usedPercent = 95
    expect(weeklyQuotaEstimate(start, end)).toEqual({ start, end, usedPercent: 0.5 })
  })

  it('preserves genuine zero, small increases, and values over 100 percent', () => {
    expect(weeklyQuotaEstimate(snapshot(30), snapshot(30, finishedAt)).usedPercent).toBe(0)
    expect(weeklyQuotaEstimate(snapshot(0), snapshot(0.000001, finishedAt)).usedPercent).toBe(0.000001)
    expect(weeklyQuotaEstimate(snapshot(100), snapshot(101.25, finishedAt)).usedPercent).toBe(1.25)
  })

  it('retains available observations without inventing missing readings or reset times', () => {
    const start = snapshot(30)
    const end = snapshot(31, finishedAt)
    expect(weeklyQuotaEstimate()).toEqual({ start: undefined, end: undefined })
    expect(weeklyQuotaEstimate(start)).toEqual({ start, end: undefined })
    expect(weeklyQuotaEstimate(undefined, end)).toEqual({ start: undefined, end })
    expect(weeklyQuotaEstimate({ sampledAt: startedAt }, end).usedPercent).toBeUndefined()
    expect(weeklyQuotaEstimate(start, { sampledAt: finishedAt }).usedPercent).toBeUndefined()
    delete start.weekly!.resetsAt
    delete end.weekly!.resetsAt
    expect(weeklyQuotaEstimate(start, end)).toEqual({ start, end })
  })

  it('rejects changed or expired reset periods even when the account percentage increases', () => {
    expect(weeklyQuotaEstimate(snapshot(30), snapshot(31, finishedAt, resetsAt + 604_800_000)).usedPercent).toBeUndefined()
    expect(weeklyQuotaEstimate(snapshot(30, startedAt, finishedAt), snapshot(31, finishedAt, finishedAt)).usedPercent).toBeUndefined()
    expect(weeklyQuotaEstimate(snapshot(30, startedAt, startedAt - 1), snapshot(31, finishedAt, startedAt - 1)).usedPercent).toBeUndefined()
  })

  it.each([NaN, Infinity, -Infinity, 0, -1])('rejects invalid matching reset timestamps %s', (reset) => {
    expect(weeklyQuotaEstimate(snapshot(30, startedAt, reset), snapshot(31, finishedAt, reset)).usedPercent).toBeUndefined()
  })

  it.each([NaN, Infinity, -Infinity, -1])('rejects invalid weekly percentages %s at either end', (value) => {
    expect(weeklyQuotaEstimate(snapshot(value), snapshot(31, finishedAt)).usedPercent).toBeUndefined()
    expect(weeklyQuotaEstimate(snapshot(30), snapshot(value, finishedAt)).usedPercent).toBeUndefined()
  })

  it('rejects decreasing readings and reversed or nonfinite sampling times', () => {
    expect(weeklyQuotaEstimate(snapshot(31), snapshot(30, finishedAt)).usedPercent).toBeUndefined()
    expect(weeklyQuotaEstimate(snapshot(30, finishedAt), snapshot(31, startedAt)).usedPercent).toBeUndefined()
    for (const time of [NaN, Infinity, -Infinity]) {
      expect(weeklyQuotaEstimate(snapshot(30, time), snapshot(31, finishedAt)).usedPercent).toBeUndefined()
      expect(weeklyQuotaEstimate(snapshot(30), snapshot(31, time)).usedPercent).toBeUndefined()
    }
  })
})
