import { describe, expect, it } from 'vitest'
import { parseCodexQuota, type ProviderQuota } from '../src/shared/quota'
import { quotaSnapshot } from '../src/shared/turn-quota'

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
