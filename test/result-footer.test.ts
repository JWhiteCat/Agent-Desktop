import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CliProvider, ResultItem } from '../src/shared/types'
import { ResultFooter } from '../src/renderer/src/components/Items'

vi.mock('../src/renderer/src/store', () => ({
  answerQuestion: vi.fn(),
  useStore: (selector: (state: unknown) => unknown) => selector({ modelsByCli: { cursor: [], codex: [], claude: [] } })
}))

function render(quotaUsage?: ResultItem['quotaUsage'], cli: CliProvider = 'codex', extra: Partial<ResultItem> = {}) {
  return renderToStaticMarkup(createElement(ResultFooter, {
    cli,
    item: { id: 'result', kind: 'result', isError: false, model: 'gpt-5.4', usage: { inputTokens: 1_000 }, quotaUsage, ...extra }
  }))
}

describe('result footer quota', () => {
  it('shows the account windows even without a before/after estimate', () => {
    const html = render(undefined, 'codex', { quotaSnapshot: {
      sampledAt: 1_800_000_000_000, weekly: { usedPercent: 37 }, fiveHour: { usedPercent: 99.5 }
    } })
    expect(html).toContain('周额度剩余 63% · 5小时剩余 0.5%')
    expect(html).toContain('由所有会话共享')
    expect(html).not.toContain('账号变化估算')
    expect(html.indexOf('周额度剩余')).toBeGreaterThan(html.indexOf('>$0.0025</span>'))
  })

  it('shows a weekly-only plan without inventing a five-hour window', () => {
    const html = render({ weekly: 3 }, 'codex', { quotaSnapshot: { sampledAt: 1_800_000_000_000, weekly: { usedPercent: 103 } } })
    expect(html).toContain('周额度剩余 0%')
    expect(html).not.toContain('5小时')
    expect(html).not.toContain('账号变化估算')
  })

  it('labels Codex thread credits as session totals and handles a missing USD estimate', () => {
    const html = render(undefined, 'codex', { codexThreadUsage: { threadId: 'session', credits: 1.25, costUsd: 0.04 } })
    expect(html).toContain('会话消耗 1.25 credits / $0.04')
    expect(html).toContain('当前会话累计开销估算')
    expect(html).toContain('不受其他会话影响')
    const noPrice = render(undefined, 'codex', { codexThreadUsage: { threadId: 'session', credits: 0.000001 } })
    expect(noPrice).toContain('会话消耗 &lt;0.0001 credits')
    expect(noPrice).not.toContain('credits /')
  })

  it('shows both quota estimates to the right of the price', () => {
    const html = render({ weekly: 0.20000000000000284, fiveHour: 1 })
    expect(html).toContain('周额度 0.2% · 5小时 1%')
    expect(html).toContain('>$0.0025</span>')
    expect(html.indexOf('周额度')).toBeGreaterThan(html.indexOf('>$0.0025</span>'))
    expect(html).toContain('本轮前后账号已用额度的百分点增量')
    expect(html).toContain('其他客户端')
  })

  it('shows a single window and explains what zero means', () => {
    const html = render({ weekly: 0 })
    expect(html).toContain('周额度 0%')
    expect(html).not.toContain('5小时')
    expect(html).toContain('0% 表示账号百分比未变化，不代表本次没有消耗')
  })

  it('does not round a small positive value to zero', () => {
    expect(render({ fiveHour: 0.001 })).toContain('5小时 &lt;0.01%')
  })

  it('leaves old results, unavailable windows, and other CLIs unchanged', () => {
    for (const html of [render(), render({}), render({ weekly: NaN, fiveHour: -1 }), render({ weekly: 1 }, 'cursor'), render({ weekly: 1 }, 'claude')]) {
      expect(html).not.toContain('周额度')
      expect(html).not.toContain('5小时')
      expect(html).not.toContain('本次额度消耗估算')
    }
  })
})
