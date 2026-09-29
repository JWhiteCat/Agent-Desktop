import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CliProvider, ResultItem } from '../src/shared/types'
import { ResultFooter } from '../src/renderer/src/components/Items'

vi.mock('../src/renderer/src/store', () => ({
  answerQuestion: vi.fn(),
  useStore: (selector: (state: unknown) => unknown) => selector({ modelsByCli: { cursor: [], codex: [], claude: [] } })
}))

function render(quotaUsage?: ResultItem['quotaUsage'], cli: CliProvider = 'codex') {
  return renderToStaticMarkup(createElement(ResultFooter, {
    cli,
    item: { id: 'result', kind: 'result', isError: false, model: 'gpt-5.4', usage: { inputTokens: 1_000 }, quotaUsage }
  }))
}

describe('result footer quota', () => {
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
