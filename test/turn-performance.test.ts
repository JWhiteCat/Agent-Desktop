import { describe, expect, it } from 'vitest'
import { TurnTiming } from '../src/main/turn-timing'
import { visibleOutputTps } from '../src/shared/turn-performance'
import type { ResultItem } from '../src/shared/types'

const result = (extra: Partial<ResultItem> = {}): ResultItem => ({
  id: 'r', kind: 'result', isError: false, usage: { outputTokens: 120 },
  timing: { elapsedMs: 6000, firstVisibleOutputMs: 2000, outcome: 'completed', visibleStream: { tokenizer: 'cl100k_base', tokens: 30, durationMs: 1500, segments: 1, excludedSegments: 0 } }, ...extra
})

describe('client prompt timing', () => {
  it('uses the monotonic interval and first visible reply, not thoughts/tools/empty chunks', () => {
    let now = 100
    const timer = new TurnTiming(() => now)
    for (const update of [
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
      { sessionUpdate: 'tool_call', content: { type: 'text', text: 'tool' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' \n' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'abc' } }
    ]) { now += 100; timer.observe(update) }
    now = 2100
    timer.observe({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply' } })
    now = 3100
    timer.observe({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'more' } })
    now = 6100
    expect(timer.finish('completed')).toMatchObject({ elapsedMs: 6000, firstVisibleOutputMs: 2000, outcome: 'completed', visibleStream: { tokens: 1, durationMs: 1000 } })
    now = 9100
    expect(timer.finish('failed').elapsedMs).toBe(6000)
  })

  it('does not invent a TTFT for tool-only, cancelled or failed work, and resets on retries', () => {
    let now = 0
    const first = new TurnTiming(() => now)
    now = 200
    expect(first.finish('cancelled')).toEqual({ elapsedMs: 200, outcome: 'cancelled' })
    first.observe({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } })
    expect(first.finish('completed').firstVisibleOutputMs).toBeUndefined()
    const retry = new TurnTiming(() => now)
    now = 500
    expect(retry.finish('failed')).toEqual({ elapsedMs: 300, outcome: 'failed' })
  })
})

describe('visible streaming throughput', () => {
  it('uses only the measured text estimate, independent of billing usage and whole-turn time', () => {
    expect(visibleOutputTps(result())).toBe(20)
    expect(visibleOutputTps(result({ usage: { outputTokens: 0 } }))).toBe(20)
    expect(visibleOutputTps(result({ usage: undefined, usageComplete: false }))).toBe(20)
  })
  it.each([
    { timing: undefined, durationMs: 6000 },
    { isError: true }, { timing: { elapsedMs: 6000, outcome: 'cancelled' as const } },
    { timing: { elapsedMs: 6000, outcome: 'failed' as const } },
    { timing: { elapsedMs: 6000, outcome: 'completed' as const } }
  ])('does not invent a rate for unavailable/interrupted data: %j', (extra) => {
    expect(visibleOutputTps(result(extra))).toBeUndefined()
  })
  it.each([0, -1, NaN, Infinity, 99])('rejects invalid or burst-only window %s', (durationMs) => {
    const item = result()
    item.timing!.visibleStream!.durationMs = durationMs
    expect(visibleOutputTps(item)).toBeUndefined()
  })
})
