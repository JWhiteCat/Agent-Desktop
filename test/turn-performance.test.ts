import { describe, expect, it } from 'vitest'
import { TurnTiming } from '../src/main/turn-timing'
import { firstTokenLatencyMs, repairTurnTimings, visibleOutputTps } from '../src/shared/turn-performance'
import type { Item, ResultItem } from '../src/shared/types'

const result = (extra: Partial<ResultItem> = {}): ResultItem => ({
  id: 'r', kind: 'result', isError: false, usage: { outputTokens: 120 },
  timing: { elapsedMs: 6000, firstTokenMs: 400, firstVisibleOutputMs: 2000, outcome: 'completed', visibleStream: { tokenizer: 'cl100k_base', tokens: 30, durationMs: 1500, segments: 1, excludedSegments: 0 } }, ...extra
})

describe('client prompt timing', () => {
  it('captures first main-agent output from thoughts/tools while ignoring whitespace, metadata, compaction, and subagents', () => {
    let now = 100
    const timer = new TurnTiming(() => now)
    for (const update of [
      { sessionUpdate: 'usage_update', usage: { inputTokens: 10 } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ' \n\t ' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' \n' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'abc' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'stale', status: 'completed' },
      { sessionUpdate: 'tool_call', toolCallId: 'compact-1', title: 'Compact conversation', kind: 'think', _meta: { contextCompaction: { version: 1 }, claudeCode: { toolName: 'compact' } } },
      { sessionUpdate: 'tool_call', toolCallId: 'bg-1', rawInput: { agentThreadId: 'sub-1', activityKind: 'completed' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'subagent thought' }, _meta: { claudeCode: { parentToolUseId: 'parent' } } },
      { sessionUpdate: 'tool_call', toolCallId: 'sub-tool', _meta: { claudeCode: { parentToolUseId: 'parent' } } }
    ]) { now += 100; timer.observe(update) }
    now = 1200
    timer.observe({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '**Analyzing Git Display**' } })
    now = 1500
    timer.observe({ sessionUpdate: 'tool_call', toolCallId: 'grep-1', rawInput: { pattern: 'HEAD' } })
    now = 2100
    timer.observe({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply' } })
    now = 3100
    timer.observe({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'more' } })
    now = 6100
    expect(timer.finish('completed')).toMatchObject({
      elapsedMs: 6000,
      firstTokenMs: 1100,
      firstVisibleOutputMs: 2000,
      outcome: 'completed',
      visibleStream: { tokens: 1, durationMs: 1000 }
    })
    now = 9100
    expect(timer.finish('failed').elapsedMs).toBe(6000)
  })

  it('records first token when a turn begins directly with a tool call or plan before later summary text', () => {
    let now = 1000
    const toolTurn = new TurnTiming(() => now)
    now = 4500
    toolTurn.observe({ sessionUpdate: 'tool_call', toolCallId: 'read-1', rawInput: { path: 'a.ts' } })
    now = 45000
    toolTurn.observe({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } })
    now = 48000
    expect(toolTurn.finish('completed')).toMatchObject({ elapsedMs: 47000, firstTokenMs: 3500, firstVisibleOutputMs: 44000 })

    let planNow = 0
    const planTurn = new TurnTiming(() => planNow)
    planNow = 1800
    planTurn.observe({ sessionUpdate: 'plan_update', plan: { content: '# Plan\nStep 1' } })
    planNow = 5000
    expect(planTurn.finish('completed')).toMatchObject({ elapsedMs: 5000, firstTokenMs: 1800 })
  })

  it('does not invent a TTFT when no model output arrived, and resets on retries', () => {
    let now = 0
    const first = new TurnTiming(() => now)
    now = 200
    expect(first.finish('cancelled')).toEqual({ elapsedMs: 200, outcome: 'cancelled' })
    first.observe({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } })
    expect(first.finish('completed').firstTokenMs).toBeUndefined()
    expect(first.finish('completed').firstVisibleOutputMs).toBeUndefined()
    const retry = new TurnTiming(() => now)
    now = 500
    expect(retry.finish('failed')).toEqual({ elapsedMs: 300, outcome: 'failed' })
  })
})

describe('legacy turn first-token repair', () => {
  it('reconstructs initial thought/tool latency on session bba121c8 and preserves direct assistant turns', () => {
    const items: Item[] = [
      { id: 'u1', kind: 'user', text: 'q1', createdAt: 1794989683831 },
      { id: 'th1', kind: 'thinking', text: 'analyzing', done: true, startedAt: 1794989701794, endedAt: 1794989704759 },
      { id: 'tl1', kind: 'tool', callId: 'c1', tool: 'grep', args: {}, status: 'success', startedAt: 1794989704759, endedAt: 1794989706522 },
      { id: 'a1', kind: 'assistant', text: 'answer' },
      {
        id: 'r1', kind: 'result', isError: false, createdAt: 1794989853382, durationMs: 161135,
        timing: { elapsedMs: 161135.4414, firstVisibleOutputMs: 147403.8979, outcome: 'completed' }
      },
      { id: 'u2', kind: 'user', text: 'q2', createdAt: 1794991000000 },
      { id: 'a2', kind: 'assistant', text: 'direct reply' },
      {
        id: 'r2', kind: 'result', isError: false, createdAt: 1794991010000, durationMs: 10000,
        timing: { elapsedMs: 10000, firstVisibleOutputMs: 1750, outcome: 'completed' }
      }
    ]
    expect(repairTurnTimings(items)).toBe(true)
    const r1 = items[4] as ResultItem
    const r2 = items[7] as ResultItem
    expect(Math.round(r1.timing!.firstTokenMs!)).toBe(9547)
    expect(r2.timing!.firstTokenMs).toBe(1750)
    expect(repairTurnTimings(items)).toBe(false)
  })

  it('refuses to fall back to polluted post-tool firstVisibleOutputMs when legacy step timestamps cannot be verified', () => {
    const cancelledResult: ResultItem = {
      id: 'rc', kind: 'result', isError: false, createdAt: 100_000,
      timing: { elapsedMs: 50_000, firstVisibleOutputMs: 45_000, outcome: 'cancelled' }
    }
    const steps: Item[] = [
      { id: 'th', kind: 'thinking', text: 'thought', done: true, startedAt: 52_000, endedAt: 60_000 },
      { id: 'a', kind: 'assistant', text: 'partial' }
    ]
    expect(firstTokenLatencyMs(cancelledResult, steps)).toBeUndefined()

    const driftedResult: ResultItem = {
      id: 'rd', kind: 'result', isError: false, createdAt: 100_000,
      timing: { elapsedMs: 50_000, firstVisibleOutputMs: 45_000, outcome: 'completed' }
    }
    expect(firstTokenLatencyMs(driftedResult, steps, { id: 'u', kind: 'user', text: 'hi', createdAt: 80_000 })).toBeUndefined()
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
