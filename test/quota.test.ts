import { describe, expect, it } from 'vitest'
import { applyCursorMonthUsage, parseCodexQuota, parseCursorQuota, windowLabel } from '../src/shared/quota'

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
      resetsAt: 1_771_077_734_000
    })
    expect(quota.windows[1].amount).toBeUndefined()
    expect(quota.windows[2]).toMatchObject({ usedPercent: 25, amount: '$25.00 / $100.00' })
  })

  it('does not show the saturated included cap as other-model spend', () => {
    const quota = parseCursorQuota(
      {
        planUsage: {
          totalSpend: 104661,
          includedSpend: 2000,
          bonusSpend: 102661,
          limit: 2000,
          autoPercentUsed: 80.6,
          apiPercentUsed: 100
        }
      },
      { planInfo: { planName: 'Team' } }
    )
    expect(quota.windows.find((row) => row.id === 'other-models')).toMatchObject({ usedPercent: 100 })
    expect(quota.windows.find((row) => row.id === 'other-models')?.amount).toBeUndefined()
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

  it('puts tokens and price on the matching monthly rows', () => {
    const period = {
      billingCycleEnd: cycleEnd,
      planUsage: { autoPercentUsed: 12, apiPercentUsed: 46, includedSpend: 100, limit: 400 },
      spendLimitUsage: { individualLimit: 10000, individualUsed: 2500 },
      autoBucketModels: ['composer-2.5']
    }
    const quota = parseCursorQuota(period, {})
    applyCursorMonthUsage(
      quota,
      {
        aggregations: [
          {
            modelIntent: 'composer-2.5',
            inputTokens: '1000',
            outputTokens: '200',
            cacheReadTokens: '3000',
            cacheWriteTokens: '40',
            totalCents: 150.5,
            tier: 2
          },
          {
            modelIntent: 'gpt-5',
            inputTokens: '25',
            outputTokens: '5',
            cacheReadTokens: '0',
            cacheWriteTokens: '10',
            totalCents: 49.5,
            tier: 1
          },
          {
            modelIntent: 'claude-sonnet',
            kind: 'USAGE_EVENT_KIND_USAGE_BASED',
            inputTokens: '8',
            outputTokens: '2',
            totalCents: 20
          }
        ]
      },
      period
    )
    expect(quota.windows.map((row) => row.detail)).toEqual(['Cursor 模型', '其他模型', '按需支出'])
    expect(quota.windows[0].usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 3000,
      cacheWriteTokens: 40,
      tokensKnown: true,
      costUsd: 1.505
    })
    expect(quota.windows[1].usage).toMatchObject({ inputTokens: 25, outputTokens: 5, cacheWriteTokens: 10, tokensKnown: true, costUsd: 0.495 })
    expect(quota.windows[2].usage).toMatchObject({ inputTokens: 8, outputTokens: 2, tokensKnown: true, costUsd: 0.2 })
  })

  it('falls back to the auto bucket and the grok prefix when tier is missing', () => {
    const period = {
      planUsage: { autoPercentUsed: 1, apiPercentUsed: 1, limit: 100, includedSpend: 1 },
      autoBucketModels: ['custom-model']
    }
    const quota = parseCursorQuota(period, {})
    applyCursorMonthUsage(
      quota,
      {
        aggregations: [
          { modelIntent: 'custom-model', inputTokens: '3', totalCents: 10 },
          { model_intent: 'grok-4.5', input_tokens: '4', total_cents: 20 },
          { modelIntent: 'sand-bot', inputTokens: '100', totalCents: 30 },
          { modelIntent: 'claude-sonnet', inputTokens: '5', totalCents: 40 }
        ]
      },
      period
    )
    expect(quota.windows[0].usage).toMatchObject({ inputTokens: 7, costUsd: 0.3 })
    expect(quota.windows[1].usage).toMatchObject({ inputTokens: 105, costUsd: 0.7 })
  })

  it('uses on-demand spend when that pool has no model rows', () => {
    const period = {
      planUsage: { autoPercentUsed: 0 },
      spendLimitUsage: { pooledLimit: 5000, pooledUsed: 1250 }
    }
    const quota = parseCursorQuota(period, {})
    applyCursorMonthUsage(quota, null, period)
    expect(quota.windows.map((row) => row.id)).toEqual(['cursor-models', 'on-demand-pooled'])
    expect(quota.windows[0].usage).toBeUndefined()
    expect(quota.windows[1].usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      tokensKnown: false,
      costUsd: 12.5
    })
  })

  it('leaves the rows alone when neither summary nor on-demand spend is present', () => {
    const quota = parseCursorQuota({ planUsage: { autoPercentUsed: 0 } }, {})
    applyCursorMonthUsage(quota, { aggregations: [] }, {})
    expect(quota.windows).toHaveLength(1)
    expect(quota.windows[0].usage).toBeUndefined()
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
