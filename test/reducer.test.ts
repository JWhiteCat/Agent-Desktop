import { describe, expect, it } from 'vitest'
import { compact, StreamReducer } from '../src/main/reducer'
import { parseQuestionBlock } from '../src/shared/questions'
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

  it('keeps ACP turn usage and splits cache out of input', () => {
    const reducer = new StreamReducer([])
    reducer.handleAcp({
      sessionUpdate: 'usage_update',
      usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 30, cacheWriteTokens: 10, inputIncludesCache: true }
    })
    expect(reducer.lastUsage).toEqual({ inputTokens: 60, outputTokens: 7, cacheReadTokens: 30, cacheWriteTokens: 10 })
    reducer.handleAcp({ sessionUpdate: 'usage_update', usage: { inputTokens: 0, outputTokens: 0 } })
    expect(reducer.lastUsage?.inputTokens).toBe(60)
  })

  it('appends ACP message chunks', () => {
    const items: Item[] = []
    const reducer = new StreamReducer(items)
    reducer.handleAcp({ sessionUpdate: 'agent_message_chunk', content: { text: 'o' } })
    reducer.handleAcp({ sessionUpdate: 'agent_message_chunk', content: { text: 'k' } })
    expect(assistantText(items)).toBe('ok')
  })

  it.each([
    { sessionUpdate: 'tool_call', status: 'pending' },
    { sessionUpdate: 'tool_call', status: 'completed' },
    { sessionUpdate: 'tool_call_update', status: 'completed' }
  ])('keeps a questions fence intact across background completion ($sessionUpdate, $status)', (event) => {
    const items: Item[] = []
    const reducer = new StreamReducer(items)
    const before = '选择方案。\n\n```questions\n{"questions":[{"id":"q1","prompt":"采用哪个方案？","options":[{"id":"a","label":"细致战斗策略需另外'
    const after = '配置；自动备餐增加开发量。"}]}]}\n```'
    const [assistant] = reducer.handleAcp({ sessionUpdate: 'agent_message_chunk', content: { text: before } })

    const [tool] = reducer.handleAcp({
      ...event,
      toolCallId: 'subagent-completed-audit',
      title: 'Complete subagent audit',
      rawInput: { agentThreadId: 'agent-thread', agentPath: '/root/audit', activityKind: 'completed' }
    })
    const changed = reducer.handleAcp({ sessionUpdate: 'agent_message_chunk', content: { text: after } })
    const updated = reducer.handleAcp({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'subagent-completed-audit',
      status: 'completed',
      content: { text: 'Audit complete' }
    })

    expect(changed).toEqual([assistant])
    expect(items.filter((item) => item.kind === 'assistant')).toEqual([assistant])
    expect(assistant).toMatchObject({ text: before + after })
    const body = assistantText(items).split('```questions\n')[1].replace(/\n```$/, '')
    expect(parseQuestionBlock(body)?.questions[0].options[0].label).toBe('细致战斗策略需另外配置；自动备餐增加开发量。')
    expect(updated).toEqual([tool])
    expect(items.filter((item) => item.kind === 'tool')).toEqual([tool])
    expect(tool).toMatchObject({
      callId: 'subagent-completed-audit',
      status: 'success',
      result: { success: { stdout: 'Audit complete' } }
    })
  })

  it.each([
    { title: 'Read file', rawInput: { path: 'README.md' }, status: 'pending' },
    { title: 'Read file', rawInput: { path: 'README.md' }, status: 'completed' },
    { title: 'Start subagent audit', rawInput: { agentThreadId: 'agent-thread', activityKind: 'started' }, status: 'completed' },
    { title: 'Interact with subagent audit', rawInput: { agentThreadId: 'agent-thread', activityKind: 'interacted' }, status: 'completed' }
  ])('starts a new message after an ordinary ACP tool call ($title, $status)', (event) => {
    const items: Item[] = []
    const reducer = new StreamReducer(items)
    const [before] = reducer.handleAcp({ sessionUpdate: 'agent_message_chunk', content: { text: '先检查。' } })
    reducer.handleAcp({ sessionUpdate: 'tool_call', toolCallId: 'ordinary-call', ...event })
    const [after] = reducer.handleAcp({ sessionUpdate: 'agent_message_chunk', content: { text: '检查完毕。' } })

    expect(after.id).not.toBe(before.id)
    expect(items.map((item) => item.kind)).toEqual(['assistant', 'tool', 'assistant'])
    expect(before).toMatchObject({ text: '先检查。' })
    expect(after).toMatchObject({ text: '检查完毕。' })
  })

  it('turns Codex plan updates into one plan card', () => {
    const items: Item[] = []
    const reducer = new StreamReducer(items)
    reducer.handleAcp({
      sessionUpdate: 'plan_update',
      plan: { type: 'markdown', planId: 'p1', content: '# 方案\n\n先看结构' }
    })
    reducer.handleAcp({ sessionUpdate: 'plan', entries: [{ content: '读代码', status: 'pending' }] })
    reducer.handleAcp({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'update_plan',
      status: 'completed',
      rawInput: { plan: '# 另一份' }
    })
    const plans = items.filter((item): item is ToolItem => item.kind === 'tool' && item.tool === 'createPlan')
    expect(plans).toHaveLength(2)
    expect(plans[0].args).toMatchObject({ name: '方案', overview: '先看结构', plan: '# 方案\n\n先看结构' })
    expect(plans[0].args.todos).toEqual([{ id: '0', content: '读代码', status: 'pending' }])
    expect(plans[1].args).toMatchObject({ plan: '# 另一份' })
  })
})
