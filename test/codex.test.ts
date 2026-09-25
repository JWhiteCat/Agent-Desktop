import { describe, expect, it } from 'vitest'
import { codexPlanModePrompt } from '../src/main/acp'
import { transcriptItems } from '../src/main/codex-history'
import { codexModeId, modelsFromConfig, modelsFromSession, resolveCodexAcpEntry } from '../src/main/codex'

describe('codex mode and models', () => {
  it('maps Ask and Plan to read-only, and keeps full access behind the sandbox switch', () => {
    expect(codexModeId('ask', true, 'disabled')).toBe('read-only')
    expect(codexModeId('plan', false, 'default')).toBe('read-only')
    expect(codexModeId('agent', false, 'disabled')).toBe('agent')
    expect(codexModeId('agent', true, 'disabled')).toBe('agent-full-access')
    expect(codexModeId('agent', true, 'enabled')).toBe('agent')
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
})
