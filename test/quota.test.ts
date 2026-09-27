import { describe, expect, it } from 'vitest'
import { parseCodexQuota, parseCursorMonthUsage, parseCursorQuota, windowLabel } from '../src/shared/quota'

describe('window labels', () => {
  it('names common periods and leaves other lengths numeric', () => {
    expect(windowLabel(18_000)).toBe('5小时')
    expect(windowLabel(604_800)).toBe('每周')
    expect(windowLabel(2_592_000)).toBe('每月')
    expect(windowLabel(7_200)).toBe('2小时')
    expect(windowLabel(10 * 86_400)).toBe('10天')
    expect(windowLabel(0)).toBe('')
  })
})

describe('cursor quota', () => {
  const cycleEnd = '1771077734000'

  it('reads monthly pools, cents, and the reset time', () => {
    const quota = parseCursorQuota(
      {
        billingCycleEnd: cycleEnd,
        planUsage: {
          includedSpend: 23222,
          remaining: 16778,
          limit: 40000,
          autoPercentUsed: 12,
          apiPercentUsed: 46.444
        },
        spendLimitUsage: { individualLimit: 10000, individualUsed: 2500 }
      },
      { planInfo: { planName: 'Ultra', billingCycleEnd: cycleEnd } }
    )
    expect(quota.plan).toBe('Ultra')
    expect(quota.note).toBeUndefined()
    expect(quota.windows.map((row) => row.detail)).toEqual(['Cursor 模型', '其他模型', '按需支出'])
    expect(quota.windows.every((row) => row.label === '每月')).toBe(true)
    expect(quota.windows[0]).toMatchObject({ usedPercent: 12, resetsAt: 1_771_077_734_000 })
    expect(quota.windows[1]).toMatchObject({
      usedPercent: 46.444,
      amount: '$232.22 / $400.00',
      resetsAt: 1_771_077_734_000
    })
    expect(quota.windows[2]).toMatchObject({ usedPercent: 25, amount: '$25.00 / $100.00' })
  })

  it('skips on-demand when there is no concrete limit', () => {
    const quota = parseCursorQuota(
      { billingCycleEnd: cycleEnd, planUsage: { autoPercentUsed: 0 }, spendLimitUsage: { limitType: 'user' } },
      {}
    )
    expect(quota.windows).toHaveLength(1)
    expect(quota.windows[0].detail).toBe('Cursor 模型')
  })

  it('notes when the payload has no windows', () => {
    expect(parseCursorQuota({}, {}).note).toBe('没有可用的额度数据')
    expect(parseCursorQuota({}, {}).windows).toEqual([])
  })

  it('sums model tokens and cents for the current cycle', () => {
    const usage = parseCursorMonthUsage(
      {
        aggregations: [
          {
            modelIntent: 'composer-2.5',
            inputTokens: '1000',
            outputTokens: '200',
            cacheReadTokens: '3000',
            cacheWriteTokens: '40',
            totalCents: 150.5
          },
          {
            model_intent: 'gpt-5',
            input_tokens: '25',
            output_tokens: '5',
            cache_read_tokens: '0',
            cache_write_tokens: '10',
            total_cents: 49.5
          }
        ]
      },
      { planUsage: { totalSpend: 99999 } }
    )
    expect(usage).toEqual({
      inputTokens: 1025,
      outputTokens: 205,
      cacheReadTokens: 3000,
      cacheWriteTokens: 50,
      tokensKnown: true,
      costUsd: 2
    })
  })

  it('uses totalSpend when the summary has no price', () => {
    const usage = parseCursorMonthUsage(
      { aggregations: [{ modelIntent: 'auto', inputTokens: '10', outputTokens: '1' }] },
      { planUsage: { totalSpend: 1288 } }
    )
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 1, tokensKnown: true, costUsd: 12.88 })
  })

  it('keeps the billed total when the model summary is missing', () => {
    expect(parseCursorMonthUsage(null, { planUsage: { totalSpend: 250 } })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      tokensKnown: false,
      costUsd: 2.5
    })
    expect(parseCursorMonthUsage({}, {})).toBeUndefined()
    expect(parseCursorMonthUsage({ aggregations: [] }, {})).toBeUndefined()
  })
})

describe('codex quota', () => {
  it('reads a 5 hour window, a weekly window, and the reset timestamp', () => {
    const quota = parseCodexQuota({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 1_780_000_000 },
        secondary_window: { used_percent: 51, limit_window_seconds: 604_800, reset_at: 1_780_500_000 }
      },
      credits: { has_credits: false, unlimited: false, balance: '0' }
    })
    expect(quota.plan).toBe('plus')
    expect(quota.note).toBeUndefined()
    expect(quota.windows.map((row) => row.label)).toEqual(['5小时', '每周'])
    expect(quota.windows[0]).toMatchObject({ usedPercent: 25, resetsAt: 1_780_000_000_000 })
    expect(quota.windows[1].resetsAt).toBe(1_780_500_000_000)
  })

  it('skips a missing window and keeps a monthly extra window plus credits', () => {
    const quota = parseCodexQuota({
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: 1_780_000_000 },
        secondary_window: null
      },
      credits: { has_credits: true, balance: '5.00' },
      additional_rate_limits: {
        code_review: {
          primary_window: { used_percent: 8, limit_window_seconds: 2_592_000, reset_at: 1_781_000_000 }
        }
      }
    })
    expect(quota.windows.map((row) => [row.label, row.detail])).toEqual([
      ['5小时', undefined],
      ['每月', 'code review'],
      ['积分', undefined]
    ])
    expect(quota.windows[2]).toMatchObject({ usedPercent: null, amount: '$5.00' })
    expect(quota.windows[1].resetsAt).toBe(1_781_000_000_000)
  })

  it('notes when no window is present', () => {
    const quota = parseCodexQuota({ plan_type: 'plus', rate_limit: { secondary_window: null } })
    expect(quota.windows).toEqual([])
    expect(quota.note).toBe('没有可用的额度窗口')
  })
})
