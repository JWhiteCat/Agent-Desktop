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
  timing: { elapsedMs: 10_000, firstVisibleOutputMs: 250, outcome: 'completed',
    visibleStream: { tokenizer: 'cl100k_base', tokens: 100, durationMs: 2000, segments: 2, excludedSegments: 1 } },
  usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 0 }
}
function render(extra: Partial<ResultItem> = {}) {
  return renderToStaticMarkup(createElement(ResultFooter, { item: { ...complete, ...extra }, models: [] }))
}

describe('honest turn performance footer', () => {
  it('shows visible-text latency and independently estimated streaming throughput with explicit limitations', () => {
    const html = render()
    expect(html).toContain('首字延迟 250ms')
    expect(html).toContain('可见输出 TPS（估算）50 token/s')
    expect(html).toContain('输入 100 · 输出 200 · 缓存读 300 · 缓存写 0')
    expect(html).toContain('不是模型原生 tokenizer 或服务端 decode TPS')
    expect(html).toContain('服务端 Prefill / Decode：未提供')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-label="首字延迟 250ms.')
    expect(html).toContain('title="从发送本轮提示')
  })

  it('never derives historical TTFT or decode speed from turn duration', () => {
    const html = render({ timing: undefined, durationMs: 10_000 })
    expect(html).toContain('首字延迟 暂无数据')
    expect(html).toContain('可见输出 TPS（估算）暂无数据')
    expect(html).not.toContain('50 token/s')
  })

  it('does not invent visible stream measurements for tool-only turns', () => {
    const html = render({ timing: { elapsedMs: 10_000, outcome: 'completed' } })
    expect(html).toContain('首字延迟 暂无数据')
    expect(html).toContain('可见输出 TPS（估算）暂无数据')
  })

  it.each(['cancelled', 'failed'] as const)('suppresses throughput for %s while retaining observed first text', (outcome) => {
    const html = render({ timing: { ...complete.timing!, outcome } })
    expect(html).toContain('首字延迟 250ms')
    expect(html).toContain('可见输出 TPS（估算）暂无数据')
  })

  it('keeps provider billing counts separate from the visible streaming estimate', () => {
    expect(render({ usageComplete: false })).toContain('可见输出 TPS（估算）50 token/s')
    expect(render({ usageComplete: false })).toContain('（统计中）')
    const zero = render({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })
    expect(zero).toContain('可见输出 TPS（估算）50 token/s')
    expect(zero).toContain('>0 tokens<')
    const missing = render({ usage: { inputTokens: 0 } })
    expect(missing).toContain('输出 未提供')
    expect(missing).toContain('缓存读 未提供')
    expect(missing).toContain('可见输出 TPS（估算）50 token/s')
    expect(render({ usage: undefined })).toContain('tokens 暂无数据')
    expect(render({ usage: undefined })).toContain('可见输出 TPS（估算）50 token/s')
    expect(render({ usage: { outputTokens: 1_000_000 } })).toContain('可见输出 TPS（估算）50 token/s')
  })

  it('uses streaming intervals rather than elapsed whole-turn time', () => {
    const html = render({ timing: { ...complete.timing!, elapsedMs: 100_000 } })
    expect(html).toContain('可见输出 TPS（估算）50 token/s')
    expect(html).not.toContain('整轮有效输出')
    expect(html).toContain('cl100k_base')
    expect(html).toContain('至少两个接收批次且相隔 100ms')
    expect(html).toContain('不保证对应模型请求')
  })

  it.each([NaN, Infinity, -1, 10_001])('rejects invalid first-text timing %s', (firstVisibleOutputMs) => {
    expect(render({ timing: { ...complete.timing!, firstVisibleOutputMs } })).toContain('首字延迟 暂无数据')
  })

  it('does not round tiny positive estimated rates to zero', () => {
    expect(render({ timing: { ...complete.timing!, elapsedMs: 1_000_000,
      visibleStream: { tokenizer: 'cl100k_base', tokens: 1, durationMs: 1_000_000, segments: 1, excludedSegments: 0 } } }))
      .toContain('可见输出 TPS（估算）&lt;0.01 token/s')
  })

  it('localizes metrics and definitions in English', () => {
    setLanguage('en')
    const html = render()
    expect(html).toContain('First visible text 250ms')
    expect(html).toContain('Visible output TPS (estimated) 50 token/s')
    expect(html).toContain('Server Prefill / Decode: not provided')
    expect(html).toContain('not a model-native tokenizer or server decode TPS')
    expect(html).not.toMatch(/[\u4e00-\u9fff]/)
  })
})
