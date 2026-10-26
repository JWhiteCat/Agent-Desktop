import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import type { ResultItem } from '../src/shared/types'
import { ResultFooter } from '../src/renderer/src/components/items/ResultFooter'

beforeEach(() => setLanguage('zh-CN'))
afterEach(() => setLanguage('system', 'zh-CN'))

const complete: ResultItem = {
  id: 'result', kind: 'result', isError: false, cli: 'cursor',
  timing: { elapsedMs: 10_000, firstVisibleOutputMs: 250, outcome: 'completed' },
  usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 0 }
}
function render(extra: Partial<ResultItem> = {}) {
  return renderToStaticMarkup(createElement(ResultFooter, { item: { ...complete, ...extra }, models: [] }))
}

describe('honest turn performance footer', () => {
  it('shows visible-text latency and whole-turn throughput with explicit limitations', () => {
    const html = render()
    expect(html).toContain('首字延迟 250ms')
    expect(html).toContain('整轮有效输出 20 token/s')
    expect(html).toContain('输入 100 · 输出 200 · 缓存读 300 · 缓存写 0')
    expect(html).toContain('不是可见出字速度或服务端 decode TPS')
    expect(html).toContain('Prefill / Decode TPS：不支持')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-label="首字延迟 250ms.')
    expect(html).toContain('title="从发送本轮提示')
  })

  it('never derives historical TTFT or decode speed from turn duration', () => {
    const html = render({ timing: undefined, durationMs: 10_000 })
    expect(html).toContain('首字延迟 暂无数据')
    expect(html).toContain('整轮有效输出 暂无数据')
    expect(html).not.toContain('20 token/s')
  })

  it('can show whole-turn throughput for tool-only turns without inventing visible text', () => {
    const html = render({ timing: { elapsedMs: 10_000, outcome: 'completed' } })
    expect(html).toContain('首字延迟 暂无数据')
    expect(html).toContain('整轮有效输出 20 token/s')
  })

  it.each(['cancelled', 'failed'] as const)('suppresses throughput for %s while retaining observed first text', (outcome) => {
    const html = render({ timing: { ...complete.timing!, outcome } })
    expect(html).toContain('首字延迟 250ms')
    expect(html).toContain('整轮有效输出 暂无数据')
  })

  it('keeps pending usage distinct from final zero output', () => {
    expect(render({ usageComplete: false })).toContain('整轮有效输出 暂无数据')
    expect(render({ usageComplete: false })).toContain('（统计中）')
    const zero = render({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })
    expect(zero).toContain('整轮有效输出 0 token/s')
    expect(zero).toContain('>0 tokens<')
    const missing = render({ usage: { inputTokens: 0 } })
    expect(missing).toContain('输出 未提供')
    expect(missing).toContain('缓存读 未提供')
    expect(missing).toContain('整轮有效输出 暂无数据')
    expect(render({ usage: undefined })).toContain('tokens 暂无数据')
  })

  it.each([NaN, Infinity, -1, 10_001])('rejects invalid first-text timing %s', (firstVisibleOutputMs) => {
    expect(render({ timing: { ...complete.timing!, firstVisibleOutputMs } })).toContain('首字延迟 暂无数据')
  })

  it('does not round tiny positive rates to zero', () => {
    expect(render({ timing: { elapsedMs: 1_000_000, outcome: 'completed' }, usage: { outputTokens: 1 } }))
      .toContain('整轮有效输出 &lt;0.01 token/s')
  })

  it('localizes metrics and definitions in English', () => {
    setLanguage('en')
    const html = render()
    expect(html).toContain('First visible text 250ms')
    expect(html).toContain('Turn-effective output 20 token/s')
    expect(html).toContain('Prefill / Decode TPS: unsupported')
    expect(html).toContain('not visible-text speed or server decode TPS')
    expect(html).not.toMatch(/[\u4e00-\u9fff]/)
  })
})
