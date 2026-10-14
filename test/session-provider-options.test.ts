import { describe, expect, it, vi } from 'vitest'
import type { SendRequest } from '../src/shared/types'
import { applySessionOptions, cursorArgs, initializeSession, type SessionConnection } from '../src/main/session/provider'

const SESSION_ID = 'codex-options-session'

function setup(mode: SendRequest['mode'] = 'plan', force = true, model = 'auto') {
  const request = vi.fn(async (_method: string, _params: unknown) => ({}))
  const session: SessionConnection = { provider: 'codex', sessionId: SESSION_ID, acp: { request } }
  const req: SendRequest = { threadId: 'thread', prompt: 'Inspect the project', model, mode, force }
  return { request, session, req }
}

describe('Codex session permission configuration', () => {
  it('waits for Plan collaboration mode before enabling the selected implementation permissions', async () => {
    const ctx = setup()
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    ctx.request.mockImplementationOnce(async () => {
      await pending
      return {}
    })

    const configured = applySessionOptions(ctx.session, ctx.req, 'default')
    await Promise.resolve()
    expect(ctx.request.mock.calls).toEqual([
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'collaboration_mode', value: 'plan' }]
    ])

    release()
    await configured
    expect(ctx.request.mock.calls).toEqual([
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'collaboration_mode', value: 'plan' }],
      ['session/set_mode', { sessionId: SESSION_ID, modeId: 'agent-full-access' }]
    ])
  })

  it.each([false, true])('stops before changing permissions when Plan configuration fails with force=%s', async (force) => {
    const ctx = setup('plan', force)
    ctx.request.mockRejectedValueOnce(new Error('Plan collaboration mode is unavailable'))

    await expect(applySessionOptions(ctx.session, ctx.req, 'default')).rejects.toThrow()
    expect(ctx.request.mock.calls).toEqual([
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'collaboration_mode', value: 'plan' }]
    ])
  })

  it('supports an older Agent adapter that does not expose collaboration mode', async () => {
    const ctx = setup('agent')
    ctx.request.mockImplementation(async (method) => {
      if (method === 'session/set_config_option') throw new Error('Method not found')
      return {}
    })

    await expect(applySessionOptions(ctx.session, ctx.req, 'default')).resolves.toBeUndefined()
    expect(ctx.request).toHaveBeenCalledWith('session/set_config_option', {
      sessionId: SESSION_ID, configId: 'collaboration_mode', value: 'default'
    })
    expect(ctx.request).toHaveBeenCalledWith('session/set_mode', { sessionId: SESSION_ID, modeId: 'agent-full-access' })
  })

  it('sets the base model, effort, and fast mode for a Fast variant', async () => {
    const ctx = setup('agent', false, 'gpt-5.4[reasoning_effort=high,fast=true]')
    await applySessionOptions(ctx.session, ctx.req, 'default')
    expect(ctx.request.mock.calls).toEqual([
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'collaboration_mode', value: 'default' }],
      ['session/set_mode', { sessionId: SESSION_ID, modeId: 'agent' }],
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'model', value: 'gpt-5.4' }],
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'reasoning_effort', value: 'high' }],
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'fast-mode', value: 'on' }]
    ])
  })

  it('turns fast mode off for a saved standard id', async () => {
    const ctx = setup('agent', false, 'gpt-5.4[high]')
    await applySessionOptions(ctx.session, ctx.req, 'default')
    expect(ctx.request.mock.calls.at(-1)).toEqual([
      'session/set_config_option', { sessionId: SESSION_ID, configId: 'fast-mode', value: 'off' }
    ])
  })

  it.each(['ask', 'plan', 'agent'] as const)('propagates a failed %s permission mode instead of silently continuing', async (mode) => {
    const ctx = setup(mode)
    ctx.request.mockImplementation(async (method) => {
      if (method === 'session/set_mode') throw new Error('Permission mode rejected')
      return {}
    })

    await expect(applySessionOptions(ctx.session, ctx.req, 'default')).rejects.toThrow()
    expect(ctx.request.mock.calls.filter(([method]) => method === 'session/set_mode')).toHaveLength(1)
  })
})

const GROK_500K = 'grok-4.7[context=500k,reasoning_effort=high,fast=true]'

function cursorRequest(model: string): SendRequest {
  return { threadId: 'thread', prompt: 'Inspect the project', model, mode: 'agent', force: false }
}

describe('Cursor parameterized model selection', () => {
  it('does not pass a bracket variant to --model', () => {
    const req = cursorRequest(GROK_500K)
    expect(cursorArgs(req, 'default', 'D:\\repo', false)).toEqual(['--trust', '--workspace', 'D:\\repo', 'acp'])
    expect(cursorArgs(cursorRequest('composer-2.5'), 'default', 'D:\\repo', false)).toEqual([
      '--trust', '--model', 'composer-2.5', '--workspace', 'D:\\repo', 'acp'
    ])
    expect(cursorArgs(cursorRequest('auto'), 'default', 'D:\\repo', true)).not.toContain('--model')
  })

  it('enables the parameterized model picker when Cursor starts', async () => {
    const request = vi.fn(async () => ({}))
    await initializeSession({ request }, 'cursor', 'key')
    expect(request).toHaveBeenCalledWith('initialize', expect.objectContaining({
      clientCapabilities: expect.objectContaining({ _meta: { parameterizedModelPicker: true } })
    }))
  })

  it('sets the base model and then each variant parameter', async () => {
    const request = vi.fn(async () => ({}))
    const session: SessionConnection = { provider: 'cursor', sessionId: SESSION_ID, acp: { request } }
    await applySessionOptions(session, cursorRequest(GROK_500K), 'default')
    expect(request.mock.calls).toEqual([
      ['session/set_mode', { sessionId: SESSION_ID, modeId: 'agent' }],
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'model', value: 'grok-4.7' }],
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'context', value: '500k' }],
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'reasoning_effort', value: 'high' }],
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'fast', value: 'true' }]
    ])
  })

  it('reports a rejected variant instead of continuing with another model', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session/set_config_option') throw new Error('Invalid value for context: 500k')
      if (method === 'session/set_model') throw new Error('Invalid model value')
      return {}
    })
    const session: SessionConnection = { provider: 'cursor', sessionId: SESSION_ID, acp: { request } }
    await expect(applySessionOptions(session, cursorRequest(GROK_500K), 'default')).rejects.toThrow('Invalid value for context: 500k')
  })

  it('keeps a flat slug when the config option is unavailable', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session/set_config_option') throw new Error('Method not found')
      if (method === 'session/set_model') throw new Error('Method not found')
      return {}
    })
    const session: SessionConnection = { provider: 'cursor', sessionId: SESSION_ID, acp: { request } }
    await expect(applySessionOptions(session, cursorRequest('composer-2.5'), 'default')).resolves.toBeUndefined()
  })
})

describe('Cursor Auto model selection', () => {
  const cursorSession = (unsupported: string[] = []) => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (unsupported.includes(method)) throw new Error(`Method not found: ${method}`)
      return {}
    })
    const session: SessionConnection = { provider: 'cursor', sessionId: SESSION_ID, acp: { request } }
    const modelCalls = () => request.mock.calls.filter(([method]) => method !== 'session/set_mode')
    return { request, session, modelCalls }
  }

  it('selects auto explicitly after a concrete model, then the concrete model again', async () => {
    const ctx = cursorSession()
    await applySessionOptions(ctx.session, cursorRequest('composer-2.5'), 'default')
    await applySessionOptions(ctx.session, cursorRequest('auto'), 'default')
    await applySessionOptions(ctx.session, cursorRequest(GROK_500K), 'default')
    expect(ctx.modelCalls()).toEqual([
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'model', value: 'composer-2.5' }],
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'model', value: 'auto' }],
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'model', value: 'grok-4.7' }],
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'context', value: '500k' }],
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'reasoning_effort', value: 'high' }],
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'fast', value: 'true' }]
    ])
  })

  it('uses session/set_model auto on an older adapter', async () => {
    const ctx = cursorSession(['session/set_config_option'])
    await applySessionOptions(ctx.session, cursorRequest('auto'), 'default')
    expect(ctx.modelCalls()).toEqual([
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'model', value: 'auto' }],
      ['session/set_model', { sessionId: SESSION_ID, modelId: 'auto' }]
    ])
  })

  it('accepts Auto on a fresh session when the adapter has no model requests', async () => {
    const ctx = cursorSession(['session/set_config_option', 'session/set_model'])
    await expect(applySessionOptions(ctx.session, cursorRequest('auto'), 'default')).resolves.toBeUndefined()
    await expect(applySessionOptions(ctx.session, cursorRequest('auto'), 'default')).resolves.toBeUndefined()
  })

  it('fails instead of keeping a concrete model it cannot reset', async () => {
    const ctx = cursorSession(['session/set_config_option', 'session/set_model'])
    await applySessionOptions(ctx.session, cursorRequest('composer-2.5'), 'default')
    await expect(applySessionOptions(ctx.session, cursorRequest('auto'), 'default')).rejects.toThrow('Auto')
  })
})
