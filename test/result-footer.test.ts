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

describe('result footer session consumption', () => {
  const accountSnapshot: ResultItem['quotaSnapshot'] = {
    sampledAt: 1_800_000_000_000, weekly: { usedPercent: 37 }, fiveHour: { usedPercent: 99.5 }
  }

  function expectNoAccountQuota(html: string) {
    expect(html).not.toContain('剩余')
    expect(html).not.toContain('周额度')
    expect(html).not.toContain('5小时')
    expect(html).not.toContain('账号变化估算')
  }

  it('shows only the independent session total when account readings are also present', () => {
    const html = render({ weekly: 0.2, fiveHour: 1 }, 'codex', {
      quotaSnapshot: accountSnapshot,
      codexThreadUsage: { threadId: 'session', credits: 1.25, costUsd: 0.04 }
    })
    expect(html).toContain('本次会话消耗 1.25 credits / $0.04')
    expect(html).toContain('当前会话累计额度消耗估算')
    expect(html).toContain('不受其他会话影响')
    expect(html).toContain('>$0.0025</span>')
    expect(html.indexOf('本次会话消耗')).toBeGreaterThan(html.indexOf('>$0.0025</span>'))
    expectNoAccountQuota(html)
  })

  it('shows unavailable session consumption while preserving independently recorded tokens and price', () => {
    for (const html of [render(), render({ weekly: 0.2, fiveHour: 1 }), render(undefined, 'codex', { quotaSnapshot: accountSnapshot })]) {
      expect(html).toContain('本次会话消耗 未提供')
      expect(html).toContain('未提供不代表消耗为零')
      expect(html).toContain('token 和公开价格估算仍可参考')
      expect(html).toContain('1.0k tokens')
      expect(html).toContain('>$0.0025</span>')
      expect(html).not.toContain('本次会话消耗 0')
      expectNoAccountQuota(html)
    }
  })

  it('shows valid zero credits and zero USD as supplied by Codex', () => {
    const html = render(undefined, 'codex', { codexThreadUsage: { threadId: 'session', credits: 0, costUsd: 0 } })
    expect(html).toContain('本次会话消耗 0 credits / $0</span>')
    expect(html).not.toContain('未提供')
  })

  it('does not round small positive credits to zero or require a USD estimate', () => {
    const html = render(undefined, 'codex', { codexThreadUsage: { threadId: 'session', credits: 0.000001 } })
    expect(html).toContain('本次会话消耗 &lt;0.0001 credits')
    expect(html).not.toContain('credits /')
    expect(html).not.toContain('未提供')
  })

  it.each([NaN, Infinity, -Infinity, -1])('treats invalid session credits %s as unavailable', (credits) => {
    const html = render({ weekly: 1 }, 'codex', {
      quotaSnapshot: accountSnapshot,
      codexThreadUsage: { threadId: 'session', credits, costUsd: 0.04 }
    })
    expect(html).toContain('本次会话消耗 未提供')
    expect(html).not.toContain('credits /')
    expect(html).toContain('>$0.0025</span>')
    expectNoAccountQuota(html)
  })

  it.each([NaN, Infinity, -Infinity, -1])('omits invalid USD %s without hiding valid credits', (costUsd) => {
    const html = render(undefined, 'codex', { codexThreadUsage: { threadId: 'session', credits: 1.25, costUsd } })
    expect(html).toContain('本次会话消耗 1.25 credits')
    expect(html).not.toContain('credits /')
    expect(html).not.toContain('未提供')
  })

  it.each(['cursor', 'claude'] as const)('does not show Codex consumption for %s results', (cli) => {
    const extra: Partial<ResultItem> = {
      quotaSnapshot: accountSnapshot,
      codexThreadUsage: { threadId: 'session', credits: 1.25, costUsd: 0.04 }
    }
    for (const html of [render({ weekly: 1 }, cli, extra), render({ weekly: 1 }, 'codex', { ...extra, cli })]) {
      expect(html).not.toContain('本次会话消耗')
      expect(html).not.toContain('credits')
      expectNoAccountQuota(html)
    }
  })

  it('keeps Codex consumption when a saved Codex result is in a conversation switched to another CLI', () => {
    const html = render(undefined, 'cursor', {
      cli: 'codex', codexThreadUsage: { threadId: 'session', credits: 1.25 }
    })
    expect(html).toContain('本次会话消耗 1.25 credits')
  })
})
