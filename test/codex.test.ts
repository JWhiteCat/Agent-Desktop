import { describe, expect, it } from 'vitest'
import { codexPlanModePrompt } from '../src/main/acp'
import { transcriptItems } from '../src/main/codex-history'
import { codexModeId, modelsFromConfig, modelsFromSession, resolveCodexAcpEntry } from '../src/main/codex'

describe('codex mode and models', () => {
  it('keeps Ask read-only regardless of full access or sandbox settings', () => {
    for (const force of [false, true]) {
      for (const sandbox of ['default', 'enabled', 'disabled'] as const) {
        expect(codexModeId('ask', force, sandbox)).toBe('read-only')
      }
    }
  })

  it.each(['agent', 'plan'] as const)('maps %s permissions independently of collaboration mode', (mode) => {
    for (const sandbox of ['default', 'enabled', 'disabled'] as const) {
      expect(codexModeId(mode, false, sandbox)).toBe('agent')
    }
    expect(codexModeId(mode, true, 'default')).toBe('agent-full-access')
    expect(codexModeId(mode, true, 'disabled')).toBe('agent-full-access')
    expect(codexModeId(mode, true, 'enabled')).toBe('agent')
  })

  it('expands model and effort selects, and puts the recommendation first', () => {
    const listed = modelsFromConfig([
      {
        id: 'model',
        currentValue: 'gpt-5.4',
        options: [
          { value: 'gpt-5.4-mini', name: '5.4 Mini' },
          { value: 'gpt-5.4', name: '5.4' }
        ],
        _meta: { jetbrains: { air: { recommendedValue: 'gpt-5.4' } } }
      },
      {
        id: 'reasoning_effort',
        currentValue: 'high',
        options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }]
      }
    ])
    expect(listed.recommended).toBe('gpt-5.4[high]')
    expect(listed.models[0]).toEqual({ id: 'gpt-5.4[high]', label: '5.4 high' })
    expect(listed.models.map((model) => model.id)).toEqual(['gpt-5.4[high]', 'gpt-5.4-mini[low]', 'gpt-5.4-mini[high]', 'gpt-5.4[low]'])
  })

  it('reads the legacy availableModels list when config options are empty', () => {
    const listed = modelsFromSession({
      configOptions: [],
      models: { availableModels: [{ modelId: 'gpt-5.4[high]', name: '5.4 (high)' }] }
    })
    expect(listed.models).toEqual([{ id: 'gpt-5.4[high]', label: '5.4 (high)' }])
  })

  it('keeps Astra ultra and does not give every model the current effort list', () => {
    const listed = modelsFromSession({
      configOptions: [
        {
          id: 'model',
          currentValue: 'gpt-6-astra',
          options: [
            { value: 'gpt-6-astra', name: '6 Astra' },
            { value: 'gpt-5.5', name: '5.5' }
          ]
        },
        {
          id: 'reasoning_effort',
          currentValue: 'high',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
            { value: 'max', name: 'Max' }
          ]
        }
      ],
      models: {
        availableModels: [
          { modelId: 'gpt-6-astra[low]', name: '6 Astra (low)' },
          { modelId: 'gpt-6-astra[high]', name: '6 Astra (high)' },
          { modelId: 'gpt-6-astra[ultra]', name: '6 Astra (ultra)' },
          { modelId: 'gpt-5.5[low]', name: '5.5 (low)' },
          { modelId: 'gpt-5.5[high]', name: '5.5 (high)' }
        ]
      }
    })
    expect(listed.recommended).toBe('gpt-6-astra[high]')
    expect(listed.models.map((model) => model.id)).toEqual([
      'gpt-6-astra[high]',
      'gpt-6-astra[low]',
      'gpt-6-astra[ultra]',
      'gpt-5.5[low]',
      'gpt-5.5[high]'
    ])
  })

  it('finds the bundled ACP adapter', () => {
    expect(resolveCodexAcpEntry()).toMatch(/codex-acp[\\/]dist[\\/]index\.js$/)
  })

  it('asks Codex to emit a questions block and a markdown plan', () => {
    const text = codexPlanModePrompt('做个待办')
    expect(text).toContain('```questions')
    expect(text).toContain('The client automatically adds an "Other (manual input)" option to every question')
    expect(text).toContain('do not include an Other placeholder in the options')
    expect(text).toContain('selected options and any manual answer arrive together as the next message')
    expect(text.endsWith('做个待办')).toBe(true)
  })
})

describe('codex rollout transcripts', () => {
  it('keeps response items and does not repeat the same turn from event_msg', () => {
    const text = [
      JSON.stringify({
        timestamp: '2026-09-01T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'thread-1', cwd: 'D:/repo', timestamp: '2026-09-01T00:00:00.000Z' }
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '你好' } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] }
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":"ls"}' }
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'c1', output: 'a.ts' }
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '看过了' }] }
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '看过了' } })
    ].join('\n')
    const items = transcriptItems(text)
    expect(items.map((item) => item.kind)).toEqual(['user', 'tool', 'assistant'])
    expect(items[0]).toMatchObject({ kind: 'user', text: '你好' })
    expect(items[1]).toMatchObject({ kind: 'tool', tool: 'shell', status: 'success' })
    expect(items[2]).toMatchObject({ kind: 'assistant', text: '看过了' })
  })

  it('falls back to event messages when a rollout has no response items', () => {
    const text = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '只有事件' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '收到' } })
    ].join('\n')
    expect(transcriptItems(text).map((item) => (item.kind === 'user' || item.kind === 'assistant' ? item.text : ''))).toEqual(['只有事件', '收到'])
  })

  it('inserts complete usage after the associated response without disrupting tools or later turns', () => {
    const event = (payload: object, timestamp = '2026-09-01T00:00:00.000Z') => ({ type: 'event_msg', payload, timestamp })
    const usage = (input: number, cached: number, output: number) => event({
      type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } }
    })
    const text = [
      event({ type: 'task_started', turn_id: 'first' }),
      { type: 'turn_context', payload: { turn_id: 'first', model: 'gpt-5.4' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'Inspect' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'call', arguments: '{}' } },
      usage(100, 20, 10),
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: 'Done' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Inspected' } },
      usage(250, 120, 30),
      event({ type: 'task_complete', turn_id: 'first' }, '2026-09-01T00:00:10.000Z'),
      event({ type: 'task_started', turn_id: 'second' }, '2026-09-01T00:00:20.000Z'),
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'Again' } },
      usage(300, 140, 35),
      event({ type: 'turn_aborted', turn_id: 'second' }, '2026-09-01T00:00:22.000Z')
    ].map((row) => JSON.stringify(row)).join('\n')
    const items = transcriptItems(text)
    expect(items.map((item) => item.kind)).toEqual(['user', 'tool', 'assistant', 'result', 'user', 'result'])
    expect(items[1]).toMatchObject({ kind: 'tool', result: { success: { stdout: 'Done' } }, status: 'success' })
    expect(items[3]).toMatchObject({
      cli: 'codex', usageId: 'codex:first', model: 'gpt-5.4', isError: false, durationMs: 10_000,
      createdAt: Date.parse('2026-09-01T00:00:10.000Z'),
      usage: { inputTokens: 130, cacheReadTokens: 120, outputTokens: 30 }
    })
    expect(items[5]).toMatchObject({
      cli: 'codex', usageId: 'codex:second', isError: true, durationMs: 2000,
      usage: { inputTokens: 30, cacheReadTokens: 20, outputTokens: 5 }
    })
  })

  it('includes usage and user timestamps when transcript parsing falls back to event messages', () => {
    const timestamp = '2026-09-01T00:00:00.000Z'
    const text = [
      { type: 'session_meta', payload: { id: 'event-only' } },
      { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'Only events' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 5 } } } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'OK' } },
      { type: 'event_msg', payload: { type: 'task_complete' }, timestamp: '2026-09-01T00:00:01.000Z' }
    ].map((row) => JSON.stringify(row)).join('\n')
    const items = transcriptItems(text)
    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant', 'result'])
    expect(items[0]).toMatchObject({ text: 'Only events', createdAt: Date.parse(timestamp) })
    expect(items[2]).toMatchObject({
      usageId: 'codex:event-only:line:1', cli: 'codex', durationMs: 1000,
      usage: { inputTokens: 10, outputTokens: 5 }
    })
  })
})
