import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import type { CliProvider, ResultItem } from '../src/shared/types'
import { ResultFooter } from '../src/renderer/src/components/Items'

vi.mock('../src/renderer/src/store', () => ({
  answerQuestion: vi.fn(),
  useStore: (selector: (state: unknown) => unknown) => selector({ modelsByCli: { cursor: [], codex: [], claude: [] } })
}))

beforeEach(() => setLanguage('zh-CN', 'zh-CN'))
afterEach(() => setLanguage('system', 'zh-CN'))

function render(quotaUsage?: ResultItem['quotaUsage'], cli: CliProvider = 'codex', extra: Partial<ResultItem> = {}) {
  return renderToStaticMarkup(createElement(ResultFooter, {
    cli,
    item: { id: 'result', kind: 'result', isError: false, model: 'gpt-5.4', usage: { inputTokens: 1_000 }, quotaUsage, ...extra }
  }))
}

describe('result footer session consumption', () => {
  const accountSnapshot: ResultItem['quotaSnapshot'] = {
    sampledAt: 1_800_000_000_000, weekly: { usedPercent: 37 }, fiveHour: { usedPercent: 99.5 }
  }

  function expectNoAccountQuota(html: string) {
    expect(html).not.toContain('剩余')
    expect(html).not.toMatch(/本轮周额度 (?:&lt;)?\d+(?:\.\d+)?%/)
    expect(html).not.toContain('5小时')
    expect(html).not.toContain('账号变化估算')
  }

  it('shows only the independent session total when account readings are also present', () => {
    const html = render({ weekly: 0.2, fiveHour: 1 }, 'codex', {
      quotaSnapshot: accountSnapshot,
      codexThreadUsage: { threadId: 'session', credits: 1.25, costUsd: 0.04 }
    })
    expect(html).toContain('本轮周额度 1.25 credits / $0.04')
    expect(html).toContain('当前会话累计额度消耗估算')
    expect(html).toContain('不受其他会话影响')
    expect(html).toContain('>$0.0025</span>')
    expect(html.indexOf('本轮周额度')).toBeGreaterThan(html.indexOf('>$0.0025</span>'))
    expectNoAccountQuota(html)
  })

  it('shows missing readings while preserving independently recorded tokens and price', () => {
    for (const html of [render(), render({ weekly: 0.2, fiveHour: 1 }), render(undefined, 'codex', { quotaSnapshot: accountSnapshot })]) {
      expect(html).toContain('本轮周额度 暂无数据')
      expect(html).toContain('尚未获得当前会话的额度消耗数据')
      expect(html).toContain('token 和公开价格估算仍可参考')
      expect(html).toContain('1.0k tokens')
      expect(html).toContain('>$0.0025</span>')
      expect(html).not.toContain('本轮周额度 0')
      expectNoAccountQuota(html)
    }
  })

  it('shows valid zero credits and zero USD as supplied by Codex', () => {
    const html = render(undefined, 'codex', { codexThreadUsage: { threadId: 'session', credits: 0, costUsd: 0 } })
    expect(html).toContain('本轮周额度 0 credits / $0</span>')
    expect(html).not.toContain('未提供')
  })

  it('does not round small positive credits to zero or require a USD estimate', () => {
    const html = render(undefined, 'codex', { codexThreadUsage: { threadId: 'session', credits: 0.000001 } })
    expect(html).toContain('本轮周额度 &lt;0.0001 credits')
    expect(html).not.toContain('credits /')
    expect(html).not.toContain('未提供')
  })

  it.each([NaN, Infinity, -Infinity, -1])('keeps invalid legacy session credits %s pending', (credits) => {
    const html = render({ weekly: 1 }, 'codex', {
      quotaSnapshot: accountSnapshot,
      codexThreadUsage: { threadId: 'session', credits, costUsd: 0.04 }
    })
    expect(html).toContain('本轮周额度 暂无数据')
    expect(html).not.toContain('credits /')
    expect(html).toContain('>$0.0025</span>')
    expectNoAccountQuota(html)
  })

  it.each([NaN, Infinity, -Infinity, -1])('omits invalid USD %s without hiding valid credits', (costUsd) => {
    const html = render(undefined, 'codex', { codexThreadUsage: { threadId: 'session', credits: 1.25, costUsd } })
    expect(html).toContain('本轮周额度 1.25 credits')
    expect(html).not.toContain('credits /')
    expect(html).not.toContain('未提供')
  })

  it.each(['cursor', 'claude'] as const)('does not show Codex consumption for %s results', (cli) => {
    const extra: Partial<ResultItem> = {
      quotaSnapshot: accountSnapshot,
      codexSessionUsage: { threadId: 'session', status: 'available', weekly: 1, fiveHour: 2 },
      codexThreadUsage: { threadId: 'session', credits: 1.25, costUsd: 0.04 }
    }
    for (const html of [render({ weekly: 1 }, cli, extra), render({ weekly: 1 }, 'codex', { ...extra, cli })]) {
      expect(html).not.toContain('本轮周额度')
      expect(html).not.toContain('credits')
      expectNoAccountQuota(html)
    }
  })

  it('keeps Codex consumption when a saved Codex result is in a conversation switched to another CLI', () => {
    const html = render(undefined, 'cursor', {
      cli: 'codex', codexThreadUsage: { threadId: 'session', credits: 1.25 }
    })
    expect(html).toContain('本轮周额度 1.25 credits')
  })

  it('prefers independently attributed consumer allowances over legacy credits and account readings', () => {
    const html = render({ weekly: 0.2, fiveHour: 1 }, 'codex', {
      quotaSnapshot: accountSnapshot,
      codexThreadUsage: { threadId: 'session', credits: 12.5 },
      codexSessionUsage: {
        threadId: 'session', status: 'available', weekly: 18.899578816199377, fiveHour: 0,
        balanceCredits: '0E-10', dataAsOf: '2026-09-29T12:34:56Z'
      }
    })
    expect(html).toContain('本轮周额度 18.8996% · 5小时额度 0%')
    expect(html).toContain('服务统计时间：2026-09-29T12:34:56Z')
    expect(html).toContain('不受其他会话影响')
    expect(html).not.toContain('credits')
    expect(html).not.toContain('剩余')
    expect(html).not.toContain('37%')
    expect(html).not.toContain('0.2%')
    expect(html).not.toContain('未提供')
  })

  it('shows only returned windows, preserves small usage, and allows percentages over 100', () => {
    const weekly = render(undefined, 'codex', {
      codexSessionUsage: { threadId: 'session', status: 'available', weekly: 0.000001 }
    })
    expect(weekly).toContain('本轮周额度 &lt;0.0001%')
    expect(weekly).not.toContain('5小时')
    expect(weekly).not.toContain('credits')
    const fiveHour = render(undefined, 'codex', {
      codexSessionUsage: { threadId: 'session', status: 'available', fiveHour: 150.25 }
    })
    expect(fiveHour).toContain('本轮周额度 5小时额度 150.25%')
    expect(fiveHour).not.toMatch(/本轮周额度 (?:&lt;)?\d+(?:\.\d+)?%/)
  })

  it('marks partial readings as still being counted', () => {
    const html = render(undefined, 'codex', {
      codexSessionUsage: { threadId: 'session', status: 'partial', weekly: 0, dataAsOf: '2026-09-29T12:34:56Z' }
    })
    expect(html).toContain('本轮周额度 0%（统计中）')
    expect(html).toContain('当前数值尚未完整')
    expect(html).toContain('服务统计时间：2026-09-29T12:34:56Z')
  })

  it('reports unavailable accounting without promising delayed data or rendering stale allowances', () => {
    const html = render({ weekly: 1 }, 'codex', {
      quotaSnapshot: accountSnapshot,
      codexSessionUsage: {
        threadId: 'session', status: 'unavailable', weekly: 99, fiveHour: 0, balanceCredits: '12.3',
        dataAsOf: '2026-09-29T12:34:56Z'
      }
    })
    expect(html).toContain('本轮周额度 服务未返回')
    expect(html).toContain('无法确认是统计延迟还是当前会话不受支持')
    expect(html).toContain('服务统计时间：2026-09-29T12:34:56Z')
    expect(html).not.toContain('本轮周额度 0')
    expect(html).not.toContain('credits')
    expect(html).not.toContain('未提供')
    expectNoAccountQuota(html)
  })

  it('falls back to valid legacy session credits when consumer accounting is unavailable', () => {
    const html = render(undefined, 'codex', {
      codexSessionUsage: { threadId: 'session', status: 'unavailable', dataAsOf: '2026-09-29T12:34:56Z' },
      codexThreadUsage: { threadId: 'session', credits: 1.25 }
    })
    expect(html).toContain('本轮周额度 1.25 credits')
    expect(html).toContain('服务统计时间：2026-09-29T12:34:56Z')
    expect(html).not.toContain('服务未返回')
  })

  it.each(['-0.000000000000000001', '1.000000000000000002', '-1E+3', '1e-400'])
    ('preserves nonzero balance debit or adjustment %s without rounding', (balanceCredits) => {
      const html = render(undefined, 'codex', {
        codexSessionUsage: { threadId: 'session', status: 'available', weekly: 1, balanceCredits }
      })
      expect(html).toContain(`本轮周额度 1% · ${balanceCredits} credits`)
    })

  it.each(['0E-10', '-0.000', '0', 'NaN', 'Infinity', '1..2', '1e', ' 1'])
    ('omits zero or malformed balance credits %s', (balanceCredits) => {
      const html = render(undefined, 'codex', {
        codexSessionUsage: { threadId: 'session', status: 'available', weekly: 1, balanceCredits }
      })
      expect(html).toContain('本轮周额度 1%')
      expect(html).not.toContain('credits')
    })

  it('reports malformed stored readings as unavailable instead of rendering invalid percentages', () => {
    const html = render(undefined, 'codex', {
      codexSessionUsage: { threadId: 'session', status: 'available', weekly: NaN, fiveHour: -1, balanceCredits: 'NaN' }
    })
    expect(html).toContain('本轮周额度 服务未返回')
    expect(html).not.toContain('NaN')
    expect(html).not.toContain('credits')
    expectNoAccountQuota(html)
  })

  it.each(['available', 'partial'] as const)('shows an explicit zero debit when it is the only %s accounting amount', (status) => {
    const html = render(undefined, 'codex', {
      codexSessionUsage: { threadId: 'session', status, balanceCredits: '0E-10' }
    })
    expect(html).toContain(`本轮周额度 0 credits${status === 'partial' ? '（统计中）' : ''}`)
    expect(html).not.toContain('服务未返回')
    expect(html).not.toContain('暂无数据')
  })
})

describe('result footer weekly turn estimate', () => {
  const weeklyQuotaEstimate: ResultItem['weeklyQuotaEstimate'] = {
    start: { sampledAt: 1_800_000_000_000, weekly: { usedPercent: 30, resetsAt: 1_801_000_000_000 } },
    end: { sampledAt: 1_800_000_060_000, weekly: { usedPercent: 30.5, resetsAt: 1_801_000_000_000 } },
    usedPercent: 0.5
  }

  it('shows the turn estimate beside independent cumulative session consumption with its source explained', () => {
    const html = render(undefined, 'codex', {
      weeklyQuotaEstimate,
      codexSessionUsage: { threadId: 'session', status: 'available', weekly: 8 }
    })
    expect(html).toContain('本轮周额度 8%')
    expect(html).toContain('本轮预估周额度 0.5%')
    expect(html.indexOf('本轮预估周额度')).toBeGreaterThan(html.indexOf('本轮周额度'))
    expect(html).not.toContain('周额度 周额度')
    expect(html).not.toContain('本次会话消耗')
    expect(html).not.toContain('本轮预估消耗')
    expect(html).toContain('开始 30%，结束 30.5%')
    expect(html).toContain('计算：结束 − 开始')
    expect(html).toContain('账号其他会话、其他客户端的使用和统计延迟可能影响估算')
    expect(html).toContain('0% 表示读数未变化')
  })

  it.each([[0, '0'], [0.000001, '&lt;0.0001'], [0.123456, '0.1235']])('formats an estimate of %s without losing a tiny positive amount', (usedPercent, expected) => {
    const html = render(undefined, 'codex', { weeklyQuotaEstimate: { ...weeklyQuotaEstimate, usedPercent: Number(usedPercent) } })
    expect(html).toContain(`本轮预估周额度 ${expected}%`)
  })

  it.each([undefined, NaN, Infinity, -Infinity, -1])('recovers missing or invalid difference %s from saved observations', (usedPercent) => {
    const html = render(undefined, 'codex', { weeklyQuotaEstimate: { ...weeklyQuotaEstimate, usedPercent } })
    expect(html).toContain('本轮预估周额度 0.5%')
    expect(html).toContain('开始 30%，结束 30.5%')
    expect(html).not.toContain('暂不能估算')
  })

  it.each([
    [74, 79, -1_000, 5],
    [84, 96, -1_000, 12],
    [74, 86, 1_000, 12]
  ])('recovers a saved %s to %s reading with reset drift %s as %s percent', (start, end, drift, expected) => {
    const estimate = {
      start: { sampledAt: 1_790_697_364_680, weekly: { usedPercent: start, resetsAt: 1_791_141_433_000 } },
      end: { sampledAt: 1_790_697_761_791, weekly: { usedPercent: end, resetsAt: 1_791_141_433_000 + drift } }
    }
    const saved = structuredClone(estimate)
    const html = render(undefined, 'codex', { weeklyQuotaEstimate: estimate })
    expect(html).toContain(`本轮预估周额度 ${expected}%`)
    expect(html).toContain(`开始 ${start}%，结束 ${end}%`)
    expect(html).not.toContain('暂不能估算')
    expect(estimate).toEqual(saved)
  })

  it('keeps missing or incomparable saved observations unavailable despite a current account snapshot', () => {
    const start = weeklyQuotaEstimate.start!
    const end = weeklyQuotaEstimate.end!
    for (const estimate of [
      { start },
      { end },
      { start: { ...start, weekly: { usedPercent: 30 } }, end },
      { start, end: { ...end, weekly: { usedPercent: 30.5, resetsAt: start.weekly!.resetsAt! + 604_800_000 } } }
    ]) {
      const html = render(undefined, 'codex', { weeklyQuotaEstimate: estimate, quotaSnapshot: end })
      expect(html).toContain('本轮预估周额度 暂无数据')
      expect(html).toContain('暂不能估算')
    }
  })

  it('shows unavailable observations but hides the estimate entirely for old results', () => {
    expect(render(undefined, 'codex', { weeklyQuotaEstimate: {} })).toContain('本轮预估周额度 暂无数据')
    expect(render(undefined, 'codex', { weeklyQuotaEstimate: {} })).toContain('开始 暂无数据，结束 暂无数据')
    expect(render()).not.toContain('本轮预估周额度')
  })

  it.each(['cursor', 'claude'] as const)('uses the saved result provider when a conversation switches to %s', (cli) => {
    expect(render(undefined, cli, { weeklyQuotaEstimate })).not.toContain('本轮预估周额度')
    expect(render(undefined, 'codex', { weeklyQuotaEstimate, cli })).not.toContain('本轮预估周额度')
    expect(render(undefined, cli, { weeklyQuotaEstimate, cli: 'codex' })).toContain('本轮预估周额度 0.5%')
  })
})
