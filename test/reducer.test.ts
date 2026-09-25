import { describe, expect, it } from 'vitest'
import { compact, StreamReducer } from '../src/main/reducer'
import type { AssistantItem, Item, ResultItem, ThinkingItem, ToolItem } from '../src/shared/types'

function assistantText(items: Item[]): string {
  return items.filter((item): item is AssistantItem => item.kind === 'assistant').map((item) => item.text).join('')
}

describe('compact', () => {
  it('drops bulky tool fields and truncates long strings', () => {
    const long = 'x'.repeat(24_001)
    const out = compact({
      afterFullFileContent: long,
      keep: long,
      nested: { parsingResult: { a: 1 }, note: 'ok' }
    }) as { keep: string; nested: { note: string } }
    expect(out).not.toHaveProperty('afterFullFileContent')
    expect(out.nested).toEqual({ note: 'ok' })
    expect(out.keep.startsWith('x'.repeat(24_000))).toBe(true)
    expect(out.keep).toContain('已截断 1 字符')
  })
})

describe('StreamReducer', () => {
  it('folds thinking and assistant deltas and skips the aggregate message', () => {
    const items: Item[] = []
    const reducer = new StreamReducer(items)
    reducer.handle({ type: 'thinking', subtype: 'delta', text: '想', timestamp_ms: 1 })
    reducer.handle({ type: 'thinking', subtype: 'completed', timestamp_ms: 2 })
    reducer.handle({
      type: 'assistant',
      timestamp_ms: 3,
      message: { content: [{ type: 'text', text: 'ok' }] }
    })
    reducer.handle({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'ok-again' }] }
    })
    reducer.handle({ type: 'result', is_error: false, duration_ms: 12, usage: { inputTokens: 3, outputTokens: 1 } })

    const thinking = items.find((item): item is ThinkingItem => item.kind === 'thinking')
    expect(thinking).toMatchObject({ text: '想', done: true })
    const result = items.find((item): item is ResultItem => item.kind === 'result')
    expect(assistantText(items)).toBe('ok')
    expect(reducer.gotResult).toBe(true)
    expect(result).toMatchObject({ isError: false, durationMs: 12, usage: { inputTokens: 3, outputTokens: 1 } })
  })

  it('stores a compacted tool result and marks a killed call as failed', () => {
    const items: Item[] = []
    const reducer = new StreamReducer(items)
    const huge = 'y'.repeat(24_050)
    reducer.handle({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c1',
      tool_call: { startedAtMs: 10, readToolCall: { args: { path: 'a.ts' } } }
    })
    reducer.handle({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'c1',
      tool_call: { completedAtMs: 20, readToolCall: { args: { path: 'a.ts' }, result: { success: { stdout: huge } } } }
    })
    const done = items.find((item): item is ToolItem => item.kind === 'tool')
    const stdout = (done?.result as { success?: { stdout?: string } } | undefined)?.success?.stdout
    expect(done).toMatchObject({ tool: 'read', status: 'success', callId: 'c1' })
    expect(stdout).toContain('已截断')
    expect(stdout?.length).toBeLessThan(huge.length)

    const running: Item[] = []
    const second = new StreamReducer(running)
    second.handle({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c2',
      tool_call: { shellToolCall: { args: { command: 'echo ok' } } }
    })
    expect(second.abortRunningTools()[0]).toMatchObject({ status: 'error' })
  })

  it('builds a unified diff from an ACP edit content block', () => {
    const items: Item[] = []
    const reducer = new StreamReducer(items)
    reducer.handleAcp({
      sessionUpdate: 'tool_call',
      toolCallId: 'e1',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: 'src/a.ts' }],
      rawInput: { path: 'src/a.ts', old_string: 'old', new_string: 'new' }
    })
    reducer.handleAcp({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'e1',
      status: 'completed',
      content: [{ type: 'diff', path: 'src/a.ts', oldText: 'keep\nold\n', newText: 'keep\nnew\n' }]
    })
    const tool = items.find((item): item is ToolItem => item.kind === 'tool')
    const success = (tool?.result as { success?: { diffString?: string; linesAdded?: number; linesRemoved?: number; oldText?: string } } | undefined)?.success
    expect(tool).toMatchObject({ tool: 'edit', status: 'success' })
    expect(success?.linesAdded).toBe(1)
    expect(success?.linesRemoved).toBe(1)
    expect(success?.diffString).toContain('b/src/a.ts')
    expect(success?.diffString).toContain('-old')
    expect(success?.diffString).toContain('+new')
    expect(success?.diffString).toContain(' keep')
    expect(success).not.toHaveProperty('oldText')
  })

  it('marks an ACP file create from a null before-text', () => {
    const items: Item[] = []
    const reducer = new StreamReducer(items)
    reducer.handleAcp({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'e2',
      kind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: 'b.ts', oldText: null, newText: 'hi\n' }]
    })
    const tool = items.find((item): item is ToolItem => item.kind === 'tool')
    const diff = (tool?.result as { success?: { diffString?: string } } | undefined)?.success?.diffString ?? ''
    expect(diff).toContain('--- /dev/null')
    expect(diff).toContain('+hi')
  })

  it('appends ACP message chunks', () => {
    const items: Item[] = []
    const reducer = new StreamReducer(items)
    reducer.handleAcp({ sessionUpdate: 'agent_message_chunk', content: { text: 'o' } })
    reducer.handleAcp({ sessionUpdate: 'agent_message_chunk', content: { text: 'k' } })
    expect(assistantText(items)).toBe('ok')
  })
})
