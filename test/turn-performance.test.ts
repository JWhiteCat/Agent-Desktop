import { describe, expect, it } from 'vitest'
import { TurnTiming } from '../src/main/turn-timing'
import { effectiveOutputTps } from '../src/shared/turn-performance'
import type { ResultItem } from '../src/shared/types'

const result = (extra: Partial<ResultItem> = {}): ResultItem => ({
  id: 'r', kind: 'result', isError: false, usage: { outputTokens: 120 },
  timing: { elapsedMs: 6000, firstVisibleOutputMs: 2000, outcome: 'completed' }, ...extra
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
    expect(timer.finish('completed')).toEqual({ elapsedMs: 6000, firstVisibleOutputMs: 2000, outcome: 'completed' })
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

describe('effective output throughput', () => {
  it('divides complete reported output by the whole turn, never just the visible output interval', () => {
    expect(effectiveOutputTps(result())).toBe(20)
    expect(effectiveOutputTps(result({ usage: { outputTokens: 0 } }))).toBe(0)
    expect(effectiveOutputTps(result({ timing: { elapsedMs: 6000, outcome: 'completed' } }))).toBe(20)
  })
  it.each([
    { timing: undefined, durationMs: 6000 }, { usageComplete: false }, { usage: undefined },
    { usage: { inputTokens: 120 } }, { usage: { outputTokens: NaN } }, { usage: { outputTokens: -1 } },
    { isError: true }, { timing: { elapsedMs: 6000, outcome: 'cancelled' as const } },
    { timing: { elapsedMs: 6000, outcome: 'failed' as const } },
    ...[0, -1, NaN, Infinity].map((elapsedMs) => ({ timing: { elapsedMs, outcome: 'completed' as const } }))
  ])('leaves unavailable/partial/interrupted data unavailable: %j', (extra) => {
    expect(effectiveOutputTps(result(extra))).toBeUndefined()
  })
})
